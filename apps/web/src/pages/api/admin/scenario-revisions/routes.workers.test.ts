/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { member, organization } from "@/db/schema";
import type { UserContext } from "@/lib/agent-bridge";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { GET as list } from "@/pages/api/admin/scenario-revisions/index";
import { GET as read, POST as change } from "@/pages/api/admin/scenario-revisions/[namespace]/[slug]";
import { GET as builds } from "@/pages/api/admin/machine-builds/index";
import { GET as buildLog } from "@/pages/api/admin/machine-builds/[buildKey]/log";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/agent-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-bridge")>()),
  requireUserContext: mocks.auth,
}));

const as = (userId: string, extra: Partial<UserContext> = {}) => mocks.auth.mockResolvedValue({
  ok: true,
  context: { userId, sessionId: "browser", role: "user", isAdmin: userId === "admin", organizationIds: [], activeOrganizationId: null, ...extra },
});
const call = (route: typeof list, params: Record<string, string> = {}, body?: unknown) => route({
  request: new Request("https://intar.test/api", body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  params,
} as never);
const scenarioIds = async (response: Response) =>
  ((await response.json()) as { scenarios: Array<{ id: string }> }).scenarios.map((scenario) => scenario.id);

beforeEach(async () => {
  await resetD1Database();
  // The test runtime has no rate limit binding.
  Object.assign(env, { ACCESS_INVITE_RATE_LIMITER: { limit: async () => ({ success: true }) } });
  await createFixtureMember({ d1: env.DB, userId: "admin", role: "admin" });
  for (const id of ["owner", "other"]) await createFixtureMember({ d1: env.DB, userId: id });
  const db = drizzle(env.DB);
  await db.insert(organization).values(["acme", "beta"].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
  await db.insert(member).values([
    { id: "m1", organizationId: "acme", userId: "owner", role: "owner", createdAt: new Date() },
    { id: "m2", organizationId: "beta", userId: "other", role: "admin", createdAt: new Date() },
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, organization_id, scope_key, enabled, play, candidate_rev)
      VALUES ('intar/web', 'intar', 'web', NULL, 'public', 1, 0, 'r1'), ('acme/web', 'acme', 'web', 'acme', 'organization:acme', 1, 0, 'r1')`),
    env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
      VALUES ('intar/web', 'r1', 3, '{}', 'ready', 1), ('acme/web', 'r1', 3, '{}', 'ready', 1)`),
    env.DB.prepare(`INSERT INTO bundles (rev, scope_key, organization_id, compiler_version, r2_key, created_at)
      VALUES ('b-public', 'public', NULL, 'c', 'k1', 1), ('b-acme', 'organization:acme', 'acme', 'c', 'k2', 1)`),
    env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, target_json, state, log_key, error)
      VALUES ('sha256:p', 'f', 'b-public', '{"kind":"machine","scenario":"web","machine":"vm"}', 'failed', 'builds/logs/p.log', 'boom'),
        ('sha256:a', 'f', 'b-acme', '{"kind":"image","name":"trixie"}', 'building', 'builds/logs/a.log', NULL)`),
  ]);
  await env.VM_IMAGE_REGISTRY_BUCKET.put("builds/logs/p.log", "public log");
  await env.VM_IMAGE_REGISTRY_BUCKET.put("builds/logs/a.log", "acme log");
});

describe("scenario revision routes", () => {
  it("show each admin only the scenarios of their scopes", async () => {
    as("admin");
    expect(await scenarioIds(await call(list))).toEqual(["acme/web", "intar/web"]);
    as("owner");
    expect(await scenarioIds(await call(list))).toEqual(["acme/web"]);
    expect((await call(read, { namespace: "intar", slug: "web" })).status).toBe(404);
    as("other");
    expect(await scenarioIds(await call(list))).toEqual([]);
    expect((await call(read, { namespace: "acme", slug: "web" })).status).toBe(404);
  });

  it("let only the scope's admins change a scenario", async () => {
    as("owner");
    expect((await call(change, { namespace: "intar", slug: "web" }, { action: "rollback", rev: "r1", liveRev: null })).status).toBe(404);
    as("other");
    expect((await call(change, { namespace: "acme", slug: "web" }, { action: "lift_hold", rev: "r1" })).status).toBe(404);
    as("admin");
    expect((await call(change, { namespace: "acme", slug: "web" }, { action: "rollback", rev: "r1", liveRev: null })).status).toBe(403);
    expect((await call(change, { namespace: "intar", slug: "web" }, { action: "drop", rev: "r1" })).status).toBe(400);
    as("admin", { impersonated: true } as Partial<UserContext>);
    expect((await call(change, { namespace: "intar", slug: "web" }, { action: "rollback", rev: "r1", liveRev: null })).status).toBe(403);
  });

  it("refuse an administrator's approval actions, which are the source's job's, and still roll back and lift a hold", async () => {
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified', restore_verified_at = 5, behaviour_digest = 'd'").run();
    as("admin");
    for (const body of [
      { action: "verify", rev: "r1" },
      { action: "promote", rev: "r1", liveRev: null },
      { action: "verify_restore", rev: "r1" },
      { action: "clear_restore_verified", rev: "r1" },
    ]) {
      const response = await call(change, { namespace: "intar", slug: "web" }, body);
      expect(response.status, body.action).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    // Nothing moved, started or was withdrawn.
    expect(await env.DB.prepare("SELECT live_rev FROM scenarios WHERE id = 'intar/web'").first("live_rev")).toBeNull();
    expect(await env.DB.prepare("SELECT restore_verified_at FROM scenario_revisions WHERE scenario_id = 'intar/web'")
      .first("restore_verified_at")).toBe(5);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scenario_runs").first("n")).toBe(0);

    // A rollback reaches the move: r1 was never live, so it has nowhere to go back to.
    const rollback = await call(change, { namespace: "intar", slug: "web" }, { action: "rollback", rev: "r1", liveRev: null });
    expect(await rollback.json()).toMatchObject({ code: "revision_never_live" });
    // A hold is lifted.
    await env.DB.prepare(`INSERT INTO scenario_revision_holds (scenario_id, behaviour_digest, held_at, held_by_user_id)
      VALUES ('intar/web', 'd', 1, 'admin')`).run();
    const lifted = await call(change, { namespace: "intar", slug: "web" }, { action: "lift_hold", rev: "r1" });
    expect(lifted.status).toBe(200);
    expect(await env.DB.prepare("SELECT lifted_by_user_id FROM scenario_revision_holds WHERE scenario_id = 'intar/web'")
      .first("lifted_by_user_id")).toBe("admin");
  });
});

describe("machine build routes", () => {
  it("show platform admins every build and organization admins their bundles' builds", async () => {
    const keys = async () => ((await (await call(builds)).json()) as { builds: Array<{ buildKey: string; target: string }> }).builds;
    as("admin");
    expect((await keys()).map((build) => [build.buildKey, build.target]).sort())
      .toEqual([["sha256:a", "trixie"], ["sha256:p", "web/vm"]]);
    expect(await (await call(buildLog, { buildKey: "sha256:p" })).text()).toBe("public log");
    as("owner");
    expect((await keys()).map((build) => build.buildKey)).toEqual(["sha256:a"]);
    expect(await (await call(buildLog, { buildKey: "sha256:a" })).text()).toBe("acme log");
    expect((await call(buildLog, { buildKey: "sha256:p" })).status).toBe(404);
    as("other");
    expect(await keys()).toEqual([]);
    expect((await call(buildLog, { buildKey: "sha256:a" })).status).toBe(404);
  });

  it("serve each attempt's log up to the newest uploaded one", async () => {
    const attemptLog = (attempt: string | null) => buildLog({
      request: new Request(`https://intar.test/api/admin/machine-builds/sha256:p/log${attempt === null ? "" : `?attempt=${attempt}`}`),
      params: { buildKey: "sha256:p" },
    } as never);
    const listed = async () => ((await (await call(builds)).json()) as {
      builds: Array<{ buildKey: string; logAttempts: number[] }>;
    }).builds.find((build) => build.buildKey === "sha256:p")!.logAttempts;
    as("admin");
    for (const n of [1, 2]) await env.VM_IMAGE_REGISTRY_BUCKET.put(`builds/logs/p.${n}.log`, `log ${n}`);

    // Attempt 1 failed and attempt 2 runs: the link serves attempt 1.
    await env.DB.prepare("UPDATE machine_builds SET state = 'building', attempt = 2, log_key = 'builds/logs/p.1.log' WHERE build_key = 'sha256:p'").run();
    expect(await (await attemptLog(null)).text()).toBe("log 1");
    expect(await (await attemptLog("1")).text()).toBe("log 1");
    expect((await attemptLog("2")).status).toBe(404);
    expect(await listed()).toEqual([1]);

    // Attempt 2 succeeded: both attempts are readable.
    await env.DB.prepare("UPDATE machine_builds SET state = 'succeeded', log_key = 'builds/logs/p.2.log' WHERE build_key = 'sha256:p'").run();
    expect(await (await attemptLog(null)).text()).toBe("log 2");
    expect(await (await attemptLog("1")).text()).toBe("log 1");
    expect(await (await attemptLog("2")).text()).toBe("log 2");
    expect(await listed()).toEqual([1, 2]);
    expect((await attemptLog("0")).status).toBe(400);
    expect((await attemptLog("x")).status).toBe(400);

    // Requeued for another bundle: no earlier attempt is served, even if an
    // object outlived its delete.
    await env.DB.prepare("UPDATE machine_builds SET state = 'queued', attempt = 0, log_key = NULL WHERE build_key = 'sha256:p'").run();
    expect((await attemptLog("1")).status).toBe(404);
    expect((await attemptLog(null)).status).toBe(404);
    expect(await listed()).toEqual([]);
  });
});
