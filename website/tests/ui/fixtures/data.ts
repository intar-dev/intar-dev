import type { SessionRole } from "./sessions";

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
  | "archived"
  | "replay";

export type TerminalMode = "connected" | "disconnected" | "error";

export interface MockApiState {
  sessionRole: SessionRole;
  variant: DataVariant;
  runState: RunFixtureState;
  terminalMode: TerminalMode;
  scenarios: Array<Record<string, unknown>>;
  scenarioDetail: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  run: Record<string, unknown>;
  teams: Array<Record<string, unknown>>;
  invites: Array<Record<string, unknown>>;
  teamDetail: Record<string, unknown>;
  assignments: Array<Record<string, unknown>>;
  progress: Record<string, unknown>;
  sshKeys: Array<Record<string, unknown>>;
  accessRequests: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  adminTeams: Array<Record<string, unknown>>;
  hosts: Array<Record<string, unknown>>;
  hostRuns: Record<string, unknown>;
  adminScenarios: Array<Record<string, unknown>>;
  adminScenarioDetail: Record<string, unknown>;
  builds: Array<Record<string, unknown>>;
  buildDetails: Record<string, Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  sourceHcl: string;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const sha = "a".repeat(64);
const kernelSha = "b".repeat(64);
const initrdSha = "c".repeat(64);

const objectives = [
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

const scenarioHints = [
  {
    id: "hint-service",
    title: "Start at the service boundary",
    body_markdown: "Inspect the service unit and recent logs before changing files.",
  },
];

const scenarioVm = {
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

const scenarioProbes = [
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

const briefing = {
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

function catalogScenario(input: {
  scenarioId: string;
  title: string;
  tagline: string;
  difficulty: "easy" | "medium" | "hard";
  category: string;
  tags: string[];
  status: "new" | "in_progress" | "attempted" | "completed";
  activeRunId?: string | null;
}) {
  return {
    scenarioId: input.scenarioId,
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

function runListEntry(input: {
  runId: string;
  title: string;
  phase: string;
  outcome: string;
  active: boolean;
  createdAt: number;
  solvedAt?: number | null;
  hasReplay?: boolean;
}) {
  return {
    runId: input.runId,
    scenarioId: "repair-nginx",
    scenarioName: "repair-nginx",
    title: input.title,
    difficulty: "medium",
    phase: input.phase,
    outcome: input.outcome,
    active: input.active,
    createdAt: input.createdAt,
    finishedAt: input.active ? null : input.createdAt + 31 * minute,
    solvedAt: input.solvedAt ?? null,
    solveDurationMs:
      input.solvedAt == null ? null : input.solvedAt - input.createdAt,
    solutionAssisted: false,
    hasReplay: input.hasReplay ?? false,
  };
}

function runLifecycle(state: RunFixtureState) {
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
        runPhase: "archiving",
        vmPhase: "archived",
        progress: 96,
        terminal: "pending",
        canOpenTerminal: false,
        canDestroy: false,
        outcome: "in_progress",
      };
    case "archived":
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

export function makeRun(state: RunFixtureState): Record<string, unknown> {
  const lifecycle = runLifecycle(state);
  const complete = state === "archived" || state === "replay";
  const solved = state === "solved" || complete;
  const ready = lifecycle.terminal === "ready";
  const bootProbe = {
    id: "boot-ready",
    label: "Machine ready",
    kind: "systemd_unit",
    phase: "boot",
    status: ready || complete || solved ? "pass" : "pending",
    error: state === "failed" ? "guest stopped during boot" : null,
    value: ready ? { state: "active", service: "sshd" } : null,
  };
  const repairProbe = {
    id: "nginx-listening",
    label: "nginx listens on port 80",
    kind: "tcp_connect",
    phase: "scenario",
    status: solved ? "pass" : "fail",
    error: solved ? null : "connection refused on 127.0.0.1:80",
    value: { host: "127.0.0.1", port: 80 },
  };
  const healthProbe = {
    id: "health-endpoint",
    label: "health endpoint returns ok",
    kind: "http_request",
    phase: "scenario",
    status: solved ? "pass" : "pending",
    error: null,
    value: solved ? { state: "healthy" } : null,
  };
  const terminalTarget = {
    host: ready ? "10.40.0.18" : null,
    port: ready ? 22 : 0,
    username: "root",
    hostKeyOpenssh: ready ? `ssh-ed25519 ${"A".repeat(68)}` : null,
    checkedAt: ready ? FIXED_NOW - minute : null,
  };
  const replayArtifacts =
    state === "replay"
      ? [
          {
            id: "artifact-cast-1",
            hostId: "host-eu-1",
            runId: "run-active",
            vmId: "run-vm-web",
            kind: "asciicast",
            filename: "session.cast",
            contentType: "application/x-asciicast",
            sizeBytes: 512,
          },
        ]
      : [];

  return {
    id: "run-active",
    scenarioId: "repair-nginx",
    scenarioName: "repair-nginx",
    title: briefing.title,
    tagline: briefing.tagline,
    briefingMarkdown: briefing.briefingMarkdown,
    objectives,
    tags: briefing.tags,
    hints: [
      {
        key: "scenario:hint-1",
        scope: "scenario",
        probeName: null,
        id: "hint-1",
        title: null,
        revealed: false,
        unlocked: true,
        bodyMarkdown: null,
      },
      {
        key: "probe:nginx-listening:hint-1",
        scope: "probe",
        probeName: "nginx-listening",
        id: "hint-nginx-1",
        title: null,
        revealed: false,
        unlocked: true,
        bodyMarkdown: null,
      },
    ],
    solution: {
      unlocked: true,
      revealed: complete,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: complete
        ? "Restore the nginx unit, validate its configuration, and restart it."
        : null,
    },
    difficulty: briefing.difficulty,
    estimatedMinutes: briefing.estimatedMinutes,
    solvedAt: solved ? FIXED_NOW - 12 * minute : null,
    solveDurationMs: solved ? 23 * minute : null,
    outcome: lifecycle.outcome,
    createdAt: FIXED_NOW - 35 * minute,
    updatedAt: FIXED_NOW - minute,
    phase: lifecycle.runPhase,
    phaseTitle: lifecycle.runPhase,
    phaseDetail:
      state === "failed"
        ? "The host reported a terminal failure."
        : "The control plane is reconciling the run.",
    progressPercent: lifecycle.progress,
    terminalPhase: lifecycle.terminal,
    canOpenTerminal: lifecycle.canOpenTerminal,
    canDestroy: lifecycle.canDestroy,
    bootProbes: [bootProbe],
    scenarioProbes: [repairProbe, healthProbe],
    replayArtifacts,
    terminalTarget,
    vms: [
      {
        id: "run-vm-web",
        ordinal: 0,
        scenarioVmId: "vm-web",
        scenarioVmName: "web",
        runtimeVmName: "repair-nginx-web-7f3a",
        hostname: "web",
        phase: lifecycle.vmPhase,
        phaseTitle: lifecycle.vmPhase,
        phaseDetail: "System state reported by the workshop host.",
        progressPercent: lifecycle.progress,
        terminalPhase: lifecycle.terminal,
        terminalReason: state === "failed" ? "guest failed" : null,
        terminalObservedAt: ready ? FIXED_NOW - minute : null,
        canOpenTerminal: lifecycle.canOpenTerminal,
        bootProbes: [bootProbe],
        scenarioProbes: [repairProbe, healthProbe],
        replayArtifacts,
        sessionTimeline:
          state === "replay"
            ? [
                {
                  index: 0,
                  startTimestampMs: FIXED_NOW - 30 * minute,
                  durationMs: 18 * minute,
                  exitCode: 0,
                  castFilename: "session.cast",
                  castArtifactId: "artifact-cast-1",
                  transcriptTruncated: false,
                },
              ]
            : null,
        hasRecording: state === "replay",
        terminalTarget,
        guestIp: ready ? "10.40.0.18" : null,
        launchSummary: {
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: {
            "boot-ready": "boot",
            "nginx-listening": "scenario",
            "health-endpoint": "scenario",
          },
          probeDescriptors: [
            {
              id: "boot-ready",
              label: "Machine ready",
              kind: "systemd_unit",
              phase: "boot",
            },
            {
              id: "nginx-listening",
              label: "nginx listens on port 80",
              kind: "tcp_connect",
              phase: "scenario",
            },
            {
              id: "health-endpoint",
              label: "health endpoint returns ok",
              kind: "http_request",
              phase: "scenario",
            },
          ],
        },
        runtimeState: ready ? "running" : lifecycle.vmPhase,
        runtimeObservedAt: FIXED_NOW - minute,
        vmCreatedAt: FIXED_NOW - 33 * minute,
        provisioning: {
          image: "debian-13",
          imageKey: scenarioVm.imageKey,
          imageSha256: sha,
          resources: { vcpus: 2, memoryMib: 2048, diskMib: 8192 },
          leaseDurationSeconds: 7200,
          groupName: "learner",
          groupId: "group-learner",
          setupKeyId: "setup-key-1",
          status: ready ? "provisioning" : "pending",
          error: state === "failed" ? "guest stopped" : null,
        },
      },
    ],
  };
}

function makeHost() {
  return {
    id: "host-eu-1",
    name: "workshop-eu-1",
    role: "agent",
    disabled: false,
    scenarioEnabled: true,
    createdAt: FIXED_NOW - 90 * day,
    updatedAt: FIXED_NOW - minute,
    status: {
      hostId: "host-eu-1",
      connected: true,
      lastHeartbeatAt: new Date(FIXED_NOW - 20_000).toISOString(),
      agentVersion: "0.8.0",
      activeSessionId: "bridge-session-1",
      inventoryVmCount: 1,
    },
    actualState: {
      appliedDesiredVersion: 42,
      observedAt: FIXED_NOW - 20_000,
      health: "healthy",
      capacity: {
        cpu_count: 16,
        memory_total_mib: 32768,
        memory_available_mib: 24576,
        disk_probe_path: "/var/lib/intar",
        disk_total_mib: 512000,
        disk_available_mib: 412000,
        load_avg_1m: 0.64,
        load_avg_5m: 0.52,
        load_avg_15m: 0.41,
        primary_ipv4: "192.0.2.18",
        primary_ipv6: "2001:db8::18",
      },
    },
  };
}

function makeHostRuns() {
  return {
    liveVms: [
      {
        id: "run-vm-web",
        name: "repair-nginx-web-7f3a",
        state: "ready",
        created_at: new Date(FIXED_NOW - 35 * minute).toISOString(),
        updated_at: new Date(FIXED_NOW - minute).toISOString(),
        error: null,
        run_id: "run-active",
        probe_state: {
          collection_state: "ready",
          collection_error: null,
          generated_at: new Date(FIXED_NOW - minute).toISOString(),
          updated_at: new Date(FIXED_NOW - minute).toISOString(),
          summary: { total: 2, pass: 0, fail: 1, unknown: 1 },
          probes: [],
        },
        terminal_target: {
          state: "ready",
          reason: null,
          host: "10.40.0.18",
          port: 22,
          username: "root",
          checkedAt: FIXED_NOW - minute,
        },
        scenario_meta: {
          scenarioName: "repair-nginx",
          scenarioDescription: briefing.tagline,
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: { "nginx-listening": "scenario" },
        },
        details: { guest_ip: "10.40.0.18" },
      },
    ],
    archivedRuns: [
      {
        id: "run-archived",
        hostId: "host-eu-1",
        userId: "user-learner",
        vmName: "repair-nginx-web-5c91",
        state: "completed",
        outcome: "succeeded",
        solvedAt: FIXED_NOW - 2 * day,
        solveDurationMs: 26 * minute,
        uploadStatus: "completed",
        vmCreatedAt: FIXED_NOW - 2 * day - 30 * minute,
        deleteRequestedAt: FIXED_NOW - 2 * day,
        deletedAt: FIXED_NOW - 2 * day,
        uploadStartedAt: FIXED_NOW - 2 * day,
        uploadCompletedAt: FIXED_NOW - 2 * day + minute,
        uploadError: null,
        createdAt: FIXED_NOW - 2 * day - 30 * minute,
        updatedAt: FIXED_NOW - 2 * day,
        events: [
          {
            id: "event-1",
            kind: "completed",
            message: "Run archived successfully",
            createdAt: FIXED_NOW - 2 * day,
          },
        ],
        artifacts: [
          {
            id: "artifact-log-1",
            ordinal: 0,
            kind: "console_log",
            filename: "run.log",
            contentType: "text/plain",
            sizeBytes: 420,
            sha256: sha,
            uploadStatus: "uploaded",
            uploadedAt: FIXED_NOW - 2 * day,
          },
        ],
        scenarioMeta: {
          scenarioName: "repair-nginx",
          scenarioDescription: briefing.tagline,
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: { "nginx-listening": "scenario" },
        },
      },
    ],
  };
}

function makeAdminScenario(enabled = true) {
  return {
    scenarioId: "repair-nginx",
    title: briefing.title,
    category: briefing.category,
    description: briefing.tagline,
    difficulty: briefing.difficulty,
    estimatedMinutes: briefing.estimatedMinutes,
    tags: briefing.tags,
    scenarioHintCount: 1,
    probeCount: scenarioProbes.length,
    vmCount: 1,
    enabled,
    enabledAt: enabled ? FIXED_NOW - 45 * day : null,
    createdAt: FIXED_NOW - 60 * day,
    updatedAt: FIXED_NOW - 2 * day,
  };
}

function makeBuild(status: string, id: string) {
  return {
    id,
    scenarioId: id === "build-2" ? "repair-dns" : "repair-nginx",
    arch: "x86_64",
    rev: "rev-20260710-01",
    contentHash: sha,
    kinoVersion: "0.8.0",
    hostId: status === "queued" ? null : "host-builder-1",
    hostName: status === "queued" ? null : "builder-eu-1",
    status,
    phase: status === "failed" ? "failed" : status === "succeeded" ? "done" : "building",
    attempt: 1,
    error: status === "failed" ? "qemu image conversion exited with code 1" : null,
    canRetry: status === "failed",
    hasLog: status !== "queued",
    timings: {
      queuedAt: FIXED_NOW - 20 * minute,
      startedAt: status === "queued" ? null : FIXED_NOW - 18 * minute,
      finishedAt: ["failed", "succeeded"].includes(status)
        ? FIXED_NOW - 2 * minute
        : null,
      lastReportAt: status === "queued" ? null : FIXED_NOW - minute,
    },
    bundleR2Key: `bundles/${id}.tar.zst`,
    createdAt: FIXED_NOW - 20 * minute,
    updatedAt: FIXED_NOW - minute,
  };
}

export function createMockApiState(input?: {
  sessionRole?: SessionRole;
  variant?: DataVariant;
  runState?: RunFixtureState;
}): MockApiState {
  const sessionRole = input?.sessionRole ?? "learner";
  const variant = input?.variant ?? "populated";
  const runState = input?.runState ?? "running";
  const empty = variant === "empty";
  const long = variant === "long";
  const run = makeRun(runState);
  const scenarios = [
    catalogScenario({
      scenarioId: "repair-nginx",
      title: briefing.title,
      tagline: long
        ? `${briefing.tagline} The learner must preserve traffic, explain the failure boundary, and verify every recovery assumption before handing the service back to operations.`
        : briefing.tagline,
      difficulty: "medium",
      category: briefing.category,
      tags: briefing.tags,
      status: "in_progress",
      activeRunId: "run-active",
    }),
    catalogScenario({
      scenarioId: "repair-dns",
      title: "Trace an intermittent DNS failure",
      tagline: "Requests fail only from one resolver path.",
      difficulty: "hard",
      category: "Networking",
      tags: ["dns", "networking", "observability"],
      status: "new",
    }),
    catalogScenario({
      scenarioId: "recover-postgres",
      title: "Recover a read-only PostgreSQL node",
      tagline: "A storage alert left application writes blocked.",
      difficulty: "easy",
      category: "Databases",
      tags: ["postgresql", "storage"],
      status: "completed",
    }),
  ];
  const runs = [
    runListEntry({
      runId: "run-active",
      title: briefing.title,
      phase: "active_full",
      outcome: "in_progress",
      active: true,
      createdAt: FIXED_NOW - 35 * minute,
    }),
    runListEntry({
      runId: "run-replay",
      title: "Trace an intermittent DNS failure",
      phase: "completed",
      outcome: "succeeded",
      active: false,
      createdAt: FIXED_NOW - 2 * day,
      solvedAt: FIXED_NOW - 2 * day + 42 * minute,
      hasReplay: true,
    }),
    runListEntry({
      runId: "run-failed",
      title: "Recover a read-only PostgreSQL node",
      phase: "failed",
      outcome: "failed",
      active: false,
      createdAt: FIXED_NOW - 9 * day,
    }),
  ];
  const host = makeHost();
  const hostRuns = makeHostRuns();
  const adminScenario = makeAdminScenario(true);
  const builds = [
    makeBuild("building", "build-1"),
    makeBuild("failed", "build-2"),
    makeBuild("succeeded", "build-3"),
  ];
  const teamDetail = {
    id: "team-platform",
    name: long
      ? "Production Reliability Learning Guild for Distributed Platform Operations"
      : "Platform Repair Crew",
    slug: "platform-repair-crew",
    createdAt: FIXED_NOW - 30 * day,
    role: sessionRole === "team-member" ? "member" : "owner",
    members: [
      {
        memberId: "member-owner",
        userId: "user-owner",
        name: "Owen Owner",
        githubUsername: "owenowns",
        role: "owner",
        joinedAt: FIXED_NOW - 30 * day,
      },
      {
        memberId: "member-learner",
        userId: "user-learner",
        name: "Mina Learner",
        githubUsername: "minalearns",
        role: "member",
        joinedAt: FIXED_NOW - 12 * day,
      },
      {
        memberId: "member-instructor",
        userId: "user-instructor",
        name: "Inez Instructor",
        githubUsername: "inezinfra",
        role: "admin",
        joinedAt: FIXED_NOW - 20 * day,
      },
    ],
    invites: [
      {
        id: "invite-pending",
        githubUsername: "futureoperator",
        status: "pending",
        createdAt: FIXED_NOW - day,
      },
    ],
  };

  return {
    sessionRole,
    variant,
    runState,
    terminalMode:
      runState === "disconnected"
        ? "disconnected"
        : runState === "failed"
          ? "error"
          : "connected",
    scenarios: empty ? [] : scenarios,
    scenarioDetail: {
      scenarioId: "repair-nginx",
      slug: "repair-nginx",
      enabledAt: FIXED_NOW - 45 * day,
      scenarioName: "repair-nginx",
      briefing,
      vmCount: 1,
      hasActiveRun: !empty,
      activeRunId: empty ? null : "run-active",
      activeRun: empty
        ? null
        : {
            runId: "run-active",
            phase: "active_full",
            phaseTitle: "Running",
            phaseDetail: "Shell ready",
            canOpenTerminal: true,
            terminalPhase: "ready",
            updatedAt: FIXED_NOW - minute,
          },
      blockingRun: null,
      finishedRuns: empty
        ? []
        : [
            {
              runId: "run-replay",
              phase: "completed",
              outcome: "succeeded",
              createdAt: FIXED_NOW - 2 * day,
              finishedAt: FIXED_NOW - 2 * day + 31 * minute,
              solvedAt: FIXED_NOW - 2 * day + 26 * minute,
              solveDurationMs: 26 * minute,
              solutionAssisted: false,
              hasReplay: true,
            },
          ],
    },
    runs: empty ? [] : runs,
    run,
    teams: empty
      ? []
      : [
          {
            id: "team-platform",
            name: teamDetail.name,
            slug: teamDetail.slug,
            role: teamDetail.role,
            memberCount: teamDetail.members.length,
            createdAt: teamDetail.createdAt,
          },
        ],
    invites: empty
      ? []
      : [
          {
            id: "invite-team-2",
            organizationId: "team-kernel",
            teamName: "Kernel Study Group",
            createdAt: FIXED_NOW - 3 * hour,
          },
        ],
    teamDetail,
    assignments: empty
      ? []
      : [
          {
            id: "assignment-nginx",
            assignmentId: "assignment-nginx",
            scenarioId: "repair-nginx",
            scenarioTitle: briefing.title,
            teamId: "team-platform",
            teamName: teamDetail.name,
            assignedAt: FIXED_NOW - 7 * day,
            createdAt: FIXED_NOW - 7 * day,
          },
        ],
    progress: {
      scenarios: empty
        ? []
        : [{ scenarioId: "repair-nginx", title: briefing.title }],
      rows: empty
        ? []
        : teamDetail.members.map((member, index) => ({
            userId: member.userId,
            name: member.name,
            githubUsername: member.githubUsername,
            cells: [
              {
                scenarioId: "repair-nginx",
                status: index === 0 ? "solved" : index === 1 ? "in_progress" : "assisted",
                solveDurationMs: index === 0 ? 24 * minute : null,
                runId: index === 1 ? "run-active" : "run-replay",
              },
            ],
          })),
    },
    sshKeys: empty
      ? []
      : [
          {
            id: "key-1",
            label: "Workshop laptop",
            keyType: "ssh-ed25519",
            comment: "mina@workshop",
            publicKeyOpenssh: `ssh-ed25519 ${"A".repeat(68)} mina@workshop`,
            fingerprintSha256: "SHA256:TestOnlyFingerprintForVisualFixtures",
            createdAt: FIXED_NOW - 20 * day,
          },
        ],
    accessRequests: empty
      ? []
      : [
          {
            id: "access-1",
            githubUsername: "newoperator",
            note: "Preparing for an on-call rotation.",
            status: "pending",
            decidedBy: null,
            decidedAt: null,
            createdAt: FIXED_NOW - 2 * hour,
          },
          {
            id: "access-2",
            githubUsername: "approvedlearner",
            note: null,
            status: "approved",
            decidedBy: "user-admin",
            decidedAt: FIXED_NOW - day,
            createdAt: FIXED_NOW - 2 * day,
          },
        ],
    users: empty
      ? []
      : [
          {
            id: "user-learner",
            name: "Mina Learner",
            email: "minalearns@example.test",
            emailVerified: true,
            image: null,
            username: "minalearns",
            role: "user",
            banned: false,
            createdAt: new Date(FIXED_NOW - 80 * day).toISOString(),
            updatedAt: new Date(FIXED_NOW - day).toISOString(),
          },
          {
            id: "user-instructor",
            name: "Inez Instructor",
            email: "inezinfra@example.test",
            emailVerified: true,
            image: null,
            username: "inezinfra",
            role: "user",
            banned: false,
            createdAt: new Date(FIXED_NOW - 70 * day).toISOString(),
            updatedAt: new Date(FIXED_NOW - day).toISOString(),
          },
        ],
    adminTeams: empty
      ? []
      : [
          {
            id: "team-platform",
            name: teamDetail.name,
            slug: teamDetail.slug,
            createdAt: teamDetail.createdAt,
            memberCount: teamDetail.members.length,
            assignmentCount: 1,
            owner: { name: "Owen Owner", username: "owenowns" },
          },
        ],
    hosts: empty ? [] : [host],
    hostRuns: empty ? { liveVms: [], archivedRuns: [] } : hostRuns,
    adminScenarios: empty
      ? []
      : [adminScenario, { ...makeAdminScenario(false), scenarioId: "repair-dns", title: "Trace an intermittent DNS failure" }],
    adminScenarioDetail: {
      ...adminScenario,
      briefingMarkdown: briefing.briefingMarkdown,
      solutionMarkdown:
        "Validate `/etc/nginx/nginx.conf`, restore the service unit, and restart nginx.",
      hints: scenarioHints,
      probes: scenarioProbes,
      vms: [scenarioVm],
    },
    builds: empty ? [] : builds,
    buildDetails: Object.fromEntries(
      builds.map((build) => [
        build.id,
        {
          ...build,
          host:
            build.hostId == null
              ? null
              : {
                  id: build.hostId,
                  name: build.hostName,
                  role: "builder",
                  connected: true,
                  lastHeartbeatAt: FIXED_NOW - minute,
                },
          bundle: {
            rev: build.rev,
            r2Key: build.bundleR2Key,
            kinoVersion: build.kinoVersion,
            meta: { fixture: true },
          },
        },
      ]),
    ),
    sources: empty
      ? []
      : [
          {
            id: "repair-nginx",
            scenarioId: "repair-nginx",
            status: "draft",
            createdBy: "user-admin",
            createdAt: FIXED_NOW - 4 * day,
            updatedAt: FIXED_NOW - 30 * minute,
          },
        ],
    sourceHcl: `scenario "repair-nginx" {\n  title = "Repair nginx"\n  category = "Linux services"\n}\n`,
  };
}
