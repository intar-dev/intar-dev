import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { CircleHelpIcon } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageShell } from "@/components/app/patterns/PageShell";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";
import {
  RunArtifactViewer,
  type RunArtifactViewerState,
} from "@/components/app/RunArtifactViewer";
import { NativeSshDialogButton } from "@/components/remote-access/NativeSshDialogButton";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentBridgeStatus, AgentHostInfo } from "@/lib/agent-bridge";
import type { HostHealth } from "@/lib/host-health";
import { isScenarioLaunchHost } from "@/lib/scenario-hosts";

interface AgentHostApi {
  id: string;
  name: string;
  role: "agent" | "builder";
  disabled: boolean;
  scenarioEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  hostInfo: AgentHostInfo | null;
  status: AgentBridgeStatus | null;
  actualState: {
    appliedDesiredVersion: number;
    observedAt: number;
    health: HostHealth;
  } | null;
}

interface VmStatus {
  id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  run_id?: string | null;
  probe_state?: VmProbeState | null;
  terminal_target?: VmTerminalTargetReadiness | null;
  scenario_meta?: VmScenarioMeta | null;
  details?: {
    guest_ip?: string | null;
  } | null;
}

interface VmProbeSummary {
  total: number;
  pass: number;
  fail: number;
  unknown: number;
}

interface VmProbe {
  id: string;
  kind: string;
  status: string;
  every_seconds: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_duration_ms: number;
  error: string | null;
  value: unknown;
}

interface VmProbeState {
  collection_state: string;
  collection_error: string | null;
  generated_at: string | null;
  updated_at: string | null;
  summary: VmProbeSummary;
  probes: VmProbe[];
}

interface VmTerminalTargetReadiness {
  state: "pending" | "ready";
  reason: string | null;
  host: string | null;
  port: number;
  username: string;
  checkedAt: number;
}

interface VmScenarioMeta {
  scenarioName: string;
  scenarioDescription: string;
  scenarioVmName: string;
  hostname: string;
  probePhaseMap: Record<string, "boot" | "scenario">;
}

interface AgentVmRunEvent {
  id: string;
  kind: string;
  message: string | null;
  createdAt: number;
}

interface AgentVmRunArtifact {
  id: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadStatus: string;
  uploadedAt: number | null;
}

interface AgentVmRunRecord {
  id: string;
  hostId: string;
  userId: string;
  vmName: string;
  state: string;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  solvedAt: number | null;
  solveDurationMs: number | null;
  uploadStatus: string;
  vmCreatedAt: number;
  deleteRequestedAt: number | null;
  deletedAt: number | null;
  uploadStartedAt: number | null;
  uploadCompletedAt: number | null;
  uploadError: string | null;
  createdAt: number;
  updatedAt: number;
  events: AgentVmRunEvent[];
  artifacts: AgentVmRunArtifact[];
  scenarioMeta?: VmScenarioMeta | null;
}

interface HostRunsResponse {
  liveVms: VmStatus[];
  archivedRuns: AgentVmRunRecord[];
}

interface AdminScenarioSummary {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AdminScenarioListResponse {
  scenarios: AdminScenarioSummary[];
}

interface AdminScenarioDetail {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
  probes: Array<{
    ordinal: number;
    name: string;
    description: string;
    phase: "boot" | "scenario";
  }>;
  vms: Array<{
    id: string;
    ordinal: number;
    name: string;
    image: string;
    cpu: number;
    memoryMib: number;
    diskMib: number;
  }>;
}

interface AdminScenarioDetailResponse {
  scenario: AdminScenarioDetail;
}

interface LaunchScenarioRunResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}

interface HostRecord {
  host: AgentHostApi;
  hostVms: VmStatus[];
  hostRuns: AgentVmRunRecord[];
  info: AgentHostInfo | null;
}

interface LiveScenarioRunRecord {
  host: AgentHostApi;
  vm: VmStatus;
}

interface ArchivedScenarioRunRecord {
  host: AgentHostApi;
  run: AgentVmRunRecord;
}

const formatTimestamp = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : "—";

const formatTimestampMs = (value: number | null | undefined) =>
  typeof value === "number" ? new Date(value).toLocaleString() : "—";

const formatLoad = (value: number | null | undefined) =>
  typeof value === "number" ? value.toFixed(2) : "—";

const formatBytes = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
};

const formatDurationMs = (value: number | null | undefined) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts =
    hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
};

const artifactKindLabel = (kind: string) => {
  switch (kind) {
    case "console_log":
      return "Console";
    case "serial_log":
      return "Serial";
    case "ssh_recording":
      return "Replay";
    case "ssh_recording_segment":
      return "Segment";
    case "ssh_recording_raw":
      return "Raw";
    default:
      return kind.replace(/_/g, " ");
  }
};

const milestoneLabel = (kind: string) =>
  kind.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());

const runStatusTone = (uploadStatus: string) => {
  switch (uploadStatus) {
    case "complete":
      return {
        rail: "bg-primary",
        badgeVariant: "secondary" as const,
        label: "Archived",
      };
    case "uploading":
      return {
        rail: "bg-secondary-foreground/40",
        badgeVariant: "outline" as const,
        label: "Uploading",
      };
    default:
      return {
        rail: "bg-destructive/80",
        badgeVariant: "destructive" as const,
        label: "Needs retry",
      };
  }
};

const runOutcomeTone = (outcome: AgentVmRunRecord["outcome"]) => {
  switch (outcome) {
    case "succeeded":
      return {
        badgeVariant: "secondary" as const,
        label: "Succeeded",
      };
    case "cancelled":
      return {
        badgeVariant: "outline" as const,
        label: "Cancelled",
      };
    case "failed":
      return {
        badgeVariant: "destructive" as const,
        label: "Failed",
      };
    case "in_progress":
      return {
        badgeVariant: "outline" as const,
        label: "In progress",
      };
  }
};

