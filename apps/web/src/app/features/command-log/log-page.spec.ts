import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { queryAll, root, settle, textOf } from '../../../testing/dom';
import { GUILD_A, logItem, logPage } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { POLL_INTERVAL_MS } from '../../core/constants/app.constants';
import { AppError } from '../../core/errors/app-error';
import { LogPage } from './log-page';

const listInteractions = vi.fn();

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(
        [
          { path: 'g/:guildId/log', component: LogPage },
          { path: 'g/:guildId/log/:id', children: [] },
        ],
        withComponentInputBinding(),
        withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      ),
      { provide: ApiClient, useValue: { listInteractions } },
    ],
  });
}

const open = async (query = ''): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/log${query}`);
  await settle(harness.fixture);
  harness.fixture.detectChanges();
  return harness;
};

const job = (status: 'pending' | 'processing' | 'done' | 'dead', attempts: number) => ({
  status,
  attempts,
  lastError: null,
});

/** For fake-timer tests: Angular's scheduler cannot use a faked setTimeout, so settle by advancing the clock. */
const openLive = async (): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/log`);
  await vi.advanceTimersByTimeAsync(0);
  harness.fixture.detectChanges();
  return harness;
};

const withTag = (
  n: number,
  llmTag: string | null,
  tagState: 'tagged' | 'untagged' | 'pending' | 'off',
  type: 'report' | 'status' = 'report',
) => {
  const item = logItem(n, {
    command: type,
    action: { type, mirrorStatus: 'sent', llmTag: null, tagState },
  });
  // Set after parsing so a value the schema would refuse (hostile-looking text) still reaches the view.
  return { ...item, action: { ...item.action!, llmTag } } as typeof item;
};

