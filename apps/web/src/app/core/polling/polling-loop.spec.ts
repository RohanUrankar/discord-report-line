import { AppError } from '../errors/app-error';
import { PollingLoop } from './polling-loop';

const INTERVAL = 5000;
const BACKOFF = [10_000, 30_000];

let hidden = false;
const setHidden = (value: boolean): void => {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

function makeLoop(tick: () => Promise<void>): PollingLoop {
  return new PollingLoop({ tick, intervalMs: INTERVAL, backoffMs: BACKOFF, doc: document });
}

const failure = (code: AppError['code'] = 'NETWORK'): AppError =>
  new AppError({ code, message: 'x', status: code === 'UNAUTHENTICATED' ? 401 : 0 });

describe('PollingLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ticks every interval while the tab is visible', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const loop = makeLoop(tick);
    loop.start();
    expect(loop.state()).toBe('running');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(tick).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it('WHEN the tab is hidden THE LOOP SHALL make no requests, and WHEN it is visible again refresh at once', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const loop = makeLoop(tick);
    loop.start();
    setHidden(true);
    expect(loop.state()).toBe('paused');
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    expect(tick).not.toHaveBeenCalled();

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.state()).toBe('running');
    loop.stop();
  });

  it('WHEN a tick is still running THE LOOP SHALL NOT start another (no overlap)', async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const loop = makeLoop(tick);
    loop.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    void loop.refreshNow();
    setHidden(true);
    setHidden(false);
    expect(tick).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    loop.stop();
  });

  it('WHEN ticks fail THE LOOP SHALL back off 10s then 30s, and return to 5s after a success', async () => {
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure())
      .mockResolvedValue(undefined);
    const loop = makeLoop(tick);
    loop.start();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(loop.state()).toBe('retrying');

    await vi.advanceTimersByTimeAsync(BACKOFF[0]! - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(BACKOFF[1]! - 1);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(BACKOFF[1]!);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(loop.state()).toBe('running');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(tick).toHaveBeenCalledTimes(5);
    loop.stop();
  });

  it('WHEN a tick comes back 401 THE LOOP SHALL stop for good', async () => {
    const tick = vi.fn().mockRejectedValue(failure('UNAUTHENTICATED'));
    const loop = makeLoop(tick);
    loop.start();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(loop.state()).toBe('stopped');
    await vi.advanceTimersByTimeAsync(INTERVAL * 20);
    expect(tick).toHaveBeenCalledTimes(1);
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stop() ends the schedule and detaches from visibility changes', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const loop = makeLoop(tick);
    loop.start();
    loop.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).not.toHaveBeenCalled();
    expect(loop.state()).toBe('stopped');
  });
});
