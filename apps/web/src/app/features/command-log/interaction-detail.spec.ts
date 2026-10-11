import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { queryAll, root, settle, textOf } from '../../../testing/dom';
import { GUILD_A, attempt, detail, logItem } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { POLL_INTERVAL_MS } from '../../core/constants/app.constants';
import { AppError } from '../../core/errors/app-error';
import { InteractionDetailPage } from './interaction-detail';

const getInteraction = vi.fn();
const ID = logItem(7).id;

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(
        [
          { path: 'g/:guildId/log/:interactionId', component: InteractionDetailPage },
          { path: 'g/:guildId/log', children: [] },
          { path: 'g/:guildId/settings', children: [] },
        ],
        withComponentInputBinding(),
        withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      ),
      { provide: ApiClient, useValue: { getInteraction } },
    ],
  });
}

const open = async (): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/log/${ID}`);
  await settle(harness.fixture);
  harness.fixture.detectChanges();
  return harness;
};

const job = (
  status: 'pending' | 'processing' | 'done' | 'dead',
  attempts: number,
  lastError: string | null = null,
) => ({
  status,
  attempts,
  lastError,
});

/** For fake-timer tests: Angular's scheduler cannot use a faked setTimeout, so settle by advancing the clock. */
const openLive = async (): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/log/${ID}`);
  await vi.advanceTimersByTimeAsync(0);
  harness.fixture.detectChanges();
  return harness;
};

