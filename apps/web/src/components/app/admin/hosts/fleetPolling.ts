export const FLEET_SNAPSHOT_POLL_INTERVAL_MS = 3_000;

export interface FleetSnapshotPollerOptions {
  poll: (signal: AbortSignal) => Promise<void>;
  isVisible: () => boolean;
  subscribeVisibility: (listener: () => void) => () => void;
  intervalMs?: number;
}

export interface FleetSnapshotPoller {
  start: () => void;
  stop: () => void;
  pollNow: () => Promise<void>;
}

/**
 * Small, framework-neutral polling coordinator for the admin fleet snapshot.
 * It owns one request at a time, never polls a hidden tab, and aborts the
 * active request when the page is hidden or the route unmounts.
 */
export function createFleetSnapshotPoller(
  options: FleetSnapshotPollerOptions,
): FleetSnapshotPoller {
  const intervalMs = options.intervalMs ?? FLEET_SNAPSHOT_POLL_INTERVAL_MS;
  let stopped = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let controller: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  let retryWhenCurrentRequestSettles = false;

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const swallowPollError = () => {
    void pollNow().catch(() => {
      // The hook owns displayable request errors. Timers must not create an
      // unhandled rejection when a temporary network error occurs.
    });
  };

  const startTimer = () => {
    if (stopped || !options.isVisible() || timer !== null) return;
    timer = setInterval(swallowPollError, intervalMs);
  };

  const pollNow = (): Promise<void> => {
    if (stopped || !options.isVisible()) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }

    const nextController = new AbortController();
    controller = nextController;
    let request: Promise<void>;
    try {
      request = Promise.resolve(options.poll(nextController.signal));
    } catch (error) {
      request = Promise.reject(error);
    }
    let pending!: Promise<void>;
    pending = request.finally(() => {
      if (controller === nextController) {
        controller = null;
      }
      if (inFlight === pending) {
        inFlight = null;
      }

      if (
        retryWhenCurrentRequestSettles &&
        !stopped &&
        options.isVisible()
      ) {
        retryWhenCurrentRequestSettles = false;
        swallowPollError();
      }
    });
    inFlight = pending;
    return pending;
  };

  const handleVisibilityChange = () => {
    if (!options.isVisible()) {
      retryWhenCurrentRequestSettles = false;
      stopTimer();
      controller?.abort();
      return;
    }

    startTimer();
    if (inFlight) {
      // A request aborted by a just-hidden tab may not settle before focus
      // returns. Ask for one fresh snapshot immediately after it settles.
      retryWhenCurrentRequestSettles = true;
      return;
    }
    swallowPollError();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = options.subscribeVisibility(handleVisibilityChange);
      if (options.isVisible()) {
        startTimer();
        swallowPollError();
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      retryWhenCurrentRequestSettles = false;
      stopTimer();
      unsubscribe?.();
      unsubscribe = null;
      controller?.abort();
    },
    pollNow,
  };
}
