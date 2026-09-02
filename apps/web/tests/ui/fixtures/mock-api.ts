import type { Route } from "@playwright/test";
import { buildTemporaryNativeSshCommand } from "@/lib/native-ssh";
import {
  FIXED_NOW,
  makeRun,
  type MockApiState,
  type RunFixtureState,
} from "./data";
import { sessionFor } from "./sessions";

export interface MockApiServer {
  state: MockApiState;
  unhandled: string[];
  requests: string[];
  nativeSshRequests: Array<{
    pathname: string;
    body: Record<string, unknown>;
  }>;
  expectedNativeSshNoProfileConflicts: number;
  nativeSshResponseDelayMs: number;
  scenarioRunStatusRevision: number;
  handle(route: Route): Promise<void>;
  setRunState(state: RunFixtureState): void;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, json: body });
}

function noContent(route: Route, headers?: Record<string, string>) {
  return route.fulfill({
    status: 204,
    body: "",
    ...(headers ? { headers } : {}),
  });
}

function nativeSshSessionFixture(input: {
  routeUsername: string;
  clientPublicKeyOpenssh: string | null;
}) {
  const knownHostsLine =
    "[stargate.example.test]:2222 ssh-ed25519 test-only-host-key";
  const issuedKey = input.clientPublicKeyOpenssh !== null;
  const keyFilename = `intar-${input.routeUsername}.key`;

  return {
    routeUsername: input.routeUsername,
    expiresAt: FIXED_NOW + 15 * 60_000,
    native: {
      authMode: issuedKey ? ("issued_key" as const) : ("profile_keys" as const),
      authorizedKeyCount: 1,
      host: "stargate.example.test",
      port: 2222,
      username: input.routeUsername,
      command: issuedKey
        ? buildTemporaryNativeSshCommand({
            username: input.routeUsername,
            host: "stargate.example.test",
            port: 2222,
            keyFilename,
            knownHostsLine,
          })
        : `ssh -p 2222 ${input.routeUsername}@stargate.example.test`,
      publicHostKeyOpenssh: "ssh-ed25519 test-only-host-key",
      publicHostKeyFingerprintSha256: "SHA256:test-only-fingerprint",
      knownHostsLine,
      ...(issuedKey ? { keyFilename } : {}),
    },
  };
}

type CourseFixture = MockApiState["courseCatalog"][number];
type CourseLectureFixture = CourseFixture["lectures"][number];

function courseCatalogResponse(
  courses: readonly CourseFixture[],
  capacityPressure: number | null,
) {
  return {
    courses: courses.map(({ lectures, ...course }) => ({
      ...course,
      lectures: lectures.map(courseLectureSummary),
    })),
    capacityPressure: courses.length ? capacityPressure : null,
  };
}

function courseLectureSummary({ bodyMarkdown, ...lecture }: CourseLectureFixture) {
  return lecture;
}

function findFixtureCourse(
  courses: readonly CourseFixture[],
  courseId: string,
) {
  return courses.find((course) => course.courseId === courseId) ?? null;
}

function organizationScopedCourses(
  courses: readonly CourseFixture[],
  organizationId: string,
  scope: "public" | "private",
) {
  return courses.filter((course) =>
    scope === "public"
      ? course.organizationId === null
      : course.organizationId === organizationId,
  );
}

function courseLectureDetail(
  courses: readonly CourseFixture[],
  courseId: string,
  lectureId: string,
) {
  const course = findFixtureCourse(courses, courseId);
  const lectureIndex = course?.lectures.findIndex(
    (lecture) => lecture.lectureId === lectureId,
  ) ?? -1;
  const lecture = lectureIndex >= 0 ? course?.lectures[lectureIndex] : null;
  if (!course || !lecture) return null;
  if (lecture.state === "locked") {
    return { locked: true as const, blockedBy: lecture.blockedBy };
  }
  const next = course.lectures[lectureIndex + 1] ?? null;
  const courseSummary = {
    courseId: course.courseId,
    organizationId: course.organizationId,
    title: course.title,
    summary: course.summary,
    sequential: course.sequential,
  };
  return {
    locked: false as const,
    detail: {
      course: courseSummary,
      lecture: {
        ...courseLectureSummary(lecture),
        bodyMarkdown: lecture.bodyMarkdown,
        nextLecture: next
          ? {
              courseId: course.courseId,
              lectureId: next.lectureId,
              title: next.title,
            }
          : null,
      },
    },
  };
}

function completeFixtureCourseLecture(
  courses: CourseFixture[],
  courseId: string,
  lectureId: string,
) {
  const course = findFixtureCourse(courses, courseId);
  const lecture = course?.lectures.find(
    (candidate) => candidate.lectureId === lectureId,
  );
  if (!course || !lecture) return null;
  if (lecture.state === "locked") {
    return { locked: true as const, blockedBy: lecture.blockedBy };
  }
  if (lecture.scenarioId) return { linked: true as const };

  lecture.state = "completed";
  lecture.activeRunId = null;
  for (const next of course.lectures) {
    if (next.blockedBy?.lectureId !== lecture.lectureId) continue;
    next.blockedBy = null;
    next.state =
      next.scenarioReady === false ? "waiting_for_scenario" : "available";
  }
  return courseLectureDetail(courses, courseId, lectureId);
}

