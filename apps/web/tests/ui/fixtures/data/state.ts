import type { SessionRole } from "../sessions";
import type { DataVariant, MockApiState, RunFixtureState } from "./shared";
import {
  FIXED_NOW,
  briefing,
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
    name: "agent-eu-1",
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
        ownerName: "Mina Learner",
        ownerUsername: "minalearns",
        vmName: "repair-nginx-web-5c91",
        state: "completed",
        outcome: "succeeded",
        solvedAt: FIXED_NOW - 2 * day,
        solveDurationMs: 26 * minute,
        uploadStatus: "complete",
        vmCreatedAt: FIXED_NOW - 2 * day - 30 * minute,
        deleteRequestedAt: FIXED_NOW - 2 * day,
        deletedAt: FIXED_NOW - 2 * day,
        uploadStartedAt: FIXED_NOW - 2 * day,
        uploadCompletedAt: FIXED_NOW - 2 * day + minute,
        uploadError: null,
        deleteBlockedReason: null,
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
            ordinal: 1,
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
    requiredResources: {
      cpuMillis: 2_000,
      vcpuCount: 2,
      memoryMib: scenarioVm.memoryMib,
      diskMib: scenarioVm.diskMib,
    },
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
      status === "failed"
        ? "qemu image conversion exited with code 1"
        : status === "stale"
          ? "superseded by bundle rev-20260710-02"
          : null,
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
  organizationRole?: "owner" | "admin" | "member";
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
  const nginxFinished = ["archived", "replay", "replay-failed"].includes(
    runState,
  );
  const nginxLectureState = nginxFinished
    ? "completed"
    : runIsForeground
      ? "in_progress"
      : "available";
  const nginxBlocker = {
    courseId: "operations",
    lectureId: "02-repair-nginx",
    title: "Repair a broken nginx service",
  };
  const courseCatalog: MockApiState["courseCatalog"] = [
    {
      courseId: "operations",
      organizationId: null,
      title: long
        ? "Linux operations for distributed service recovery and deliberate production handover"
        : "Linux operations",
      summary:
        "Learn service recovery theory before you repair a live system.",
      bodyMarkdown:
        "## How to use this course\n\nRead each lecture first. Then apply the idea in the linked scenario when it is ready.",
      sequential: true,
      lectures: [
        {
          lectureId: "01-operating-model",
          title: "Operating model",
          summary: "Use evidence before you change a live service.",
          bodyMarkdown:
            "## Observe first\n\nStart with the symptom, then narrow the fault boundary with evidence.",
          category: "Linux services",
          tags: ["linux", "operations"],
          estimatedMinutes: 10,
          scenarioId: null,
          state: "completed",
          blockedBy: null,
          activeRunId: null,
          scenarioReady: null,
        },
        {
          lectureId: "02-repair-nginx",
          title: briefing.title,
          summary: briefing.tagline,
          bodyMarkdown:
            "## Service recovery\n\nA web service depends on process state, configuration, and network reachability. Check each boundary in order.",
          category: briefing.category,
          tags: briefing.tags,
          difficulty: "medium",
          estimatedMinutes: briefing.estimatedMinutes,
          scenarioId: "repair-nginx",
          state: nginxLectureState,
          blockedBy: null,
          activeRunId: runIsForeground ? "run-active" : null,
          scenarioReady: true,
        },
        {
          lectureId: "03-trace-dns",
          title: "Trace an intermittent DNS failure",
          summary: "Separate resolver policy from the service symptom.",
          bodyMarkdown:
            "## Resolver paths\n\nCompare working and failing paths before you change resolver configuration.",
          category: "Networking",
          tags: ["dns", "networking", "observability"],
          difficulty: "hard",
          estimatedMinutes: 60,
          scenarioId: "repair-dns",
          state:
            nginxLectureState === "completed"
              ? "waiting_for_scenario"
              : "locked",
          blockedBy:
            nginxLectureState === "completed" ? null : nginxBlocker,
          activeRunId: null,
          scenarioReady: nginxLectureState === "completed" ? false : true,
        },
      ],
    },
    {
      courseId: "systems-concepts",
      organizationId: null,
      title: "Systems concepts",
      summary: "Read compact theory units at your own pace.",
      bodyMarkdown:
        "## Concepts before commands\n\nUse these short lectures to build a mental model before practice.",
      sequential: false,
      lectures: [
        {
          lectureId: "01-storage-alerts",
          title: "Storage alerts need context",
          summary: "A full filesystem can be a cause or a symptom.",
          bodyMarkdown:
            "## Storage pressure\n\nCheck capacity, inode use, and the process that owns the growth before you delete data.",
          category: "Databases",
          tags: ["postgresql", "storage"],
          difficulty: "easy",
          estimatedMinutes: 20,
          scenarioId: "recover-postgres",
          state: "waiting_for_scenario",
          blockedBy: null,
          activeRunId: null,
          scenarioReady: false,
        },
        {
          lectureId: "02-write-a-handoff",
          title: "Write a useful handoff",
          summary: "State what changed and the evidence that proves it.",
          bodyMarkdown:
            "## A useful handoff\n\nRecord the fault, the repair, and the checks that now pass.",
          category: "Operations",
          tags: ["operations", "communication"],
          estimatedMinutes: 10,
          scenarioId: null,
          state: "available",
          blockedBy: null,
          activeRunId: null,
          scenarioReady: null,
        },
      ],
    },
  ];
  const organizationCourseCatalog: MockApiState["organizationCourseCatalog"] = [
    ...courseCatalog,
    {
      courseId: "platform-repair",
      organizationId: "org-platform",
      title: "Platform repair sequence",
      summary: "Apply the team operating model to private platform services.",
      bodyMarkdown:
        "## Private platform work\n\nUse the same evidence-first method with organization-specific systems.",
      sequential: true,
      lectures: [
        {
          lectureId: "01-private-context",
          title: "Private service context",
          summary: "Identify the organization boundary before you investigate.",
          bodyMarkdown:
            "## Scope matters\n\nKnow which team owns the service and which evidence you can safely inspect.",
          category: "Platform operations",
          tags: ["organization", "operations"],
          estimatedMinutes: 10,
          scenarioId: null,
          state: "available",
          blockedBy: null,
          activeRunId: null,
          scenarioReady: null,
        },
        {
          lectureId: "02-logrotate",
          title: "Recover the platform log rotation job",
          summary: "Find why a private fleet policy filled the service volume.",
          bodyMarkdown:
            "## Growth and rotation\n\nConfirm whether the scheduler, policy, or filesystem caused the pressure.",
          category: "Platform operations",
          tags: ["linux", "storage", "organization"],
          difficulty: "medium",
          estimatedMinutes: 35,
          scenarioId: "platform-logrotate",
          state: "locked",
          blockedBy: {
            courseId: "platform-repair",
            lectureId: "01-private-context",
            title: "Private service context",
          },
          activeRunId: null,
          scenarioReady: true,
        },
      ],
    },
  ];
  const runs = [
    runListEntry({
      runId: "run-active",
      title: briefing.title,
      phase: String(run.phase),
      outcome: String(run.outcome),
      active: Boolean(run.active),
      activity: runActivity,
      replayState: run.replayState as
        | "not_started"
        | "preparing"
        | "ready"
        | "none"
        | "failed",
      hasReplay: Boolean(run.hasReplay),
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
    makeBuild("stale", "build-4"),
    makeBuild("building", "build-1"),
    makeBuild("failed", "build-2"),
    makeBuild("succeeded", "build-3"),
  ];
  const organizationDetail = {
    id: "org-platform",
    name: long
      ? "Production Reliability Learning Guild for Distributed Platform Operations"
      : "Platform Repair Crew",
    slug: "platform-repair-crew",
    createdAt: FIXED_NOW - 30 * day,
    role:
      input?.organizationRole ??
      (sessionRole === "organization-member" ? "member" : "owner"),
    members: [
      {
        memberId: "member-owner",
        userId: "user-owner",
        name: "Owen Owner",
        email: "owen@platform.example",
        githubUsername: "owenowns",
        role: "owner",
        joinedAt: FIXED_NOW - 30 * day,
      },
      {
        memberId: "member-learner",
        userId: "user-learner",
        name: "Mina Learner",
        email: "mina@platform.example",
        githubUsername: "minalearns",
        role: "member",
        joinedAt: FIXED_NOW - 12 * day,
      },
      {
        memberId: "member-instructor",
        userId: "user-instructor",
        name: "Inez Instructor",
        email: "inez@platform.example",
        githubUsername: "inezinfra",
        role: "admin",
        joinedAt: FIXED_NOW - 20 * day,
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
    capacityPressure: empty ? null : 68,
    courseCatalog: empty ? [] : courseCatalog,
    organizationCourseCatalog: empty ? [] : organizationCourseCatalog,
    runs: empty ? [] : runs,
    run,
    organizations: empty
      ? []
      : [
          {
            id: "org-platform",
            name: organizationDetail.name,
            slug: organizationDetail.slug,
            role: organizationDetail.role,
            memberCount: organizationDetail.members.length,
            createdAt: organizationDetail.createdAt,
          },
        ],
    organizationCreation: {
      enabled: false,
      reason: sessionRole === "owner" ? "owner_limit_reached" : "not_selected",
    },
    organizationDetail,
    assignments: empty
      ? []
      : [
          {
            id: "assignment-nginx",
            assignmentId: "assignment-nginx",
            scenarioId: "platform-logrotate",
            scenarioTitle: "Recover the platform log rotation job",
            organizationId: "org-platform",
            organizationName: organizationDetail.name,
            assignedAt: FIXED_NOW - 7 * day,
            createdAt: FIXED_NOW - 7 * day,
            courseLocation: {
              scope: "organization-private",
              organizationId: "org-platform",
              courseId: "platform-repair",
              courseTitle: "Platform repair sequence",
              lectureId: "02-logrotate",
              step: 2,
              steps: 2,
            },
          },
        ],
    progress: {
      scenarios: empty
        ? []
        : [{ scenarioId: "repair-nginx", title: briefing.title }],
      rows: empty
        ? []
        : organizationDetail.members.map((member, index) => ({
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
            label: "Training laptop",
            keyType: "ssh-ed25519",
            comment: "mina@training",
            publicKeyOpenssh: `ssh-ed25519 ${"A".repeat(68)} mina@training`,
            fingerprintSha256: "SHA256:TestOnlyFingerprintForVisualFixtures",
            createdAt: FIXED_NOW - 20 * day,
          },
        ],
    accessInvites: empty
      ? []
      : [
          {
            id: "invite-pending",
            codePrefix: "intar_beta_AAAAAAAA",
            state: "active",
            createdAt: FIXED_NOW - 2 * hour,
            expiresAt: FIXED_NOW + 7 * day - 2 * hour,
            completedAt: null,
            redeemerGithubUsername: null,
            version: 1,
          },
          {
            id: "invite-redeemed",
            codePrefix: "intar_beta_BBBBBBBB",
            state: "redeemed",
            createdAt: FIXED_NOW - 2 * day,
            expiresAt: FIXED_NOW + 5 * day,
            completedAt: FIXED_NOW - day,
            redeemerGithubUsername: "minalearns",
            version: 3,
          },
        ],
    betaUsers: empty
      ? []
      : [
          {
            userId: "user-learner",
            name: "Mina Learner",
            role: "user",
            state: "active",
            githubAccountId: "github-account-learner",
            githubUsername: "minalearns",
            sourceInviteId: "invite-redeemed",
            grantedBy: "user-admin",
            grantReason: "beta_invite",
            grantedAt: FIXED_NOW - day,
            revocationId: null,
            revokedBy: null,
            revocationReason: null,
            revokedAt: null,
            revocationCleanupCompletedAt: null,
          },
          {
            userId: "user-blocked",
            name: "Blake Blocked",
            role: "user",
            state: "revoked",
            githubAccountId: "github-account-blocked",
            githubUsername: "blakeblocked",
            sourceInviteId: "invite-old",
            grantedBy: "user-admin",
            grantReason: "beta_invite",
            grantedAt: FIXED_NOW - 10 * day,
            revocationId: "revocation-blocked",
            revokedBy: "user-admin",
            revocationReason: "policy_violation",
            revokedAt: FIXED_NOW - 3 * day,
            revocationCleanupCompletedAt: FIXED_NOW - 3 * day,
          },
        ],
    betaClaim: {
      state: "ready",
      expiresAt: FIXED_NOW + 7 * day - 2 * hour,
    },
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
    adminOrganizations: empty
      ? []
      : [
          {
            id: "org-platform",
            name: organizationDetail.name,
            slug: organizationDetail.slug,
            createdAt: organizationDetail.createdAt,
            memberCount: organizationDetail.members.length,
            assignmentCount: 1,
            owner: { name: "Owen Owner", username: "owenowns" },
          },
        ],
    organizationRunners: empty
      ? []
      : [
          {
            id: "platform-runner-a1b2",
            name: "platform-runner",
            role: "agent",
            disabled: false,
            scenarioEnabled: true,
            createdAt: FIXED_NOW - 10 * day,
            updatedAt: FIXED_NOW - minute,
            status: {
              connected: true,
              lastHeartbeatAt: new Date(FIXED_NOW - minute).toISOString(),
              agentVersion: "0.1.0",
              inventoryVmCount: 2,
            },
            recentRuns: [],
          },
        ],
    organizationOidc: {
      providerId: "org-provider-1",
      issuer: "https://id.platform.example",
      domain: "platform.example",
      domainVerified: true,
      callbackUrl: "https://intar.dev/api/auth/sso/callback/org-provider-1",
      clientIdLastFour: "****demo",
      pkce: true,
      scopes: ["openid", "email", "profile", "offline_access"],
      verification: null,
    },
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
            meta: { fixture: true },
          },
        },
      ]),
    ),
  };
}
