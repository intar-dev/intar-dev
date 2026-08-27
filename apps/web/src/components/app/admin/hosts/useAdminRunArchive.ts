import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminRunArchivePageResponse,
  AgentVmRunRecord,
  ArchivedScenarioRunRecord,
} from "./types";

const ADMIN_RUN_ARCHIVE_PATH = "/api/admin/runs";
const ADMIN_RUN_ARCHIVE_REFRESH_INTERVAL_MS = 10_000;

interface PageRequest {
  controller: AbortController;
  promise: Promise<void>;
}

export function useAdminRunArchive() {
  const [runs, setRuns] = useState<ArchivedScenarioRunRecord[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const pageRequestRef = useRef<PageRequest | null>(null);
  const hasLoadedOlderPagesRef = useRef(false);
  const archiveGenerationRef = useRef(0);

  const loadPage = useCallback(
    (cursor: string | null, append: boolean): Promise<void> => {
      const existing = pageRequestRef.current;
      if (existing) return existing.promise;

      const controller = new AbortController();
      const requestGeneration = archiveGenerationRef.current;
      let promise!: Promise<void>;
      promise = (async () => {
        try {
          const search = cursor
            ? `?cursor=${encodeURIComponent(cursor)}`
            : "";
          const response = await fetch(`${ADMIN_RUN_ARCHIVE_PATH}${search}`, {
            method: "GET",
            credentials: "include",
            signal: controller.signal,
          });
          if (!response.ok) {
            throw await responseError(response, "Failed to load run archive");
          }
          const page = (await response.json()) as AdminRunArchivePageResponse;
          if (
            !controller.signal.aborted &&
            mountedRef.current &&
            requestGeneration === archiveGenerationRef.current
          ) {
            setRuns((current) =>
              append ? mergeArchiveRuns(current, page.runs) : page.runs,
            );
            if (page.totalCount !== null) setTotalCount(page.totalCount);
            else if (!append) setTotalCount(null);
            setNextCursor(page.nextCursor);
            if (append) hasLoadedOlderPagesRef.current = true;
            setError(null);
            setLoadMoreError(null);
          }
        } catch (cause) {
          const nextError = asError(cause, "Failed to load run archive");
          if (
            !controller.signal.aborted &&
            nextError.name !== "AbortError" &&
            mountedRef.current &&
            requestGeneration === archiveGenerationRef.current
          ) {
            if (append) setLoadMoreError(nextError);
            else setError(nextError);
          }
          throw nextError;
        } finally {
          if (pageRequestRef.current?.promise === promise) {
            pageRequestRef.current = null;
          }
          if (mountedRef.current) {
            setIsPending(false);
            setIsLoadingMore(false);
          }
        }
      })();
      pageRequestRef.current = { controller, promise };
      return promise;
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadPage(null, false).catch(() => {
      // The archive section renders the request error.
    });
    const refreshLatestPage = () => {
      if (
        hasLoadedOlderPagesRef.current ||
        pageRequestRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void loadPage(null, false).catch(() => {
        // The archive section renders the request error.
      });
    };
    const interval = window.setInterval(
      refreshLatestPage,
      ADMIN_RUN_ARCHIVE_REFRESH_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", refreshLatestPage);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshLatestPage);
      pageRequestRef.current?.controller.abort();
      pageRequestRef.current = null;
    };
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (!nextCursor || pageRequestRef.current) return Promise.resolve();
    setIsLoadingMore(true);
    return loadPage(nextCursor, true);
  }, [loadPage, nextCursor]);

  const refetch = useCallback(() => {
    hasLoadedOlderPagesRef.current = false;
    return loadPage(null, false);
  }, [loadPage]);

  const loadRunDetail = useCallback(
    async (runId: string): Promise<AgentVmRunRecord> => {
      const response = await fetch(
        `${ADMIN_RUN_ARCHIVE_PATH}/${encodeURIComponent(runId)}`,
        { method: "GET", credentials: "include" },
      );
      if (!response.ok) {
        throw await responseError(
          response,
          "Failed to load archived run details",
        );
      }
      const body = (await response.json()) as { run: AgentVmRunRecord };
      return body.run;
    },
    [],
  );

  const forgetRun = useCallback((runId: string) => {
    archiveGenerationRef.current += 1;
    setRuns((current) => current.filter(({ run }) => run.id !== runId));
    setTotalCount((current) =>
      current === null ? null : Math.max(0, current - 1),
    );
  }, []);

  useEffect(() => {
    if (!isPending && nextCursor === null) setTotalCount(runs.length);
  }, [isPending, nextCursor, runs.length]);

  return {
    runs,
    totalCount,
    hasMore: nextCursor !== null,
    isPending,
    error,
    refetch,
    isLoadingMore,
    loadMoreError,
    loadMore,
    loadRunDetail,
    forgetRun,
  };
}

function mergeArchiveRuns(
  current: ArchivedScenarioRunRecord[],
  incoming: ArchivedScenarioRunRecord[],
) {
  const byId = new Map(current.map((entry) => [entry.run.id, entry]));
  for (const entry of incoming) byId.set(entry.run.id, entry);
  return [...byId.values()];
}

async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(body?.error ?? `${fallback} (${response.status})`);
}

function asError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
