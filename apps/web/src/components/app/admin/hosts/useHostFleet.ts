import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFleetSnapshotPoller,
  FLEET_SNAPSHOT_POLL_INTERVAL_MS,
} from "./fleetPolling";
import type { HostRecord } from "./types";

interface FleetSnapshotResponse {
  hostRecords: HostRecord[];
  liveLoadedCount: number;
  liveTotalCount: number;
  hasMoreLive: boolean;
}

interface SnapshotRequest {
  controller: AbortController;
  promise: Promise<FleetSnapshotResponse>;
}

const FLEET_SNAPSHOT_PATH =
  "/api/admin/fleet-snapshot?includeArchiveSummaries=0";
const EMPTY_HOST_RECORDS: HostRecord[] = [];

// Shared host/live-run state for the admin Overview and Hosts pages. Retained
// run history has its own non-polling global admin API.
export function useHostFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshotResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(true);
  const mountedRef = useRef(false);
  const snapshotEpochRef = useRef(0);
  const snapshotRequestRef = useRef<SnapshotRequest | null>(null);

  const loadSnapshot = useCallback(
    (parentSignal?: AbortSignal): Promise<FleetSnapshotResponse> => {
      const existing = snapshotRequestRef.current;
      if (existing) return existing.promise;

      const controller = new AbortController();
      const detachAbort = forwardAbort(parentSignal, controller);
      const requestEpoch = snapshotEpochRef.current;
      let promise!: Promise<FleetSnapshotResponse>;
      promise = (async () => {
        try {
          const response = await fetch(FLEET_SNAPSHOT_PATH, {
            method: "GET",
            credentials: "include",
            signal: controller.signal,
          });
          if (!response.ok) {
            throw await responseError(response, "Failed to load host fleet");
          }
          const next = (await response.json()) as FleetSnapshotResponse;
          if (
            !controller.signal.aborted &&
            mountedRef.current &&
            requestEpoch === snapshotEpochRef.current
          ) {
            setSnapshot(next);
            setError(null);
            setIsPending(false);
          }
          return next;
        } catch (cause) {
          const nextError = asError(cause, "Failed to load host fleet");
          if (
            !controller.signal.aborted &&
            nextError.name !== "AbortError" &&
            mountedRef.current &&
            requestEpoch === snapshotEpochRef.current
          ) {
            setError(nextError);
            setIsPending(false);
          }
          throw nextError;
        } finally {
          detachAbort();
          if (snapshotRequestRef.current?.promise === promise) {
            snapshotRequestRef.current = null;
          }
        }
      })();
      snapshotRequestRef.current = { controller, promise };
      return promise;
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const poller = createFleetSnapshotPoller({
      intervalMs: FLEET_SNAPSHOT_POLL_INTERVAL_MS,
      poll: async (signal) => {
        await loadSnapshot(signal);
      },
      isVisible: () =>
        typeof document === "undefined" || document.visibilityState !== "hidden",
      subscribeVisibility: (listener) => {
        if (typeof document === "undefined") return () => {};
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    });
    poller.start();

    return () => {
      mountedRef.current = false;
      poller.stop();
      snapshotRequestRef.current?.controller.abort();
    };
  }, [loadSnapshot]);

  const loadFreshSnapshot = useCallback(async () => {
    const prior = snapshotRequestRef.current?.promise;
    if (prior) {
      try {
        await prior;
      } catch {
        // A failed stale read must not stop the required fresh read.
      }
    }
    return loadSnapshot();
  }, [loadSnapshot]);

  const refetch = useCallback(
    () => loadFreshSnapshot(),
    [loadFreshSnapshot],
  );

  const refreshHost = useCallback(
    async (hostId: string) => {
      const next = await loadFreshSnapshot();
      if (!next.hostRecords.some((record) => record.host.id === hostId)) {
        throw new Error("host not found");
      }
    },
    [loadFreshSnapshot],
  );

  const forgetHost = useCallback((hostId: string) => {
    snapshotEpochRef.current += 1;
    setSnapshot((current) =>
      current
        ? {
            ...current,
            hostRecords: current.hostRecords.filter(
              (record) => record.host.id !== hostId,
            ),
          }
        : current,
    );
  }, []);

  const hostRecords = snapshot?.hostRecords ?? EMPTY_HOST_RECORDS;
  const hosts = useMemo(
    () => ({
      data: hostRecords.map((record) => record.host),
      error,
      isPending,
      refetch,
    }),
    [error, hostRecords, isPending, refetch],
  );

  return {
    hosts,
    hostRecords,
    liveLoadedCount: snapshot?.liveLoadedCount ?? 0,
    liveTotalCount: snapshot?.liveTotalCount ?? 0,
    hasMoreLive: snapshot?.hasMoreLive ?? false,
    refreshHost,
    forgetHost,
  };
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(body?.error ?? `${fallback} (${response.status})`);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) {
    abort();
    return () => {};
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
