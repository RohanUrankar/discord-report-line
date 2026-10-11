import { describe, expect, it } from 'vitest';

import { useTestDatabase } from '../../test/helpers/db.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  buttonPayload,
  commandPayload,
  modalSubmitPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, makeJobsDue, wire, type Reply } from '../../test/helpers/pgApp.js';
import { slackWebhookUrl, usePipeline } from '../../test/helpers/workerHarness.js';

// The whole Step 5 story in one run, the way a person would drive it in Discord: open the form, submit it,
// let the worker finish, then click the buttons that the worker's own PATCH delivered.

const db = useTestDatabase();
const pipeline = usePipeline(db);

const SUBMIT_ID = '900000000000000401';
const FIRST_CLICK = '900000000000000402';
const SECOND_CLICK = '900000000000000403';
const ESCALATE_CLICK = '900000000000000404';
const OTHER_USER = '900000000000000043';
const REPORT_TEXT = 'the printer on floor 2 is jammed';

interface Message {
  content: string;
  components?: { components: { custom_id: string }[] }[];
}
interface Update {
  type: number;
  data: Message;
}

const customIds = (message: Message): string[] =>
  (message.components ?? []).flatMap((row) => row.components.map((button) => button.custom_id));

describe('form → worker → buttons', () => {
  it('SHALL carry a report from /report to an escalated message, one state change per step', async () => {
    const h = pipeline();
    h.clock.set(NOW_MS);
    await db().query('INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)', [
      GUILD_ID,
      h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID),
    ]);
    const { send, sink } = wire(db());

    // 1. /report with no text opens the form; nothing is stored.
    const opened = (await send(commandPayload('report')).expect(200)).body as { type: number };
    expect(opened.type).toBe(9);
    expect((await db().query('SELECT 1 FROM interaction')).rowCount).toBe(0);

    // 2. The submit is a fresh interaction: deferred at once, then filled in by the worker.
    const submitted = (await send(modalSubmitPayload(REPORT_TEXT, SUBMIT_ID)).expect(200))
      .body as unknown;
    expect(submitted).toEqual({ type: 5, data: { flags: 64 } });
    await makeJobsDue(db());
    await h.drain();
    const patch = h.discord.requests.find((request) => request.method === 'PATCH');
    const filled = JSON.parse(patch?.body ?? '{}') as Message;
    expect(filled.content).toBe('Report logged. The team has been notified.');
    expect(customIds(filled)).toEqual([`rpt:ack:${SUBMIT_ID}`, `rpt:esc:${SUBMIT_ID}`]);
    expect(h.slack.requests).toHaveLength(1);

    // 3. Acknowledge, using the custom_id the worker actually sent.
    const [ackId, escId] = customIds(filled);
    const acked = (
      await send(buttonPayload({ id: FIRST_CLICK, customId: ackId ?? '' })).expect(200)
    ).body as Update;
    expect(acked.type).toBe(7);
    expect(acked.data.content).toContain('✅ Acknowledged by');
    expect(customIds(acked.data)).toEqual([escId]);

    // 4. A second person clicking the same, now stale, button is told so and changes nothing.
    const stale = (
      await send(
        buttonPayload({ id: SECOND_CLICK, customId: ackId ?? '', userId: OTHER_USER }),
      ).expect(200)
    ).body as Reply;
    expect(stale.type).toBe(4);
    expect(stale.data.flags).toBe(64);
    expect(stale.data.content).toMatch(/^This report was already acknowledged by </);

    // 5. Escalate finishes it: no buttons left, nothing sent anywhere.
    const slackBefore = h.slack.requests.length;
    const discordBefore = h.discord.requests.length;
    const escalated = (
      await send(
        buttonPayload({ id: ESCALATE_CLICK, customId: escId ?? '', userId: OTHER_USER }),
      ).expect(200)
    ).body as Update;
    expect(escalated.type).toBe(7);
    expect(escalated.data.content).toContain('🚨 Escalated by');
    expect(customIds(escalated.data)).toEqual([]);
    expect(h.slack.requests).toHaveLength(slackBefore);
    expect(h.discord.requests).toHaveLength(discordBefore);

    const rows = await db().query(
      `SELECT i.id, i.type, i.command_name, i.status, a.type AS action, a.report_id
         FROM interaction i JOIN action a ON a.interaction_id = i.id ORDER BY i.id`,
    );
    expect(rows.rows).toEqual([
      {
        id: SUBMIT_ID,
        type: 5,
        command_name: 'report',
        status: 'followed_up',
        action: 'report',
        report_id: null,
      },
      {
        id: FIRST_CLICK,
        type: 3,
        command_name: null,
        status: 'answered',
        action: 'acknowledged',
        report_id: SUBMIT_ID,
      },
      {
        id: ESCALATE_CLICK,
        type: 3,
        command_name: null,
        status: 'answered',
        action: 'escalated',
        report_id: SUBMIT_ID,
      },
    ]);
    expect(sink.text()).not.toContain(FAKE_INTERACTION_TOKEN);
    expect(sink.text()).not.toContain(REPORT_TEXT);
  });
});
