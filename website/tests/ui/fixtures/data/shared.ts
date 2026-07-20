import type { SessionRole } from "../sessions";

export const FIXED_NOW = Date.parse("2026-07-10T09:00:00.000Z");

export type DataVariant = "populated" | "empty" | "loading" | "error" | "long";
export type RunFixtureState =
  | "launching"
  | "booting"
  | "waiting"
  | "running"
  | "disconnected"
  | "solved"
  | "failed"
  | "ending"
  | "rendering"
  | "archived"
  | "replay-failed"
  | "replay";

export type TerminalMode = "connected" | "disconnected" | "error";

export interface MockApiState {
  sessionRole: SessionRole;
  variant: DataVariant;
  runState: RunFixtureState;
  terminalMode: TerminalMode;
  scenarios: Array<Record<string, unknown>>;
  courses: Array<Record<string, unknown>>;
  organizationScenarios: Array<Record<string, unknown>>;
  organizationCourses: Array<Record<string, unknown>>;
  scenarioDetail: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  run: Record<string, unknown>;
  organizations: Array<Record<string, unknown>>;
  organizationCreation: Record<string, unknown>;
  organizationDetail: Record<string, unknown>;
  assignments: Array<Record<string, unknown>>;
  progress: Record<string, unknown>;
  sshKeys: Array<Record<string, unknown>>;
  accessRequests: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  adminOrganizations: Array<Record<string, unknown>>;
  organizationRunners: Array<Record<string, unknown>>;
  organizationOidc: Record<string, unknown> | null;
  workshopSessions: Array<Record<string, unknown>>;
  workshopSession: Record<string, unknown>;
  organizationWorkshops: Record<string, unknown>;
  hosts: Array<Record<string, unknown>>;
  hostRuns: Record<string, unknown>;
  adminScenarios: Array<Record<string, unknown>>;
  adminScenarioDetail: Record<string, unknown>;
  builds: Array<Record<string, unknown>>;
  buildDetails: Record<string, Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  sourceHcl: string;
}

export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;
export const sha = "a".repeat(64);
export const kernelSha = "b".repeat(64);
export const initrdSha = "c".repeat(64);

export const objectives = [
  {
    probeName: "nginx-listening",
    vmName: "web",
    label: "Restore the public web listener",
    title: "Bring the service back online",
    bodyMarkdown:
      "Find why **nginx** is not listening on port 80 and restore the service without replacing the machine.",
    hintCount: 2,
  },
  {
    probeName: "health-endpoint",
    vmName: "web",
    label: "Return a healthy response",
    title: "Verify the health endpoint",
    bodyMarkdown:
      "Make `http://localhost/health` return a successful response containing `ok`.",
    hintCount: 1,
  },
];

export const scenarioHints = [
  {
    id: "hint-service",
    title: "Start at the service boundary",
    body_markdown:
      "Inspect the service unit and recent logs before changing files.",
  },
];

export const scenarioVm = {
  id: "vm-web",
  ordinal: 0,
  name: "web",
  image: "debian-13",
  imageKey: { scenario: "repair-nginx", vm: "web", arch: "x86_64" },
  imageSha256: sha,
  imageFormat: "raw_zstd",
  imageVirtualSizeBytes: 8 * 1024 * 1024 * 1024,
  kernelSha256: kernelSha,
  initrdSha256: initrdSha,
  bootCmdline: "console=ttyS0 root=/dev/vda rw quiet",
  cpu: 2,
  memoryMib: 2048,
  diskMib: 8192,
};

export const scenarioProbes = [
  {
    scenarioVmId: "vm-web",
    scenarioVmName: "web",
    ordinal: 0,
    name: "boot-ready",
    description: "Machine booted and accepted probes",
    title: "Machine ready",
    bodyMarkdown: null,
    hints: [],
    phase: "boot",
    kind: "systemd_unit",
  },
  {
    scenarioVmId: "vm-web",
    scenarioVmName: "web",
    ordinal: 1,
    name: "nginx-listening",
    description: "nginx listens on port 80",
    title: "Bring the service back online",
    bodyMarkdown: objectives[0]?.bodyMarkdown ?? null,
    hints: scenarioHints,
    phase: "scenario",
    kind: "tcp_connect",
  },
  {
    scenarioVmId: "vm-web",
    scenarioVmName: "web",
    ordinal: 2,
    name: "health-endpoint",
    description: "health endpoint returns ok",
    title: "Verify the health endpoint",
    bodyMarkdown: objectives[1]?.bodyMarkdown ?? null,
    hints: [],
    phase: "scenario",
    kind: "http_request",
  },
];

export const briefing = {
  title: "Repair a broken nginx service",
  tagline: "A routine configuration change left the service unreachable.",
  category: "Linux services",
  difficulty: "medium",
  estimatedMinutes: 35,
  briefingMarkdown:
    "## Work order\n\nThe edge monitor reports that the web service stopped answering after a routine change. Diagnose the failure, make the smallest safe repair, and verify it from the machine.\n\n> Preserve the existing content and leave a clear audit trail in the shell history.",
  tags: ["linux", "nginx", "systemd", "networking"],
  objectives,
};

