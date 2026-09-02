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

export type TerminalMode =
  | "connected"
  | "disconnected"
  | "error"
  | "delayed-first-ready";

export type CourseLectureFixtureState =
  | "locked"
  | "available"
  | "waiting_for_scenario"
  | "in_progress"
  | "completed";

export interface CourseLectureFixture {
  lectureId: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  category: string;
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  scenarioId: string | null;
  state: CourseLectureFixtureState;
  blockedBy: { courseId: string; lectureId: string; title: string } | null;
  activeRunId: string | null;
  scenarioReady: boolean | null;
}

export interface CourseFixture {
  courseId: string;
  organizationId: string | null;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sequential: boolean;
  lectures: CourseLectureFixture[];
}

export interface MockApiState {
  sessionRole: SessionRole;
  variant: DataVariant;
  runState: RunFixtureState;
  terminalMode: TerminalMode;
  capacityPressure: number | null;
  courseCatalog: CourseFixture[];
  organizationCourseCatalog: CourseFixture[];
  runs: Array<Record<string, unknown>>;
  run: Record<string, unknown>;
  organizations: Array<Record<string, unknown>>;
  organizationCreation: Record<string, unknown>;
  organizationDetail: Record<string, unknown>;
  assignments: Array<Record<string, unknown>>;
  progress: Record<string, unknown>;
  sshKeys: Array<Record<string, unknown>>;
  accessInvites: Array<Record<string, unknown>>;
  betaUsers: Array<Record<string, unknown>>;
  betaClaim: Record<string, unknown>;
  users: Array<Record<string, unknown>>;
  adminOrganizations: Array<Record<string, unknown>>;
  organizationRunners: Array<Record<string, unknown>>;
  organizationOidc: Record<string, unknown> | null;
  hosts: Array<Record<string, unknown>>;
  hostRuns: Record<string, unknown>;
  adminScenarios: Array<Record<string, unknown>>;
  adminScenarioDetail: Record<string, unknown>;
  builds: Array<Record<string, unknown>>;
  buildDetails: Record<string, Record<string, unknown>>;
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
    title: "Start the web server",
    bodyMarkdown:
      "HIDDEN_OBJECTIVE_DETAIL: run `sudo systemctl restart internal-nginx`.",
    hintCount: 2,
  },
  {
    probeName: "health-endpoint",
    vmName: "web",
    label: "Return a healthy response",
    title: "Make the site reachable",
    bodyMarkdown: "HIDDEN_OBJECTIVE_PATH: inspect `/etc/internal/health`.",
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
    title: "Start the web server",
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
    title: "Make the site reachable",
    bodyMarkdown: objectives[1]?.bodyMarkdown ?? null,
    hints: [],
    phase: "scenario",
    kind: "http_request",
  },
];

export const briefing = {
  title: "Repair a broken nginx service",
  tagline: "Bring a stopped website back online.",
  category: "Linux services",
  difficulty: "medium",
  estimatedMinutes: 35,
  briefingMarkdown:
    "A routine change left the website down. Find what is wrong and get it working again.",
  tags: ["linux", "nginx", "systemd", "networking"],
  objectives,
};

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
