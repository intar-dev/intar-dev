import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  createScenarioStatusRefreshQueue,
  createScenarioStatusTransport,
  parseScenarioRunStatusStreamMessage,
  preferNewerScenarioStatusResult,
  type ScenarioStatusPollResultLike,
} from "./scenario-status-stream";

describe("scenario status stream messages", () => {
  it("accepts only current-run protocol messages", () => {
    expect(
      parseScenarioRunStatusStreamMessage(
        JSON.stringify({ type: "subscribed", runId: "run-1" }),
        "run-1",
      ),
    ).toEqual({ type: "subscribed", runId: "run-1" });
    expect(
      parseScenarioRunStatusStreamMessage(
        JSON.stringify({ type: "invalidate", runId: "run-1", revision: 12 }),
        "run-1",
      ),
    ).toEqual({ type: "invalidate", runId: "run-1", revision: 12 });
    expect(
      parseScenarioRunStatusStreamMessage(
        JSON.stringify({ type: "invalidate", runId: "other", revision: 12 }),
        "run-1",
      ),
    ).toBeNull();
  });
});

describe("scenario status refresh queue", () => {
  it("ignores duplicate and older invalidations after status is current", async () => {
    let revision = 12;
    const refresh = vi.fn(async () => revision);
    const queue = createScenarioStatusRefreshQueue({
      currentRevision: () => revision,
      refresh,
    });

    await queue.request(12);
    await queue.request(11);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps the newest invalidation while one refresh is running", async () => {
    let revision = 0;
    const first = deferred<number | null>();
    const targets: Array<number | null> = [];
    const queue = createScenarioStatusRefreshQueue({
      currentRevision: () => revision,
      refresh: async (target) => {
        targets.push(target);
        const received =
          targets.length === 1 ? await first.promise : (target ?? revision);
        revision = Math.max(revision, received ?? 0);
        return received;
      },
    });

    const completed = queue.request(5);
    void queue.request(7);
    first.resolve(5);
    await completed;

    expect(targets).toEqual([5, 7]);
  });

  it("checks a stale invalidation response once more", async () => {
    let revision = 0;
    const targets: Array<number | null> = [];
    const queue = createScenarioStatusRefreshQueue({
      currentRevision: () => revision,
      refresh: async (target) => {
        targets.push(target);
        const received = targets.length === 1 ? 4 : 5;
        revision = received;
        return received;
      },
    });

    await queue.request(5);

    expect(targets).toEqual([5, 5]);
  });
});

describe("scenario status transport", () => {
  it("waits for a poll before it starts the fresh subscription request", async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    let active = 0;
    let maxActive = 0;
    const fetchStatus = vi.fn(async () => {
      const next = deferred<string>();
      pending.push(next);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return next.promise.finally(() => {
        active -= 1;
      });
    });
    const transport = createScenarioStatusTransport(fetchStatus);

    const poll = transport.request();
    const subscribed = transport.request(true);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    pending[0]!.resolve("poll");
    await poll;
    await flush();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    pending[1]!.resolve("fresh");
    await expect(subscribed).resolves.toBe("fresh");
  });

  it("keeps a newer stream result when a QueryClient poll started first", async () => {
    const queryClient = new QueryClient();
    const key = ["scenarios", "run", "run-1", "status"] as const;
    const pending = deferred<ScenarioStatusPollResultLike>();
    let calls = 0;
    const transport = createScenarioStatusTransport(() => {
      calls += 1;
      return calls === 1 ? pending.promise : Promise.resolve(status(101));
    });
    queryClient.setQueryData(key, status(99));

    const poll = queryClient.fetchQuery({
      queryKey: key,
      queryFn: async () =>
        preferNewerScenarioStatusResult(
          queryClient.getQueryData<ScenarioStatusPollResultLike>(key),
          await transport.request(),
        ),
      staleTime: 0,
    });
    const stream = transport.request(true).then((next) => {
      queryClient.setQueryData<ScenarioStatusPollResultLike>(key, (current) =>
        preferNewerScenarioStatusResult(current, next),
      );
    });

    pending.resolve(status(100));
    await poll;
    await stream;

    queryClient.setQueryData<ScenarioStatusPollResultLike>(key, (current) =>
      preferNewerScenarioStatusResult(current, status(100)),
    );

    expect(queryClient.getQueryData(key)).toEqual(status(101));
    expect(calls).toBe(2);
    queryClient.clear();
  });

  it("keeps a pending old-run refresh out of the next run transport and cache", async () => {
    const queryClient = new QueryClient();
    const oldKey = ["scenarios", "run", "run-old", "status"] as const;
    const newKey = ["scenarios", "run", "run-new", "status"] as const;
    const oldPending = deferred<ScenarioStatusPollResultLike>();
    const oldFetch = vi.fn(() => oldPending.promise);
    const newFetch = vi.fn(() => Promise.resolve(status(20)));
    const oldRevision = { current: 0 };
    const newRevision = { current: 0 };
    const oldTransport = createScenarioStatusTransport(oldFetch);
    const newTransport = createScenarioStatusTransport(newFetch);
    const update = (
      key: readonly unknown[],
      revision: { current: number },
      transport: ReturnType<typeof createScenarioStatusTransport<ScenarioStatusPollResultLike>>,
    ) =>
      createScenarioStatusRefreshQueue({
        currentRevision: () => revision.current,
        refresh: async () => {
          const result = await transport.request(true);
          const received = Number(result.version);
          revision.current = Math.max(revision.current, received);
          queryClient.setQueryData<ScenarioStatusPollResultLike>(key, (current) =>
            preferNewerScenarioStatusResult(current, result),
          );
          return received;
        },
      });
    const oldQueue = update(oldKey, oldRevision, oldTransport);

    const oldRefresh = oldQueue.request(10);
    oldQueue.dispose();
    const newQueue = update(newKey, newRevision, newTransport);
    await newQueue.request(20);

    oldPending.resolve(status(10));
    await oldRefresh;

    expect(oldFetch).toHaveBeenCalledTimes(1);
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(oldKey)).toEqual(status(10));
    expect(queryClient.getQueryData(newKey)).toEqual(status(20));
    queryClient.clear();
  });
});

function status(version: number): ScenarioStatusPollResultLike {
  return { version: String(version), status: { updatedAt: version } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
