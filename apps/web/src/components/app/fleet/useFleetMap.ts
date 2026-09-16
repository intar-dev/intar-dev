import { useCallback, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  HttpResponseError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import type { FleetMapSnapshot } from "./types";

export const FLEET_MAP_PATH = "/api/fleet/map";

/** A cold cache resolves only a few addresses per load. */
export const FLEET_MAP_PENDING_POLL_MS = 3_000;
/** The first read plus ten follow-up reads, then the page stops asking. */
export const FLEET_MAP_MAX_READS = 11;

export interface FleetMapQuery {
  query: UseQueryResult<FleetMapSnapshot, unknown>;
  /** True when follow-up reads stopped with a first lookup still missing. */
  stalled: boolean;
  /** Reads the fleet again and starts the follow-up budget from zero. */
  refresh: () => void;
}

/**
 * The placed fleet for the map. The page reads it once. While the payload
 * still reports a first lookup in progress, the hook asks again a bounded
 * number of times, so a cold cache fills in without a reader reload, and it
 * says so when the budget runs out instead of promising work that stopped.
 */
export function useFleetMap(): FleetMapQuery {
  const reads = useRef(0);
  const [stalled, setStalled] = useState(false);
  const query = useQuery({
    queryKey: ["fleet-map"],
    queryFn: async ({ signal }) => {
      reads.current += 1;
      const response = await fetch(FLEET_MAP_PATH, {
        method: "GET",
        credentials: "include",
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load the fleet map (${response.status})`,
        );
      }
      const snapshot = (await response.json()) as FleetMapSnapshot;
      setStalled(
        snapshot.pendingHostCount > 0 && reads.current >= FLEET_MAP_MAX_READS,
      );
      return snapshot;
    },
    staleTime: Infinity,
    refetchInterval: (state) =>
      (state.state.data?.pendingHostCount ?? 0) > 0 &&
      reads.current < FLEET_MAP_MAX_READS
        ? FLEET_MAP_PENDING_POLL_MS
        : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: retryHttpResponseError,
  });
  const { refetch } = query;
  // A deliberate refresh is a new budget: the reader asked for the host that
  // the last read left pending, not for a promise that already ran out.
  const refresh = useCallback(() => {
    reads.current = 0;
    setStalled(false);
    void refetch();
  }, [refetch]);
  return { query, stalled, refresh };
}