const probeStatusTone = (status: string) => {
  switch (status) {
    case "pass":
      return "secondary" as const;
    case "fail":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
};

const probeCollectionTone = (state: string) =>
  state === "error"
    ? "border-destructive/30 bg-destructive/5 text-destructive"
    : "border-border/70 bg-secondary text-secondary-foreground";

const summarizeProbeValue = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  const object = value as Record<string, unknown>;
  if (typeof object.path === "string" && typeof object.exists === "boolean") {
    return `${object.path} ${object.exists ? "exists" : "missing"}`;
  }
  if (
    typeof object.host === "string" &&
    typeof object.port === "number" &&
    typeof object.open === "boolean"
  ) {
    return `${object.host}:${object.port} ${object.open ? "open" : "closed"}`;
  }
  if (
    typeof object.service === "string" &&
    typeof object.desiredState === "string"
  ) {
    const actualState =
      typeof object.actualState === "string" && object.actualState.trim()
        ? ` (${object.actualState})`
        : "";
    return `${object.service} -> ${object.desiredState}${actualState}`;
  }
  const serialized = JSON.stringify(object);
  return serialized.length > 120
    ? `${serialized.slice(0, 117)}...`
    : serialized;
};

function groupVmProbesByScenario(
  probes: VmProbe[],
  scenarioMeta: VmScenarioMeta | null | undefined,
) {
  if (!scenarioMeta) {
    return null;
  }

  const boot: VmProbe[] = [];
  const scenario: VmProbe[] = [];
  const other: VmProbe[] = [];

  for (const probe of probes) {
    const phase = scenarioMeta.probePhaseMap[probe.id];
    if (phase === "boot") {
      boot.push(probe);
    } else if (phase === "scenario") {
      scenario.push(probe);
    } else {
      other.push(probe);
    }
  }

  return { boot, scenario, other };
}