function updateFixtureLinkedLectureState(
  courses: readonly CourseFixture[],
  scenarioId: string,
  runState: RunFixtureState,
) {
  const active = makeRun(runState).activity === "foreground";
  const completed = ["archived", "replay", "replay-failed"].includes(
    runState,
  );
  for (const course of courses) {
    for (const lecture of course.lectures) {
      if (lecture.scenarioId !== scenarioId || lecture.state === "locked") {
        continue;
      }
      lecture.state = active
        ? "in_progress"
        : completed
          ? "completed"
          : "available";
      lecture.activeRunId = active ? "run-active" : null;
    }
  }
}

function courseLecturePath(
  pathname: string,
  pattern: RegExp,
): { organizationId: string | null; courseId: string; lectureId: string } | null {
  const match = pathname.match(pattern);
  if (!match) return null;
  const [, organizationId, courseId, lectureId] = match;
  if (lectureId === undefined) {
    return {
      organizationId: null,
      courseId: decodeURIComponent(organizationId ?? ""),
      lectureId: decodeURIComponent(courseId ?? ""),
    };
  }
  return {
    organizationId: decodeURIComponent(organizationId ?? ""),
    courseId: decodeURIComponent(courseId ?? ""),
    lectureId: decodeURIComponent(lectureId),
  };
}

type FixtureRecord = Record<string, unknown>;

function records(value: unknown): FixtureRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is FixtureRecord =>
          entry !== null && typeof entry === "object",
      )
    : [];
}

/**
 * Match the bounded fleet DTO. The fixture keeps the legacy rich archive
 * records so other tests can still exercise the old host endpoints; this
 * projection is what the new dashboard is allowed to receive initially.
 */
function fleetSnapshot(
  state: MockApiState,
  archiveOffset = 0,
  includeArchiveSummaries = true,
) {
  const hostRuns = state.hostRuns as {
    liveVms?: FixtureRecord[];
    archivedRuns?: FixtureRecord[];
  };
  const archivedRuns = records(hostRuns.archivedRuns);
  const archiveSummaries = archivedRuns.map((run) => {
    const { artifacts, events, ...summary } = run;
    return {
      ...summary,
      artifactCount: records(artifacts).length,
      eventCount: records(events).length,
    };
  });
  const archiveTotalCount = archiveSummaries.length;
  const archivePage = includeArchiveSummaries
    ? archiveSummaries.slice(archiveOffset, archiveOffset + 100)
    : [];
  const archiveNextOffset =
    includeArchiveSummaries &&
    archiveOffset + archivePage.length < archiveTotalCount
      ? archiveOffset + archivePage.length
      : null;
  const liveVms = records(hostRuns.liveVms);

  return {
    liveLoadedCount: liveVms.length,
    liveTotalCount: liveVms.length,
    archiveTotalCount,
    archiveOffset,
    archiveNextOffset,
    hasMoreArchives: archiveNextOffset !== null,
    hasMoreLive: false,
    hostRecords: records(state.hosts)
      .filter((host) => host.disabled !== true)
      .map((host) => ({
        host,
        hostVms: liveVms,
        hostRuns: archivePage,
        archiveTotalCount,
        capacity:
          host.actualState && typeof host.actualState === "object"
            ? ((host.actualState as FixtureRecord).capacity ?? null)
            : null,
      })),
  };
}

function fleetArchiveDetail(state: MockApiState, runId: string) {
  const hostRuns = state.hostRuns as { archivedRuns?: FixtureRecord[] };
  const run = records(hostRuns.archivedRuns).find((entry) => entry.id === runId);
  if (!run) return null;
  return {
    ...run,
    artifactCount: records(run.artifacts).length,
    eventCount: records(run.events).length,
  };
}

function adminRunArchive(state: MockApiState) {
  const hostRuns = state.hostRuns as { archivedRuns?: FixtureRecord[] };
  const hosts = records(state.hosts);
  const runs = records(hostRuns.archivedRuns).map((run) => {
    const { artifacts, events, ...summary } = run;
    const host = hosts.find((entry) => entry.id === run.hostId);
    return {
      host: {
        id: String(run.hostId ?? "unknown-host"),
        name: String(host?.name ?? run.hostId ?? "Unknown host"),
      },
      run: {
        ...summary,
        artifactCount: records(artifacts).length,
        eventCount: records(events).length,
      },
    };
  });
  return { runs, totalCount: runs.length, nextCursor: null };
}

