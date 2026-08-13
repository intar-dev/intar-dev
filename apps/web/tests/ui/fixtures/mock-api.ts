import type { Route } from "@playwright/test";
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
  handle(route: Route): Promise<void>;
  setRunState(state: RunFixtureState): void;
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, json: body });
}

function noContent(route: Route) {
  return route.fulfill({ status: 204, body: "" });
}

const GENERAL_PRACTICE_DESCRIPTION =
  "Standalone systems for focused practice outside a guided curriculum.";

function nestedCourseCatalog(
  scenarios: Array<Record<string, unknown>>,
  courses: Array<Record<string, unknown>>,
) {
  const scenarioById = new Map(
    scenarios.flatMap((scenario) =>
      typeof scenario.scenarioId === "string"
        ? [[scenario.scenarioId, scenario] as const]
        : [],
    ),
  );
  const claimed = new Set<string>();
  const authored = courses.flatMap((course) => {
    const members = Array.isArray(course.scenarioIds)
      ? course.scenarioIds.flatMap((scenarioId) => {
          if (typeof scenarioId !== "string" || claimed.has(scenarioId)) {
            return [];
          }
          const scenario = scenarioById.get(scenarioId);
          if (!scenario) return [];
          claimed.add(scenarioId);
          return [scenario];
        })
      : [];
    if (!members.length) return [];
    return [
      {
        kind: "authored" as const,
        courseId: course.courseId,
        organizationId: course.organizationId ?? null,
        title: course.title,
        description: course.description,
        scenarios: members,
      },
    ];
  });
  const generalScenarios = scenarios.filter(
    (scenario) =>
      typeof scenario.scenarioId === "string" &&
      !claimed.has(scenario.scenarioId),
  );

  return {
    courses: [
      ...authored,
      ...(generalScenarios.length
        ? [
            {
              kind: "general-practice" as const,
              courseId: null,
              organizationId: null,
              title: "General practice" as const,
              description: GENERAL_PRACTICE_DESCRIPTION,
              scenarios: generalScenarios,
            },
          ]
        : []),
    ],
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
    setRunState(runState) {
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
      const foreground = server.state.run.activity === "foreground";
      const catalogEntry = server.state.scenarios.find(
        (scenario) => scenario.scenarioId === "repair-nginx",
      );
      if (catalogEntry?.progress && typeof catalogEntry.progress === "object") {
        const progress = catalogEntry.progress as Record<string, unknown>;
        progress.activeRunId = foreground ? "run-active" : null;
        progress.status = foreground ? "in_progress" : "attempted";
      }
      server.state.scenarioDetail.hasActiveRun = foreground;
      server.state.scenarioDetail.activeRunId = foreground
        ? "run-active"
        : null;
      server.state.scenarioDetail.activeRun = foreground
        ? server.state.scenarioDetail.activeRun
        : null;
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
      if (pathname === "/api/auth/admin/list-users" && method === "GET") {
        await json(route, {
          users: server.state.users,
          total: server.state.users.length,
          limit: 200,
          offset: 0,
        });
        return;
      }
      if (
        /^\/api\/admin\/users\/[^/]+\/(ban|role)$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const userId = segment(
          pathname,
          /^\/api\/admin\/users\/([^/]+)\/(?:ban|role)$/,
        );
        const target = server.state.users.find((user) => user.id === userId);
        if (target) {
          if (pathname.endsWith("/ban") && typeof body.banned === "boolean") {
            target.banned = body.banned;
          }
          if (pathname.endsWith("/role") && typeof body.role === "string") {
            target.role = body.role;
          }
        }
        await json(route, { user: target ?? null });
        return;
      }
      if (
        pathname === "/api/auth/oauth2/public-client-prelogin" &&
        method === "POST"
      ) {
        await json(route, {
          client_id: "intar-cli",
          client_name: "Intar Workshop CLI",
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

      if (pathname === "/api/workshops" && method === "GET") {
        await json(route, { sessions: server.state.workshopSessions });
        return;
      }
      const workshopSessionId = segment(
        pathname,
        /^\/api\/workshops\/([^/]+)$/,
      );
      if (workshopSessionId && method === "GET") {
        const session = structuredClone(server.state.workshopSession);
        if (url.searchParams.get("view") === "projector") {
          const modules = Array.isArray(session.modules)
            ? (session.modules as Array<Record<string, unknown>>)
            : [];
          const slides = Array.isArray(session.slides)
            ? (session.slides as Array<Record<string, unknown>>)
            : [];
          session.viewer = {
            userId: "projector-viewer",
            role: "participant",
            checkedIn: false,
            canFacilitate: false,
            canPresent: false,
          };
          session.modules = modules
            .filter((module) => module.released === true)
            .map((module) => ({
              ...module,
              dependsOn: [],
              health: "unknown",
              contentMarkdown: null,
              facilitatorNotesMarkdown: null,
              solutionMarkdown: null,
              solutionRevealed: false,
              explainBackPrompt: null,
              explainBackCompletedAt: null,
              verifiedAt: null,
              hints: [],
              probes: [],
            }));
          session.agenda = [];
          const currentSlideOrdinal = Number(session.currentSlideOrdinal ?? 0);
          session.slides = slides.map((slide, ordinal) => {
            const released =
              ordinal === currentSlideOrdinal && slide.released === true;
            return {
              ...slide,
              bodyMarkdown: released ? slide.bodyMarkdown : null,
              notesMarkdown: null,
              released,
            };
          });
          session.workspace = null;
          session.helpRequest = null;
          session.assistGrant = null;
          session.roster = [];
          session.capacity = null;
        }
        await json(route, { session });
        return;
      }
      if (
        /^\/api\/workshops\/[^/]+\/presence$/.test(pathname) &&
        method === "POST"
      ) {
        await json(route, {
          observedAt: FIXED_NOW,
          lastSeenAt: FIXED_NOW,
          state: "present",
        });
        return;
      }
      if (
        /^\/api\/workshops\/[^/]+\/actions$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const workshop = server.state.workshopSession;
        const action = String(body.action ?? "");
        workshop.version = Number(workshop.version ?? 1) + 1;
        if (action === "check_in") {
          (workshop.viewer as Record<string, unknown>).checkedIn = true;
        }
        if (action === "open_lobby") workshop.state = "lobby";
        if (action === "go_live") workshop.state = "live";
        if (action === "end_session") workshop.state = "ended";
        if (action === "announce") {
          workshop.announcement = String(body.message ?? "");
        }
        if (action === "set_slide") {
          const ordinal = Number(body.slideOrdinal ?? 0);
          workshop.currentSlideOrdinal = ordinal;
          const slides = workshop.slides as Array<Record<string, unknown>>;
          workshop.currentSlideId = slides[ordinal]?.id ?? null;
        }
        if (action === "focus_module") {
          workshop.currentModuleId = String(body.moduleId ?? "");
          const agenda = workshop.agenda as Array<Record<string, unknown>>;
          for (const item of agenda) {
            item.active = item.moduleId === body.moduleId;
          }
        }
        if (action === "focus_agenda") {
          const agendaItemId = String(body.agendaItemId ?? "");
          const agenda = workshop.agenda as Array<Record<string, unknown>>;
          const focused = agenda.find((item) => item.id === agendaItemId);
          workshop.currentAgendaItemId = agendaItemId;
          workshop.currentModuleId = focused?.moduleId ?? null;
          for (const item of agenda) item.active = item.id === agendaItemId;
        }
        if (action === "release_module") {
          const moduleId = String(body.moduleId ?? "");
          const modules = workshop.modules as Array<Record<string, unknown>>;
          const module = modules.find((entry) => entry.id === moduleId);
          if (module) {
            module.released = true;
            module.state = "available";
          }
          const agenda = workshop.agenda as Array<Record<string, unknown>>;
          for (const item of agenda) {
            if (item.moduleId === moduleId) item.released = true;
          }
        }
        if (action === "reveal_hint") {
          const modules = workshop.modules as Array<Record<string, unknown>>;
          const module = modules.find((entry) => entry.id === body.moduleId);
          const hints = (module?.hints ?? []) as Array<Record<string, unknown>>;
          const hint = hints.find((entry) => entry.id === body.hintId);
          if (hint) {
            hint.revealed = true;
            hint.bodyMarkdown =
              "Inspect the boundary with `talosctl health` before debugging Cilium.";
          }
        }
        if (action === "complete_explain_back") {
          const modules = workshop.modules as Array<Record<string, unknown>>;
          const module = modules.find((entry) => entry.id === body.moduleId);
          if (module) module.explainBackCompletedAt = FIXED_NOW;
        }
        if (action === "reveal_solution") {
          const modules = workshop.modules as Array<Record<string, unknown>>;
          const module = modules.find((entry) => entry.id === body.moduleId);
          if (module) module.solutionRevealed = true;
        }
        if (action === "pause_timer") {
          const timer = workshop.timer as Record<string, unknown> | null;
          if (timer) {
            timer.pausedAt = FIXED_NOW;
            timer.remainingMs = Math.max(
              0,
              Number(timer.endsAt ?? FIXED_NOW) - FIXED_NOW,
            );
            timer.endsAt = null;
            timer.observedAt = FIXED_NOW;
          }
        }
        if (action === "resume_timer") {
          const timer = workshop.timer as Record<string, unknown> | null;
          if (timer) {
            timer.endsAt = FIXED_NOW + Number(timer.remainingMs ?? 0);
            timer.pausedAt = null;
            timer.observedAt = FIXED_NOW;
          }
        }
        if (action === "provision_checked_in") {
          const roster = workshop.roster as Array<Record<string, unknown>>;
          for (const member of roster) {
            if (member.role === "participant" && member.checkedInAt) {
              member.workspaceState = "ready";
            }
          }
        }
        if (action === "replace_roster") {
          const sessionId = pathname.split("/").at(-2);
          const sessions = server.state.organizationWorkshops.sessions as Array<
            Record<string, unknown>
          >;
          const summary = sessions.find((entry) => entry.id === sessionId);
          if (summary) {
            summary.version = Number(summary.version ?? 1) + 1;
            summary.draftRoster = Array.isArray(body.members)
              ? body.members
              : [];
          }
        }
        if (action === "claim_help") {
          const roster = workshop.roster as Array<Record<string, unknown>>;
          const member = roster.find((entry) => entry.userId === body.userId);
          if (member) {
            member.helpState = "claimed";
            member.helpAssignedToViewer = true;
          }
        }
        if (action === "resolve_help") {
          const roster = workshop.roster as Array<Record<string, unknown>>;
          const member = roster.find((entry) => entry.userId === body.userId);
          if (member) {
            member.helpState = "none";
            member.helpAssignedToViewer = false;
          }
        }
        if (action === "grant_assist") {
          workshop.assistGrant = {
            id: "assist-fixture",
            helperName: "Inez Instructor",
            expiresAt: FIXED_NOW + 15 * 60_000,
            revokedAt: null,
          };
        }
        if (action === "revoke_assist") workshop.assistGrant = null;
        await json(route, { session: workshop });
        return;
      }
      if (
        /^\/api\/workshops\/[^/]+\/help-requests$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        server.state.workshopSession.helpRequest = {
          id: "help-fixture",
          state: "open",
          message: String(body.message ?? ""),
          moduleId: body.moduleId ?? null,
          requestedAt: FIXED_NOW,
          claimedByName: null,
        };
        await json(route, { session: server.state.workshopSession }, 201);
        return;
      }
      if (
        /^\/api\/workshops\/[^/]+\/help-requests\/[^/]+$/.test(pathname) &&
        method === "DELETE"
      ) {
        server.state.workshopSession.helpRequest = null;
        server.state.workshopSession.assistGrant = null;
        await json(route, { session: server.state.workshopSession });
        return;
      }
      if (
        /^\/api\/workshops\/[^/]+\/terminal$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        if (body.mode === "native") {
          await json(route, {
            routeUsername: "workshop-route-test-only-native",
            expiresAt: FIXED_NOW + 15 * 60_000,
            native: {
              authMode: "profile_keys",
              authorizedKeyCount: 1,
              host: "stargate.example.test",
              port: 2222,
              username: "workshop-route-test-only-native",
              command:
                "ssh -p 2222 workshop-route-test-only-native@stargate.example.test",
              publicHostKeyOpenssh: "ssh-ed25519 test-only-host-key",
              publicHostKeyFingerprintSha256: "SHA256:test-only-fingerprint",
              knownHostsLine:
                "[stargate.example.test]:2222 ssh-ed25519 test-only-host-key",
            },
          });
          return;
        }
        await json(route, {
          routeUsername: "workshop-route-test-only",
          expiresAt: FIXED_NOW + 15 * 60_000,
          browser: {
            websocketUrl: "ws://terminal.example.test/terminal/workshop-live",
          },
        });
        return;
      }

      if (pathname === "/api/scenarios" && method === "GET") {
        await json(
          route,
          nestedCourseCatalog(server.state.scenarios, server.state.courses),
        );
        return;
      }
      if (
        pathname === "/api/organizations/my-assignments" &&
        method === "GET"
      ) {
        await json(route, { assignments: server.state.assignments });
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
      const learnerScenarioId = segment(
        pathname,
        /^\/api\/scenarios\/([^/]+)$/,
      );
      if (learnerScenarioId && method === "GET") {
        await json(route, { scenario: server.state.scenarioDetail });
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
          await json(route, {
            routeUsername: "route-test-only",
            expiresAt: FIXED_NOW + 15 * 60_000,
            native: {
              authMode: "profile_keys",
              authorizedKeyCount: 1,
              host: "stargate.example.test",
              port: 2222,
              username: "route-test-only",
              command: "ssh -p 2222 route-test-only@stargate.example.test",
              publicHostKeyOpenssh: `ssh-ed25519 ${"A".repeat(68)}`,
              publicHostKeyFingerprintSha256: "SHA256:test-only-host-key",
              knownHostsLine:
                "[stargate.example.test]:2222 ssh-ed25519 test-only-host-key",
            },
          });
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
      if (
        /^\/api\/organizations\/[^/]+\/workshops$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, server.state.organizationWorkshops);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/workshops\/tokens$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { tokens: server.state.workshopRegistryTokens });
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/workshops\/tokens$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const token = `intar_ws_${"d".repeat(64)}`;
        const created = {
          id: "workshop-registry-token-created",
          name: String(body.name ?? "Workshop publisher"),
          tokenPrefix: token.slice(0, "intar_ws_".length + 10),
          token,
          lastUsedAt: null,
          expiresAt:
            typeof body.expiresAfterMinutes === "number"
              ? FIXED_NOW + body.expiresAfterMinutes * 60_000
              : FIXED_NOW + 24 * 60 * 60 * 1_000,
          revokedAt: null,
          createdAt: FIXED_NOW,
        };
        server.state.workshopRegistryTokens.unshift(
          Object.fromEntries(
            Object.entries(created).filter(([key]) => key !== "token"),
          ),
        );
        await json(route, created, 201);
        return;
      }
      const workshopRegistryTokenId = segment(
        pathname,
        /^\/api\/organizations\/[^/]+\/workshops\/tokens\/([^/]+)$/,
      );
      if (workshopRegistryTokenId && method === "DELETE") {
        const token = server.state.workshopRegistryTokens.find(
          (entry) => entry.id === workshopRegistryTokenId,
        );
        if (token) token.revokedAt = FIXED_NOW;
        await noContent(route);
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/workshop-sessions$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const session = structuredClone(server.state.workshopSession);
        session.id = "workshop-new";
        session.title = String(body.title ?? "New workshop");
        session.state = "draft";
        session.startsAt = Number(
          body.startsAt ?? FIXED_NOW + 24 * 60 * 60_000,
        );
        session.endsAt = Number(session.startsAt) + 4 * 60 * 60_000;
        session.lobbyOpensAt = Number(session.startsAt) - 30 * 60_000;
        session.currentModuleId = null;
        session.currentSlideOrdinal = 0;
        await json(route, { session }, 201);
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
        /^\/api\/organizations\/[^/]+\/scenarios$/.test(pathname) &&
        method === "GET"
      ) {
        await json(
          route,
          nestedCourseCatalog(
            server.state.organizationScenarios,
            server.state.organizationCourses,
          ),
        );
        return;
      }
      if (
        /^\/api\/organizations\/[^/]+\/scenarios\/sources$/.test(pathname) &&
        method === "GET"
      ) {
        await json(route, { sources: server.state.sources });
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
        const body = await requestBody(route);
        const invite = {
          id: `invite-created-${server.state.accessInvites.length + 1}`,
          codePrefix: "intar_beta_CCCCCCCC",
          kind: "standard",
          state: "pending",
          label: typeof body.label === "string" ? body.label : null,
          createdBy: "user-admin",
          createdAt: FIXED_NOW,
          expiresAt: FIXED_NOW + 14 * 24 * 60 * 60_000,
          leaseExpiresAt: null,
          redeemerUserId: null,
          redeemerGithubAccountId: null,
          redeemerGithubUsername: null,
          redeemedAt: null,
          revokedBy: null,
          revocationReason: null,
          revokedAt: null,
          replacesInviteId: null,
          replacedByInviteId: null,
          version: 1,
          updatedAt: FIXED_NOW,
        };
        server.state.accessInvites.unshift(invite);
        await json(
          route,
          {
            invite,
            inviteUrl: `http://127.0.0.1:4330/join#invite=intar_beta_${"C".repeat(43)}`,
          },
          201,
        );
        return;
      }
      const replacedInviteId = segment(
        pathname,
        /^\/api\/admin\/access-invites\/([^/]+)\/replace$/,
      );
      if (replacedInviteId && method === "POST") {
        const replaced = server.state.accessInvites.find(
          (entry) => entry.id === replacedInviteId,
        );
        if (replaced) {
          replaced.state = "revoked";
          replaced.revocationReason = "replaced";
          replaced.revokedAt = FIXED_NOW;
          replaced.updatedAt = FIXED_NOW;
          replaced.version = Number(replaced.version ?? 0) + 1;
        }
        const invite = {
          ...(replaced ?? {}),
          id: `${replacedInviteId}-replacement`,
          codePrefix: "intar_beta_DDDDDDDD",
          state: "pending",
          createdAt: FIXED_NOW,
          expiresAt: FIXED_NOW + 14 * 24 * 60 * 60_000,
          revokedBy: null,
          revocationReason: null,
          revokedAt: null,
          replacesInviteId: replacedInviteId,
          replacedByInviteId: null,
          version: 1,
          updatedAt: FIXED_NOW,
        };
        server.state.accessInvites.unshift(invite);
        await json(route, {
          invite,
          inviteUrl: `http://127.0.0.1:4330/join#invite=intar_beta_${"D".repeat(43)}`,
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
        if (invite) {
          invite.state = "revoked";
          invite.revocationReason = body.reason;
          invite.revokedBy = "user-admin";
          invite.revokedAt = FIXED_NOW;
          invite.updatedAt = FIXED_NOW;
          invite.version = Number(invite.version ?? 0) + 1;
        }
        await json(route, { invite: invite ?? null });
        return;
      }
      const removedInviteId = segment(
        pathname,
        /^\/api\/admin\/access-invites\/([^/]+)\/remove$/,
      );
      if (removedInviteId && method === "POST") {
        const body = await requestBody(route);
        const invite = server.state.accessInvites.find(
          (entry) => entry.id === removedInviteId,
        );
        if (!invite || body.expectedVersion !== invite.version) {
          await json(
            route,
            { code: "access_invite_stale_version", message: "stale invite" },
            409,
          );
          return;
        }
        server.state.accessInvites = server.state.accessInvites.filter(
          (entry) => entry.id !== removedInviteId,
        );
        await json(route, { removed: true });
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
          betaUser.state = "blocked";
          betaUser.revocationId = `revocation-${revokedBetaUserId}`;
          betaUser.revocationReason = body.reason;
          betaUser.revokedBy = "user-admin";
          betaUser.revokedAt = FIXED_NOW;
          betaUser.revocationCleanupCompletedAt = FIXED_NOW;
        }
        await json(route, {
          userId: revokedBetaUserId,
          state: "blocked",
          revocationId: betaUser?.revocationId ?? null,
          cleanupCompleted: true,
        });
        return;
      }
      const reinvitedBetaUserId = segment(
        pathname,
        /^\/api\/admin\/beta-users\/([^/]+)\/allow-reinvite$/,
      );
      if (reinvitedBetaUserId && method === "POST") {
        server.state.betaUsers = server.state.betaUsers.filter(
          (entry) => entry.userId !== reinvitedBetaUserId,
        );
        await json(route, {
          userId: reinvitedBetaUserId,
          state: "reinvite_allowed",
        });
        return;
      }
      if (pathname === "/api/admin/organizations" && method === "GET") {
        await json(route, {
          organizations: server.state.adminOrganizations,
        });
        return;
      }

      if (pathname === "/api/admin/authoring/sources" && method === "GET") {
        await json(route, { sources: server.state.sources });
        return;
      }
      if (pathname === "/api/admin/authoring/sources" && method === "POST") {
        await json(route, { source: server.state.sources[0] ?? null }, 201);
        return;
      }
      const sourceId = segment(
        pathname,
        /^\/api\/admin\/authoring\/sources\/([^/]+)$/,
      );
      if (sourceId && method === "GET") {
        await json(route, {
          source: {
            id: sourceId,
            scenarioId: sourceId,
            hcl: server.state.sourceHcl,
          },
        });
        return;
      }
      if (sourceId && method === "DELETE") {
        await noContent(route);
        return;
      }
      if (pathname === "/api/admin/authoring/build" && method === "POST") {
        await json(route, {
          rev: "rev-test-only",
          queued: 1,
          assigned: [{ buildId: "build-test-only", hostId: "host-builder-1" }],
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
