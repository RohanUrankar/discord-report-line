import { TestBed } from '@angular/core/testing';
import type { InteractionLogItem } from '@report-line/shared';

import { GUILD_A, GUILD_B, logItem, logPage } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import {
  LOG_LIST_CAP,
  POLL_BACKOFF_MS,
  POLL_INTERVAL_MS,
} from '../../core/constants/app.constants';
import { AppError } from '../../core/errors/app-error';
import { CommandLogStore, compareNewestFirst } from './command-log-store';

const listInteractions = vi.fn();

let hidden = false;
const setHidden = (value: boolean): void => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

const ids = (store: CommandLogStore): string[] => store.items().map((i) => i.id);
const tick = async (ms: number = POLL_INTERVAL_MS): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const netError = (): AppError => new AppError({ code: 'NETWORK', message: 'offline', status: 0 });

function rows(
  from: number,
  to: number,
  overrides: Partial<InteractionLogItem> = {},
): InteractionLogItem[] {
  // newest first, as the API returns them
  const out: InteractionLogItem[] = [];
  for (let n = to; n >= from; n--) {
    out.push(logItem(n, overrides));
  }
  return out;
}

async function openStore(page = logPage(rows(1, 3)), status?: 'dead'): Promise<CommandLogStore> {
  listInteractions.mockResolvedValueOnce(page);
  const store = TestBed.inject(CommandLogStore);
  await store.open(GUILD_A, status);
  return store;
}

