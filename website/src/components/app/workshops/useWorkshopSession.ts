import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getWorkshopSession, sendWorkshopPresence } from "./api";

const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;

export const workshopSessionQueryKey = (
  sessionId: string,
  view: "room" | "projector" = "room",
) => ["workshops", "session", sessionId, view] as const;

export function useWorkshopSession(
  sessionId: string,
  view: "room" | "projector" = "room",
) {
  const query = useQuery({
    queryKey: workshopSessionQueryKey(sessionId, view),
    queryFn: () => getWorkshopSession(sessionId, view),
    retry: 1,
    staleTime: 1_000,
    refetchInterval: (query) => {
      const state = query.state.data?.session.state;
      return state === "lobby" || state === "live" ? 2_000 : false;
    },
    refetchIntervalInBackground: false,
  });
  const state = query.data?.session.state;
  useWorkshopPresence(
    sessionId,
    view === "room" && (state === "lobby" || state === "live"),
  );
  return query;
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
