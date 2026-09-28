import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import workerSource from "../worker.ts?raw";
import {
  GITHUB_WEBHOOK_PATH,
  handleGitHubWebhook,
} from "@/control-plane/github-webhook";
import { handleMaintenanceMode } from "@/maintenance";
import { resetD1Database } from "@/test/d1-migrations";

const INSTALLATION = 7;
const REPOSITORY = 42;
const HEAD_SHA = "a".repeat(40);

describe("GitHub App webhook", () => {
  beforeEach(async () => {
    await resetD1Database();
    await env.DB.batch([
      binding("public", "NULL", REPOSITORY),
      env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org-a', 'org-a', 'org-a', 0)"),
      binding("organization:org-a", "'org-a'", 43),
    ]);
  });

  it("refuses missing, malformed and wrong signatures", async () => {
    const body = JSON.stringify(push("main"));
    const good = (await sign(body)).slice("sha256=".length);
    for (const signature of [
      null,
      `sha256=${good.slice(0, 63)}`,
      `sha256=${good.slice(0, 63)}g`,
      `sha1=${good}`,
      await sign(`${body} `),
    ]) {
      const response = await deliver("push", body, signature);
      expect(response.status, String(signature)).toBe(401);
    }
    expect(await pokedAt("public")).toBeNull();

    const upper = await deliver("push", body, `sha256=${good.toUpperCase()}`);
    expect(upper.status).toBe(204);
    expect(await pokedAt("public")).toEqual(expect.any(Number));
  });

  it("answers 404 without a secret and 413 above 5 MiB", async () => {
    const unset = await handleGitHubWebhook(
      await request("push", "{}"),
      { ...env, GITHUB_APP_WEBHOOK_SECRET: undefined } as unknown as Cloudflare.Env,
    );
    expect(unset.status).toBe(404);

    const oversized = "x".repeat(5 * 1024 * 1024 + 1);
    const response = await deliver("push", oversized, `sha256=${"0".repeat(64)}`);
    expect(response.status).toBe(413);
  });

  it("pokes a binding only on a default-branch push of its own pair", async () => {
    expect((await deliver("push", { ...push("feature") })).status).toBe(204);
    expect((await deliver("push", { ...push("main"), installation: { id: 8 } })).status).toBe(204);
    expect((await deliver("push", { ...push("main"), repository: { id: 99, default_branch: "main" } })).status).toBe(204);
    expect(await pokedAt("public")).toBeNull();

    expect((await deliver("push", push("main"))).status).toBe(204);
    expect(await pokedAt("public")).toEqual(expect.any(Number));
    expect(await pokedAt("organization:org-a")).toBeNull();
  });

  it("flips rerequested check runs and check suites", async () => {
    await env.DB.batch([
      commit("run-failed", "failed", "b".repeat(40), 101),
      commit("run-invalid", "invalid", "c".repeat(40), 102),
      commit("run-live", "live", "d".repeat(40), 103),
      commit("suite-failed", "failed", HEAD_SHA, null),
      commit("suite-invalid", "invalid", HEAD_SHA, null, "validate"),
    ]);
    const pair = { installation: { id: INSTALLATION }, repository: { id: REPOSITORY } };

    // A check run of another installation never reaches this binding's rows.
    await deliver("check_run", { ...pair, installation: { id: 8 }, action: "rerequested", check_run: { id: 101 } });
    expect(await state("run-failed")).toBe("failed");

    for (const id of [101, 102, 103]) {
      await deliver("check_run", { ...pair, action: "rerequested", check_run: { id } });
    }
    expect(await state("run-failed")).toBe("ingesting");
    expect(await state("run-invalid")).toBe("superseded");
    expect(await state("run-live")).toBe("live");
    expect(await pokedAt("public")).toEqual(expect.any(Number));

    await deliver("check_suite", { ...pair, action: "rerequested", check_suite: { head_sha: HEAD_SHA } });
    expect(await state("suite-failed")).toBe("ingesting");
    expect(await state("suite-invalid")).toBe("invalid");
  });

  it("answers check_suite requested and completed without touching D1", async () => {
    const databaseAccess = vi.fn(() => {
      throw new Error("check_suite touched D1");
    });
    const fenced = { ...env, DB: new Proxy({}, { get: databaseAccess }) } as unknown as Cloudflare.Env;
    for (const action of ["requested", "completed"]) {
      const body = JSON.stringify({
        action,
        check_suite: { head_sha: HEAD_SHA },
        installation: { id: INSTALLATION },
        repository: { id: REPOSITORY },
      });
      const response = await handleGitHubWebhook(await request("check_suite", body), fenced);
      expect(response.status).toBe(204);
    }
    expect(databaseAccess).not.toHaveBeenCalled();
  });

  it("only pokes on a replayed installation_repositories removed", async () => {
    const removed = {
      action: "removed",
      installation: { id: INSTALLATION },
      repositories_removed: [{ id: REPOSITORY }],
    };
    for (let delivery = 0; delivery < 2; delivery += 1) {
      expect((await deliver("installation_repositories", removed)).status).toBe(204);
    }
    const rows = await env.DB.prepare(
      "SELECT poked_at, disconnected_at, paused_at FROM scenario_sources ORDER BY scope_key",
    ).all();
    expect(rows.results).toEqual([
      { poked_at: expect.any(Number), disconnected_at: null, paused_at: null },
      { poked_at: expect.any(Number), disconnected_at: null, paused_at: null },
    ]);
  });

  it("stays behind the maintenance fence", async () => {
    const fenced = await handleMaintenanceMode(await request("push", "{}"), {
      ...env,
      CONTROL_PLANE_MAINTENANCE: "on",
    } as unknown as Cloudflare.Env);
    expect(fenced?.status).toBe(503);

    const fence = workerSource.indexOf("handleMaintenanceMode(request, env)");
    const webhook = workerSource.indexOf("handleGitHubWebhook(request, env)");
    const security = workerSource.indexOf("secureApplicationApiRequest(request, env)");
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(webhook);
    expect(webhook).toBeLessThan(security);
  });
});