describe('LogPage: AI tag column', () => {
  beforeEach(() => {
    listInteractions.mockReset();
    configure();
  });

  it('WHEN each tag state occurs THE UI SHALL word it differently, with an icon, not colour alone', async () => {
    listInteractions.mockResolvedValue(
      logPage([
        withTag(4, 'bug', 'tagged'),
        withTag(3, 'untagged', 'untagged'),
        withTag(2, null, 'pending'),
        withTag(1, null, 'off'),
      ]),
    );
    const harness = await open();
    const cells = queryAll(harness.fixture, 'mat-cell[data-label="AI tag"]');
    expect(cells.map((c) => textOf(c))).toEqual([
      'Tag: bug',
      'Not tagged: the AI could not tag this',
      'Tag pending',
      'AI tagging is off',
    ]);
    for (const cell of cells) {
      expect(cell.querySelector('svg')).not.toBeNull();
    }
  });

  it('WHEN the command is not a report and tagging is off THE UI SHALL show no tag state', async () => {
    listInteractions.mockResolvedValue(logPage([withTag(1, null, 'off', 'status')]));
    const harness = await open();
    const cell = queryAll(harness.fixture, 'mat-cell[data-label="AI tag"]')[0]!;
    expect(textOf(cell)).toBe('—None');
  });

  it('WHEN a tag looks like HTML THE UI SHALL render it as text', async () => {
    const evil = '<img src=x onerror="window.__pwned = 1"><script>window.__pwned = 1</script>';
    listInteractions.mockResolvedValue({ items: [withTag(1, evil, 'tagged')], nextCursor: null });
    const harness = await open();
    expect(textOf(harness.fixture)).toContain(`Tag: ${evil}`);
    expect(root(harness.fixture).querySelector('img')).toBeNull();
    expect(root(harness.fixture).querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('LogPage', () => {
  beforeEach(() => {
    listInteractions.mockReset();
    configure();
  });

  it('WHEN the log is loading THE UI SHALL show a skeleton announced as loading', async () => {
    listInteractions.mockReturnValue(new Promise(() => undefined));
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('Loading commands');
    expect(root(harness.fixture).querySelector('[role="status"] .sr-only')).not.toBeNull();
    expect(root(harness.fixture).querySelector('[role="table"]')).toBeNull();
  });

  it('WHEN there are no commands yet THE UI SHALL say why and what to do next', async () => {
    listInteractions.mockResolvedValue(logPage([]));
    const harness = await open();
    const text = textOf(harness.fixture);
    expect(text).toContain('No commands yet');
    expect(text).toContain('Run /status in your Discord server');
    expect(text).toContain('Copy /status');
  });

  it('WHEN nothing needs attention THE UI SHALL say so and offer the full list', async () => {
    listInteractions.mockResolvedValue(logPage([]));
    const harness = await open('?filter=attention');
    expect(listInteractions).toHaveBeenCalledWith(GUILD_A, { limit: 50, status: 'dead' });
    expect(textOf(harness.fixture)).toContain('Nothing needs attention');
  });

  it('WHEN the log cannot be loaded THE UI SHALL show the error and a retry that reloads it', async () => {
    listInteractions.mockRejectedValueOnce(
      new AppError({
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        status: 500,
        requestId: 'ref-9',
      }),
    );
    const harness = await open();
    const alert = root(harness.fixture).querySelector('[role="alert"]') as HTMLElement;
    expect(textOf(alert)).toContain('Something went wrong on our side');
    expect(textOf(alert)).toContain('Reference: ref-9');

    listInteractions.mockResolvedValue(logPage([logItem(1)]));
    (alert.querySelector('button') as HTMLButtonElement).click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();
    expect(root(harness.fixture).querySelector('[role="table"]')).not.toBeNull();
  });

  it('renders a real table: column headers, one row per command, a details link in each row', async () => {
    listInteractions.mockResolvedValue(logPage([logItem(2), logItem(1)]));
    const harness = await open();
    const headers = queryAll(harness.fixture, '[role="columnheader"]').map((h) => textOf(h));
    expect(headers).toEqual([
      'Time',
      'Command',
      'User',
      'Status',
      'Notification',
      'AI tag',
      'Attempts',
    ]);
    const rows = queryAll(harness.fixture, 'mat-row');
    expect(rows).toHaveLength(2);
    const link = rows[0]!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`/g/${GUILD_A}/log/${logItem(2).id}`);
    expect(textOf(link)).toContain('details of /report');
  });

  it('WHEN a command needs attention THE UI SHALL flag it with an icon and words, not colour alone', async () => {
    listInteractions.mockResolvedValue(
      logPage([
        logItem(3, {
          interactionStatus: 'followed_up',
          job: job('dead', 8),
          action: { type: 'report', mirrorStatus: 'failed', llmTag: null, tagState: 'off' },
        }),
        logItem(2, { interactionStatus: 'failed', job: null, action: null }),
        logItem(1),
      ]),
    );
    const harness = await open();
    const rows = queryAll(harness.fixture, 'mat-row');
    expect(textOf(rows[0])).toContain('Reply sent, notification failed');
    expect(textOf(rows[0])).toContain('Failed');
    expect(rows[0]!.classList.contains('attention')).toBe(true);
    expect(rows[0]!.querySelector('app-status-badge svg')).not.toBeNull();
    expect(rows[1]!.classList.contains('attention')).toBe(true);
    expect(rows[2]!.classList.contains('attention')).toBe(false);
  });

  it('WHEN the filter is changed THE UI SHALL put it in the URL and ask the server for dead jobs', async () => {
    listInteractions.mockResolvedValue(logPage([logItem(1)]));
    const harness = await open();
    const toggles = queryAll<HTMLButtonElement>(harness.fixture, 'mat-button-toggle button');
    toggles.find((b) => textOf(b).includes('Needs attention'))!.click();
    await settle(harness.fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toContain('filter=attention');
      expect(listInteractions).toHaveBeenLastCalledWith(GUILD_A, { limit: 50, status: 'dead' });
    });
  });

  it('WHEN there are older pages THE UI SHALL offer "Load older commands" and use the cursor', async () => {
    listInteractions.mockResolvedValueOnce(logPage([logItem(3)], 'cur-1'));
    const harness = await open();
    const button = queryAll<HTMLButtonElement>(harness.fixture, 'button').find((b) =>
      textOf(b).includes('Load older'),
    )!;
    listInteractions.mockResolvedValueOnce(logPage([logItem(2)], null));
    button.click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();
    expect(listInteractions).toHaveBeenLastCalledWith(GUILD_A, { limit: 50, cursor: 'cur-1' });
    expect(queryAll(harness.fixture, 'mat-row')).toHaveLength(2);
    expect(textOf(harness.fixture)).not.toContain('Load older commands');
  });

  describe('live updates', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('WHEN a new command arrives and the reader is idle at the top THE UI SHALL add it and announce a count', async () => {
      listInteractions.mockResolvedValueOnce(logPage([logItem(1)]));
      const harness = await openLive();
      listInteractions.mockResolvedValueOnce(logPage([logItem(2), logItem(1)]));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      harness.fixture.detectChanges();
      expect(queryAll(harness.fixture, 'mat-row')).toHaveLength(2);
      const live = root(harness.fixture).querySelector('[aria-live="polite"]') as HTMLElement;
      expect(textOf(live)).toBe('1 new command');
    });

    it('WHEN the reader is working in the table THE UI SHALL hold new rows behind a button and not move the list', async () => {
      listInteractions.mockResolvedValueOnce(logPage([logItem(1)]));
      const harness = await openLive();
      const link = root(harness.fixture).querySelector('mat-row a') as HTMLAnchorElement;
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      listInteractions.mockResolvedValueOnce(logPage([logItem(3), logItem(2), logItem(1)]));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      harness.fixture.detectChanges();
      expect(queryAll(harness.fixture, 'mat-row')).toHaveLength(1);
      const pill = queryAll<HTMLButtonElement>(harness.fixture, 'button').find((b) =>
        textOf(b).startsWith('Show 2 new commands'),
      )!;
      expect(pill).toBeDefined();

      pill.click();
      harness.fixture.detectChanges();
      expect(queryAll(harness.fixture, 'mat-row')).toHaveLength(3);
    });

    it('WHEN polling fails THE UI SHALL keep the rows and say updates are paused, quietly', async () => {
      listInteractions.mockResolvedValueOnce(logPage([logItem(1)]));
      const harness = await openLive();
      listInteractions.mockRejectedValue(
        new AppError({ code: 'NETWORK', message: 'offline', status: 0 }),
      );
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      harness.fixture.detectChanges();
      expect(queryAll(harness.fixture, 'mat-row')).toHaveLength(1);
      expect(textOf(harness.fixture)).toContain('Live updates paused');
      expect(root(harness.fixture).querySelector('[role="alert"]')).toBeNull();
    });
  });
});
