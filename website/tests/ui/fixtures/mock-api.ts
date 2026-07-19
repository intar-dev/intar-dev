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
        await json(route, { redirect: false, url: "/scenarios" });
        return;
      }
      if (pathname === "/api/auth/sign-out" && method === "POST") {
        await json(route, { success: true });
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
        /^\/api\/auth\/admin\/(ban-user|unban-user|set-role)$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const target = server.state.users.find(
          (user) => user.id === body.userId,
        );
        if (target) {
          if (pathname.endsWith("ban-user")) target.banned = true;
          if (pathname.endsWith("unban-user")) target.banned = false;
          if (pathname.endsWith("set-role") && typeof body.role === "string") {
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

      if (pathname === "/api/access-requests" && method === "POST") {
        await json(route, { accepted: true }, 202);
        return;
      }

      if (pathname === "/api/scenarios" && method === "GET") {
        await json(route, { scenarios: server.state.scenarios });
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
        await json(route, { scenarios: server.state.scenarios });
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
        await json(route, { hosts: server.state.hosts });
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
        await json(route, { host: server.state.hosts[0] ?? null });
        return;
      }
      if (hostId && method === "DELETE") {
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

      if (pathname === "/api/admin/access-requests" && method === "GET") {
        await json(route, { requests: server.state.accessRequests });
        return;
      }
      if (
        /^\/api\/admin\/access-requests\/[^/]+\/decision$/.test(pathname) &&
        method === "POST"
      ) {
        const body = await requestBody(route);
        const requestId = segment(
          pathname,
          /^\/api\/admin\/access-requests\/([^/]+)\/decision$/,
        );
        const accessRequest = server.state.accessRequests.find(
          (entry) => entry.id === requestId,
        );
        if (accessRequest && typeof body.decision === "string") {
          accessRequest.status = body.decision;
          accessRequest.decidedAt = FIXED_NOW;
          accessRequest.decidedBy = "user-admin";
        }
        await json(route, { request: accessRequest ?? null });
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