describe('InteractionDetailPage', () => {
  beforeEach(() => {
    getInteraction.mockReset();
    configure();
  });

  it('WHEN the details are loading THE UI SHALL show a skeleton', async () => {
    getInteraction.mockReturnValue(new Promise(() => undefined));
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('Loading command details');
  });

  it('WHEN the job is dead after the user got their reply THE UI SHALL show the explicit "reply sent, notification failed" state', async () => {
    const item = logItem(7, {
      interactionStatus: 'followed_up',
      job: job('dead', 8, 'Slack answered 404'),
      action: { type: 'report', mirrorStatus: 'failed', llmTag: null, tagState: 'off' },
    });
    getInteraction.mockResolvedValue(
      detail(item, [
        attempt({
          attemptNo: 1,
          target: 'mirror',
          outcome: 'retryable',
          httpStatus: 503,
          error: 'Slack unavailable',
        }),
        attempt({
          attemptNo: 2,
          target: 'mirror',
          outcome: 'fatal',
          httpStatus: 404,
          error: 'Webhook not found',
        }),
      ]),
    );
    const harness = await open();
    const callout = root(harness.fixture).querySelector('section.callout') as HTMLElement;
    expect(textOf(callout)).toContain('Reply sent, notification failed');
    expect(textOf(callout)).toContain(
      'The user got their reply, but the Slack notification failed after 8 attempts.',
    );
    expect(callout.querySelector('a')!.getAttribute('href')).toBe(`/g/${GUILD_A}/settings`);
  });

  it('shows each attempt: target, outcome, HTTP status, time and a plain-language reason', async () => {
    getInteraction.mockResolvedValue(
      detail(logItem(7), [
        attempt({
          attemptNo: 1,
          target: 'mirror',
          outcome: 'retryable',
          httpStatus: 503,
          error: 'Slack unavailable',
        }),
        attempt({ attemptNo: 2, target: 'mirror', outcome: 'success', httpStatus: 200 }),
        attempt({ attemptNo: 3, target: 'followup', outcome: 'success', httpStatus: 200 }),
      ]),
    );
    const harness = await open();
    const items = queryAll(harness.fixture, 'ol.timeline > li');
    expect(items).toHaveLength(3);
    expect(textOf(items[0])).toContain('Attempt 1: Slack notification');
    expect(textOf(items[0])).toContain('Failed, will retry');
    expect(textOf(items[0])).toContain('HTTP 503');
    expect(textOf(items[0])).toContain('Slack had a problem on its side (HTTP 503).');
    expect(textOf(items[0])).toContain('Detail: Slack unavailable');
    expect(textOf(items[1])).toContain('Succeeded');
    expect(textOf(items[2])).toContain('Reply in Discord');
  });

  it('renders server text as text: a <script> in an error never becomes an element', async () => {
    const evil = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">';
    getInteraction.mockResolvedValue(
      detail(logItem(7, { job: job('dead', 1, evil), interactionStatus: 'failed' }), [
        attempt({ outcome: 'fatal', httpStatus: 400, error: evil }),
      ]),
    );
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('<script>window.__pwned = 1</script>');
    expect(root(harness.fixture).querySelector('script')).toBeNull();
    expect(root(harness.fixture).querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('WHEN the command had no background work THE UI SHALL explain the empty history', async () => {
    getInteraction.mockResolvedValue(
      detail(
        logItem(7, {
          command: 'status',
          job: null,
          action: { type: 'status', mirrorStatus: 'skipped', llmTag: null, tagState: 'off' },
          interactionStatus: 'answered',
        }),
      ),
    );
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('answered this command straight away');
  });

  it('WHEN the load fails THE UI SHALL show the error with a reference and a retry that loads again', async () => {
    getInteraction.mockRejectedValueOnce(
      new AppError({
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        status: 500,
        requestId: 'ref-3',
      }),
    );
    const harness = await open();
    const alert = root(harness.fixture).querySelector('[role="alert"]') as HTMLElement;
    expect(textOf(alert)).toContain('Reference: ref-3');
    getInteraction.mockResolvedValue(detail(logItem(7)));
    (alert.querySelector('button') as HTMLButtonElement).click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();
    expect(textOf(harness.fixture)).toContain('Command details');
    expect(root(harness.fixture).querySelector('dl')).not.toBeNull();
  });

  it('WHEN the command is not in this server THE UI SHALL say so without offering a pointless retry', async () => {
    getInteraction.mockRejectedValue(
      new AppError({ code: 'NOT_FOUND', message: "We couldn't find that.", status: 404 }),
    );
    const harness = await open();
    const alert = root(harness.fixture).querySelector('[role="alert"]') as HTMLElement;
    expect(textOf(alert)).toContain("We couldn't find that command in this server.");
    expect(alert.querySelector('button')).toBeNull();
  });

  describe('while the job is still running', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const running = detail(logItem(7, { interactionStatus: 'deferred', job: job('pending', 1) }), [
      attempt({ attemptNo: 1, outcome: 'retryable', httpStatus: 503 }),
    ]);

    it('refreshes by itself and stops once the job is finished', async () => {
      getInteraction.mockResolvedValueOnce(running);
      const harness = await openLive();
      getInteraction.mockResolvedValueOnce(
        detail(logItem(7), [attempt({ attemptNo: 1, outcome: 'success' })]),
      );
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      harness.fixture.detectChanges();
      expect(textOf(harness.fixture)).toContain('Replied');
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(getInteraction).toHaveBeenCalledTimes(2);
    });

    it('WHEN a refresh fails THE UI SHALL keep the details on screen and say it could not refresh', async () => {
      getInteraction.mockResolvedValueOnce(running);
      const harness = await openLive();
      getInteraction.mockRejectedValue(
        new AppError({ code: 'NETWORK', message: 'offline', status: 0 }),
      );
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      harness.fixture.detectChanges();
      expect(textOf(harness.fixture)).toContain("We couldn't refresh these details");
      expect(queryAll(harness.fixture, 'ol.timeline > li')).toHaveLength(1);

      getInteraction.mockResolvedValue(detail(logItem(7), [attempt({ attemptNo: 1 })]));
      const retry = queryAll<HTMLButtonElement>(harness.fixture, '[role="status"] button')[0]!;
      retry.click();
      await vi.advanceTimersByTimeAsync(0);
      harness.fixture.detectChanges();
      expect(textOf(harness.fixture)).not.toContain("We couldn't refresh these details");
    });
  });
});
