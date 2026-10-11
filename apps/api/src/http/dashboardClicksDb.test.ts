import { InteractionDetail, InteractionLogPage } from '@report-line/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  makeDashboardKit,
  type Admin,
  type DashboardKit,
} from '../../test/helpers/dashboardKit.js';
import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  buttonPayload,
  modalSubmitPayload,
  reportPayload,
} from '../../test/helpers/payloads.js';
import { wire } from '../../test/helpers/pgApp.js';

// A button click (type 3, no command name) and a form submit (type 5) must show up in the log of the admin
// who manages the server, label sensibly, and be invisible to everyone else (DESIGN §5.5, CLAUDE.md tenancy).

const db = useTestDatabase();

const OTHER_GUILD = '900000000000000102';
const MODAL_SUBMIT_ID = '900000000000000301';
const CLICK_ID = '900000000000000302';

let kit: DashboardKit;
let owner: Admin;
let stranger: Admin;

beforeEach(async () => {
  await truncateAll(db());
  kit = makeDashboardKit(db());
  owner = await kit.signIn('owner@example.test');
  stranger = await kit.signIn('stranger@example.test');
  const { send } = wire(db());
  await send(reportPayload('the printer is jammed')).expect(200); // the report the click is about
  await send(modalSubmitPayload('from the form', MODAL_SUBMIT_ID)).expect(200);
  await send(buttonPayload({ id: CLICK_ID, customId: `rpt:ack:${INTERACTION_ID}` })).expect(200);
  await kit.manage(owner, GUILD_ID);
  await db().query('INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [OTHER_GUILD]);
  await kit.manage(stranger, OTHER_GUILD);
});

const logPath = `/api/guilds/${GUILD_ID}/interactions`;

describe('dashboard log: modal submits and button clicks', () => {
  it('WHEN the managing admin reads the log THE SYSTEM SHALL list the click with no command and its action, and the form submit as /report', async () => {
    const res = await kit.get(owner, logPath);

    expect(res.status).toBe(200);
    const page = InteractionLogPage.parse(res.body);
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(CLICK_ID)).toMatchObject({
      command: null,
      interactionStatus: 'answered',
      action: { type: 'acknowledged', mirrorStatus: 'skipped' },
      job: null,
    });
    expect(byId.get(MODAL_SUBMIT_ID)).toMatchObject({
      command: 'report',
      interactionStatus: 'deferred',
      action: { type: 'report', mirrorStatus: 'pending' },
      job: { status: 'pending' },
    });
    expect(page.items).toHaveLength(3);
  });

  it('WHEN a click or a form submit is opened THE SYSTEM SHALL return its detail without a custom_id, a token or the report text', async () => {
    for (const id of [CLICK_ID, MODAL_SUBMIT_ID]) {
      const res = await kit.get(owner, `${logPath}/${id}`);

      expect(res.status).toBe(200);
      InteractionDetail.parse(res.body);
      expect(res.text).not.toMatch(/custom_id|customId|rpt:ack|report_modal/);
      expect(res.text).not.toContain(FAKE_INTERACTION_TOKEN);
      expect(res.text).not.toContain('from the form');
    }
    const list = await kit.get(owner, logPath);
    expect(list.text).not.toMatch(/custom_id|customId|rpt:ack|report_modal/);
    expect(list.text).not.toContain(FAKE_INTERACTION_TOKEN);
  });

  it('WHEN another admin asks for that server or those rows THE SYSTEM SHALL answer 404 and no data', async () => {
    const wholeLog = await kit.get(stranger, logPath);
    const clickViaOwnGuild = await kit.get(
      stranger,
      `/api/guilds/${OTHER_GUILD}/interactions/${CLICK_ID}`,
    );
    const clickViaForeignGuild = await kit.get(stranger, `${logPath}/${CLICK_ID}`);
    const modalViaForeignGuild = await kit.get(stranger, `${logPath}/${MODAL_SUBMIT_ID}`);

    for (const res of [wholeLog, clickViaOwnGuild, clickViaForeignGuild, modalViaForeignGuild]) {
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(CLICK_ID);
      expect(res.text).not.toContain('acknowledged');
    }
    const own = InteractionLogPage.parse(
      (await kit.get(stranger, `/api/guilds/${OTHER_GUILD}/interactions`)).body,
    );
    expect(own.items).toEqual([]);
  });
});
