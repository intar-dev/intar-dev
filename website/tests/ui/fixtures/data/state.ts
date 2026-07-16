import type { SessionRole } from "../sessions";
import type { DataVariant, MockApiState, RunFixtureState } from "./shared";
import {
  FIXED_NOW,
  briefing,
  catalogScenario,
  day,
  hour,
  minute,
  runListEntry,
  scenarioHints,
  scenarioProbes,
  scenarioVm,
  sha,
} from "./shared";
import { makeRun } from "./run";

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
        total_cpu_millis: 16_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: 15_000,
        committed_cpu_millis: 2_000,
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
    phase:
      status === "failed"
        ? "failed"
        : status === "succeeded"
          ? "done"
          : "building",
    attempt: 1,
    error:
      status === "failed" ? "qemu image conversion exited with code 1" : null,
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
  const runActivity = run.activity as "foreground" | "background" | "settled";
  const runIsForeground = runActivity === "foreground";
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
      status: runIsForeground ? "in_progress" : "attempted",
      activeRunId: runIsForeground ? "run-active" : null,
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
      phase: String(run.phase),
      outcome: String(run.outcome),
      active: Boolean(run.active),
      activity: runActivity,
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
      hasActiveRun: !empty && runIsForeground,
      activeRunId: !empty && runIsForeground ? "run-active" : null,
      activeRun: empty || !runIsForeground
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
              replayState: "ready",
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
                status:
                  index === 0
                    ? "solved"
                    : index === 1
                      ? "in_progress"
                      : "assisted",
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
      : [
          adminScenario,
          {
            ...makeAdminScenario(false),
            scenarioId: "repair-dns",
            title: "Trace an intermittent DNS failure",
          },
        ],
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
