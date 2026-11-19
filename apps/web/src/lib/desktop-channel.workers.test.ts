/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { handleLocalRunCliRequest } from "@/control-plane/run-cli";
import { user } from "@/db/schema";
import { hashStoredOAuthToken } from "@/lib/auth";
import {
  DESKTOP_OAUTH_CLIENT_ID, localCatalogRequest, localRunRequest, reportLocalRunRequest, requireDesktopCaller, startLocalRunRequest,
  type LocalRunView,
} from "@/lib/desktop-channel";
import { LOCAL_RUN_SILENCE_MS, reapSilentLocalRuns } from "@/lib/local-runs";
import { guardBetterAuthRequest, guardCustomApiMutation } from "@/lib/request-security";
import { createScenarioSshSessionForUser, getScenarioRunForUser, listScenarioRunsForUser } from "@/lib/scenario-runs";
import { getScenarioRunStatusStreamTargetForUser } from "@/lib/scenario-runs/status";
import { ALL as authRoute } from "@/pages/api/auth/[...all]";
import { ensureFixtureMember } from "@/test/account-fixtures";
import desktopClientSeed from "../../seeds/desktop-oauth-client.sql?raw";
import { seedSessionCookie } from "@/test/auth-requests";
import { resetD1Database } from "@/test/d1-migrations";
import {
  KINO, LEARNER, ORIGIN, STRANGER, labState, machineImage, revisionDoc, seedScenario, specBlob, store, v2, vmState,
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
    // The app's own client is the row a deploy seeds.
    await env.DB.prepare(desktopClientSeed).run();
    await env.DB.prepare("INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('other-row', 'other-app', '[\"https://other.example/callback\"]')").run();
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
    expect(run).toMatchObject({ scenarioId: "intar/web", state: "provisioning", active: true, userId: LEARNER });
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
    const guardEnv = { BETTER_AUTH_URL: ORIGIN } as unknown as Pick<Cloudflare.Env, "BETTER_AUTH_URL">;
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

  it("lets the app pull what its learner's active local run names, and nothing else", async () => {
    const mine = await token("mine", LEARNER);
    const theirs = await token("theirs", STRANGER);
    const unlisted = await machineImage("unlisted");
    const blobOf = async (manifest: string) => (await env.DB.prepare(
      "SELECT blob_digest FROM registry_manifest_blobs WHERE manifest_digest = ?1 LIMIT 1").bind(manifest).first<{ blob_digest: string }>())!.blob_digest;
    const repository = (image: string) => `/v2/machines/${image.slice(7)}`;
    const named = [
      `${repository(images.web!)}/manifests/machine`,
      `${repository(images.web!)}/manifests/${images.web}`,
      `${repository(images.web!)}/blobs/${await blobOf(images.web!)}`,
      `${repository(images.client!)}/manifests/machine`,
      `/v2/specs/blobs/${specs.web}`,
      `/v2/kino/manifests/${KINO}`,
      `/v2/kino/blobs/${await blobOf(KINO)}`,
    ];
    const statuses = async (secret: string) => Promise.all(named.map((path) => v2(path, secret)));
    const all = (status: number) => named.map(() => status);

    // No run yet: nothing is granted, and a denial looks like an unknown object.
    expect(await statuses(mine)).toEqual(all(404));
    const { run } = await view(await start(mine));
    expect(await statuses(mine)).toEqual(all(200));
    expect(await v2("/v2/", mine)).toBe(200);

    // Another learner, an image the run does not name, and a blob of another image.
    expect(await statuses(theirs)).toEqual(all(404));
    expect(await v2(`${repository(unlisted)}/manifests/machine`, mine)).toBe(404);
    expect(await v2(`${repository(images.web!)}/blobs/${await blobOf(unlisted)}`, mine)).toBe(404);
    // No credential the registry knows.
    expect(await v2("/v2/", "secret-unknown-0123456789abcdef")).toBe(401);
    expect(await v2(named[0]!, await token("unscoped", LEARNER, { scopes: ["offline_access"] }))).toBe(401);

    // A hidden run, and then an ended one, grants nothing.
    await env.DB.prepare("UPDATE scenario_runs SET hidden_at = 1 WHERE run_id = ?1").bind(run.runId).run();
    expect(await statuses(mine)).toEqual(all(404));
    await env.DB.prepare("UPDATE scenario_runs SET hidden_at = NULL WHERE run_id = ?1").bind(run.runId).run();
    expect(await statuses(mine)).toEqual(all(200));
    expect((await localRunRequest(call(mine, { method: "POST" }, `/api/local/runs/${run.runId}/end`), run.runId, "end")).status).toBe(200);
    expect(await statuses(mine)).toEqual(all(404));
  });

  it("turns the app's reports into the run's state, and refuses them once the run is closed", async () => {
    const mine = await token("mine", LEARNER);
    const { run } = await view(await start(mine));
    expect(run).toMatchObject({ executionId: run.runId, generation: 1 });
    const report = async (vms: unknown[], secret = mine, protocol = 1) => {
      const response = await reportLocalRunRequest(call(secret, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol, vms }),
      }, `/api/local/runs/${run.runId}/report`), run.runId);
      return { status: response.status, ...(await view(response)) };
    };
    const row = () => env.DB.prepare(
      "SELECT state, active_key, solved_at, updated_at, state_json FROM scenario_runs WHERE run_id = ?1").bind(run.runId)
      .first<{ state: string; active_key: string | null; solved_at: number | null; updated_at: number; state_json: string }>();
    const passed = (id: string, at: number) => [{ id, status: "pass" as const, message: "", passed_at_unix_ms: at }];
    const t0 = Date.now();

    // Booting, then one machine ready, then both with their tasks passed.
    expect(await report([vmState(run.runId, "web", labState("preparing"), t0)])).toMatchObject({ status: 200, run: { state: "provisioning" } });
    expect(await report([vmState(run.runId, "web", labState("ready"), t0 + 1)])).toMatchObject({ run: { state: "active_partial" } });
    // A report older than the last one of that machine changes nothing.
    expect(await report([vmState(run.runId, "web", labState("preparing"), t0)])).toMatchObject({ run: { state: "active_partial" } });
    expect(await report([
      vmState(run.runId, "web", labState("ready", passed("serve", t0 + 2)), t0 + 2),
      vmState(run.runId, "client", labState("ready", passed("fetch", t0 + 2)), t0 + 2),
    ])).toMatchObject({ status: 200, run: { state: "solved", active: true } });
    const solved = (await row())!;
    expect(solved.solved_at).not.toBeNull();
    // No endpoint the device named is kept.
    expect(solved.state_json).not.toContain("203.0.113.9");
    expect(JSON.parse(solved.state_json).vms.every((vm: { canOpenTerminal: boolean }) => !vm.canOpenTerminal)).toBe(true);

    // Only this run's own VMs, from its learner, in the app's protocol.
    const good = vmState(run.runId, "web", labState("ready"), t0 + 3);
    expect((await report([good], await token("theirs", STRANGER))).status).toBe(404);
    expect((await report([good], mine, 2)).code).toBe("upgrade_required");
    for (const bad of [
      { ...good, owner_user_id: STRANGER }, { ...good, run_id: "another-run" }, { ...good, name: "unknown" },
      { ...good, generation: 2 }, { ...good, runtime_execution_id: "another" }, { ...good, phase: "flying" }, "nonsense",
    ]) expect((await report([bad])).code, JSON.stringify(bad).slice(0, 80)).toBe("invalid_report");
    expect((await report([])).code).toBe("invalid_report");
    expect((await report([good, good])).code).toBe("invalid_report");
    expect((await report([good, good, good])).code).toBe("invalid_report");
    expect((await row())!.state_json).toBe(solved.state_json);

    // An unchanged report still keeps a silent run from being closed.
    await env.DB.prepare("UPDATE scenario_runs SET updated_at = ?2 WHERE run_id = ?1").bind(run.runId, Date.now() - LOCAL_RUN_SILENCE_MS - 1).run();
    expect((await report([vmState(run.runId, "web", labState("ready", passed("serve", t0 + 2)), t0 + 2)])).status).toBe(200);
    expect(await reapSilentLocalRuns(env.DB)).toBe(0);

    // Once the server closed the run, a report is refused and says so.
    expect((await localRunRequest(call(mine, { method: "POST" }, `/api/local/runs/${run.runId}/end`), run.runId, "end")).status).toBe(200);
    const closed = (await row())!;
    expect(await report([vmState(run.runId, "web", labState("preparing"), t0 + 9)]))
      .toMatchObject({ status: 409, code: "run_closed", run: { active: false, state: "completed" } });
    expect(await row()).toEqual(closed);

    // A lab the device reports as failed fails the run and frees the learner's slot.
    const second = (await view(await start(mine, {}, "desktop-key-2"))).run;
    const failed = await reportLocalRunRequest(call(mine, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: 1, vms: [{ ...vmState(second.runId, "web", labState("failed", [], "boom")), runtime_execution_id: second.executionId }] }),
    }, `/api/local/runs/${second.runId}/report`), second.runId);
    expect(await view(failed)).toMatchObject({ run: { state: "failed", active: false } });
    expect((await start(mine, {}, "desktop-key-3")).status).toBe(201);
  });

  it("says nothing about another organization's scenarios", async () => {
    await env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 1)").run();
    await seedScenario("acme/secret", "org-1", revisionDoc(images, specs));
    const mine = await token("mine", LEARNER);
    // Not a member: an existing scenario answers like a missing one, whatever the app claims to support.
    for (const scenarioId of ["acme/secret", "acme/missing"]) {
      for (const guestContracts of [[3], [99]]) {
        for (const organizationId of ["org-1", "acme"]) {
          const response = await start(mine, { scenarioId, organizationId, guestContracts });
          expect([response.status, (await view(response)).code], `${scenarioId} ${guestContracts} ${organizationId}`)
            .toEqual([404, "scenario_not_found"]);
        }
      }
    }
    // A member is told to update the app.
    await env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org-1', ?1, 'member', 1)").bind(LEARNER).run();
    expect((await view(await start(mine, { scenarioId: "acme/secret", organizationId: "org-1", guestContracts: [99] }))).code).toBe("upgrade_required");
  });

  it("is marked local on the website, which offers it no terminal and no status stream", async () => {
    const { run } = await view(await start(await token("mine", LEARNER)));
    expect(await listScenarioRunsForUser({ userId: LEARNER })).toMatchObject([{ runId: run.runId, local: true, active: true }]);
    expect(await getScenarioRunForUser({ runId: run.runId, userId: LEARNER })).toMatchObject({ id: run.runId, local: true, canOpenTerminal: false });
    const vmId = JSON.parse((await env.DB.prepare("SELECT state_json FROM scenario_runs WHERE run_id = ?1").bind(run.runId)
      .first<{ state_json: string }>())!.state_json).vms[0].id as string;
    for (const mode of ["browser", "native"] as const) {
      await expect(createScenarioSshSessionForUser({ runId: run.runId, vmId, userId: LEARNER, mode }))
        .rejects.toMatchObject({ code: "scenario_terminal_local" });
    }
    await expect(getScenarioRunStatusStreamTargetForUser({ runId: run.runId, userId: LEARNER }))
      .rejects.toMatchObject({ code: "scenario_run_local" });
    await expect(getScenarioRunStatusStreamTargetForUser({ runId: run.runId, userId: STRANGER }))
      .rejects.toMatchObject({ code: "scenario_run_not_found" });
  });

  it("lists the courses its learner sees, with where they stand", async () => {
    await env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 1)").run();
    await seedScenario("acme/secret", "org-1", revisionDoc(images, specs));
    const mine = await token("mine", LEARNER);
    const catalog = async (secret: string | null = mine) => {
      const response = await localCatalogRequest(call(secret, {}, "/api/local/catalog"));
      const body = await response.json() as { protocol: number; courses: Array<{ organizationId: string | null;
        lectures: Array<{ scenarioId: string | null; state: string; activeRunId: string | null }> }> };
      return { status: response.status, protocol: body.protocol,
        lectures: (body.courses ?? []).flatMap((course) => course.lectures.map((lecture) => ({ ...lecture, organizationId: course.organizationId }))) };
    };
    expect((await catalog(null)).status).toBe(401);

    // The public scenario is there to start; another organization's is not.
    const before = await catalog();
    expect(before).toMatchObject({ status: 200, protocol: 1 });
    expect(before.lectures.filter((lecture) => lecture.scenarioId)).toMatchObject([
      { scenarioId: "intar/web", organizationId: null, state: "available", activeRunId: null },
    ]);

    // A started run shows on its lecture, and what the catalog names is what a start takes.
    const { run } = await view(await start(mine, { scenarioId: before.lectures[0]!.scenarioId }));
    expect((await catalog()).lectures.find((lecture) => lecture.scenarioId === "intar/web"))
      .toMatchObject({ state: "in_progress", activeRunId: run.runId });

    // A member sees the organization's course too.
    await env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org-1', ?1, 'member', 1)").bind(LEARNER).run();
    expect((await catalog()).lectures.map((lecture) => [lecture.scenarioId, lecture.organizationId]).sort())
      .toEqual([["acme/secret", "org-1"], ["intar/web", null]]);
    expect((await catalog(await token("theirs", STRANGER))).lectures.map((lecture) => lecture.scenarioId)).toEqual(["intar/web"]);
  });

  it("answers the guest's intar command for its learner's active local run", async () => {
    const mine = await token("mine", LEARNER);
    const { run } = await view(await start(mine));
    const cli = async (action: Record<string, unknown>, options: { secret?: string | null; machine?: string } = {}) => {
      const machine = options.machine ?? "web";
      const response = await handleLocalRunCliRequest(call(options.secret === undefined ? mine : options.secret, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, request_id: "r1", action }),
      }, `/api/local/runs/${run.runId}/machines/${machine}/cli`), run.runId, machine);
      const body = await response.json() as { request_id?: string; result?: { kind: string; error?: { code: string };
        aliases?: string[]; view?: { run: { title: string }; hint_groups: Array<{ alias: string; can_reveal: boolean;
          revealed_count: number; entries: Array<{ ordinal: number; state: string; title?: string }> }> } } };
      return { status: response.status, ...body };
    };

    expect((await cli({ kind: "status" }, { secret: null })).status).toBe(401);

    // Status carries the run's safe view; nothing sealed is in it.
    const status = await cli({ kind: "status" });
    expect(status).toMatchObject({ status: 200, request_id: "r1", result: { kind: "ok", view: { run: { title: "Lecture" } } } });
    const group = status.result!.view!.hint_groups.find((candidate) => candidate.can_reveal)!;
    expect(group.entries.every((entry) => entry.title === undefined)).toBe(true);
    expect(await cli({ kind: "completion" })).toMatchObject({ result: { kind: "completion" } });

    // Revealing a hint is stored on the run, as from the website.
    const revealed = await cli({ kind: "hint_reveal", alias: group.alias, expected_ordinal: 1 });
    expect(revealed.result!.view!.hint_groups.find((candidate) => candidate.alias === group.alias))
      .toMatchObject({ revealed_count: 1, entries: [{ ordinal: 1, state: "revealed" }] });
    expect(JSON.parse((await env.DB.prepare("SELECT revealed_hints_json AS hints FROM scenario_runs WHERE run_id = ?1")
      .bind(run.runId).first<{ hints: string }>())!.hints)).toHaveLength(1);

    // Another learner, a machine the run does not have, and malformed commands get nothing of it.
    expect(await cli({ kind: "status" }, { secret: await token("theirs", STRANGER) }))
      .toMatchObject({ status: 200, result: { kind: "error", error: { code: "unavailable" } } });
    expect((await cli({ kind: "status" }, { machine: "no-such-machine" })).result).toMatchObject({ kind: "error" });
    expect((await cli({ kind: "format-disk" })).result).toMatchObject({ kind: "error", error: { code: "invalid_request" } });

    // Once the run has ended, the command says so.
    expect((await localRunRequest(call(mine, { method: "POST" }, `/api/local/runs/${run.runId}/end`), run.runId, "end")).status).toBe(200);
    expect(await cli({ kind: "status" })).toMatchObject({ status: 200, result: { kind: "error", error: { code: "unavailable" } } });
  });

  it("takes the report the desktop app sends, byte for byte", async () => {
    const mine = await token("mine", LEARNER);
    const { run } = await view(await start(mine));
    expect(run.userId).toBe(LEARNER);
    // The exact text of jumper's test `a_guest_report_becomes_the_state_intar_takes`
    // (apps/jumper/src/local.rs); only the run's id and the time are this run's.
    const fromTheApp = String.raw`{"owner_user_id":"learner","runtime_execution_id":"run-1","generation":1,"run_id":"run-1","name":"web","phase":"ready","terminal":{"state":"pending","observed_at_unix_ms":1700000000000},"ssh_host_keys_openssh":[],"lab":{"state":"ready","kino_version":"0.9.1","ready":[{"name":"nginx","status":"pass","tail":""}],"tasks":[{"id":"serve","status":"pass","message":"","passed_at_unix_ms":5}],"timings_ms":{}},"updated_at_unix_ms":1700000000000}`;
    const now = String(Date.now());
    const vm = JSON.parse(fromTheApp.replaceAll('"run-1"', JSON.stringify(run.runId)).replaceAll("1700000000000", now));
    const response = await reportLocalRunRequest(call(mine, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: 1, vms: [vm] }),
    }, `/api/local/runs/${run.runId}/report`), run.runId);
    expect(response.status).toBe(200);
    // One of the run's two machines is ready, and its task counts.
    expect((await view(response)).run).toMatchObject({ state: "active_partial", active: true });
    const stored = JSON.parse((await env.DB.prepare("SELECT state_json FROM scenario_runs WHERE run_id = ?1").bind(run.runId)
      .first<{ state_json: string }>())!.state_json) as { tasks: Array<{ id: string; status: string }> };
    expect(stored.tasks.find((task) => task.id === "serve")).toMatchObject({ status: "pass" });
  });

  it("signs the app in through the provider with the client a deploy seeds", async () => {
    const cookie = await seedSessionCookie({ id: "web-session", token: "web-session-token", userId: LEARNER, now: Date.now() });
    const handle = (request: Request) => authRoute({ request } as Parameters<typeof authRoute>[0]) as Promise<Response>;
    const SITE = "http://localhost"; // the auth base URL in tests
    const redirectUri = "http://127.0.0.1:53123/callback";
    const verifier = "v".repeat(64);
    const challenge = await hashStoredOAuthToken(verifier);
    const query = new URLSearchParams({
      client_id: DESKTOP_OAUTH_CLIENT_ID, response_type: "code", redirect_uri: redirectUri,
      scope: "offline_access local-runs", state: "state-0123456789", code_challenge: challenge, code_challenge_method: "S256",
    });

    const signIn = async () => {
      // The browser, signed in on the website, is sent to the consent page.
      const authorize = await handle(new Request(`${SITE}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }));
      expect(authorize.status).toBe(302);
      const consentPage = new URL(authorize.headers.get("location")!, SITE);
      // Consent is asked once; a later sign-in returns to the app directly.
      if (consentPage.href.startsWith(redirectUri)) return consentPage.searchParams.get("code")!;
      expect(consentPage.pathname).toBe("/oauth/consent");
      expect(await env.DB.prepare(
        "SELECT user_id, public, require_pkce, skip_consent, disabled, token_endpoint_auth_method, scopes FROM oauth_client WHERE client_id = ?1",
      ).bind(DESKTOP_OAUTH_CLIENT_ID).first()).toEqual({
        user_id: null, public: 1, require_pkce: 1, skip_consent: 0, disabled: 0,
        token_endpoint_auth_method: "none", scopes: '["offline_access","local-runs"]',
      });

      const consent = await handle(new Request(`${SITE}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: { cookie, origin: SITE, "content-type": "application/json" },
        body: JSON.stringify({ accept: true, oauth_query: consentPage.search.slice(1) }),
      }));
      expect(consent.status).toBe(200);
      const back = new URL(((await consent.json()) as { url: string }).url);
      expect(back.origin + back.pathname).toBe(redirectUri);
      expect(back.searchParams.get("state")).toBe("state-0123456789");
      return back.searchParams.get("code")!;
    };

    // The app, with no cookie and no origin, exchanges the code and its verifier.
    const exchange = (fields: Record<string, string>) => handle(new Request(`${SITE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DESKTOP_OAUTH_CLIENT_ID, ...fields }).toString(),
    }));
    const wrong = await exchange({ grant_type: "authorization_code", code: await signIn(), redirect_uri: redirectUri, code_verifier: "w".repeat(64) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const issued = await exchange({ grant_type: "authorization_code", code: await signIn(), redirect_uri: redirectUri, code_verifier: verifier });
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as { access_token: string; refresh_token: string; scope: string } | null;
    expect(tokens!.scope.split(" ").sort()).toEqual(["local-runs", "offline_access"]);
    expect(await requireDesktopCaller(call(tokens!.access_token))).toMatchObject({ ok: true, userId: LEARNER });

    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: tokens!.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect(await requireDesktopCaller(call(next.access_token))).toMatchObject({ ok: true, userId: LEARNER });
  });
});