export function catalogScenario(input: {
  scenarioId: string;
  title: string;
  tagline: string;
  difficulty: "easy" | "medium" | "hard";
  category: string;
  tags: string[];
  status: "new" | "in_progress" | "attempted" | "completed";
  activeRunId?: string | null;
  organizationId?: string | null;
}) {
  return {
    scenarioId: input.scenarioId,
    organizationId: input.organizationId ?? null,
    slug: input.scenarioId,
    title: input.title,
    tagline: input.tagline,
    difficulty: input.difficulty,
    estimatedMinutes: input.difficulty === "hard" ? 60 : 35,
    tags: input.tags,
    category: input.category,
    scenarioName: input.scenarioId,
    enabledAt: FIXED_NOW - 45 * day,
    vmCount: input.difficulty === "hard" ? 2 : 1,
    progress: {
      status: input.status,
      activeRunId: input.activeRunId ?? null,
      attemptCount: input.status === "new" ? 0 : 2,
      completedCount: input.status === "completed" ? 1 : 0,
      bestSolveMs: input.status === "completed" ? 27 * minute : null,
      lastPlayedAt: input.status === "new" ? null : FIXED_NOW - 2 * day,
    },
  };
}

export function paginatedScenarioFixtures(count = 19) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return catalogScenario({
      scenarioId: `paging-scenario-${number}`,
      title: `Paging scenario ${String(number).padStart(2, "0")}`,
      tagline: "A catalog fixture that verifies collection paging behavior.",
      difficulty: "medium",
      category: "Pagination lab",
      tags: ["paging", "catalog"],
      status: "new",
    });
  });
}

export function runListEntry(input: {
  runId: string;
  title: string;
  phase: string;
  outcome: string;
  active: boolean;
  createdAt: number;
  solvedAt?: number | null;
  hasReplay?: boolean;
  replayState?: "not_started" | "preparing" | "ready" | "none" | "failed";
  activity?: "foreground" | "background" | "settled";
}) {
  const activity = input.activity ?? (input.active ? "foreground" : "settled");
  return {
    runId: input.runId,
    scenarioId: "repair-nginx",
    scenarioName: "repair-nginx",
    title: input.title,
    difficulty: "medium",
    phase: input.phase,
    outcome: input.outcome,
    active: input.active,
    activity,
    deleteRequestedAt:
      activity === "foreground" ? null : input.createdAt + minute,
    replayState:
      input.replayState ??
      (input.hasReplay
        ? "ready"
        : activity === "background"
          ? "preparing"
          : activity === "settled"
            ? "none"
            : "not_started"),
    createdAt: input.createdAt,
    finishedAt: input.active ? null : input.createdAt + 31 * minute,
    solvedAt: input.solvedAt ?? null,
    solveDurationMs:
      input.solvedAt == null ? null : input.solvedAt - input.createdAt,
    solutionAssisted: false,
    hasReplay: input.hasReplay ?? false,
  };
}

export function runLifecycle(state: RunFixtureState) {
  switch (state) {
    case "launching":
      return {
        runPhase: "queued",
        vmPhase: "queued",
        progress: 8,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: true,
        outcome: "in_progress",
      };
    case "booting":
      return {
        runPhase: "provisioning",
        vmPhase: "booting",
        progress: 42,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: true,
        outcome: "in_progress",
      };
    case "waiting":
      return {
        runPhase: "active_partial",
        vmPhase: "ready",
        progress: 66,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: true,
        outcome: "in_progress",
      };
    case "solved":
      return {
        runPhase: "solved",
        vmPhase: "solved",
        progress: 100,
        terminal: "ready",
        canOpenTerminal: true,
        canDestroy: true,
        outcome: "in_progress",
      };
    case "failed":
      return {
        runPhase: "failed",
        vmPhase: "failed",
        progress: 55,
        terminal: "failed",
        canOpenTerminal: false,
        canDestroy: true,
        outcome: "failed",
      };
    case "ending":
      return {
        runPhase: "teardown_requested",
        vmPhase: "destroying",
        progress: 88,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: false,
        outcome: "in_progress",
      };
    case "rendering":
      return {
        runPhase: "archiving",
        vmPhase: "archived",
        progress: 96,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: false,
        outcome: "in_progress",
      };
    case "archived":
    case "replay-failed":
    case "replay":
      return {
        runPhase: "completed",
        vmPhase: "completed",
        progress: 100,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: false,
        outcome: "succeeded",
      };
    case "running":
    case "disconnected":
      return {
        runPhase: "active_full",
        vmPhase: "ready",
        progress: 72,
        terminal: "ready",
        canOpenTerminal: true,
        canDestroy: true,
        outcome: "in_progress",
      };
  }
}