/** Build the small run projection used after the first full run response. */
function scenarioRunStatus(run: FixtureRecord, revision: number) {
  const baseUpdatedAt =
    typeof run.updatedAt === "number" ? run.updatedAt : FIXED_NOW - 60_000;
  const updatedAt = baseUpdatedAt + revision;
  const vms = records(run.vms).map((vm) => ({
    id: vm.id,
    phase: vm.phase,
    phaseTitle: vm.phaseTitle,
    phaseDetail: vm.phaseDetail,
    progressPercent: vm.progressPercent,
    terminalPhase: vm.terminalPhase,
    canOpenTerminal: vm.canOpenTerminal,
    terminalTarget: vm.terminalTarget,
    bootProbes: records(vm.bootProbes),
    scenarioProbes: records(vm.scenarioProbes),
    sessionTimeline: vm.sessionTimeline ?? null,
    ...(vm.hasRecording === undefined ? {} : { hasRecording: vm.hasRecording }),
  }));
  return {
    version: String(updatedAt),
    updatedAt,
    phase: run.phase,
    phaseTitle: run.phaseTitle,
    phaseDetail: run.phaseDetail,
    progressPercent: run.progressPercent,
    terminalPhase: run.terminalPhase,
    canOpenTerminal: run.canOpenTerminal,
    canDestroy: run.canDestroy,
    terminalTarget: run.terminalTarget,
    outcome: run.outcome,
    active: run.active,
    activity: run.activity,
    deleteRequestedAt: run.deleteRequestedAt,
    solvedAt: run.solvedAt,
    solveDurationMs: run.solveDurationMs,
    savingStage: run.savingStage,
    replayState: run.replayState,
    hasReplay: run.hasReplay,
    vms,
  };
}

function probeSnapshots(variant: MockApiState["variant"]) {
  if (variant === "long") {
    return [
      {
        id: "snapshot-dense-1",
        vmId: "run-vm-web",
        runtimeVmName: "repair-nginx-web-7f3a",
        observedAt: FIXED_NOW - 5 * 60_000,
        probes: [
          {
            id: "boot-ready",
            label: "Machine ready",
            kind: "systemd_unit",
            phase: "boot",
            status: "pending",
          },
          {
            id: "nginx-listening",
            label: "nginx listens on port 80",
            kind: "tcp_connect",
            phase: "scenario",
            status: "fail",
          },
          {
            id: "health-endpoint",
            label: "health endpoint returns ok",
            kind: "http_request",
            phase: "scenario",
            status: "pending",
          },
        ],
      },
      {
        id: "snapshot-dense-2",
        vmId: "run-vm-web",
        runtimeVmName: "repair-nginx-web-7f3a",
        observedAt: FIXED_NOW - 2 * 60_000,
        probes: [
          {
            id: "boot-ready",
            label: "Machine ready",
            kind: "systemd_unit",
            phase: "boot",
            status: "pass",
          },
          {
            id: "nginx-listening",
            label: "nginx listens on port 80",
            kind: "tcp_connect",
            phase: "scenario",
            status: "pass",
          },
          {
            id: "health-endpoint",
            label:
              "health endpoint returns ok through the public ingress while preserving the original host header, forwarding the full request path, keeping cache-control intact, and refusing fallback content from the maintenance virtual host",
            kind: "http_request",
            phase: "scenario",
            status: "pass",
          },
        ],
      },
    ];
  }

  return [
    {
      id: "snapshot-1",
      vmId: "run-vm-web",
      runtimeVmName: "repair-nginx-web-7f3a",
      observedAt: FIXED_NOW - 5 * 60_000,
      probes: [
        {
          id: "nginx-listening",
          label: "nginx listens on port 80",
          kind: "tcp_connect",
          phase: "scenario",
          status: "fail",
        },
      ],
    },
    {
      id: "snapshot-2",
      vmId: "run-vm-web",
      runtimeVmName: "repair-nginx-web-7f3a",
      observedAt: FIXED_NOW - 2 * 60_000,
      probes: [
        {
          id: "nginx-listening",
          label: "nginx listens on port 80",
          kind: "tcp_connect",
          phase: "scenario",
          status: "pass",
        },
      ],
    },
  ];
}

