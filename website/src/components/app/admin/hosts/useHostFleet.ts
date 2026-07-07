import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AgentHostApi,
  AgentVmRunRecord,
  HostRecord,
  HostRunsResponse,
  VmStatus,
} from "./types";

// Shared host-fleet state: the hosts list plus per-host live VM / archived run
// polling. Used by both the admin Overview (runs view) and the Hosts page.
export function useHostFleet() {
  const [hostViewById, setHostViewById] = useState<
    Record<string, AgentHostApi>
  >({});
  const [vmListByHost, setVmListByHost] = useState<Record<string, VmStatus[]>>(
    {},
  );
  const [runListByHost, setRunListByHost] = useState<
    Record<string, AgentVmRunRecord[]>
  >({});

  const hosts = useQuery({
    queryKey: ["agent-hosts"],
    queryFn: async () => {
      const response = await fetch("/api/agent/hosts", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load hosts (${response.status})`,
        );
      }

      const body = (await response.json()) as { hosts: AgentHostApi[] };
      return body.hosts;
    },
    staleTime: 0,
    retry: 1,
    refetchInterval: 1_500,
  });

  useEffect(() => {
    if (!hosts.data?.length) {
      return;
    }

    setHostViewById((current) => {
      const next = { ...current };
      for (const host of hosts.data) {
        next[host.id] = host;
      }
      return next;
    });
  }, [hosts.data]);

  // Keyed on the id list (not hosts.data identity, which changes on every
  // heartbeat refetch) so the 3s cadence actually holds; hidden tabs skip
  // ticks down to an effective 15s.
  const hostIdsKey = (hosts.data ?? []).map((host) => host.id).join(",");

  useEffect(() => {
    if (!hostIdsKey) return;
    const hostIds = hostIdsKey.split(",");

    let cancelled = false;
    let tick = 0;

    const pollOnce = async () => {
      for (const hostId of hostIds) {
        try {
          const state = await loadHostState(hostId);
          if (cancelled) return;
          setHostViewById((current) => ({
            ...current,
            [hostId]: state.host,
          }));
          setVmListByHost((current) => ({
            ...current,
            [hostId]: state.liveVms,
          }));
          setRunListByHost((current) => ({
            ...current,
            [hostId]: state.archivedRuns,
          }));
        } catch {
          continue;
        }
      }
    };

    void pollOnce();
    const timer = setInterval(() => {
      tick += 1;
      const hidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      if (hidden && tick % 5 !== 0) return;
      void pollOnce();
    }, 3_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostIdsKey]);

  const refreshHost = async (hostId: string) => {
    const state = await loadHostState(hostId);
    setHostViewById((current) => ({ ...current, [hostId]: state.host }));
    setVmListByHost((current) => ({ ...current, [hostId]: state.liveVms }));
    setRunListByHost((current) => ({
      ...current,
      [hostId]: state.archivedRuns,
    }));
  };

  /** Drop cached state for a host that was just deleted. */
  const forgetHost = (hostId: string) => {
    setHostViewById((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
    setVmListByHost((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
    setRunListByHost((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
  };

  /** Locally remove an archived run (after a delete) without waiting for the poll. */
  const forgetArchivedRun = (hostId: string, runId: string) => {
    setRunListByHost((current) => ({
      ...current,
      [hostId]: (current[hostId] ?? []).filter((run) => run.id !== runId),
    }));
  };

  const hostRecords = useMemo<HostRecord[]>(
    () =>
      (hosts.data ?? []).map((baseHost) => {
        const host = hostViewById[baseHost.id] ?? baseHost;
        return {
          host,
          hostVms: vmListByHost[host.id] ?? [],
          hostRuns: runListByHost[host.id] ?? [],
          info: host.status?.hostInfo ?? host.hostInfo ?? null,
        };
      }),
    [hosts.data, hostViewById, runListByHost, vmListByHost],
  );

  return { hosts, hostRecords, refreshHost, forgetHost, forgetArchivedRun };
}

async function loadHostState(hostId: string) {
  const [hostResponse, runResponse] = await Promise.all([
    fetch(`/api/agent/hosts/${encodeURIComponent(hostId)}`, {
      method: "GET",
      credentials: "include",
    }),
    fetch(`/api/agent/hosts/${encodeURIComponent(hostId)}/runs`, {
      method: "GET",
      credentials: "include",
    }),
  ]);

  if (!hostResponse.ok) {
    const body = (await hostResponse.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Failed to load host (${hostResponse.status})`,
    );
  }
  if (!runResponse.ok) {
    const body = (await runResponse.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Failed to load host runs (${runResponse.status})`,
    );
  }

  const hostBody = (await hostResponse.json()) as { host: AgentHostApi };
  const runBody = (await runResponse.json()) as HostRunsResponse;
  return {
    host: hostBody.host,
    liveVms: runBody.liveVms ?? [],
    archivedRuns: runBody.archivedRuns ?? [],
  };
}
