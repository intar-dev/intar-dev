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
  const courses = [
    {
      courseId: "operations",
      organizationId: null,
      title: long
        ? "Linux operations for distributed service recovery and deliberate production handover"
        : "Linux operations",
      description: long
        ? "Practice tracing service failures from the network edge through resolver policy, host networking, process supervision, persistent storage, and the final production handover without skipping verification evidence."
        : "Practice tracing service failures from the network edge to the process boundary.",
      scenarioIds: ["repair-nginx", "repair-dns"],
    },
  ];
  const organizationScenarios = [
    ...scenarios,
    catalogScenario({
      scenarioId: "platform-logrotate",
      organizationId: "org-platform",
      title: "Recover the platform log rotation job",
      tagline: "A private fleet policy filled the service volume overnight.",
      difficulty: "medium",
      category: "Platform operations",
      tags: ["linux", "storage", "organization"],
      status: "new",
    }),
    catalogScenario({
      scenarioId: "platform-firewall",
      organizationId: "org-platform",
      title: "Trace a private firewall regression",
      tagline: "A fleet-only policy blocks east-west service traffic.",
      difficulty: "hard",
      category: "Platform networking",
      tags: ["networking", "firewall", "organization"],
      status: "new",
    }),
  ];
  const organizationCourses = [
    {
      ...courses[0],
      scenarioIds: ["repair-dns"],
    },
    {
      courseId: "operations",
      organizationId: "org-platform",
      title: "Platform repair sequence",
      description:
        "Work through the public service repair before applying the crew's private fleet policy.",
      scenarioIds: ["repair-nginx", "platform-logrotate"],
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
  const facilitator = ["instructor", "owner", "global-admin"].includes(
    sessionRole,
  );
  const workshopModules = [
    {
      id: "00",
      ordinal: 0,
      title: "Preflight and workspace setup",
      outcome:
        "Confirm the local toolchain and dedicated workspace are ready before the room starts.",
      tier: "gate",
      durationMinutes: 20,
      dependsOn: [],
      state: "verified",
      health: "passing",
      released: true,
      contentMarkdown:
        "Check that your terminal opens, then run `./verify.sh 00`. Keep this workspace for the entire workshop.",
      facilitatorNotesMarkdown:
        "Resolve access failures before starting the shared timer.",
      solutionMarkdown: null,
      solutionRevealed: false,
      explainBackPrompt: null,
      explainBackCompletedAt: null,
      verifiedAt: FIXED_NOW - 30 * minute,
      hints: [],
      probes: [
        {
          id: "workspace-ready",
          label: "Workspace accepts terminal sessions",
          status: "pass",
          detail: "Debian 13 · generation 1",
        },
      ],
    },
    {
      id: "01",
      ordinal: 1,
      title: "Talos and Cilium foundations",
      outcome:
        "Boot a Talos cluster and prove that Cilium owns pod networking.",
      tier: "core",
      durationMinutes: 35,
      dependsOn: ["00"],
      state: "working",
      health: "failing",
      released: true,
      contentMarkdown:
        "## Work order\n\nBring up the cluster, then inspect the Cilium agents before changing any defaults. Treat every AI suggestion as a hypothesis to verify.\n\n1. Create the cluster.\n2. Wait for the control plane.\n3. Verify Cilium connectivity.",
      facilitatorNotesMarkdown:
        "At minute 25, walk the room through the control-plane health check. Do not reveal the solution before the final five minutes.",
      solutionMarkdown:
        "Run the pinned bootstrap command, wait for all Talos members, then use `cilium status --wait`.",
      solutionRevealed: false,
      explainBackPrompt:
        "Explain which layer owns pod networking and show the evidence you used.",
      explainBackCompletedAt: null,
      verifiedAt: null,
      hints: [
        {
          id: "01-hint-control-plane",
          title: "Separate boot from networking",
          bodyMarkdown: null,
          revealed: false,
        },
        {
          id: "01-hint-cilium",
          title: "Ask Cilium for its own health",
          bodyMarkdown:
            "Start with `cilium status --wait` and inspect the first failing subsystem.",
          revealed: true,
        },
      ],
      probes: [
        {
          id: "talos-members",
          label: "All Talos members report ready",
          status: "pass",
          detail: "3/3 members ready",
        },
        {
          id: "cilium-connectivity",
          label: "Cilium connectivity test passes",
          status: "fail",
          detail: "DNS egress policy denies one path",
        },
      ],
    },
    {
      id: "02",
      ordinal: 2,
      title: "Gitea and Argo CD",
      outcome:
        "Establish a GitOps reconciliation loop from Gitea into the cluster.",
      tier: "core",
      durationMinutes: 35,
      dependsOn: ["01"],
      state: "locked",
      health: "unknown",
      released: false,
      contentMarkdown: null,
      facilitatorNotesMarkdown: "Release after module 01 explain-back.",
      solutionMarkdown:
        "Register the repository and wait for Argo CD to report Synced and Healthy.",
      solutionRevealed: false,
      explainBackPrompt:
        "Show which system is the source of truth after reconciliation.",
      explainBackCompletedAt: null,
      verifiedAt: null,
      hints: [],
      probes: [],
    },
  ];
  const workshopAgenda = [
    {
      id: "opening",
      ordinal: 0,
      kind: "briefing",
      title: "Opening and operating model",
      durationMinutes: 15,
      scheduled: true,
      moduleId: null,
      slideIds: ["cover"],
      released: true,
      active: false,
      completed: true,
    },
    {
      id: "module-01",
      ordinal: 1,
      kind: "lab",
      title: "Talos and Cilium foundations",
      durationMinutes: 35,
      scheduled: true,
      moduleId: "01",
      slideIds: ["module-01-go"],
      released: true,
      active: true,
      completed: false,
    },
    {
      id: "module-02",
      ordinal: 2,
      kind: "lab",
      title: "Gitea and Argo CD",
      durationMinutes: 35,
      scheduled: true,
      moduleId: "02",
      slideIds: ["module-02-go"],
      released: false,
      active: false,
      completed: false,
    },
    {
      id: "break-1",
      ordinal: 3,
      kind: "break",
      title: "Break",
      durationMinutes: 10,
      scheduled: true,
      moduleId: null,
      slideIds: [],
      released: false,
      active: false,
      completed: false,
    },
  ];
  const workshopSlides = [
    {
      id: "cover",
      ordinal: 0,
      layout: "title",
      title: "Platform Engineering Workshop",
      bodyMarkdown: "Build the platform as a product, then prove every layer.",
      notesMarkdown:
        "Welcome the room and set the four-hour working agreement.",
      moduleId: null,
      released: true,
    },
    {
      id: "module-01-go",
      ordinal: 1,
      layout: "lab",
      title: "Talos and Cilium foundations",
      bodyMarkdown:
        "**Outcome:** boot the cluster and prove which layer owns pod networking.\n\n- Work in pairs socially; everyone keeps their own VM.\n- Use the layered hints when the search space is too wide.\n- Be ready to explain your evidence.",
      notesMarkdown:
        "Start the 35-minute timer. At 25 minutes, announce the remaining validation path. Walk the solution in the final five minutes.",
      moduleId: "01",
      released: true,
    },
    {
      id: "module-02-go",
      ordinal: 2,
      layout: "lab",
      title: "Gitea and Argo CD",
      bodyMarkdown:
        "Establish the reconciliation loop and identify the source of truth.",
      notesMarkdown: "Release only after the module 01 explain-back.",
      moduleId: "02",
      released: false,
    },
  ];
  const workshopRoster = [
    {
      userId: "user-learner",
      name: "Mina Learner",
      role: "participant",
      checkedInAt: FIXED_NOW - 40 * minute,
      lastSeenAt: FIXED_NOW - 10_000,
      presenceState: "present",
      provisionState: "ready",
      provisionError: null,
      workspaceState: "ready",
      currentModuleId: "01",
      helpState: "open",
      helpAssignedToViewer: false,
      assistGrant: null,
      progress: [
        {
          moduleId: "00",
          state: "verified",
          health: "passing",
          explainBackStatus: "not_required",
          probes: [
            {
              id: "workspace-ready",
              label: "workspace-ready",
              status: "pass",
              detail: "Debian 13 · generation 1",
            },
          ],
        },
        {
          moduleId: "01",
          state: "working",
          health: "failing",
          explainBackStatus: "pending",
          probes: [
            {
              id: "talos-members",
              label: "talos-members",
              status: "pass",
              detail: "3/3 members ready",
            },
            {
              id: "cilium-connectivity",
              label: "cilium-connectivity",
              status: "fail",
              detail: "DNS egress policy denies one path",
            },
          ],
        },
        {
          moduleId: "02",
          state: "locked",
          health: "unknown",
          explainBackStatus: "pending",
          probes: [],
        },
      ],
    },
    {
      userId: "user-owner",
      name: "Owen Owner",
      role: "participant",
      checkedInAt: FIXED_NOW - 35 * minute,
      lastSeenAt: FIXED_NOW - minute,
      presenceState: "stale",
      provisionState: "ready",
      provisionError: null,
      workspaceState: "ready",
      currentModuleId: "01",
      helpState: "none",
      helpAssignedToViewer: false,
      assistGrant: null,
      progress: [
        {
          moduleId: "00",
          state: "verified",
          health: "passing",
          explainBackStatus: "not_required",
          probes: [
            {
              id: "workspace-ready",
              label: "workspace-ready",
              status: "pass",
              detail: null,
            },
          ],
        },
        {
          moduleId: "01",
          state: "verified",
          health: "passing",
          explainBackStatus: "completed",
          probes: [
            {
              id: "talos-members",
              label: "talos-members",
              status: "pass",
              detail: null,
            },
            {
              id: "cilium-connectivity",
              label: "cilium-connectivity",
              status: "pass",
              detail: null,
            },
          ],
        },
        {
          moduleId: "02",
          state: "locked",
          health: "unknown",
          explainBackStatus: "pending",
          probes: [],
        },
      ],
    },
    {
      userId: "user-instructor",
      name: "Inez Instructor",
      role: "facilitator",
      checkedInAt: null,
      lastSeenAt: null,
      presenceState: "absent",
      provisionState: "not_ready",
      provisionError: null,
      workspaceState: null,
      currentModuleId: "01",
      helpState: "none",
      helpAssignedToViewer: false,
      assistGrant: null,
      progress: [
        {
          moduleId: "00",
          state: "available",
          health: "unknown",
          explainBackStatus: "not_required",
          probes: [
            {
              id: "workspace-ready",
              label: "workspace-ready",
              status: "unknown",
              detail: null,
            },
          ],
        },
        {
          moduleId: "01",
          state: "available",
          health: "unknown",
          explainBackStatus: "pending",
          probes: [
            {
              id: "talos-members",
              label: "talos-members",
              status: "unknown",
              detail: null,
            },
            {
              id: "cilium-connectivity",
              label: "cilium-connectivity",
              status: "unknown",
              detail: null,
            },
          ],
        },
        {
          moduleId: "02",
          state: "locked",
          health: "unknown",
          explainBackStatus: "pending",
          probes: [],
        },
      ],
    },
  ];
  const workshopSummary = {
    id: "workshop-live",
    version: 7,
    templateRevisionId: "revision-platform-engineering-3",
    organizationId: "org-platform",
    organizationName: organizationDetail.name,
    title: "Platform Engineering · July cohort",
    templateTitle: "Platform Engineering Workshop",
    state: "live",
    role: facilitator ? "facilitator" : "participant",
    startsAt: FIXED_NOW - 15 * minute,
    endsAt: FIXED_NOW + 225 * minute,
    currentModuleTitle: "Talos and Cilium foundations",
    checkedIn: true,
    workspaceState: facilitator ? null : "ready",
    participantCount: 2,
    draftRoster: null,
  };
  const workshopSession = {
    id: "workshop-live",
    organizationId: "org-platform",
    organizationName: organizationDetail.name,
    title: workshopSummary.title,
    templateTitle: workshopSummary.templateTitle,
    state: "live",
    version: 7,
    startsAt: workshopSummary.startsAt,
    endsAt: workshopSummary.endsAt,
    lobbyOpensAt: FIXED_NOW - 45 * minute,
    observedAt: FIXED_NOW,
    currentAgendaItemId: "module-01",
    currentModuleId: "01",
    currentSlideId: "module-01-go",
    currentSlideOrdinal: 1,
    announcement: "Explain-back at 09:25. Keep your evidence visible.",
    timer: {
      observedAt: FIXED_NOW,
      startedAt: FIXED_NOW - 5 * minute,
      endsAt: FIXED_NOW + 30 * minute,
      pausedAt: null,
      remainingMs: null,
    },
    viewer: {
      userId: facilitator ? "user-instructor" : "user-learner",
      role: facilitator ? "facilitator" : "participant",
      checkedIn: !facilitator,
      canFacilitate: facilitator,
      canPresent: facilitator,
      canAssist: facilitator,
    },
    modules: workshopModules,
    agenda: workshopAgenda,
    checkpoints: [
      {
        id: "checkpoint-00",
        label: "Clean workshop start",
        released: true,
        coveredModuleIds: [],
      },
      {
        id: "checkpoint-01",
        label: "Talos and Cilium complete",
        released: true,
        coveredModuleIds: ["00", "01"],
      },
    ],
    slides: workshopSlides,
    workspace: facilitator
      ? null
      : {
          id: "workspace-mina",
          state: "ready",
          generation: 1,
          checkpointId: "checkpoint-00",
          vmName: "platform-workshop",
          terminalAvailable: true,
          lastHealthyAt: FIXED_NOW - minute,
          recoveryMessage: null,
          applications: [
            {
              id: "gitea",
              label: "Gitea",
              url: "https://gitea.workshop-app.example.test/",
              available: true,
              releaseModuleId: "01",
            },
            {
              id: "argocd",
              label: "Argo CD",
              url: null,
              available: false,
              releaseModuleId: "02",
            },
          ],
        },
    helpRequest: null,
    assistGrant: null,
    roster: workshopRoster,
    capacity: {
      seatsTotal: 4,
      seatsAvailable: 2,
      seatsRequired: 2,
      checkedIn: 2,
      provisioned: 2,
      imagesReady: true,
      healthyRunners: 2,
      seatResources: {
        cpuMillis: 4_000,
        memoryMib: 16_384,
        worstCaseDiskMib: 32_768,
      },
      runners: [
        {
          hostId: "runner-hel-01",
          imagesReady: true,
          missingImageVmIds: [],
          seatsTotal: 2,
          seatsAvailable: 1,
          available: {
            cpuMillis: 8_000,
            memoryMib: 20_480,
            worstCaseDiskMib: 153_600,
          },
        },
        {
          hostId: "runner-hel-02",
          imagesReady: true,
          missingImageVmIds: [],
          seatsTotal: 2,
          seatsAvailable: 1,
          available: {
            cpuMillis: 6_000,
            memoryMib: 18_432,
            worstCaseDiskMib: 122_880,
          },
        },
      ],
      allocationFailures: [
        {
          hostId: "runner-hel-03",
          reason: "host_report_stale",
          detail: "runner has no fresh bridge state report",
        },
      ],
    },
  };
  const runtimeProfilesForRevision = (revision: number) => [
    {
      id: `runtime-profile-agent-r${revision}`,
      profileId: "agent-kvm",
      providerKind: "agent_kvm",
      machineType: null,
      systemImage: "platform-workshop-debian-13-x86_64",
      rootDiskType: null,
      hardware: {
        architecture: "x86_64",
        cpuMillis: 4_000,
        memoryMib: 16_384,
        diskMib: 32_768,
      },
      locations: [],
      certification: {
        state: "verified",
        connectionId: null,
        verifiedAt: FIXED_NOW - day,
        deletionConfirmedAt: FIXED_NOW - day,
      },
      compatible: true,
    },
  ];
  const workshopTemplate = {
    id: "template-platform-engineering",
    slug: "platform-engineering",
    title: "Platform Engineering Workshop",
    summary:
      "Build a compact internal platform from first principles and prove each layer.",
    latestRevision: 3,
    currentRevisionId: "revision-platform-engineering-3",
    revisionCount: 3,
    durationMinutes: 240,
    moduleCount: 11,
    status: "ready",
    updatedAt: FIXED_NOW - day,
    revisions: [
      {
        id: "revision-platform-engineering-3",
        revision: 3,
        sourceRevision: "1b6fad43551a720b143d7a52799f81c4c89455cb",
        contentHash: "c".repeat(64),
        durationMinutes: 240,
        moduleCount: 11,
        publishedAt: FIXED_NOW - day,
        current: true,
        runtimeProfiles: runtimeProfilesForRevision(3),
      },
      {
        id: "revision-platform-engineering-2",
        revision: 2,
        sourceRevision: "workshop-source-v2",
        contentHash: "b".repeat(64),
        durationMinutes: 235,
        moduleCount: 10,
        publishedAt: FIXED_NOW - 2 * day,
        current: false,
        runtimeProfiles: runtimeProfilesForRevision(2),
      },
      {
        id: "revision-platform-engineering-1",
        revision: 1,
        sourceRevision: "workshop-source-v1",
        contentHash: "a".repeat(64),
        durationMinutes: 220,
        moduleCount: 9,
        publishedAt: FIXED_NOW - 3 * day,
        current: false,
        runtimeProfiles: runtimeProfilesForRevision(1),
      },
    ],
  };
  const workshopDraftSummary = {
    ...workshopSummary,
    id: "workshop-upcoming",
    version: 2,
    title: "Platform Engineering · August cohort",
    state: "draft",
    startsAt: FIXED_NOW + 21 * day,
    endsAt: FIXED_NOW + 21 * day + 4 * hour,
    currentModuleTitle: null,
    checkedIn: false,
    workspaceState: null,
    draftRoster: [
      { userId: "user-owner", role: "facilitator" },
      { userId: "user-learner", role: "participant" },
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
    courses: empty ? [] : courses,
    organizationScenarios: empty ? [] : organizationScenarios,
    organizationCourses: empty ? [] : organizationCourses,
    scenarioDetail: {
      scenarioId: "repair-nginx",
      organizationId: null,
      slug: "repair-nginx",
      enabledAt: FIXED_NOW - 45 * day,
      scenarioName: "repair-nginx",
      briefing,
      vmCount: 1,
      hasActiveRun: !empty && runIsForeground,
      activeRunId: !empty && runIsForeground ? "run-active" : null,
      activeRun:
        empty || !runIsForeground
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
            scenarioId: "repair-nginx",
            scenarioTitle: briefing.title,
            organizationId: "org-platform",
            organizationName: organizationDetail.name,
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
    workshopSessions: empty
      ? []
      : [
          workshopSummary,
          workshopDraftSummary,
        ],
    workshopSession,
    organizationWorkshops: {
      organization: {
        id: "org-platform",
        name: organizationDetail.name,
        role: organizationDetail.role,
      },
      viewer: {
        userId:
          sessionRole === "owner"
            ? "user-owner"
            : sessionRole === "instructor"
              ? "user-instructor"
              : "user-learner",
      },
      members: organizationDetail.members.map((member) => ({
        userId: member.userId,
        name: member.name,
        email: member.email,
      })),
      templates: empty ? [] : [workshopTemplate],
      sessions: empty ? [] : [workshopSummary, workshopDraftSummary],
      providerConnections: [],
      capacity: empty ? null : workshopSession.capacity,
    },
    workshopRegistryTokens: [],
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
