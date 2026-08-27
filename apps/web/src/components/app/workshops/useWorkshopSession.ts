import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getWorkshopSession,
  getWorkshopSessionStatus,
  sendWorkshopPresence,
} from "./api";
import {
  commitWorkshopStatusAfterFullRefresh,
  createWorkshopStatusPollVersions,
  mergeWorkshopSessionStatus,
} from "./status";
import type { WorkshopSessionResponse } from "./types";

const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
const WORKSHOP_STATUS_POLL_INTERVAL_MS = 2_000;

export const workshopSessionQueryKey = (
  sessionId: string,
  view: "room" | "projector" = "room",
) => ["workshops", "session", sessionId, view] as const;

export function useWorkshopSession(
  sessionId: string,
  view: "room" | "projector" = "room",
  options: { polling?: "full" | "status" } = {},
) {
  const statusPolling = options.polling === "status" && view === "room";
  const query = useQuery({
    queryKey: workshopSessionQueryKey(sessionId, view),
    queryFn: ({ signal }) => getWorkshopSession(sessionId, view, { signal }),
    retry: 1,
    staleTime: 1_000,
    refetchInterval: statusPolling
      ? false
      : (query) => {
          const state = query.state.data?.session.state;
          return state === "lobby" || state === "live" ? 2_000 : false;
        },
    refetchIntervalInBackground: false,
  });
  const state = query.data?.session.state;
  useWorkshopStatusPolling({
    sessionId,
    view,
    enabled:
      statusPolling && (state === "lobby" || state === "live"),
  });
  useWorkshopPresence(
    sessionId,
    view === "room" && (state === "lobby" || state === "live"),
  );
  return query;
}

function useWorkshopStatusPolling({
  sessionId,
  view,
  enabled,
}: {
  sessionId: string;
  view: "room" | "projector";
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const pollVersionsRef = useRef<ReturnType<
    typeof createWorkshopStatusPollVersions
  > | null>(null);
  if (!pollVersionsRef.current) {
    pollVersionsRef.current = createWorkshopStatusPollVersions();
  }

  useEffect(() => {
    pollVersionsRef.current?.reset();
  }, [sessionId, view]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const queryKey = workshopSessionQueryKey(sessionId, view);

    const schedule = (delay = WORKSHOP_STATUS_POLL_INTERVAL_MS) => {
      if (stopped || document.visibilityState !== "visible") return;
      timeout = setTimeout(() => void poll(), delay);
    };
    const refreshFullProjection = async (signal: AbortSignal) => {
      const response = await getWorkshopSession(sessionId, view, { signal });
      if (stopped) return false;
      queryClient.setQueryData(queryKey, response);
      return true;
    };
    const poll = async () => {
      if (
        stopped ||
        inFlight ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const current = queryClient.getQueryData<WorkshopSessionResponse>(queryKey);
      if (!current) return;
      inFlight = true;
      const activeController = new AbortController();
      controller = activeController;
      try {
        const status = await getWorkshopSessionStatus(sessionId, {
          ...pollVersionsRef.current!.request(current.session.version),
          signal: activeController.signal,
        });
        if (!status || stopped) return;
        if (status.requiresFullRefresh) {
          await commitWorkshopStatusAfterFullRefresh(
            pollVersionsRef.current!,
            status,
            () => refreshFullProjection(activeController.signal),
          );
          return;
        }
        const latest = queryClient.getQueryData<WorkshopSessionResponse>(queryKey);
        if (!latest) return;
        const merged = mergeWorkshopSessionStatus(latest, status);
        if (merged.requiresFullRefresh) {
          await commitWorkshopStatusAfterFullRefresh(
            pollVersionsRef.current!,
            status,
            () => refreshFullProjection(activeController.signal),
          );
        } else {
          queryClient.setQueryData(queryKey, merged.response);
          pollVersionsRef.current?.commit(status);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // A status refresh is supplementary. The loaded room remains usable
          // and the next bounded attempt can recover without replacing it.
        }
      } finally {
        if (controller === activeController) controller = null;
        inFlight = false;
        schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        controller?.abort();
        return;
      }
      if (timeout) clearTimeout(timeout);
      timeout = null;
      schedule(0);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, queryClient, sessionId, view]);
}

function useWorkshopPresence(sessionId: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (stopped) return;
      timeout = setTimeout(() => void heartbeat(), PRESENCE_HEARTBEAT_INTERVAL_MS);
    };
    const heartbeat = async () => {
      if (!stopped && document.visibilityState === "visible") {
        await sendWorkshopPresence(sessionId).catch(() => undefined);
      }
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      void heartbeat();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void heartbeat();
    return () => {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, sessionId]);
}
