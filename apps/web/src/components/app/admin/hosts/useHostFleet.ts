import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createFleetSnapshotPoller,
  FLEET_SNAPSHOT_POLL_INTERVAL_MS,
} from "./fleetPolling";
import type {
  AgentVmRun,
  AgentVmRunRecord,
  HostRecord,
} from "./types";

interface FleetSnapshotResponse {
  hostRecords: HostRecord[];
  liveLoadedCount: number;
  liveTotalCount: number;
  archiveTotalCount: number;
  archiveOffset: number;
  archiveNextOffset: number | null;
  hasMoreArchives: boolean;
  hasMoreLive: boolean;
}

interface SnapshotRequest {
  controller: AbortController;
  promise: Promise<FleetSnapshotResponse>;
  epoch: number;
}

interface DetailRequest {
  controller: AbortController;
  promise: Promise<AgentVmRunRecord>;
}

interface ArchivePageRequest {
  controller: AbortController;
  promise: Promise<void>;
}

const FLEET_SNAPSHOT_PATH = "/api/admin/fleet-snapshot";

// Shared host-fleet state for the admin Overview and Hosts page. Polling is
// intentionally one bounded fleet request instead of a request fan-out per
// host, VM list, and run archive.
export function useHostFleet() {
  const [snapshot, setSnapshot] = useState<FleetSnapshotResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(true);
  const [olderArchiveRunsByHost, setOlderArchiveRunsByHost] = useState<
    Record<string, AgentVmRun[]>
  >({});
  const [archiveNextOffset, setArchiveNextOffset] = useState<number | null>(
    null,
  );
  const [isLoadingMoreArchives, setIsLoadingMoreArchives] = useState(false);
  const [loadMoreArchivesError, setLoadMoreArchivesError] = useState<
    Error | null
  >(null);
  const [archivedRunDetailsById, setArchivedRunDetailsById] = useState<
    Record<string, AgentVmRunRecord>
  >({});
  const mountedRef = useRef(false);
  const snapshotEpochRef = useRef(0);
  const snapshotRequestRef = useRef<SnapshotRequest | null>(null);
  const detailRequestsRef = useRef<Map<string, DetailRequest>>(new Map());
  const archivePageRequestRef = useRef<ArchivePageRequest | null>(null);
  const archiveNextOffsetRef = useRef<number | null>(null);
  const hasLoadedOlderArchivesRef = useRef(false);

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
            if (!hasLoadedOlderArchivesRef.current) {
              archiveNextOffsetRef.current = next.archiveNextOffset;
              setArchiveNextOffset(next.archiveNextOffset);
            }
            setError(null);
            setIsPending(false);
          }
          return next;
        } catch (cause) {
          const nextError = asError(cause, "Failed to load host fleet");
          if (
            !controller.signal.aborted &&
            !isAbortError(nextError) &&
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
      snapshotRequestRef.current = { controller, promise, epoch: requestEpoch };
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
      for (const request of detailRequestsRef.current.values()) {
        request.controller.abort();
      }
      detailRequestsRef.current.clear();
      archivePageRequestRef.current?.controller.abort();
      archivePageRequestRef.current = null;
    };
  }, [loadSnapshot]);

  const loadFreshSnapshot = useCallback(async () => {
    // A mutation can happen while the periodic read is already in flight.
    // Let that read settle, then issue a second request so callers never treat
    // a snapshot started before their mutation as the post-mutation refresh.
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

  const loadMoreArchives = useCallback((): Promise<void> => {
    const existing = archivePageRequestRef.current;
    if (existing) return existing.promise;
    const archiveOffset = archiveNextOffsetRef.current;
    if (archiveOffset === null) return Promise.resolve();

    const controller = new AbortController();
    const requestEpoch = snapshotEpochRef.current;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        const response = await fetch(
          `${FLEET_SNAPSHOT_PATH}?archiveOffset=${encodeURIComponent(String(archiveOffset))}`,
          {
            method: "GET",
            credentials: "include",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw await responseError(response, "Failed to load older runs");
        }
        const page = (await response.json()) as FleetSnapshotResponse;
        if (
          !controller.signal.aborted &&
          mountedRef.current &&
          requestEpoch === snapshotEpochRef.current
        ) {
          setOlderArchiveRunsByHost((current) =>
            appendArchivePage(current, page.hostRecords),
          );
          hasLoadedOlderArchivesRef.current = true;
          archiveNextOffsetRef.current = page.archiveNextOffset;
          setArchiveNextOffset(page.archiveNextOffset);
          setLoadMoreArchivesError(null);
        }
      } catch (cause) {
        const nextError = asError(cause, "Failed to load older runs");
        if (
          !controller.signal.aborted &&
          !isAbortError(nextError) &&
          mountedRef.current &&
          requestEpoch === snapshotEpochRef.current
        ) {
          setLoadMoreArchivesError(nextError);
        }
        throw nextError;
      } finally {
        if (archivePageRequestRef.current?.promise === promise) {
          archivePageRequestRef.current = null;
        }
        if (mountedRef.current) {
          setIsLoadingMoreArchives(false);
        }
      }
    })();
    archivePageRequestRef.current = { controller, promise };
    setIsLoadingMoreArchives(true);
    return promise;
  }, []);

  const loadArchivedRunDetail = useCallback(
    (hostId: string, runId: string): Promise<AgentVmRunRecord> => {
      const existing = detailRequestsRef.current.get(runId);
      if (existing) return existing.promise;

      const controller = new AbortController();
      let promise!: Promise<AgentVmRunRecord>;
      promise = (async () => {
        try {
          const response = await fetch(
            `${FLEET_SNAPSHOT_PATH}/runs/${encodeURIComponent(runId)}?hostId=${encodeURIComponent(hostId)}`,
            {
              method: "GET",
              credentials: "include",
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            throw await responseError(
              response,
              "Failed to load archived run details",
            );
          }
          const body = (await response.json()) as { run: AgentVmRunRecord };
          if (!controller.signal.aborted && mountedRef.current) {
            setArchivedRunDetailsById((current) => ({
              ...current,
              [body.run.id]: body.run,
            }));
          }
          return body.run;
        } finally {
          const current = detailRequestsRef.current.get(runId);
          if (current?.promise === promise) {
            detailRequestsRef.current.delete(runId);
          }
        }
      })();
      detailRequestsRef.current.set(runId, { controller, promise });
      return promise;
    },
    [],
  );

  /** Drop cached state for a host that was just deleted. */
  const forgetHost = useCallback((hostId: string) => {
    snapshotEpochRef.current += 1;
    hasLoadedOlderArchivesRef.current = false;
    archiveNextOffsetRef.current = null;
    archivePageRequestRef.current?.controller.abort();
    setSnapshot((current) => {
      if (!current) return current;
      const removed = current.hostRecords.find(
        (record) => record.host.id === hostId,
      );
      return {
        ...current,
        archiveTotalCount: Math.max(
          0,
          current.archiveTotalCount - (removed?.archiveTotalCount ?? 0),
        ),
        hostRecords: current.hostRecords.filter(
          (record) => record.host.id !== hostId,
        ),
      };
    });
    setOlderArchiveRunsByHost({});
    setArchiveNextOffset(null);
    setArchivedRunDetailsById((current) => {
      const next = { ...current };
      for (const [runId, detail] of Object.entries(current)) {
        if (detail.hostId === hostId) delete next[runId];
      }
      return next;
    });
  }, []);

  /** Locally remove an archive entry after deletion without waiting for a poll. */
  const forgetArchivedRun = useCallback((hostId: string, runId: string) => {
    snapshotEpochRef.current += 1;
    hasLoadedOlderArchivesRef.current = false;
    archiveNextOffsetRef.current = null;
    detailRequestsRef.current.get(runId)?.controller.abort();
    archivePageRequestRef.current?.controller.abort();
    setSnapshot((current) => {
      if (!current) return current;
      const hostRecords = current.hostRecords.map((record) => {
        if (record.host.id !== hostId) return record;
        const hostRuns = record.hostRuns.filter((run) => run.id !== runId);
        return {
          ...record,
          hostRuns,
          archiveTotalCount: Math.max(0, record.archiveTotalCount - 1),
        };
      });
      return {
        ...current,
        archiveTotalCount: Math.max(0, current.archiveTotalCount - 1),
        hostRecords,
      };
    });
    setOlderArchiveRunsByHost({});
    setArchiveNextOffset(null);
    setArchivedRunDetailsById((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, []);

  const hostRecords = useMemo<HostRecord[]>(
    () =>
      (snapshot?.hostRecords ?? []).map((record) => ({
        ...record,
        hostRuns: mergeArchiveRuns(
          record.hostRuns,
          olderArchiveRunsByHost[record.host.id] ?? [],
        ).map((run) =>
          mergeLoadedArchiveDetail(run, archivedRunDetailsById[run.id]),
        ),
      })),
    [archivedRunDetailsById, olderArchiveRunsByHost, snapshot?.hostRecords],
  );

  const hosts = useMemo(
    () => ({
      data: (snapshot?.hostRecords ?? []).map((record) => record.host),
      error,
      isPending,
      refetch,
    }),
    [error, isPending, refetch, snapshot?.hostRecords],
  );

  return {
    hosts,
    hostRecords,
    liveLoadedCount: snapshot?.liveLoadedCount ?? 0,
    liveTotalCount: snapshot?.liveTotalCount ?? 0,
    archiveTotalCount: snapshot?.archiveTotalCount ?? 0,
    hasMoreArchives: archiveNextOffset !== null,
    hasMoreLive: snapshot?.hasMoreLive ?? false,
    isLoadingMoreArchives,
    loadMoreArchivesError,
    loadMoreArchives,
    refreshHost,
    forgetHost,
    forgetArchivedRun,
    loadArchivedRunDetail,
  };
}

function mergeLoadedArchiveDetail(
  summary: AgentVmRun,
  detail: AgentVmRunRecord | undefined,
): AgentVmRun {
  if (!detail) return summary;
  // Snapshot scalars stay current while the loaded arrays remain available
  // through later background snapshots.
  return {
    ...summary,
    artifacts: detail.artifacts,
    events: detail.events,
  };
}

function appendArchivePage(
  current: Record<string, AgentVmRun[]>,
  hostRecords: HostRecord[],
): Record<string, AgentVmRun[]> {
  const next = { ...current };
  for (const record of hostRecords) {
    next[record.host.id] = mergeArchiveRuns(
      next[record.host.id] ?? [],
      record.hostRuns,
    );
  }
  return next;
}

function mergeArchiveRuns(
  current: AgentVmRun[],
  incoming: AgentVmRun[],
): AgentVmRun[] {
  const ids = new Set<string>();
  return [...current, ...incoming].filter((run) => {
    if (ids.has(run.id)) return false;
    ids.add(run.id);
    return true;
  });
}

async function responseError(response: Response, fallback: string): Promise<Error> {
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

function isAbortError(error: Error) {
  return error.name === "AbortError";
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