function binding(scopeKey: string, organizationId: string, repositoryId: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO scenario_sources (scope_key, organization_id, github_installation_id,
       github_repository_id, github_repository, default_branch)
     VALUES (?1, ${organizationId}, ?2, ?3, 'acme/scenarios-' || ?3, 'main')`,
  ).bind(scopeKey, INSTALLATION, repositoryId);
}

function commit(
  id: string,
  commitState: string,
  sha: string,
  checkRunId: number | null,
  purpose = "deploy",
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, state, check_run_id)
     VALUES (?1, 'public', ?2, ?3, 'git-42-' || ?3 || '-' || ?1, 'pull', ?4, ?5)`,
  ).bind(id, purpose, sha, commitState, checkRunId);
}

function push(branch: string) {
  return {
    ref: `refs/heads/${branch}`,
    installation: { id: INSTALLATION },
    repository: { id: REPOSITORY, default_branch: "main" },
  };
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_APP_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function request(event: string, body: string, signature?: string | null): Promise<Request> {
  const headers = new Headers({ "x-github-event": event, "content-type": "application/json" });
  const value = signature === undefined ? await sign(body) : signature;
  if (value !== null) headers.set("x-hub-signature-256", value);
  return new Request(`https://intar.dev${GITHUB_WEBHOOK_PATH}`, { method: "POST", headers, body });
}

async function deliver(event: string, body: object | string, signature?: string | null): Promise<Response> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return handleGitHubWebhook(await request(event, text, signature), env);
}

async function pokedAt(scopeKey: string): Promise<number | null> {
  return env.DB.prepare("SELECT poked_at FROM scenario_sources WHERE scope_key = ?1")
    .bind(scopeKey)
    .first<number | null>("poked_at");
}

async function state(id: string): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM scenario_source_commits WHERE id = ?1")
    .bind(id)
    .first<string>("state");
}