function ProbeRows(props: { probes: VmProbe[] }) {
  if (!props.probes.length) {
    return (
      <div className="rounded-xl border border-dashed bg-background/70 px-4 py-5 text-center text-muted-foreground">
        No probes in this section yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {props.probes.map((probe) => (
        <details
          key={probe.id}
          className="rounded-xl border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={probeStatusTone(probe.status)}
                  className="capitalize"
                >
                  {probe.status}
                </Badge>
                <span className="font-medium">{probe.id}</span>
                <span className="text-muted-foreground">{probe.kind}</span>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {summarizeProbeValue(probe.value)}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">Details</span>
          </summary>
          <div className="mt-3 grid gap-3 text-xs text-muted-foreground">
            <div className="grid gap-2 sm:grid-cols-2">
              <p>Every: {probe.every_seconds}s</p>
              <p>Last duration: {probe.last_duration_ms} ms</p>
              <p>Last attempt: {formatTimestamp(probe.last_attempt_at)}</p>
              <p>Last success: {formatTimestamp(probe.last_success_at)}</p>
            </div>
            {probe.error ? (
              <p className="text-destructive">{probe.error}</p>
            ) : null}
            <pre className="overflow-x-auto rounded-lg border bg-background/80 p-3 text-xs text-foreground">
              <code>{JSON.stringify(probe.value, null, 2)}</code>
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}

const SCENARIO_RUNS_PAGE_SIZE = 6;
const SCENARIO_RUN_PAGE_LINKS = 5;

const parseTimestamp = (value: string | null | undefined) => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function buildVisiblePages(currentPage: number, totalPages: number) {
  if (totalPages <= SCENARIO_RUN_PAGE_LINKS) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const half = Math.floor(SCENARIO_RUN_PAGE_LINKS / 2);
  const start = Math.max(
    1,
    Math.min(currentPage - half, totalPages - SCENARIO_RUN_PAGE_LINKS + 1),
  );

  return Array.from(
    { length: SCENARIO_RUN_PAGE_LINKS },
    (_, index) => start + index,
  );
}

export function Dashboard() {
  const [vmError, setVmError] = useState<string | null>(null);
  const [vmNotice, setVmNotice] = useState<string | null>(null);
  const [vmBusyKey, setVmBusyKey] = useState<string | null>(null);
  const [selectedScenarioByHost, setSelectedScenarioByHost] = useState<
    Record<string, string>
  >({});
  const [vmListByHost, setVmListByHost] = useState<Record<string, VmStatus[]>>(
    {},
  );
  const [runListByHost, setRunListByHost] = useState<
    Record<string, AgentVmRunRecord[]>
  >({});
  const [expandedActiveVms, setExpandedActiveVms] = useState<
    Record<string, boolean>
  >({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [artifactViewerByRun, setArtifactViewerByRun] = useState<
    Record<string, RunArtifactViewerState>
  >({});
  const [hostViewById, setHostViewById] = useState<
    Record<string, AgentHostApi>
  >({});
  const artifactStreamRef = useRef<Record<string, AbortController>>({});
  const [runsPage, setRunsPage] = useState(1);
  const [activeWebSsh, setActiveWebSsh] = useState<{
    hostId: string;
    runId: string;
    vmId: string;
    vmName: string;
  } | null>(null);

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

  const scenarios = useQuery({
    queryKey: ["admin-scenarios", "launcher"],
    queryFn: async () => {
      const response = await fetch("/api/admin/scenarios", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenarios (${response.status})`,
        );
      }

      return (await response.json()) as AdminScenarioListResponse;
    },
    staleTime: 10_000,
  });

  const launchableScenarios = scenarios.data?.scenarios ?? [];
  const defaultScenarioId =
    launchableScenarios.find((scenario) => scenario.enabled)?.scenarioId ??
    launchableScenarios[0]?.scenarioId ??
    "";

  const deleteHost = useMutation({
    mutationFn: async (hostId: string) => {
      const response = await fetch(
        `/api/agent/hosts/${encodeURIComponent(hostId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Delete failed (${response.status})`);
      }
      return (await response.json()) as { ok: boolean; hostId: string };
    },
    onSuccess: (result) => {
      setSelectedScenarioByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setHostViewById((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setVmListByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setRunListByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setExpandedActiveVms((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setExpandedRuns((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setArtifactViewerByRun((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setActiveWebSsh((current) =>
        current && current.hostId === result.hostId ? null : current,
      );
      void hosts.refetch();
    },
  });

  useEffect(() => {
    if (!hosts.data?.length || !defaultScenarioId) {
      return;
    }

    setSelectedScenarioByHost((current) => {
      const next = { ...current };
      let changed = false;

      for (const host of hosts.data) {
        const selected = next[host.id];
        if (
          !selected ||
          !launchableScenarios.some(
            (scenario) => scenario.scenarioId === selected,
          )
        ) {
          next[host.id] = defaultScenarioId;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [defaultScenarioId, hosts.data, launchableScenarios]);

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

  useEffect(() => {
    if (!hosts.data?.length) return;

    let cancelled = false;

    const pollOnce = async () => {
      for (const baseHost of hosts.data ?? []) {
        try {
          const state = await loadHostState(baseHost.id);
          if (cancelled) return;
          setHostViewById((current) => ({
            ...current,
            [baseHost.id]: state.host,
          }));
          setVmListByHost((current) => ({
            ...current,
            [baseHost.id]: state.liveVms,
          }));
          setRunListByHost((current) => ({
            ...current,
            [baseHost.id]: state.archivedRuns,
          }));
        } catch {
          continue;
        }
      }
    };

    void pollOnce();
    const intervalMs =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? 15_000
        : 3_000;
    const timer = setInterval(() => {
      void pollOnce();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hosts.data]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(artifactStreamRef.current)) {
        controller.abort();
      }
    };
  }, []);

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

  const refreshVmList = async (hostId: string) => {
    setVmError(null);
    const state = await loadHostState(hostId);
    setHostViewById((current) => ({ ...current, [hostId]: state.host }));
    setVmListByHost((current) => ({ ...current, [hostId]: state.liveVms }));
    setRunListByHost((current) => ({
      ...current,
      [hostId]: state.archivedRuns,
    }));
  };

  const refreshRunList = async (hostId: string) => {
    const state = await loadHostState(hostId);
    setHostViewById((current) => ({ ...current, [hostId]: state.host }));
    setVmListByHost((current) => ({ ...current, [hostId]: state.liveVms }));
    setRunListByHost((current) => ({
      ...current,
      [hostId]: state.archivedRuns,
    }));
  };

  const streamArtifactContent = async (
    hostId: string,
    runId: string,
    artifact: AgentVmRunArtifact,
  ) => {
    const viewerKey = `${hostId}:${runId}`;
    artifactStreamRef.current[viewerKey]?.abort();

    const controller = new AbortController();
    artifactStreamRef.current[viewerKey] = controller;
    setArtifactViewerByRun((current) => ({
      ...current,
      [viewerKey]: {
        artifact,
        loading: true,
        error: null,
        content: "",
        receivedBytes: 0,
      },
    }));

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
        {
          method: "GET",
          credentials: "include",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load artifact (${response.status})`,
        );
      }

      if (!response.body) {
        const text = await response.text();
        setArtifactViewerByRun((current) => ({
          ...current,
          [viewerKey]: {
            artifact,
            loading: false,
            error: null,
            content: text,
            receivedBytes: new TextEncoder().encode(text).byteLength,
          },
        }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        accumulated += decoder.decode(value, { stream: true });
        startTransition(() => {
          setArtifactViewerByRun((current) => ({
            ...current,
            [viewerKey]: {
              artifact,
              loading: true,
              error: null,
              content: accumulated,
              receivedBytes,
            },
          }));
        });
      }

      accumulated += decoder.decode();
      setArtifactViewerByRun((current) => ({
        ...current,
        [viewerKey]: {
          artifact,
          loading: false,
          error: null,
          content: accumulated,
          receivedBytes: Math.max(receivedBytes, artifact.sizeBytes),
        },
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setArtifactViewerByRun((current) => ({
        ...current,
        [viewerKey]: {
          artifact,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "failed to stream artifact",
          content: current[viewerKey]?.content ?? "",
          receivedBytes: current[viewerKey]?.receivedBytes ?? 0,
        },
      }));
    } finally {
      if (artifactStreamRef.current[viewerKey] === controller) {
        delete artifactStreamRef.current[viewerKey];
      }
    }
  };

  const handleLaunchScenario = async (hostId: string, scenarioId: string) => {
    const busyKey = `${hostId}:launch`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
      const response = await fetch(
        `/api/agent/hosts/${encodeURIComponent(hostId)}/runs`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ scenarioId }),
        },
      );

      const body = (await response.json().catch(() => null)) as
        | LaunchScenarioRunResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          (body as { error?: string } | null)?.error ??
            `Failed to launch scenario (${response.status})`,
        );
      }

      const result = body as LaunchScenarioRunResponse;
      setVmNotice(
        result.reused
          ? `${result.scenarioId} is already active on ${hostId}.`
          : `${result.scenarioId} queued on ${hostId}.`,
      );
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to launch scenario",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const handleDestroyRun = async (
    hostId: string,
    runId: string,
    vmName: string,
  ) => {
    const busyKey = `${hostId}:destroy-run:${runId}`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to request teardown (${response.status})`,
        );
      }
      setVmNotice(`Teardown requested for ${vmName}`);
      setExpandedActiveVms((current) => {
        const next = { ...current };
        delete next[`${hostId}:${vmName}`];
        return next;
      });
      setActiveWebSsh((current) =>
        current && current.hostId === hostId && current.runId === runId
          ? null
          : current,
      );
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to request teardown",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const handleDeleteRun = async (hostId: string, runId: string) => {
    const busyKey = `${hostId}:delete-run:${runId}`;
    const viewerKey = `${hostId}:${runId}`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to delete run (${response.status})`,
        );
      }

      artifactStreamRef.current[viewerKey]?.abort();
      delete artifactStreamRef.current[viewerKey];
      setExpandedRuns((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setArtifactViewerByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setRunListByHost((current) => ({
        ...current,
        [hostId]: (current[hostId] ?? []).filter((run) => run.id !== runId),
      }));
      setVmNotice(`Deleted archived run ${runId}`);
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to delete run",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
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
  const connectedHostCount = hostRecords.filter(
    ({ host }) => host.status?.connected,
  ).length;
  const activeVmCount = hostRecords.reduce(
    (total, { hostVms }) => total + hostVms.length,
    0,
  );
  const archivedRunCount = hostRecords.reduce(
    (total, { hostRuns }) => total + hostRuns.length,
    0,
  );
  const liveScenarioRuns = useMemo<LiveScenarioRunRecord[]>(
    () =>
      hostRecords
        .flatMap(({ host, hostVms }) =>
          hostVms
            .filter((vm) => Boolean(vm.run_id))
            .map((vm) => ({ host, vm })),
        )
        .sort(
          (left, right) =>
            parseTimestamp(right.vm.updated_at) -
            parseTimestamp(left.vm.updated_at),
        ),
    [hostRecords],
  );
  const archivedScenarioRuns = useMemo<ArchivedScenarioRunRecord[]>(
    () =>
      hostRecords
        .flatMap(({ host, hostRuns }) => hostRuns.map((run) => ({ host, run })))
        .sort((left, right) => {
          const leftTime =
            left.run.deletedAt ??
            left.run.uploadCompletedAt ??
            left.run.updatedAt ??
            left.run.createdAt;
          const rightTime =
            right.run.deletedAt ??
            right.run.uploadCompletedAt ??
            right.run.updatedAt ??
            right.run.createdAt;
          return rightTime - leftTime;
        }),
    [hostRecords],
  );
  const totalRunPages = Math.max(
    1,
    Math.ceil(archivedScenarioRuns.length / SCENARIO_RUNS_PAGE_SIZE),
  );
  const archiveStart =
    archivedScenarioRuns.length > 0
      ? (runsPage - 1) * SCENARIO_RUNS_PAGE_SIZE + 1
      : 0;
  const archiveEnd =
    archivedScenarioRuns.length > 0
      ? Math.min(
          runsPage * SCENARIO_RUNS_PAGE_SIZE,
          archivedScenarioRuns.length,
        )
      : 0;
  const pageNumbers = useMemo(
    () => buildVisiblePages(runsPage, totalRunPages),
    [runsPage, totalRunPages],
  );
  const pagedArchivedScenarioRuns = useMemo(() => {
    const start = (runsPage - 1) * SCENARIO_RUNS_PAGE_SIZE;
    return archivedScenarioRuns.slice(
      start,
      start + SCENARIO_RUNS_PAGE_SIZE,
    );
  }, [archivedScenarioRuns, runsPage]);

  useEffect(() => {
    setRunsPage((current) => Math.min(Math.max(current, 1), totalRunPages));
  }, [totalRunPages]);

  return (
    <PageShell admin
      title="Overview"
      description="Scenario runs stay front and center while host operations remain close at hand."
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <WorkspaceStat
          label="Hosts"
          value={String(hostRecords.length)}
          detail={`${connectedHostCount} online`}
        />
        <WorkspaceStat
          label="Live runs"
          value={String(activeVmCount)}
          detail="Active VMs"
        />
        <WorkspaceStat
          label="Run archive"
          value={String(archivedRunCount)}
          detail="Archived sessions"
        />
        <WorkspaceStat
          label="Scenarios"
          value={String(launchableScenarios.length)}
          detail={
            launchableScenarios.filter((scenario) => scenario.enabled).length >
            0
              ? `${
                  launchableScenarios.filter((scenario) => scenario.enabled)
                    .length
                } enabled`
              : "No launchable scenarios"
          }
        />
      </div>

      <div className="space-y-3">
        {scenarios.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load scenarios</AlertTitle>
            <AlertDescription>
              {scenarios.error instanceof Error
                ? scenarios.error.message
                : "Failed to load scenarios"}
            </AlertDescription>
          </Alert>
        ) : null}
        {hosts.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load hosts</AlertTitle>
            <AlertDescription>
              {hosts.error instanceof Error
                ? hosts.error.message
                : "Failed to load hosts"}
            </AlertDescription>
          </Alert>
        ) : null}
        {deleteHost.error ? (
          <Alert variant="destructive">
            <AlertTitle>Host deletion failed</AlertTitle>
            <AlertDescription>
              {deleteHost.error instanceof Error
                ? deleteHost.error.message
                : "Delete failed"}
            </AlertDescription>
          </Alert>
        ) : null}
        {vmError ? (
          <Alert variant="destructive">
            <AlertTitle>VM action failed</AlertTitle>
            <AlertDescription>{vmError}</AlertDescription>
          </Alert>
        ) : null}
        {vmNotice ? (
          <Alert>
            <AlertTitle>Host update</AlertTitle>
            <AlertDescription>{vmNotice}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <Tabs defaultValue="scenario-runs" className="gap-6">
        <TabsList
          variant="line"
          className="w-full justify-start gap-6 rounded-none border-b border-border/70 p-0"
        >
          <TabsTrigger
            value="scenario-runs"
            className="rounded-none px-1 py-3 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Scenario runs
          </TabsTrigger>
          <TabsTrigger
            value="hosts"
            className="rounded-none px-1 py-3 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Hosts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scenario-runs" className="space-y-6">
          <section className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
                  Live now
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  Active scenario runs
                </h2>
              </div>
              <Badge variant="outline">{liveScenarioRuns.length} active</Badge>
            </div>

            {hosts.isLoading ? (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                Loading active runs...
              </div>
            ) : liveScenarioRuns.length ? (
              <div className="mt-6 space-y-4">
                {liveScenarioRuns.map(({ host, vm }) => {
                  const vmKey = `${host.id}:${vm.name}`;
                  return (
                    <LiveScenarioRunCard
                      key={vmKey}
                      host={host}
                      vmItem={vm}
                      isExpanded={Boolean(expandedActiveVms[vmKey])}
                      onToggle={() => {
                        setExpandedActiveVms((current) => ({
                          ...current,
                          [vmKey]: !current[vmKey],
                        }));
                      }}
                      onOpenWebSsh={() => {
                        if (!vm.run_id) return;
                        setActiveWebSsh({
                          hostId: host.id,
                          runId: vm.run_id,
                          vmId: vm.id,
                          vmName: vm.name,
                        });
                      }}
                      onDelete={() => {
                        if (!vm.run_id) return;
                        void handleDestroyRun(host.id, vm.run_id, vm.name);
                      }}
                      isDeleting={
                        vmBusyKey === `${host.id}:destroy-run:${vm.run_id}`
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                No active scenario runs.
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
                  Archive
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  Scenario run history
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {archivedScenarioRuns.length
                    ? `${archiveStart}-${archiveEnd} of ${archivedScenarioRuns.length}`
                    : "0 runs"}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setRunsPage((current) => Math.max(1, current - 1))
                  }
                  disabled={runsPage === 1 || !archivedScenarioRuns.length}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setRunsPage((current) =>
                      Math.min(totalRunPages, current + 1),
                    )
                  }
                  disabled={
                    runsPage === totalRunPages || !archivedScenarioRuns.length
                  }
                >
                  Next
                </Button>
              </div>
            </div>

            {hosts.isLoading ? (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                Loading archived runs...
              </div>
            ) : pagedArchivedScenarioRuns.length ? (
              <div className="mt-6 space-y-4">
                {pagedArchivedScenarioRuns.map(({ host, run }) => {
                  const viewerKey = `${host.id}:${run.id}`;
                  return (
                    <ScenarioRunArchiveCard
                      key={viewerKey}
                      host={host}
                      run={run}
                      viewer={artifactViewerByRun[viewerKey] ?? null}
                      isExpanded={Boolean(expandedRuns[viewerKey])}
                      onToggle={() => {
                        setExpandedRuns((current) => ({
                          ...current,
                          [viewerKey]: !current[viewerKey],
                        }));
                      }}
                      onDelete={() => {
                        void handleDeleteRun(host.id, run.id);
                      }}
                      onStreamArtifact={(artifact) => {
                        void streamArtifactContent(host.id, run.id, artifact);
                      }}
                      isDeleting={
                        vmBusyKey === `${host.id}:delete-run:${run.id}`
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                No archived scenario runs yet.
              </div>
            )}

            {archivedScenarioRuns.length > SCENARIO_RUNS_PAGE_SIZE ? (
              <div className="mt-6 flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Page {runsPage} of {totalRunPages}
                </p>
                <div className="flex flex-wrap gap-2">
                  {pageNumbers.map((pageNumber) => (
                    <Button
                      key={pageNumber}
                      type="button"
                      size="sm"
                      variant={pageNumber === runsPage ? "secondary" : "outline"}
                      onClick={() => setRunsPage(pageNumber)}
                    >
                      {pageNumber}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        </TabsContent>

        <TabsContent value="hosts" className="space-y-6">
          <HostOnboardingPanel
            eyebrow="New host"
            title="Bridge config"
            onGenerated={() => {
              void hosts.refetch();
            }}
          />

          {hosts.isLoading ? (
            <div className="rounded-3xl border border-border/70 bg-card/70 px-6 py-10 text-sm text-muted-foreground shadow-sm">
              Loading hosts...
            </div>
          ) : hostRecords.length ? (
            <div className="grid gap-5 xl:grid-cols-2">
              {hostRecords.map(({ host, hostVms, hostRuns, info }) => {
                const isDeletingThisHost =
                  deleteHost.isPending && deleteHost.variables === host.id;
                const isLaunchingScenario = vmBusyKey === `${host.id}:launch`;
                const isRefreshingVmList = vmBusyKey === `${host.id}:list`;
                const selectedScenarioId =
                  selectedScenarioByHost[host.id] ?? defaultScenarioId;
                const selectedScenario =
                  launchableScenarios.find(
                    (scenario) => scenario.scenarioId === selectedScenarioId,
                  ) ?? null;
                const memorySummary =
                  info?.memoryAvailableMib !== null &&
                  info?.memoryAvailableMib !== undefined &&
                  info?.memoryTotalMib !== null &&
                  info?.memoryTotalMib !== undefined
                    ? `${info.memoryAvailableMib} / ${info.memoryTotalMib} MiB`
                    : info?.memoryTotalMib !== null &&
                        info?.memoryTotalMib !== undefined
                      ? `— / ${info.memoryTotalMib} MiB`
                      : "—";
                const diskSummary =
                  info?.diskAvailableMib !== null &&
                  info?.diskAvailableMib !== undefined &&
                  info?.diskTotalMib !== null &&
                  info?.diskTotalMib !== undefined
                    ? `${info.diskAvailableMib} / ${info.diskTotalMib} MiB`
                    : info?.diskTotalMib !== null &&
                        info?.diskTotalMib !== undefined
                      ? `— / ${info.diskTotalMib} MiB`
                      : "—";

                return (
                  <article
                    key={host.id}
                    className="overflow-hidden rounded-3xl border border-border/70 bg-card/80 shadow-sm"
                  >
                    <div className="px-5 py-5 sm:px-6">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-xl font-semibold tracking-tight">
                              {host.name}
                            </h2>
                            <Badge
                              variant={
                                host.status?.connected ? "secondary" : "outline"
                              }
                            >
                              {host.status?.connected ? "Online" : "Offline"}
                            </Badge>
                            {host.actualState?.health === "degraded" ? (
                              <Badge variant="destructive">Degraded</Badge>
                            ) : host.actualState?.health === "unknown" ? (
                              <Badge variant="outline">Unknown health</Badge>
                            ) : null}
                            {host.disabled ? (
                              <Badge variant="destructive">Disabled</Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">
                              {host.role === "builder" ? "Builder" : "Agent"}
                            </Badge>
                            <Badge variant="outline">{host.id}</Badge>
                            <Badge variant="outline">{hostVms.length} live</Badge>
                            <Badge variant="outline">
                              {hostRuns.length} archived
                            </Badge>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setVmBusyKey(`${host.id}:list`);
                              void refreshVmList(host.id)
                                .catch((error) => {
                                  setVmError(
                                    error instanceof Error
                                      ? error.message
                                      : "failed to refresh host state",
                                  );
                                })
                                .finally(() => {
                                  setVmBusyKey((current) =>
                                    current === `${host.id}:list`
                                      ? null
                                      : current,
                                  );
                                });
                            }}
                            disabled={isRefreshingVmList}
                          >
                            {isRefreshingVmList ? "Refreshing..." : "Refresh"}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              if (
                                typeof window !== "undefined" &&
                                !window.confirm(
                                  `Delete agent "${host.name}" (${host.id})? This removes host access and bootstrap tokens.`,
                                )
                              ) {
                                return;
                              }
                              deleteHost.mutate(host.id);
                            }}
                            disabled={isDeletingThisHost}
                          >
                            {isDeletingThisHost ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-6 border-t border-border/70 px-5 py-5 sm:px-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                        <HostMetric
                          label="Heartbeat"
                          value={formatTimestamp(host.status?.lastHeartbeatAt)}
                          detail={
                            host.actualState?.health === "degraded"
                              ? "No state report for over 60 seconds"
                              : host.status?.connected
                              ? "Connected via bridge"
                              : "No fresh bridge heartbeat"
                          }
                        />
                        <HostMetric
                          label="Network"
                          value={info?.primaryIpv4 ?? "—"}
                          detail={info?.primaryIpv6 ?? "No IPv6"}
                        />
                        <HostMetric
                          label="CPU"
                          value={
                            info?.cpuCores ? `${info.cpuCores} cores` : "Unknown"
                          }
                          detail={`${formatLoad(info?.loadAvg1m)} / ${formatLoad(
                            info?.loadAvg5m,
                          )} / ${formatLoad(info?.loadAvg15m)}`}
                        />
                        <HostMetric
                          label="Memory"
                          value={memorySummary}
                          detail="Available / total"
                        />
                        <HostMetric
                          label={`Disk ${info?.diskProbePath ?? "/"}`}
                          value={diskSummary}
                          detail="Available / total"
                        />
                        <HostMetric
                          label="Runs"
                          value={`${hostVms.length} live`}
                          detail={`${hostRuns.length} archived`}
                        />
                      </div>

                      <div className="xl:border-l xl:border-border/70 xl:pl-6">
                        <HostScenarioLaunchPanel
                          host={host}
                          selectedScenarioId={selectedScenarioId}
                          selectedScenario={selectedScenario}
                          scenarios={launchableScenarios}
                          onScenarioChange={(scenarioId) => {
                            setSelectedScenarioByHost((current) => ({
                              ...current,
                              [host.id]: scenarioId,
                            }));
                          }}
                          onLaunch={() => {
                            if (!selectedScenarioId) return;
                            void handleLaunchScenario(host.id, selectedScenarioId);
                          }}
                          isLaunching={isLaunchingScenario}
                        />
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-border/70 bg-card/70 px-6 py-12 text-center text-sm text-muted-foreground">
              No hosts yet. Generate a bridge config to register one.
            </div>
          )}
        </TabsContent>
      </Tabs>

      {activeWebSsh ? (
        <WebSshTerminal
          vmName={activeWebSsh.vmName}
          sessionRequest={{
            url: `/api/scenarios/runs/${encodeURIComponent(activeWebSsh.runId)}/ssh`,
            body: { vmId: activeWebSsh.vmId },
          }}
          onClose={() => setActiveWebSsh(null)}
        />
      ) : null}
    </PageShell>
  );
}

function DetailStat(props: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{props.value}</p>
      {props.detail ? (
        <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}

function LiveScenarioRunCard(props: {
  host: AgentHostApi;
  vmItem: VmStatus;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenWebSsh: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const probeState = props.vmItem.probe_state ?? null;
  const summary = probeState?.summary ?? null;
  const scenarioMeta = props.vmItem.scenario_meta ?? null;
  const groupedProbes = probeState
    ? groupVmProbesByScenario(probeState.probes, scenarioMeta)
    : null;
  const terminalTarget = props.vmItem.terminal_target ?? {
    state: "pending" as const,
    reason:
      props.vmItem.state.trim().toLowerCase() === "running"
        ? "Waiting for the terminal target to become reachable."
        : "The terminal target is only prepared when the VM is running.",
    host: null,
    port: 22,
    username: "ubuntu",
  };

  return (
    <article className="overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-sm">
      <div className="flex flex-col gap-4 px-5 py-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{props.vmItem.state}</Badge>
            <Badge variant="outline">
              {scenarioMeta?.scenarioName ?? "Legacy run"}
            </Badge>
            <Badge variant="outline">{props.host.name}</Badge>
            {summary ? (
              <>
                <Badge variant="secondary">{summary.pass} pass</Badge>
                <Badge variant="destructive">{summary.fail} fail</Badge>
                <Badge variant="outline">{summary.unknown} unknown</Badge>
              </>
            ) : (
              <Badge variant="outline">Probes pending</Badge>
            )}
          </div>

          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              {props.vmItem.name}
            </h3>
            <p className="text-sm text-muted-foreground">
              {scenarioMeta?.scenarioVmName ?? "Legacy VM"} • Run{" "}
              {props.vmItem.run_id ?? "—"}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DetailStat
              label="Guest IP"
              value={props.vmItem.details?.guest_ip ?? "—"}
            />
            <DetailStat
              label="Updated"
              value={formatTimestamp(props.vmItem.updated_at)}
            />
            <DetailStat
              label="Probe update"
              value={formatTimestamp(probeState?.updated_at)}
            />
            <DetailStat
              label="Target"
              value={
                terminalTarget.host
                  ? `${terminalTarget.host}:${terminalTarget.port}`
                  : "Pending"
              }
              detail={terminalTarget.state === "ready" ? "Ready" : "Bootstrap pending"}
            />
            <DetailStat label="Host" value={props.host.name} detail={props.host.id} />
          </div>

          {props.vmItem.error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {props.vmItem.error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={props.onToggle}>
            {props.isExpanded ? "Hide details" : "Details"}
          </Button>
          <div
            className="inline-flex"
            title={
              terminalTarget.state === "ready"
                ? undefined
                : (terminalTarget.reason ?? undefined)
            }
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!terminalTarget.host) return;
                props.onOpenWebSsh();
              }}
              disabled={
                !props.vmItem.run_id ||
                terminalTarget.state !== "ready" ||
                !terminalTarget.host
              }
            >
              Open Web SSH
              {terminalTarget.state !== "ready" || !terminalTarget.host ? (
                <CircleHelpIcon size={12} />
              ) : null}
            </Button>
          </div>
          <NativeSshDialogButton
            vmName={props.vmItem.name}
            sessionRequest={{
              url: `/api/scenarios/runs/${encodeURIComponent(props.vmItem.run_id ?? "")}/ssh`,
              body: { vmId: props.vmItem.id },
            }}
            disabled={
              !props.vmItem.run_id ||
              terminalTarget.state !== "ready" ||
              !terminalTarget.host
            }
          />
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={props.onDelete}
            disabled={!props.vmItem.run_id || props.isDeleting}
          >
            {props.isDeleting ? "Requesting..." : "Teardown run"}
          </Button>
        </div>
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          props.isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="grid gap-4 border-t border-border/70 px-5 py-5 xl:grid-cols-[minmax(0,0.34fr)_minmax(0,0.66fr)]">
            <div className="space-y-4">
              {probeState ? (
                <div
                  className={`rounded-xl border px-4 py-3 ${probeCollectionTone(
                    probeState.collection_state,
                  )}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      Probe collector: {probeState.collection_state}
                    </p>
                    <p className="text-xs">
                      Generated {formatTimestamp(probeState.generated_at)}
                    </p>
                  </div>
                  {probeState.collection_error ? (
                    <p className="mt-2 text-xs">{probeState.collection_error}</p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                  Waiting for the first probe scrape.
                </div>
              )}
            </div>

            <div className="space-y-4">
              {probeState?.probes.length ? (
                scenarioMeta && groupedProbes ? (
                  <>
                    <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Boot probes</p>
                        <Badge variant="outline">{groupedProbes.boot.length}</Badge>
                      </div>
                      <ProbeRows probes={groupedProbes.boot} />
                    </div>
                    <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Scenario probes</p>
                        <Badge variant="outline">
                          {groupedProbes.scenario.length}
                        </Badge>
                      </div>
                      <ProbeRows probes={groupedProbes.scenario} />
                    </div>
                    {groupedProbes.other.length ? (
                      <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <p className="text-sm font-medium">Ungrouped probes</p>
                          <Badge variant="outline">
                            {groupedProbes.other.length}
                          </Badge>
                        </div>
                        <ProbeRows probes={groupedProbes.other} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <ProbeRows probes={probeState.probes} />
                )
              ) : (
                <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                  No probe rows yet for this VM.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function ScenarioRunArchiveCard(props: {
  host: AgentHostApi;
  run: AgentVmRunRecord;
  viewer: RunArtifactViewerState | null;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onStreamArtifact: (artifact: AgentVmRunArtifact) => void;
  isDeleting: boolean;
}) {
  const tone = runStatusTone(props.run.uploadStatus);
  const outcome = runOutcomeTone(props.run.outcome);

  return (
    <article className="overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-sm">
      <div className={`h-1 w-full ${tone.rail}`} />
      <div className="flex flex-col gap-4 px-5 py-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tone.badgeVariant}>{tone.label}</Badge>
            <Badge variant={outcome.badgeVariant}>{outcome.label}</Badge>
            <Badge variant="outline">
              {props.run.scenarioMeta?.scenarioName ?? "Legacy run"}
            </Badge>
            <Badge variant="outline">{props.host.name}</Badge>
          </div>

          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              {props.run.vmName}
            </h3>
            <p className="text-sm text-muted-foreground">
              {props.run.scenarioMeta?.scenarioVmName ?? "Legacy VM"} •{" "}
              {props.run.id}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DetailStat
              label="Deleted"
              value={formatTimestampMs(props.run.deletedAt)}
            />
            <DetailStat
              label="Uploaded"
              value={
                props.run.uploadCompletedAt
                  ? formatTimestampMs(props.run.uploadCompletedAt)
                  : props.run.uploadStartedAt
                    ? `Started ${formatTimestampMs(props.run.uploadStartedAt)}`
                    : "Pending"
              }
            />
            <DetailStat
              label="Artifacts"
              value={String(props.run.artifacts.length)}
              detail={
                props.run.artifacts.length === 1 ? "file captured" : "files captured"
              }
            />
            <DetailStat
              label="Solve time"
              value={
                props.run.outcome === "succeeded"
                  ? formatDurationMs(props.run.solveDurationMs)
                  : "Not solved"
              }
              {...(props.run.solvedAt
                ? { detail: `Solved ${formatTimestampMs(props.run.solvedAt)}` }
                : props.run.outcome === "cancelled"
                  ? { detail: "Cancelled before solve" }
                  : {})}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={props.onToggle}>
            {props.isExpanded ? "Hide details" : "Details"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={props.onDelete}
            disabled={props.isDeleting}
          >
            {props.isDeleting ? "Deleting..." : "Delete run"}
          </Button>
        </div>
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          props.isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="grid gap-6 border-t border-border/70 px-5 py-5 xl:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <DetailStat
                  label="Created"
                  value={formatTimestampMs(props.run.vmCreatedAt)}
                />
                <DetailStat
                  label="Delete requested"
                  value={formatTimestampMs(props.run.deleteRequestedAt)}
                />
                <DetailStat
                  label="Upload state"
                  value={props.run.uploadStatus}
                />
                <DetailStat label="Owner" value={props.run.userId} />
              </div>

              {props.run.uploadError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {props.run.uploadError}
                </div>
              ) : null}

              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Milestones</p>
                  <Badge variant="outline">{props.run.events.length}</Badge>
                </div>
                {props.run.events.length ? (
                  <div className="mt-4 space-y-3">
                    {props.run.events.map((event) => (
                      <div key={event.id} className="relative pl-5 text-sm">
                        <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-primary" />
                        <p className="font-medium">
                          {milestoneLabel(event.kind)}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {event.message ?? "No detail"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestampMs(event.createdAt)}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No run events recorded.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-border/70 bg-muted/15 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Artifacts</p>
                  <Badge variant="outline">{props.run.artifacts.length}</Badge>
                </div>
                {props.run.artifacts.length ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {props.run.artifacts.map((artifact) => (
                      <button
                        key={artifact.id}
                        type="button"
                        className={`rounded-2xl border px-4 py-3 text-left text-sm transition-colors ${
                          props.viewer?.artifact.id === artifact.id
                            ? "border-primary/40 bg-primary/10 text-foreground"
                            : "border-border/70 bg-background/90 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        }`}
                        onClick={() => {
                          props.onStreamArtifact(artifact);
                        }}
                      >
                        <span className="block font-medium">
                          {artifact.ordinal}. {artifactKindLabel(artifact.kind)}
                        </span>
                        <span className="mt-1 block text-xs">
                          {artifact.filename} • {formatBytes(artifact.sizeBytes)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No archived files for this run.
                  </p>
                )}
              </div>

              <RunArtifactViewer
                viewer={props.viewer}
                emptyDescription="Select an artifact from this run."
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function WorkspaceStat(props: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/70 px-5 py-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-3 text-3xl font-semibold tracking-tight">
        {props.value}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function HostMetric(props: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">{props.value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function HostScenarioLaunchPanel(props: {
  host: AgentHostApi;
  selectedScenarioId: string;
  selectedScenario: AdminScenarioSummary | null;
  scenarios: AdminScenarioSummary[];
  onScenarioChange: (scenarioId: string) => void;
  onLaunch: () => void;
  isLaunching: boolean;
}) {
  const scenarioDetail = useQuery({
    queryKey: ["admin-scenarios", "detail", props.selectedScenarioId],
    enabled: Boolean(props.selectedScenarioId),
    queryFn: async () => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(props.selectedScenarioId)}`,
        {
          method: "GET",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenario (${response.status})`,
        );
      }

      return (await response.json()) as AdminScenarioDetailResponse;
    },
    staleTime: 10_000,
  });

  const launchVm = scenarioDetail.data?.scenario.vms[0] ?? null;
  const isHostOnline = Boolean(props.host.status?.connected);
  const canLaunchScenarios = isScenarioLaunchHost(props.host);
  const launchDisabled =
    props.host.disabled ||
    !canLaunchScenarios ||
    !isHostOnline ||
    !props.selectedScenarioId ||
    props.isLaunching ||
    !props.scenarios.length;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
          Launch
        </p>
        <h3 className="mt-2 text-lg font-semibold tracking-tight">
          Run scenario
        </h3>
      </div>

      {props.scenarios.length ? (
        <div className="space-y-4 rounded-3xl border border-border/70 bg-muted/15 p-4">
          <Select
            value={props.selectedScenarioId}
            onValueChange={(value) => {
              if (value) props.onScenarioChange(value);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select scenario" />
            </SelectTrigger>
            <SelectContent>
              {props.scenarios.map((scenario) => (
                <SelectItem
                  key={scenario.scenarioId}
                  value={scenario.scenarioId}
                >
                  {scenario.scenarioId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {props.selectedScenario ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    props.selectedScenario.enabled ? "secondary" : "outline"
                  }
                >
                  {props.selectedScenario.enabled ? "Enabled" : "Draft"}
                </Badge>
                <Badge variant="outline">
                  {props.selectedScenario.vmCount} VM
                  {props.selectedScenario.vmCount === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline">
                  {props.selectedScenario.probeCount} probe
                  {props.selectedScenario.probeCount === 1 ? "" : "s"}
                </Badge>
              </div>

              <p className="text-sm leading-6 text-muted-foreground">
                {props.selectedScenario.description}
              </p>

              {launchVm ? (
                <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    Launch target
                  </p>
                  <p className="mt-2 text-sm font-medium">{launchVm.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {launchVm.cpu} vCPU • {launchVm.memoryMib} MiB •{" "}
                    {launchVm.diskMib} MiB
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {scenarioDetail.error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {scenarioDetail.error instanceof Error
                ? scenarioDetail.error.message
                : "Failed to load scenario detail"}
            </div>
          ) : null}

          {!isHostOnline ? (
            <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
              Host must be online to queue a scenario.
            </div>
          ) : null}

          {!canLaunchScenarios ? (
            <div className="rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm text-muted-foreground">
              This host is reserved for image builds.
            </div>
          ) : null}

          <Button
            type="button"
            onClick={props.onLaunch}
            disabled={launchDisabled}
            className="w-full"
          >
            {props.isLaunching ? "Queueing..." : "Run scenario"}
          </Button>
        </div>
      ) : (
        <div className="rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
          No scenarios available.
        </div>
      )}
    </div>
  );
}