function segment(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function requestBody(route: Route): Promise<Record<string, unknown>> {
  try {
    return (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function createMockApiServer(initial: MockApiState): MockApiServer {
  const server: MockApiServer = {
    state: initial,
    unhandled: [],
    requests: [],
    nativeSshRequests: [],
    expectedNativeSshNoProfileConflicts: 0,
    nativeSshResponseDelayMs: 0,
    scenarioRunStatusRevision: 0,
    setRunState(runState) {
      server.scenarioRunStatusRevision += 1;
      server.state.runState = runState;
      server.state.run = makeRun(runState);
      const listedRun = server.state.runs.find(
        (run) => run.runId === "run-active",
      );
      if (listedRun) {
        const projected = server.state.run;
        listedRun.phase = projected.phase;
        listedRun.outcome = projected.outcome;
        listedRun.active = projected.active;
        listedRun.activity = projected.activity;
        listedRun.deleteRequestedAt = projected.deleteRequestedAt;
        listedRun.replayState = projected.replayState;
        listedRun.hasReplay = projected.hasReplay;
        listedRun.finishedAt =
          projected.activity === "settled" ? FIXED_NOW : null;
      }
      updateFixtureLinkedLectureState(
        server.state.courseCatalog,
        "repair-nginx",
        runState,
      );
      updateFixtureLinkedLectureState(
        server.state.organizationCourseCatalog,
        "repair-nginx",
        runState,
      );
      server.state.terminalMode =
        runState === "disconnected"
          ? "disconnected"
          : runState === "failed"
            ? "error"
            : "connected";
    },
    async handle(route) {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const pathname = url.pathname.replace(/\/$/, "") || "/";
      const signature = `${method} ${pathname}`;
      server.requests.push(signature);

      if (pathname === "/api/app/bootstrap" && method === "GET") {
        const session = sessionFor(server.state.sessionRole);
        await json(route, {
          session,
          betaAccess: session ? "active" : "restricted",
        });
        return;
      }
      if (pathname === "/api/auth/get-session" && method === "GET") {
        await json(route, sessionFor(server.state.sessionRole));
        return;
      }
      if (pathname === "/api/auth/sign-in/social" && method === "POST") {
        await json(route, { redirect: false, url: "/courses" });
        return;
      }
      if (pathname === "/api/auth/sign-out" && method === "POST") {
        await json(route, { success: true });
        return;
      }
      if (pathname === "/api/access-invites/current" && method === "GET") {
        const session = sessionFor(server.state.sessionRole);
        await json(
          route,
          session
            ? {
                state: "active",
                user: {
                  id: session.user.id,
                  githubUsername: session.user.username,
                },
              }
            : server.state.betaClaim,
        );
        return;
      }
      if (pathname === "/api/access-invites/exchange" && method === "POST") {
        await requestBody(route);
        await json(route, server.state.betaClaim);
        return;
      }
      if (pathname === "/api/access-invites/start" && method === "POST") {
        await requestBody(route);
        const leaseExpiresAt = FIXED_NOW + 10 * 60_000;
        server.state.betaClaim = {
          state: "leased",
          leaseExpiresAt,
          ownsLease: true,
        };
        await json(route, {
          redirectUrl: "/join?oauth=github",
          redirectKind: "github",
          leaseExpiresAt,
        });
        return;
      }
      if (pathname === "/api/access-invites/confirm" && method === "POST") {
        server.state.betaClaim = {
          state: "active",
          user: { id: "user-learner", githubUsername: "minalearns" },
        };
        await json(route, server.state.betaClaim);
        return;
      }
      if (pathname === "/api/access-invites/cancel" && method === "POST") {
        server.state.betaClaim = { state: "invalid" };
        await json(route, { canceled: true });
        return;
      }
      if (
        pathname === "/api/auth/organization/set-active" &&
        method === "POST"
      ) {
        await json(route, { session: sessionFor(server.state.sessionRole) });
        return;
      }
      if (pathname === "/api/admin/users" && method === "GET") {
        await json(route, {
          users: server.state.users,
        });
        return;
      }
      if (
        /^\/api\/admin\/users\/[^/]+\/role$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const userId = segment(
          pathname,
          /^\/api\/admin\/users\/([^/]+)\/role$/,
        );
        const target = server.state.users.find((user) => user.id === userId);
        if (target) {
          if (typeof body.role === "string") {
            target.role = body.role;
          }
        }
        await json(route, { user: target ?? null });
        return;
      }
      const deletedUserId = segment(pathname, /^\/api\/admin\/users\/([^/]+)$/);
      if (deletedUserId && method === "DELETE") {
        server.state.users = server.state.users.filter(
          (entry) => entry.id !== deletedUserId,
        );
        server.state.betaUsers = server.state.betaUsers.filter(
          (entry) => entry.userId !== deletedUserId,
        );
        await json(route, { deleted: true });
        return;
      }
      if (
        pathname === "/api/auth/oauth2/public-client-prelogin" &&
        method === "POST"
      ) {
        await json(route, {
          client_id: "intar-cli",
          client_name: "Intar Run CLI",
          client_uri: "https://docs.intar.dev/cli",
          logo_uri: null,
          redirect_uris: ["https://cli.example.test/callback"],
        });
        return;
      }
      if (pathname === "/api/auth/oauth2/consent" && method === "POST") {
        await json(route, {
          url: "https://cli.example.test/callback?code=test-only-code&state=fixed",
        });
        return;
      }

      if (server.state.variant === "loading" && method === "GET") {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

      if (server.state.variant === "error" && method === "GET") {
        await json(route, { error: "Deterministic fixture failure" }, 503);
        return;
      }

      if (pathname === "/api/courses" && method === "GET") {
        await json(
          route,
          courseCatalogResponse(
            server.state.courseCatalog,
            server.state.capacityPressure,
          ),
        );
        return;
      }
      const publicCourseLectureComplete = courseLecturePath(
        pathname,
        /^\/api\/courses\/([^/]+)\/lectures\/([^/]+)\/complete$/,
      );
      if (publicCourseLectureComplete && method === "POST") {
        const result = completeFixtureCourseLecture(
          server.state.courseCatalog,
          publicCourseLectureComplete.courseId,
          publicCourseLectureComplete.lectureId,
        );
        if (!result) {
          await json(route, { error: "lecture not found" }, 404);
        } else if ("linked" in result) {
          await json(
            route,
            { error: "only theory lectures can be completed directly" },
            400,
          );
        } else if (result.locked) {
          await json(
            route,
            {
              locked: true,
              blockedBy: result.blockedBy,
            },
          );
        } else {
          await json(route, result.detail);
        }
        return;
      }
      const publicCourseLecture = courseLecturePath(
        pathname,
        /^\/api\/courses\/([^/]+)\/lectures\/([^/]+)$/,
      );
      if (publicCourseLecture && method === "GET") {
        const result = courseLectureDetail(
          server.state.courseCatalog,
          publicCourseLecture.courseId,
          publicCourseLecture.lectureId,
        );
        if (!result) {
          await json(route, { error: "lecture not found" }, 404);
        } else if (result.locked) {
          await json(
            route,
            {
              locked: true,
              blockedBy: result.blockedBy,
            },
          );
        } else {
          await json(route, result.detail);
        }
        return;
      }
      if (
        pathname === "/api/organizations/my-assignments" &&
        method === "GET"
      ) {
        await json(route, {
          assignments: server.state.assignments.map((assignment) => {
            for (const course of server.state.organizationCourseCatalog) {
              const lecture = course.lectures.find(
                (candidate) => candidate.scenarioId === assignment.scenarioId,
              );
              if (!lecture) continue;
              return {
                ...assignment,
                scenarioTitle: lecture.title,
                lecture: {
                  courseId: course.courseId,
                  lectureId: lecture.lectureId,
                  title: lecture.title,
                  state: lecture.state,
                  blockedBy: lecture.blockedBy,
                  scope:
                    course.organizationId === assignment.organizationId
                      ? "organization-private"
                      : "organization-public",
                },
              };
            }
            return { ...assignment, lecture: null };
          }),
        });
        return;
      }
      if (pathname === "/api/scenarios/runs/summary" && method === "GET") {
        const activeRuns = server.state.runs.filter(
          (run) => run.active === true || run.activity === "background",
        );
        const foreground = activeRuns.find(
          (run) => run.activity === "foreground",
        );
        await json(route, {
          activeCount: activeRuns.length,
          activeRunId:
            typeof foreground?.runId === "string" ? foreground.runId : null,
        });
        return;
      }
      if (pathname === "/api/scenarios/runs" && method === "GET") {
        await json(route, { runs: server.state.runs });
        return;
      }
      if (
        /^\/api\/scenarios\/[^/]+\/start$/.test(pathname) &&
        method === "POST"
      ) {
        await json(
          route,
          {
            accepted: true,
            runId: "run-active",
            scenarioId: "repair-nginx",
            acceptedAt: FIXED_NOW,
            reused: false,
            run: server.state.run,
          },
          202,
        );
        return;
      }
      const runId = segment(pathname, /^\/api\/scenarios\/runs\/([^/]+)$/);
      if (runId && method === "GET") {
        await json(route, { run: server.state.run });
        return;
      }
      if (runId && method === "DELETE") {
        server.state.runs = server.state.runs.filter(
          (run) => run.runId !== runId,
        );
        await noContent(route);
        return;
      }
      if (
        /^\/api\/scenarios\/runs\/[^/]+\/destroy$/.test(pathname) &&
        method === "POST"
      ) {
        server.setRunState("ending");
        await json(
          route,
          {
            accepted: true,
            runId: "run-active",
            acceptedAt: FIXED_NOW,
            activeSlotReleased: true,
            run: server.state.run,
          },
          202,
        );
        return;
      }
      if (
        /^\/api\/scenarios\/runs\/[^/]+\/hints\/reveal$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const hints = server.state.run.hints as Array<Record<string, unknown>>;
        for (const hint of hints) {
          if (hint.key === body.hintKey) {
            hint.revealed = true;
            hint.unlocked = false;
            hint.title = "Inspect the service boundary";
            hint.bodyMarkdown = "Start with `systemctl status nginx`.";
          }
        }
        await json(route, { run: server.state.run });
        return;
      }
      if (
        /^\/api\/scenarios\/runs\/[^/]+\/solution\/reveal$/.test(pathname) &&
        method === "POST"
      ) {
        server.state.run.solution = {
          unlocked: true,
          revealed: true,
          assisted: true,
          revealedAt: FIXED_NOW,
          bodyMarkdown:
            "Validate the nginx configuration, restore the unit, and restart it.",
        };
        await json(route, { run: server.state.run });
        return;
      }
      if (
        /^\/api\/scenarios\/runs\/[^/]+\/ssh$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        if (body.mode === "native") {
          const clientPublicKeyOpenssh =
            typeof body.clientPublicKeyOpenssh === "string"
              ? body.clientPublicKeyOpenssh
              : null;
          server.nativeSshRequests.push({ pathname, body });
          if (!clientPublicKeyOpenssh && server.state.sshKeys.length === 0) {
            server.expectedNativeSshNoProfileConflicts += 1;
            await json(
              route,
              {
                code: "scenario_native_ssh_key_required",
                error:
                  "provide a temporary SSH key or add an SSH key to your profile before opening a native SSH route",
              },
              409,
            );
            return;
          }
          if (server.nativeSshResponseDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, server.nativeSshResponseDelayMs),
            );
          }
          await json(
            route,
            nativeSshSessionFixture({
              routeUsername: "route-test-only",
              clientPublicKeyOpenssh,
            }),
          );
          return;
        }
        await json(route, {
          routeUsername: "route-test-only",
          expiresAt: FIXED_NOW + 15 * 60_000,
          browser: {
            websocketUrl: "ws://terminal.example.test/terminal/run-active",
          },
        });
        return;
      }
      if (
        /^\/api\/scenarios\/runs\/[^/]+\/probe-snapshots$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, {
          snapshots: probeSnapshots(server.state.variant),
        });
        return;
      }

      const statusRunId = segment(
        pathname,
        /^\/api\/scenarios\/runs\/([^/]+)\/status$/,
      );
      if (statusRunId && method === "GET") {
        const status = scenarioRunStatus(
          server.state.run,
          server.scenarioRunStatusRevision,
        );
        if (url.searchParams.get("version") === status.version) {
          await noContent(route, { "cache-control": "private, no-store" });
          return;
        }
        await json(route, { status });
        return;
      }

      if (
        /^\/api\/runs\/[^/]+\/vms\/[^/]+\/sessions\/\d+\/transcript$/.test(
          pathname,
        ) &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          body: "$ systemctl status nginx\nnginx.service: failed\n$ sudo systemctl restart nginx\n$ curl -fsS localhost/health\nok\n",
        });
        return;
      }
      if (
        /^\/api\/runs\/[^/]+\/artifacts\/[^/]+\/content$/.test(pathname) &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          body: '{"version":2,"width":120,"height":30,"timestamp":1783670400,"env":{"TERM":"xterm-256color"}}\n[0.05,"o","$ "]\n[0.1,"i","systemctl status nginx\\r"]\n[0.2,"o","systemctl status nginx\\r\\n"]\n',
        });
        return;
      }
      if (
        /^\/api\/admin\/runs\/[^/]+\/artifacts\/[^/]+\/content$/.test(
          pathname,
        ) &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          body: '{"version":2,"width":120,"height":30,"timestamp":1783670400,"env":{"TERM":"xterm-256color"}}\n[0.05,"o","$ "]\n[0.1,"i","systemctl status nginx\\r"]\n[0.2,"o","systemctl status nginx\\r\\n"]\n',
        });
        return;
      }

      if (pathname === "/api/organizations" && method === "GET") {
        await json(route, {
          organizations: server.state.organizations,
          creation: server.state.organizationCreation,
        });
        return;
      }
      if (pathname === "/api/organizations" && method === "POST") {
        const body = await requestBody(route);
        const organization = {
          id: "org-new",
          name: String(body.name ?? "New organization"),
          slug: "new-organization-ab12cd",
          role: "owner",
          memberCount: 1,
          createdAt: FIXED_NOW,
        };
        server.state.organizations.push(organization);
        await json(route, { organization }, 201);
        return;
      }
      const organizationId = segment(
        pathname,
        /^\/api\/organizations\/([^/]+)$/,
      );
      if (organizationId && method === "GET") {
        await json(route, { organization: server.state.organizationDetail });
        return;
      }
      if (organizationId && method === "PATCH") {
        const body = await requestBody(route);
        if (typeof body.name === "string") {
          server.state.organizationDetail.name = body.name;
        }
        await json(route, { organization: server.state.organizationDetail });
        return;
      }
      if (organizationId && method === "DELETE") {
        await noContent(route);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/members\/[^/]+$/.test(pathname) &&
        (method === "DELETE" || method === "PATCH")
      ) {
        await noContent(route);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/assignments$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { assignments: server.state.assignments });
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/assignments$/.test(pathname) &&
        method === "POST"
      ) {
        await json(
          route,
          { assignment: server.state.assignments[0] ?? null },
          201,
        );
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/assignments\/[^/]+$/.test(pathname) &&
        method === "DELETE"
      ) {
        await noContent(route);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/progress$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { progress: server.state.progress });
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/(transfer-ownership|leave)$/.test(
          pathname,
        ) &&
        method === "POST"
      ) {
        await noContent(route);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/courses$/.test(pathname) &&
        method === "GET"
      ) {
        await json(
          route,
          courseCatalogResponse(
            server.state.organizationCourseCatalog,
            server.state.capacityPressure,
          ),
        );
        return;
      }
      const organizationCourseLectureComplete = courseLecturePath(
        pathname,
        /^\/api\/organizations\/([^/]+)\/courses\/([^/]+)\/lectures\/([^/]+)\/complete$/,
      );
      if (organizationCourseLectureComplete && method === "POST") {
        const scope = url.searchParams.get("scope");
        if (scope !== "public" && scope !== "private") {
          await json(route, { error: "scope must be public or private" }, 400);
          return;
        }
        const result = completeFixtureCourseLecture(
          organizationScopedCourses(
            server.state.organizationCourseCatalog,
            organizationCourseLectureComplete.organizationId ?? "",
            scope,
          ),
          organizationCourseLectureComplete.courseId,
          organizationCourseLectureComplete.lectureId,
        );
        if (!result) {
          await json(route, { error: "lecture not found" }, 404);
        } else if ("linked" in result) {
          await json(
            route,
            { error: "only theory lectures can be completed directly" },
            400,
          );
        } else if (result.locked) {
          await json(
            route,
            {
              error: "complete the required lecture first",
              code: "course_lecture_locked",
              blockedBy: result.blockedBy,
            },
            409,
          );
        } else {
          await json(route, result.detail);
        }
        return;
      }
      const organizationCourseLecture = courseLecturePath(
        pathname,
        /^\/api\/organizations\/([^/]+)\/courses\/([^/]+)\/lectures\/([^/]+)$/,
      );
      if (organizationCourseLecture && method === "GET") {
        const scope = url.searchParams.get("scope");
        if (scope !== "public" && scope !== "private") {
          await json(route, { error: "scope must be public or private" }, 400);
          return;
        }
        const result = courseLectureDetail(
          organizationScopedCourses(
            server.state.organizationCourseCatalog,
            organizationCourseLecture.organizationId ?? "",
            scope,
          ),
          organizationCourseLecture.courseId,
          organizationCourseLecture.lectureId,
        );
        if (!result) {
          await json(route, { error: "lecture not found" }, 404);
        } else if (result.locked) {
          await json(
            route,
            {
              error: "complete the required lecture first",
              code: "course_lecture_locked",
              blockedBy: result.blockedBy,
            },
            409,
          );
        } else {
          await json(route, result.detail);
        }
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/runners$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { runners: server.state.organizationRunners });
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/sso$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { provider: server.state.organizationOidc });
        return;
      }

      if (pathname === "/api/profile/ssh-keys" && method === "GET") {
        await json(route, { keys: server.state.sshKeys });
        return;
      }
      if (pathname === "/api/profile/ssh-keys" && method === "POST") {
        const key = {
          id: "key-new",
          label: "New key",
          keyType: "ssh-ed25519",
          comment: null,
          publicKeyOpenssh: "ssh-ed25519 test-only",
          fingerprintSha256: "SHA256:TestOnly",
          createdAt: FIXED_NOW,
        };
        server.state.sshKeys.push(key);
        await json(route, { key }, 201);
        return;
      }
      if (
        /^\/api\/profile\/ssh-keys\/[^/]+$/.test(pathname) &&
        method === "DELETE"
      ) {
        await json(route, { deleted: true });
        return;
      }

      if (pathname === "/api/agent/hosts" && method === "GET") {
        await json(route, {
          hosts: server.state.hosts.filter((host) => host.disabled !== true),
        });
        return;
      }
      if (pathname === "/api/admin/runs" && method === "GET") {
        const cursor = url.searchParams.get("cursor");
        if (cursor === "invalid") {
          await json(route, { error: "cursor is invalid" }, 400);
          return;
        }
        await json(route, adminRunArchive(server.state));
        return;
      }
      const adminRunId = segment(pathname, /^\/api\/admin\/runs\/([^/]+)$/);
      if (adminRunId && method === "GET") {
        const run = fleetArchiveDetail(server.state, adminRunId);
        if (!run) {
          await json(route, { error: "archived run not found" }, 404);
          return;
        }
        await json(route, { run });
        return;
      }
      if (adminRunId && method === "DELETE") {
        const hostRuns = server.state.hostRuns as {
          archivedRuns?: FixtureRecord[];
        };
        hostRuns.archivedRuns = records(hostRuns.archivedRuns).filter(
          (run) => run.id !== adminRunId,
        );
        await noContent(route, { "cache-control": "private, no-store" });
        return;
      }
      const fleetDetailRunId = segment(
        pathname,
        /^\/api\/admin\/fleet-snapshot\/runs\/([^/]+)$/,
      );
      if (fleetDetailRunId && method === "GET") {
        const run = fleetArchiveDetail(server.state, fleetDetailRunId);
        if (!run) {
          await json(route, { error: "archived run not found" }, 404);
          return;
        }
        await json(route, { run });
        return;
      }
      if (pathname === "/api/admin/fleet-snapshot" && method === "GET") {
        const requestedOffset = url.searchParams.get("archiveOffset");
        const archiveOffset =
          requestedOffset === null || requestedOffset === ""
            ? 0
            : /^\d+$/.test(requestedOffset)
              ? Number(requestedOffset)
              : null;
        if (archiveOffset === null || !Number.isSafeInteger(archiveOffset)) {
          await json(route, { error: "archiveOffset must be a non-negative integer" }, 400);
          return;
        }
        await json(
          route,
          fleetSnapshot(
            server.state,
            archiveOffset,
            url.searchParams.get("includeArchiveSummaries") !== "0",
          ),
        );
        return;
      }
      if (pathname === "/api/agent/hosts" && method === "POST") {
        await json(route, {
          host: server.state.hosts[0] ?? null,
          bootstrapToken: "test-only-bootstrap-token",
        });
        return;
      }
      const hostId = segment(pathname, /^\/api\/agent\/hosts\/([^/]+)$/);
      if (hostId && method === "GET") {
        const host = server.state.hosts.find(
          (candidate) => candidate.id === hostId,
        );
        await json(route, { host: host ?? null }, host ? 200 : 404);
        return;
      }
      if (hostId && method === "DELETE") {
        const host = server.state.hosts.find(
          (candidate) => candidate.id === hostId,
        );
        if (!host) {
          await json(route, { error: "Host not found" }, 404);
          return;
        }
        host.disabled = true;
        await json(route, { ok: true, hostId });
        return;
      }
      if (
        /^\/api\/agent\/hosts\/[^/]+\/runs$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, server.state.hostRuns);
        return;
      }

      if (pathname === "/api/admin/scenarios" && method === "GET") {
        await json(route, { scenarios: server.state.adminScenarios });
        return;
      }
      const adminScenarioId = segment(
        pathname,
        /^\/api\/admin\/scenarios\/([^/]+)$/,
      );
      if (adminScenarioId && method === "GET") {
        await json(route, { scenario: server.state.adminScenarioDetail });
        return;
      }
      if (
        /^\/api\/admin\/scenarios\/[^/]+\/enabled$/.test(pathname) &&
        (method === "POST" || method === "DELETE")
      ) {
        server.state.adminScenarioDetail.enabled = method === "POST";
        server.state.adminScenarioDetail.enabledAt =
          method === "POST" ? FIXED_NOW : null;
        await json(route, { scenario: server.state.adminScenarioDetail });
        return;
      }

      if (pathname === "/api/admin/builds" && method === "GET") {
        await json(route, { builds: server.state.builds });
        return;
      }
      const buildId = segment(pathname, /^\/api\/admin\/builds\/([^/]+)$/);
      if (buildId && method === "GET") {
        await json(route, { build: server.state.buildDetails[buildId] });
        return;
      }
      if (
        /^\/api\/admin\/builds\/[^/]+\/retry$/.test(pathname) &&
        method === "POST"
      ) {
        await json(route, { accepted: true });
        return;
      }
      if (
        /^\/api\/admin\/builds\/[^/]+\/log$/.test(pathname) &&
        method === "GET"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          body: "builder: downloading bundle\nbuilder: converting image\nbuilder: done\n",
        });
        return;
      }

      if (pathname === "/api/admin/access-invites" && method === "GET") {
        await json(route, {
          invites: server.state.accessInvites,
          betaUsers: server.state.betaUsers,
        });
        return;
      }
      if (pathname === "/api/admin/access-invites" && method === "POST") {
        const invite = {
          id: `invite-created-${server.state.accessInvites.length + 1}`,
          codePrefix: "intar_beta_CCCCCCCC",
          state: "active",
          createdAt: FIXED_NOW,
          expiresAt: FIXED_NOW + 7 * 24 * 60 * 60_000,
          completedAt: null,
          redeemerGithubUsername: null,
          version: 1,
        };
        server.state.accessInvites.unshift(invite);
        await json(
          route,
          { invite },
          201,
        );
        return;
      }
      const copiedInviteId = segment(
        pathname,
        /^\/api\/admin\/access-invites\/([^/]+)\/copy$/,
      );
      if (copiedInviteId && method === "POST") {
        const body = await requestBody(route);
        const invite = server.state.accessInvites.find(
          (entry) => entry.id === copiedInviteId,
        );
        if (!invite || body.expectedVersion !== invite.version) {
          await json(
            route,
            { code: "access_invite_stale_version", message: "stale invite" },
            409,
          );
          return;
        }
        await json(route, {
          inviteUrl: `http://127.0.0.1:4330/join#invite=intar_beta_${
            copiedInviteId.startsWith("invite-created")
              ? "C".repeat(43)
              : "A".repeat(43)
          }`,
        });
        return;
      }
      const revokedInviteId = segment(
        pathname,
        /^\/api\/admin\/access-invites\/([^/]+)\/revoke$/,
      );
      if (revokedInviteId && method === "POST") {
        const body = await requestBody(route);
        const invite = server.state.accessInvites.find(
          (entry) => entry.id === revokedInviteId,
        );
        if (!invite || body.expectedVersion !== invite.version) {
          await json(
            route,
            { code: "access_invite_stale_version", message: "stale invite" },
            409,
          );
          return;
        }
        if (invite) {
          invite.state = "revoked";
          invite.completedAt = FIXED_NOW;
          invite.version = Number(invite.version ?? 0) + 1;
        }
        await json(route, { invite: invite ?? null });
        return;
      }
      const revokedBetaUserId = segment(
        pathname,
        /^\/api\/admin\/beta-users\/([^/]+)\/revoke$/,
      );
      if (revokedBetaUserId && method === "POST") {
        const body = await requestBody(route);
        const betaUser = server.state.betaUsers.find(
          (entry) => entry.userId === revokedBetaUserId,
        );
        if (betaUser) {
          betaUser.state = "revoked";
          betaUser.revocationId = `revocation-${revokedBetaUserId}`;
          betaUser.revocationReason = body.reason;
          betaUser.revokedBy = "user-admin";
          betaUser.revokedAt = FIXED_NOW;
          betaUser.revocationCleanupCompletedAt = FIXED_NOW;
        }
        await json(route, {
          userId: revokedBetaUserId,
          state: "revoked",
          revocationId: betaUser?.revocationId ?? null,
          cleanupCompleted: true,
        });
        return;
      }
      if (pathname === "/api/admin/organizations" && method === "GET") {
        await json(route, {
          organizations: server.state.adminOrganizations,
        });
        return;
      }

      server.unhandled.push(signature);
      await json(
        route,
        { error: `Unhandled deterministic UI fixture: ${signature}` },
        501,
      );
    },
  };

  return server;
}
