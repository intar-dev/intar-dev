/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { user } from "@/db/schema";
import { hashStoredOAuthToken } from "@/lib/auth";
import {
  DESKTOP_OAUTH_CLIENT_ID, localRunRequest, requireDesktopCaller, startLocalRunRequest, type LocalRunView,
} from "@/lib/desktop-channel";
import { guardBetterAuthRequest, guardCustomApiMutation } from "@/lib/request-security";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  KINO, LEARNER, ORIGIN, STRANGER, machineImage, revisionDoc, seedScenario, specBlob, store,
} from "./scenario-runs/revision-test-fixtures";

const FAR = 9_999_999_999_999;
// The test runtime has no rate limiter binding; the channel takes its environment as an argument.
let allow = true;
const channelEnv = {
  ...env,
  ACCESS_INVITE_RATE_LIMITER: { limit: async () => ({ success: allow }) },
} as unknown as Cloudflare.Env;

describe("the desktop channel", () => {
  let images: Record<string, string>;
  let specs: Record<string, string>;

  /** Stores an access token as the provider does and returns the secret the app would hold. */
  async function token(id: string, userId: string, options: {
    client?: string; scopes?: string[]; expiresAt?: number; revoked?: number; sessionId?: string;
  } = {}): Promise<string> {
    const secret = `secret-${id}-0123456789abcdef`;
    await env.DB.prepare(
      `INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, revoked, scopes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, await hashStoredOAuthToken(secret), options.client ?? DESKTOP_OAUTH_CLIENT_ID, options.sessionId ?? null,
      userId, options.expiresAt ?? FAR, options.revoked ?? null,
      JSON.stringify(options.scopes ?? ["offline_access", "local-runs"])).run();
    return secret;
  }
  const call = (secret: string | null, init: RequestInit = {}, path = "/api/local/runs") =>
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...init.headers },
    });
  const start = (secret: string | null, body: Record<string, unknown> = {}, key = "desktop-key-1") =>
    startLocalRunRequest(call(secret, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ protocol: 1, scenarioId: "intar/web", guestContracts: [3], arch: "x86_64", ...body }),
    }), channelEnv);
  const view = async (response: Response) => (await response.json() as { run: LocalRunView; reused?: boolean; code?: string });

  beforeEach(async () => {
    allow = true;
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of [LEARNER, STRANGER]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    await env.DB.batch([
      // The app's client belongs to nobody, so no account's deletion removes it.
      env.DB.prepare("INSERT INTO oauth_client (id, client_id, redirect_uris, public) VALUES ('jumper-row', ?1, '[\"http://127.0.0.1/callback\"]', 1)")
        .bind(DESKTOP_OAUTH_CLIENT_ID),
      env.DB.prepare("INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('other-row', 'other-app', '[\"https://other.example/callback\"]')"),
    ]);
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    images = { web: await machineImage("web"), client: await machineImage("client") };
    specs = { web: await specBlob("web"), client: await specBlob("client") };
    await seedScenario("intar/web", null, revisionDoc(images, specs));
  });

  it("accepts only the app's own live token with the local-runs scope", async () => {
    const good = await token("good", LEARNER);
    expect(await requireDesktopCaller(call(good))).toEqual({ ok: true, userId: LEARNER, accessTokenId: "good" });

    const refused: Array<[string, string | null]> = [
      ["no token", null],
      ["an unknown token", "secret-unknown-0123456789abcdef"],
      ["another client's token with the scope", await token("other", LEARNER, { client: "other-app" })],
      ["the app's token without the scope", await token("unscoped", LEARNER, { scopes: ["openid", "offline_access"] })],
      ["an expired token", await token("expired", LEARNER, { expiresAt: Date.now() - 1 })],
      ["a revoked token", await token("revoked", LEARNER, { revoked: Date.now() })],
    ];
    for (const [label, secret] of refused) {
      const result = await requireDesktopCaller(call(secret));
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.response.status, label).toBe(401);
    }
    // The stored hash itself is not a credential, and a cookie is never read.
    expect((await requireDesktopCaller(call(await hashStoredOAuthToken(good)))).ok).toBe(false);
    expect((await requireDesktopCaller(call(null, { headers: { cookie: `better-auth.session_token=${good}` } }))).ok).toBe(false);

    // A token bound to a session dies with that session.
    await env.DB.prepare("INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('s1', 's1-token', ?1, ?2, 1, 1)")
      .bind(LEARNER, FAR).run();
    const bound = await token("bound", LEARNER, { sessionId: "s1" });
    expect((await requireDesktopCaller(call(bound))).ok).toBe(true);
    await env.DB.prepare("UPDATE session SET expires_at = 1 WHERE id = 's1'").run();
    expect((await requireDesktopCaller(call(bound))).ok).toBe(false);

    // A disabled client and a banned account end every token at once.
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?1").bind(LEARNER).run();
    expect((await requireDesktopCaller(call(good))).ok).toBe(false);
    const stranger = await token("stranger", STRANGER);
    expect((await requireDesktopCaller(call(stranger))).ok).toBe(true);
    await env.DB.prepare("UPDATE oauth_client SET disabled = 1 WHERE client_id = ?1").bind(DESKTOP_OAUTH_CLIENT_ID).run();
    expect((await requireDesktopCaller(call(stranger))).ok).toBe(false);
  });

  it("starts a local run and says what to run", async () => {
    const secret = await token("t1", LEARNER);
    const response = await start(secret);
    expect(response.status).toBe(201);
    const { run, reused } = await view(response);
    expect(reused).toBe(false);
    expect(run).toMatchObject({ scenarioId: "intar/web", state: "provisioning", active: true });
    expect(run.machines.map((machine) => machine.name).sort()).toEqual(["client", "web"]);
    for (const machine of run.machines) {
      expect(machine).toMatchObject({
        image: images[machine.name], spec: specs[machine.name], kino: KINO, mode: "learn",
        cpuMillis: 1000, memoryMib: 512, diskMib: 4096, egress: false, terminal: true,
        peers: [machine.name === "web" ? "client" : "web"],
      });
    }
    expect(await env.DB.prepare("SELECT runtime, user_id FROM scenario_runs WHERE run_id = ?1").bind(run.runId).first())
      .toEqual({ runtime: "local", user_id: LEARNER });

    // The same request again is the same run; a different one is refused while it is active.
    const replay = await start(secret);
    expect(replay.status).toBe(200);
    expect(await view(replay)).toMatchObject({ reused: true, run: { runId: run.runId } });
    const second = await start(secret, {}, "desktop-key-2");
    expect(second.status).toBe(409);
    expect((await view(second)).code).toBe("scenario_run_active_conflict");
  });

  it("reads and ends a run for its learner only", async () => {
    const mine = await token("mine", LEARNER);
    const theirs = await token("theirs", STRANGER);
    const { run } = await view(await start(mine));
    const path = `/api/local/runs/${run.runId}`;

    expect((await localRunRequest(call(theirs, {}, path), run.runId, "read")).status).toBe(404);
    expect((await localRunRequest(call(theirs, { method: "POST" }, `${path}/end`), run.runId, "end")).status).toBe(404);
    expect((await localRunRequest(call(null, {}, path), run.runId, "read")).status).toBe(401);
    expect((await view(await localRunRequest(call(mine, {}, path), run.runId, "read"))).run).toMatchObject({ active: true });

    const ended = await view(await localRunRequest(call(mine, { method: "POST" }, `${path}/end`), run.runId, "end"));
    expect(ended.run).toMatchObject({ state: "completed", active: false });
    // The server's state is in every answer, and the learner can start again.
    expect((await view(await localRunRequest(call(mine, {}, path), run.runId, "read"))).run.active).toBe(false);
    expect((await start(mine, {}, "desktop-key-2")).status).toBe(201);
  });

  it("refuses what the app cannot run, before a run exists", async () => {
    const secret = await token("t1", LEARNER);
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ protocol: 2 }, 409, "upgrade_required"],
      [{ guestContracts: [2] }, 409, "upgrade_required"],
      [{ arch: "aarch64" }, 409, "architecture_unavailable"],
      [{ scenarioId: "intar/unknown" }, 404, "scenario_not_found"],
      [{ scenarioId: "not-an-id" }, 400, "invalid_scenario"],
      [{ organizationId: "no-such-org" }, 404, "scenario_not_found"],
      // Options of the internal start are not part of this request.
      [{ guestContracts: "3" }, 400, "invalid_guest_contracts"],
    ];
    for (const [body, status, code] of cases) {
      const response = await start(secret, body);
      expect(response.status, code).toBe(status);
      expect((await view(response)).code, JSON.stringify(body)).toBe(code);
    }
    expect((await start(null)).status).toBe(401);
    // Starts are limited per learner, after the token is known.
    allow = false;
    expect((await start(secret)).status).toBe(429);
    allow = true;
    expect(await env.DB.prepare("SELECT count(*) AS n FROM scenario_runs").first()).toEqual({ n: 0 });

    // Admin flags and a host id in the body change nothing: the run is an ordinary local run.
    const response = await start(secret, { allowSequenceBypass: true, allowDrainedAdminProof: true, hostId: "host-1" });
    expect(response.status).toBe(201);
    const { run } = await view(response);
    expect(await env.DB.prepare("SELECT host_id, request_scope_json FROM scenario_runs WHERE run_id = ?1").bind(run.runId).first())
      .toMatchObject({ host_id: `local:${LEARNER}` });
    const scope = JSON.parse((await env.DB.prepare("SELECT request_scope_json AS scope FROM scenario_runs WHERE run_id = ?1")
      .bind(run.runId).first<{ scope: string }>())!.scope);
    expect(scope).toMatchObject({ allowSequenceBypass: false, allowDrainedAdminProof: false, hostId: null, runtime: "local" });
  });

  it("lets a native client through the origin guard only where it authenticates by token", async () => {
    const guardEnv = { BETTER_AUTH_URL: ORIGIN };
    const post = (path: string, headers: Record<string, string> = {}, body = "{}") =>
      new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    // No Origin header at all, as a native client sends it.
    expect((await guardCustomApiMutation(post("/api/local/runs"), guardEnv)).ok).toBe(true);
    expect((await guardCustomApiMutation(post("/api/local/runs/r1/end"), guardEnv)).ok).toBe(true);
    expect((await guardCustomApiMutation(post("/api/scenarios/intar/web/start"), guardEnv)).ok).toBe(false);
    // The body rules still hold on the channel.
    const tooLarge = await guardCustomApiMutation(post("/api/local/runs", {}, JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) })), guardEnv);
    expect(tooLarge.ok).toBe(false);

    const form = (path: string) => new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token",
    });
    expect((await guardBetterAuthRequest(form("/api/auth/oauth2/token"), guardEnv)).ok).toBe(true);
    expect((await guardBetterAuthRequest(form("/api/auth/oauth2/revoke"), guardEnv)).ok).toBe(true);
    // Everything else under better-auth still needs the browser's origin.
    expect((await guardBetterAuthRequest(form("/api/auth/sign-out"), guardEnv)).ok).toBe(false);
    expect((await guardBetterAuthRequest(form("/api/auth/oauth2/consent"), guardEnv)).ok).toBe(false);
  });
});
