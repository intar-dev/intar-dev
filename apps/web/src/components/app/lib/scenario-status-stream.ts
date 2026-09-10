export type ScenarioRunStatusStreamMessage =
  | { type: "subscribed"; runId: string }
  | { type: "invalidate"; runId: string; revision: number };

export interface ScenarioStatusPollResultLike {
  status: { updatedAt: number } | null;
  version: string;
}

export function scenarioStatusRevision(
  result: ScenarioStatusPollResultLike | undefined,
): number | null {
  if (!result) return null;
  const version = Number(result.version);
  return Number.isFinite(version) ? version : (result.status?.updatedAt ?? null);
}

/** Keeps an in-flight older poll from replacing a newer stream refresh. */
export function preferNewerScenarioStatusResult<T extends ScenarioStatusPollResultLike>(
  current: T | undefined,
  next: T,
): T {
  const currentRevision = scenarioStatusRevision(current);
  const nextRevision = scenarioStatusRevision(next);
  return currentRevision !== null &&
    nextRevision !== null &&
    currentRevision > nextRevision
    ? current!
    : next;
}

/**
 * Shares the actual HTTP request between polling and stream hints. A forced
 * request waits for any active poll, then starts (or joins) one fresh request.
 */
export function createScenarioStatusTransport<T>(fetchStatus: () => Promise<T>) {
  let inFlight: Promise<T> | null = null;

  const start = () => {
    const request = fetchStatus();
    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) inFlight = null;
      },
      () => {
        if (inFlight === request) inFlight = null;
      },
    );
    return request;
  };

  const request = (fresh = false): Promise<T> => {
    const active = inFlight;
    if (!active) return start();
    return active.then(
      (value) => {
        if (!fresh) return value;
        return inFlight && inFlight !== active ? inFlight : start();
      },
      (error: unknown) => {
        if (!fresh) throw error;
        return inFlight && inFlight !== active ? inFlight : start();
      },
    );
  };

  return { request };
}

/** Parses only messages that belong to the current run. */
export function parseScenarioRunStatusStreamMessage(
  raw: string,
  runId: string,
): ScenarioRunStatusStreamMessage | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.runId !== runId) return null;
    if (value.type === "subscribed") {
      return { type: "subscribed", runId };
    }
    if (
      value.type === "invalidate" &&
      typeof value.revision === "number" &&
      Number.isFinite(value.revision)
    ) {
      return { type: "invalidate", runId, revision: value.revision };
    }
  } catch {
    // Ignore malformed messages. Polling remains the fallback.
  }
  return null;
}

/**
 * One WebSocket can send several invalidations while a conditional status GET
 * is in flight. Keep one follow-up GET for the newest revision.
 */
export function createScenarioStatusRefreshQueue(input: {
  currentRevision: () => number;
  refresh: (targetRevision: number | null) => Promise<number | null>;
}) {
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let forceQueued = false;
  let queuedRevision: number | null = null;

  const drain = async (initialTarget: number | null, initialForce: boolean) => {
    let targetRevision = initialTarget;
    let force = initialForce;
    let retriedTarget: number | null = null;
    while (!disposed && (force || targetRevision !== null)) {
      forceQueued = false;
      queuedRevision = null;
      let receivedRevision: number | null = null;
      try {
        receivedRevision = await input.refresh(targetRevision);
      } catch {
        // The normal status poll reports the error and remains the fallback.
      }
      if (
        targetRevision !== null &&
        receivedRevision !== null &&
        receivedRevision < targetRevision &&
        retriedTarget !== targetRevision
      ) {
        // The notification follows a committed write. One fresh follow-up
        // covers a status request that raced that write without spinning if
        // the normal poll is unavailable.
        queuedRevision = Math.max(queuedRevision ?? targetRevision, targetRevision);
        retriedTarget = targetRevision;
      }
      force = forceQueued;
      targetRevision = queuedRevision;
      if (targetRevision !== null && targetRevision <= input.currentRevision()) {
        targetRevision = null;
      }
    }
  };

  const request = (revision?: number) => {
    if (
      disposed ||
      (revision !== undefined && revision <= input.currentRevision())
    ) {
      return Promise.resolve();
    }
    if (inFlight) {
      if (revision === undefined) {
        forceQueued = true;
      } else {
        queuedRevision = Math.max(queuedRevision ?? revision, revision);
      }
      return inFlight;
    }
    inFlight = drain(revision ?? null, revision === undefined).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    request,
    dispose() {
      disposed = true;
      forceQueued = false;
      queuedRevision = null;
    },
  };
}
