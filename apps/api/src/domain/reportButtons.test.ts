import { describe, expect, it } from 'vitest';

import { parseReportButton, reportButtons } from './reportButtons.js';

const REPORT_ID = '1300000000000000001';

describe('buttons', () => {
  it('puts Acknowledge and Escalate buttons (type 2) inside one action row (type 1)', () => {
    expect(reportButtons(REPORT_ID)).toEqual({
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `rpt:ack:${REPORT_ID}`, label: 'Acknowledge' },
        { type: 2, style: 1, custom_id: `rpt:esc:${REPORT_ID}`, label: 'Escalate' },
      ],
    });
  });

  it('keeps custom_id within Discord’s 100-character limit', () => {
    for (const button of reportButtons('9'.repeat(20)).components) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
  });

  it('round-trips a custom_id it built', () => {
    expect(parseReportButton(`rpt:ack:${REPORT_ID}`)).toEqual({
      action: 'acknowledge',
      reportId: REPORT_ID,
    });
    expect(parseReportButton(`rpt:esc:${REPORT_ID}`)).toEqual({
      action: 'escalate',
      reportId: REPORT_ID,
    });
  });

  it.each([
    ['unknown action', `rpt:del:${REPORT_ID}`],
    ['missing id', 'rpt:ack:'],
    ['non-snowflake id', 'rpt:ack:../../admin'],
    ['trailing junk', `rpt:ack:${REPORT_ID}:x`],
    ['other prefix', `report_modal`],
    ['empty', ''],
  ])('rejects a forged custom_id: %s', (_case, customId) => {
    expect(parseReportButton(customId)).toBeUndefined();
  });
});