describe('CommandLogStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    listInteractions.mockReset();
    TestBed.configureTestingModule({
      providers: [CommandLogStore, { provide: ApiClient, useValue: { listInteractions } }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('WHEN a server is opened THE STORE SHALL load page 1 newest first and ask for the active filter', async () => {
    const store = await openStore(logPage(rows(1, 3), 'cursor-1'), 'dead');
    expect(store.status()).toBe('loaded');
    expect(ids(store)).toEqual([logItem(3).id, logItem(2).id, logItem(1).id]);
    expect(store.hasMore()).toBe(true);
    expect(listInteractions).toHaveBeenCalledWith(GUILD_A, { limit: 50, status: 'dead' });
  });

  it('WHEN the first load fails THE STORE SHALL expose the error, not poll, and let reload try again', async () => {
    listInteractions.mockRejectedValueOnce(netError());
    const store = TestBed.inject(CommandLogStore);
    await store.open(GUILD_A, undefined);
    expect(store.status()).toBe('error');
    expect(store.error()?.code).toBe('NETWORK');
    await tick(POLL_INTERVAL_MS * 3);
    expect(listInteractions).toHaveBeenCalledTimes(1);

    listInteractions.mockResolvedValueOnce(logPage(rows(1, 2)));
    await store.reload();
    expect(store.status()).toBe('loaded');
    expect(store.items()).toHaveLength(2);
  });

  it('shows an empty list as loaded-and-empty, distinct from loading', async () => {
    const store = await openStore(logPage([]));
    expect(store.isEmpty()).toBe(true);
  });

  describe('polling and merging', () => {
    it('WHEN a poll returns new rows THE STORE SHALL add them on top and announce a count, not each row', async () => {
      const store = await openStore();
      listInteractions.mockResolvedValueOnce(logPage([...rows(4, 5), ...rows(1, 3)]));
      await tick();
      expect(ids(store)).toEqual([5, 4, 3, 2, 1].map((n) => logItem(n).id));
      expect(store.announcement()).toBe('2 new commands');
      expect(store.highlight().size).toBe(2);
    });

    it('WHEN a known row changed THE STORE SHALL update it in place without duplicating it', async () => {
      const store = await openStore(
        logPage(rows(1, 2, { job: { status: 'pending', attempts: 0, lastError: null } })),
      );
      const done = logItem(2, { job: { status: 'done', attempts: 1, lastError: null } });
      listInteractions.mockResolvedValueOnce(
        logPage([done, logItem(1, { job: { status: 'pending', attempts: 0, lastError: null } })]),
      );
      await tick();
      expect(store.items()).toHaveLength(2);
      expect(store.items().find((i) => i.id === done.id)?.job?.status).toBe('done');
      expect(store.announcement()).toBe('');
    });

    it('WHEN nothing changed THE STORE SHALL keep the same row objects (no needless re-render)', async () => {
      const store = await openStore();
      const before = store.items();
      listInteractions.mockResolvedValueOnce(logPage(rows(1, 3)));
      await tick();
      expect(store.items()).toStrictEqual(before);
      expect(store.items()[0]).toBe(before[0]);
    });

    it('dedupes: the same rows delivered twice appear once', async () => {
      const store = await openStore();
      listInteractions.mockResolvedValue(logPage([...rows(4, 4), ...rows(1, 3)]));
      await tick(POLL_INTERVAL_MS * 3);
      expect(store.items()).toHaveLength(4);
    });

    it('WHEN the reader has scrolled away THE STORE SHALL hold new rows behind a count and show them on request', async () => {
      const store = await openStore();
      store.setHold(true);
      listInteractions.mockResolvedValueOnce(logPage([...rows(4, 5), ...rows(1, 3)]));
      await tick();
      expect(store.items()).toHaveLength(3);
      expect(store.pendingCount()).toBe(2);
      expect(store.announcement()).toMatch(/^2 new commands/);

      store.showPending();
      expect(store.pendingCount()).toBe(0);
      expect(ids(store)[0]).toBe(logItem(5).id);
      expect(store.items()).toHaveLength(5);
    });

    it('still applies changes to visible rows while new rows are held', async () => {
      const store = await openStore(
        logPage(rows(1, 1, { job: { status: 'pending', attempts: 0, lastError: null } })),
      );
      store.setHold(true);
      listInteractions.mockResolvedValueOnce(
        logPage([
          logItem(2),
          logItem(1, { job: { status: 'done', attempts: 1, lastError: null } }),
        ]),
      );
      await tick();
      expect(store.pendingCount()).toBe(1);
      expect(store.items()[0]?.job?.status).toBe('done');
    });

    it('WHEN the hold is released THE STORE SHALL show what waited', async () => {
      const store = await openStore();
      store.setHold(true);
      listInteractions.mockResolvedValueOnce(logPage([...rows(4, 4), ...rows(1, 3)]));
      await tick();
      store.setHold(false);
      expect(store.pendingCount()).toBe(0);
      expect(store.items()).toHaveLength(4);
    });

    it('WHEN more rows arrive than one page holds THE STORE SHALL restart from page 1 instead of showing a gap', async () => {
      const store = await openStore(logPage(rows(1, 3), 'old-cursor'));
      listInteractions.mockResolvedValueOnce(logPage(rows(100, 150), 'new-cursor'));
      await tick();
      expect(ids(store)[0]).toBe(logItem(150).id);
      expect(store.items()).toHaveLength(51);
      expect(store.items().some((i) => i.id === logItem(1).id)).toBe(false);
      expect(store.announcement()).toMatch(/refreshed/);
    });

    it('WHEN the list passes the cap THE STORE SHALL drop the oldest rows and stop offering "older"', async () => {
      const store = await openStore(logPage(rows(1, LOG_LIST_CAP), 'c'));
      expect(store.hasMore()).toBe(true);
      listInteractions.mockResolvedValueOnce(
        logPage([
          ...rows(LOG_LIST_CAP + 1, LOG_LIST_CAP + 5),
          ...rows(LOG_LIST_CAP - 44, LOG_LIST_CAP),
        ]),
      );
      await tick();
      expect(store.items()).toHaveLength(LOG_LIST_CAP);
      expect(store.items()[0]?.id).toBe(logItem(LOG_LIST_CAP + 5).id);
      expect(store.items().at(-1)?.id).toBe(logItem(6).id);
      expect(store.capped()).toBe(true);
      expect(store.hasMore()).toBe(false);
    });
  });

  describe('older pages', () => {
    it('WHEN "Load older" is used THE STORE SHALL append the next page by cursor without duplicates', async () => {
      const store = await openStore(logPage(rows(6, 8), 'cursor-1'));
      listInteractions.mockResolvedValueOnce(logPage([...rows(5, 6)], null));
      await store.loadOlder();
      expect(listInteractions).toHaveBeenLastCalledWith(GUILD_A, { limit: 50, cursor: 'cursor-1' });
      expect(ids(store)).toEqual([8, 7, 6, 5].map((n) => logItem(n).id));
      expect(store.hasMore()).toBe(false);
    });

    it('WHEN loading older rows fails THE STORE SHALL keep the list and report it separately', async () => {
      const store = await openStore(logPage(rows(1, 3), 'cursor-1'));
      listInteractions.mockRejectedValueOnce(netError());
      await store.loadOlder();
      expect(store.items()).toHaveLength(3);
      expect(store.moreError()?.code).toBe('NETWORK');
      expect(store.status()).toBe('loaded');
      expect(store.hasMore()).toBe(true);
    });

    it('does not start a second "older" request while one is running', async () => {
      const store = await openStore(logPage(rows(1, 3), 'cursor-1'));
      let release: (page: unknown) => void = () => undefined;
      listInteractions.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const first = store.loadOlder();
      void store.loadOlder();
      expect(listInteractions).toHaveBeenCalledTimes(2); // open + one older
      release(logPage([], null));
      await first;
    });
  });

  describe('polling rules', () => {
    it('WHEN the tab is hidden THE STORE SHALL make no requests and WHEN it returns refresh at once', async () => {
      await openStore();
      setHidden(true);
      await tick(POLL_INTERVAL_MS * 4);
      expect(listInteractions).toHaveBeenCalledTimes(1);

      listInteractions.mockResolvedValue(logPage(rows(1, 3)));
      setHidden(false);
      await tick(0);
      expect(listInteractions).toHaveBeenCalledTimes(2);
    });

    it('WHEN a poll is slow THE STORE SHALL NOT overlap requests', async () => {
      await openStore();
      listInteractions.mockReturnValue(new Promise(() => undefined));
      await tick(POLL_INTERVAL_MS * 6);
      expect(listInteractions).toHaveBeenCalledTimes(2);
    });

    it('WHEN polls fail THE STORE SHALL keep the rows, mark updates as retrying and back off', async () => {
      const store = await openStore();
      listInteractions.mockRejectedValue(netError());
      await tick();
      expect(store.status()).toBe('loaded');
      expect(store.items()).toHaveLength(3);
      expect(store.pollState()).toBe('retrying');
      expect(listInteractions).toHaveBeenCalledTimes(2);
      await tick(POLL_BACKOFF_MS[0]! - 1);
      expect(listInteractions).toHaveBeenCalledTimes(2);
      await tick(1);
      expect(listInteractions).toHaveBeenCalledTimes(3);
    });

    it('WHEN a poll comes back 401 THE STORE SHALL stop polling for good', async () => {
      const store = await openStore();
      listInteractions.mockRejectedValue(
        new AppError({ code: 'UNAUTHENTICATED', message: 'x', status: 401 }),
      );
      await tick();
      expect(store.pollState()).toBe('stopped');
      await tick(POLL_INTERVAL_MS * 10);
      expect(listInteractions).toHaveBeenCalledTimes(2);
    });

    it('WHEN another server is opened THE STORE SHALL ignore a late answer for the old one', async () => {
      const store = TestBed.inject(CommandLogStore);
      let releaseA: (page: unknown) => void = () => undefined;
      listInteractions.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseA = resolve;
        }),
      );
      const opening = store.open(GUILD_A, undefined);
      listInteractions.mockResolvedValueOnce(logPage(rows(10, 11)));
      await store.open(GUILD_B, undefined);
      releaseA(logPage(rows(1, 3)));
      await opening;
      expect(ids(store)).toEqual([11, 10].map((n) => logItem(n).id));
    });

    it('stops polling when the store is closed', async () => {
      const store = await openStore();
      store.close();
      await tick(POLL_INTERVAL_MS * 5);
      expect(listInteractions).toHaveBeenCalledTimes(1);
      expect(store.items()).toHaveLength(0);
    });
  });
});

describe('compareNewestFirst', () => {
  it('orders by time, then by numeric id', () => {
    const a = logItem(1, {}, Date.parse('2026-10-12T10:00:00Z'));
    const b = logItem(2, {}, Date.parse('2026-10-12T10:00:00Z'));
    const c = logItem(3, {}, Date.parse('2026-10-12T10:00:05Z'));
    expect([a, b, c].sort(compareNewestFirst).map((i) => i.id)).toEqual([c.id, b.id, a.id]);
  });
});
