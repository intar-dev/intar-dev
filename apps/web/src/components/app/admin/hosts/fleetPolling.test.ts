import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetSnapshotPoller } from "./fleetPolling";

afterEach(() => {
  vi.useRealTimers();
});

describe("fleet snapshot polling", () => {
  it("keeps one request in flight even when several intervals elapse", async () => {
    vi.useFakeTimers();
    let visible = true;
    let onVisibilityChange!: () => void;
    const first = deferred<void>();
    const poll = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const poller = createFleetSnapshotPoller({
      poll,
      isVisible: () => visible,
      subscribeVisibility: (listener) => {
        onVisibilityChange = listener;
        return () => {
          onVisibilityChange = () => {};
        };
      },
    });

    poller.start();
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poll).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(2);

    visible = false;
    onVisibilityChange();
    poller.stop();
  });

  it("stops timers and aborts the current request while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visible = true;
    let onVisibilityChange!: () => void;
    const inFlight = deferred<void>();
    let signal!: AbortSignal;
    const poll = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return inFlight.promise;
    });
    const poller = createFleetSnapshotPoller({
      poll,
      isVisible: () => visible,
      subscribeVisibility: (listener) => {
        onVisibilityChange = listener;
        return () => {
          onVisibilityChange = () => {};
        };
      },
    });

    poller.start();
    expect(poll).toHaveBeenCalledTimes(1);
    visible = false;
    onVisibilityChange();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(poll).toHaveBeenCalledTimes(1);

    inFlight.resolve();
    await flushPromises();
    visible = true;
    onVisibilityChange();
    expect(poll).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("uses 20 recurring requests per minute for one or 100 returned hosts", async () => {
    vi.useFakeTimers();
    const oneHostResponse = [{ id: "host-1" }];
    const hundredHostResponse = Array.from(
      { length: 100 },
      (_, index) => ({ id: `host-${index}` }),
    );
    const oneHostPoll = vi.fn(async () => {
      void oneHostResponse;
    });
    const hundredHostPoll = vi.fn(async () => {
      void hundredHostResponse;
    });
    const oneHostPoller = createFleetSnapshotPoller({
      poll: oneHostPoll,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });
    const hundredHostPoller = createFleetSnapshotPoller({
      poll: hundredHostPoll,
      isVisible: () => true,
      subscribeVisibility: () => () => {},
    });

    oneHostPoller.start();
    hundredHostPoller.start();
    await flushPromises();
    expect(oneHostPoll).toHaveBeenCalledTimes(1);
    expect(hundredHostPoll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    // One immediate read plus exactly 20 three-second cadence reads.
    expect(oneHostPoll).toHaveBeenCalledTimes(21);
    expect(hundredHostPoll).toHaveBeenCalledTimes(21);

    oneHostPoller.stop();
    hundredHostPoller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(oneHostPoll).toHaveBeenCalledTimes(21);
    expect(hundredHostPoll).toHaveBeenCalledTimes(21);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
