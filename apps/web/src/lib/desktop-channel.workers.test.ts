/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { handleLocalRunCliRequest } from "@/control-plane/run-cli";
import { scenarioRunArtifacts, user } from "@/db/schema";
import { hashStoredOAuthToken } from "@/lib/auth";
import {
  appReleaseRequest, DESKTOP_OAUTH_CLIENT_ID, localCatalogRequest, localLectureRequest, localRunArtifactRequest,
  localRunHistoryRequest, localRunLearning, localRunLearningRequest, localRunRecap, localRunRecapRequest,
  localRunRequest, reportLocalRunRequest, requireDesktopCaller, startLocalRunRequest,
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
  HINT_BODY, KINO, LEARNER, ORIGIN, SOLUTION, STRANGER, TASK_BODY, labState, machineImage, revisionDoc, seedScenario, specBlob, store, v2, vmState,
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
      // No arm64 images are built for this scenario; no images exist for the other at all.
      [{ arch: "aarch64" }, 409, "architecture_unavailable"],
      [{ arch: "riscv64" }, 409, "architecture_unavailable"],
      [{ arch: "constructor" }, 409, "architecture_unavailable"],
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

  it("starts an arm64 computer on the arm64 images and Kino, once both exist", async () => {
    const secret = await token("t1", LEARNER);
    const arm64Image = await store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json",
      { guest_contract: 3, architecture: "arm64" }, [["application/vnd.intar.kernel.v1", "arm64 kernel"]]);
    const startArm = (key: string) => startLocalRunRequest(call(secret, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ protocol: 1, scenarioId: "intar/web", guestContracts: [3], arch: "aarch64" }),
    }), channelEnv);
    const lecture = async () => ((await (await localCatalogRequest(call(secret, {}, "/api/local/catalog?arch=aarch64"))).json()) as {
      courses: Array<{ lectures: Array<{ state: string }> }> }).courses[0]!.lectures[0]!.state;

    // The build's arm64 image failed: the lecture waits and a start is refused.
    await env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, arm64_asked, arm64_state, arm64_error)
      VALUES (?1, 'intar-image-4', 'b', 'succeeded', 1, 'failed', 'no')`).bind(`sha256:${"b".repeat(64)}`).run();
    expect(await lecture()).toBe("waiting_for_scenario");
    expect((await view(await startArm("desktop-arm-key-1"))).code).toBe("architecture_unavailable");

    await env.DB.prepare("UPDATE machine_builds SET arm64_state = 'succeeded', arm64_image_digest = ?1").bind(arm64Image).run();
    expect(await lecture()).toBe("available");
    // The images exist; the arm64 Kino the pin names is not stored yet.
    expect((await view(await startArm("desktop-arm-key-2"))).code).toBe("architecture_unavailable");
    const arm64Kino = await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE,
      { guest_contract: 3, version: "run-test", architecture: "arm64" }, [["application/octet-stream", "arm64 kino"]]);
    expect(arm64Kino).toBe("sha256:97dacd4f819cdd85e9f25f5cc8d994d5771b1838c951b828a7fcb10e3f31daa3");

    const response = await startArm("desktop-arm-key-3");
    expect(response.status, await response.clone().text()).toBe(201);
    for (const machine of (await view(response)).run.machines) expect(machine).toMatchObject({ image: arm64Image, kino: arm64Kino });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM scenario_runs").first("n")).toBe(1);

    // The same key from the same computer is the same run; from an amd64 one it is another request.
    expect(await view(await startArm("desktop-arm-key-3"))).toMatchObject({ reused: true });
    const other = await start(secret, {}, "desktop-arm-key-3");
    expect(other.status).toBe(409);
    expect((await view(other)).code).toBe("idempotency_key_conflict");
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

  it("answers a lecture's theory, locked while an earlier one is open, and marks a theory lecture read", async () => {
    await env.DB.prepare("UPDATE course_catalogs SET catalog_json = ?1 WHERE scope_key = 'public'").bind(JSON.stringify({
      version: 2, courses: [{ courseId: "course", title: "Course", summary: "", bodyMarkdown: "", sequential: true, lectures: [
        { lectureId: "intro", scenarioId: null, title: "Intro", summary: "", bodyMarkdown: "INTRO-THEORY", category: "t", tags: [], estimatedMinutes: 5 },
        { lectureId: "web", scenarioId: "intar/web", title: "Lecture", summary: "", bodyMarkdown: "WEB-THEORY", category: "t", tags: [], estimatedMinutes: 10 },
      ] }],
    })).run();
    const mine = await token("mine", LEARNER);
    const lecture = async (id: string, action: "read" | "complete" = "read", secret: string | null = mine) => {
      const path = `/api/local/courses/course/lectures/${id}${action === "complete" ? "/complete" : ""}`;
      const response = await localLectureRequest(call(secret, { method: action === "complete" ? "POST" : "GET" }, path), "course", id, action);
      return { status: response.status, ...(await response.json() as Record<string, unknown>) };
    };

    expect((await lecture("intro", "read", null)).status).toBe(401);
    expect(await lecture("web")).toEqual({ status: 200, protocol: 1, locked: true });
    expect(await lecture("intro")).toEqual({ status: 200, protocol: 1, locked: false, lecture: {
      courseId: "course", lectureId: "intro", title: "Intro", bodyMarkdown: "INTRO-THEORY", ordinal: 1, count: 2, state: "available",
    } });
    // A lecture with a lab is completed by its run, not here.
    expect(await lecture("web", "complete")).toMatchObject({ status: 409, code: "course_lecture_locked", protocol: 1 });
    expect(await lecture("intro", "complete")).toMatchObject({ status: 200, lecture: { lectureId: "intro", state: "completed" } });
    expect(await lecture("web")).toMatchObject({ locked: false, lecture: { bodyMarkdown: "WEB-THEORY", ordinal: 2, state: "available" } });
    expect(await lecture("web", "complete")).toMatchObject({ status: 409, code: "course_lecture_requires_scenario" });
    expect(await lecture("missing")).toMatchObject({ status: 404, code: "course_lecture_not_found" });
  });

  it("answers an organization's lecture to its members only", async () => {
    await env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 1)").run();
    await seedScenario("acme/secret", "org-1", revisionDoc(images, specs));
    await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].bodyMarkdown', 'ORG-THEORY') WHERE scope_key = 'organization:org-1'").run();
    const read = async (secret: string, organizationId: string | null) => {
      const query = organizationId ? `?organizationId=${organizationId}` : "";
      const response = await localLectureRequest(call(secret, {}, `/api/local/courses/course/lectures/secret${query}`), "course", "secret", "read");
      return { status: response.status, ...(await response.json() as { code?: string; lecture?: { bodyMarkdown: string } }) };
    };
    const mine = await token("mine", LEARNER);
    // Not a member: the course answers like a missing one, by id, by slug, and without the organization.
    for (const organizationId of ["org-1", "acme", "no-such-org", null]) {
      const answer = await read(mine, organizationId);
      expect(answer.status, String(organizationId)).toBe(404);
      expect(JSON.stringify(answer)).not.toContain("ORG-THEORY");
    }
    await env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'org-1', ?1, 'member', 1)").bind(LEARNER).run();
    for (const organizationId of ["org-1", "acme"]) {
      expect(await read(mine, organizationId)).toMatchObject({ status: 200, lecture: { bodyMarkdown: "ORG-THEORY" } });
    }
    expect((await read(await token("theirs", STRANGER), "org-1")).status).toBe(404);
  });

  it("shows a local run's learning panel to its learner, sealed until revealed", async () => {
    const mine = await token("mine", LEARNER);
    const { run } = await view(await start(mine));
    type Learning = { runId: string; solved: boolean; lectureMarkdown: string;
      checks: Array<{ key: string; machine: string; status: string; description: string | null }>;
      hints: Array<{ key: string; checkKey: string | null; title: string | null; revealed: boolean; unlocked: boolean; bodyMarkdown: string | null }>;
      solution: { unlocked: boolean; revealed: boolean; assisted: boolean; bodyMarkdown: string | null } };
    const learning = async (action: "read" | "hint" | "solution" = "read", options: { secret?: string | null; body?: unknown } = {}) => {
      const path = `/api/local/runs/${run.runId}/${{ read: "learning", hint: "hints/reveal", solution: "solution/reveal" }[action]}`;
      const response = await localRunLearningRequest(call(options.secret === undefined ? mine : options.secret, {
        method: action === "read" ? "GET" : "POST",
        ...(options.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
      }, path), run.runId, action);
      const text = await response.text();
      return { status: response.status, text, ...(JSON.parse(text) as { code?: string; learning: Learning }) };
    };

    expect((await learning("read", { secret: null })).status).toBe(401);
    const theirs = await token("theirs", STRANGER);
    for (const action of ["read", "hint", "solution"] as const) {
      expect((await learning(action, { secret: theirs, ...(action === "read" ? {} : { body: { protocol: 1, hintKey: "x" } }) })).status, action).toBe(404);
    }

    const before = await learning();
    expect(before.status).toBe(200);
    expect(before.learning).toMatchObject({ runId: run.runId, solved: false, checks: [
      { key: "serve", machine: "web", status: "checking", description: TASK_BODY },
      { key: "fetch", machine: "client", status: "checking", description: null },
    ], solution: { revealed: false, bodyMarkdown: null } });
    // Nothing sealed is in the answer.
    expect(before.text).not.toContain(HINT_BODY);
    expect(before.text).not.toContain(SOLUTION);
    const portHint = before.learning.hints.find((hint) => hint.checkKey === "serve")!;
    expect(portHint).toMatchObject({ title: null, bodyMarkdown: null, revealed: false, unlocked: true });
    expect(before.learning.hints.find((hint) => hint.checkKey === null)).toBeDefined();

    expect((await learning("hint", { body: { protocol: 2, hintKey: portHint.key } })).code).toBe("upgrade_required");
    expect((await learning("hint", { body: { protocol: 1 } })).code).toBe("invalid_hint");
    expect((await learning("hint", { body: { protocol: 1, hintKey: "nope" } })).status).toBe(404);
    const revealed = await learning("hint", { body: { protocol: 1, hintKey: portHint.key } });
    expect(revealed.learning.hints.find((hint) => hint.key === portHint.key))
      .toMatchObject({ revealed: true, title: "Port", bodyMarkdown: HINT_BODY });
    expect((await learning("hint", { body: { protocol: 1, hintKey: portHint.key } })).code).toBe("scenario_hint_already_revealed");
    expect((await learning()).learning.hints.find((hint) => hint.key === portHint.key)).toMatchObject({ bodyMarkdown: HINT_BODY });

    expect((await learning("solution")).learning.solution).toMatchObject({ revealed: true, bodyMarkdown: SOLUTION });

    // Only a local run is the app's to read.
    await env.DB.prepare("UPDATE scenario_runs SET runtime = 'host' WHERE run_id = ?1").bind(run.runId).run();
    expect((await learning()).status).toBe(404);
  });

  it("maps a probe run's checks and hints as the website's panel shows them", () => {
    const probe = (id: string, status: string) => ({ id, label: id, kind: "http", phase: "scenario" as const, status, error: null, value: null });
    const learning = localRunLearning({
      id: "run-1", phase: "active_full", solvedAt: null, lectureTitle: null, lectureBodyMarkdown: null, briefingMarkdown: "BRIEFING",
      objectives: [{ probeName: "p1", vmName: "web", label: "P1", title: "Serve it", bodyMarkdown: "SECRET", hintCount: 1 }],
      vms: [{ scenarioVmName: "web", scenarioProbes: [probe("p1", "pass"), probe("p2", "fail"), probe("p3", "pending")] }],
      hints: [
        { key: "probe:web:p1:0", scope: "probe", probeName: "p1", id: "0", title: null, revealed: false, unlocked: true, bodyMarkdown: null },
        { key: "scenario:0", scope: "scenario", probeName: null, id: "0", title: "T", revealed: true, unlocked: false, bodyMarkdown: "B" },
      ],
      solution: { unlocked: false, revealed: false, assisted: false, revealedAt: null, bodyMarkdown: null },
    } as unknown as Parameters<typeof localRunLearning>[0]);
    expect(learning).toEqual({
      runId: "run-1", lectureTitle: null, lectureMarkdown: "BRIEFING", solved: false,
      checks: [
        { key: "p1", machine: "web", title: "Serve it", description: null, status: "verified", optional: false },
        { key: "p2", machine: "web", title: "Repair objective 2", description: null, status: "needs_repair", optional: false },
        { key: "p3", machine: "web", title: "Repair objective 3", description: null, status: "checking", optional: false },
      ],
      hints: [
        { key: "probe:web:p1:0", checkKey: "p1", title: null, revealed: false, unlocked: true, bodyMarkdown: null },
        { key: "scenario:0", checkKey: null, title: "T", revealed: true, unlocked: false, bodyMarkdown: "B" },
      ],
      solution: { unlocked: false, revealed: false, assisted: false, bodyMarkdown: null },
    });
  });

  it("lists the learner's runs, recaps any of them and serves their artifacts, to that learner only", async () => {
    const mine = await token("mine", LEARNER);
    const theirs = await token("theirs", STRANGER);
    type Recap = { runId: string; kind: string; heading: string; description: string; solveDurationMs: number | null;
      hintsRevealed: number; solutionUsed: boolean; checks: unknown[]; replay: string; replayParts: unknown[] };
    const history = async (secret: string | null) => {
      const response = await localRunHistoryRequest(call(secret), channelEnv);
      return { status: response.status, ...(await response.json() as { protocol: number; runs: Array<Record<string, unknown>> }) };
    };
    const recap = async (runId: string, secret: string | null = mine) => {
      const response = await localRunRecapRequest(call(secret, {}, `/api/local/runs/${runId}/recap`), runId, channelEnv);
      return { status: response.status, ...(await response.json() as { protocol: number; code?: string; recap: Recap }) };
    };
    const artifact = (runId: string, artifactId: string, secret: string | null = mine) =>
      localRunArtifactRequest(call(secret, {}, `/api/local/runs/${runId}/artifacts/${artifactId}`), runId, artifactId, channelEnv);
    const end = (runId: string, secret = mine) =>
      localRunRequest(call(secret, { method: "POST" }, `/api/local/runs/${runId}/end`), runId, "end");

    // Ended before any check passed, then moved off the learner's computer.
    const early = (await view(await start(mine))).run;
    expect((await end(early.runId)).status).toBe(200);
    // Solved with a hint and the solution revealed.
    const solved = (await view(await start(mine, {}, "desktop-key-2"))).run;
    const learning = (path: string, body: unknown) => localRunLearningRequest(call(mine, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, `/api/local/runs/${solved.runId}/${path}`), solved.runId, path === "solution/reveal" ? "solution" : "hint");
    const { learning: panel } = await (await localRunLearningRequest(call(mine), solved.runId, "read")).json() as
      { learning: { hints: Array<{ key: string; unlocked: boolean }> } };
    expect((await learning("hints/reveal", { protocol: 1, hintKey: panel.hints.find((hint) => hint.unlocked)!.key })).status).toBe(200);
    expect((await learning("solution/reveal", {})).status).toBe(200);
    const t0 = Date.now();
    const passed = (id: string) => [{ id, status: "pass" as const, message: "", passed_at_unix_ms: t0 }];
    expect((await reportLocalRunRequest(call(mine, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: 1, vms: [
        vmState(solved.runId, "web", labState("ready", passed("serve")), t0),
        vmState(solved.runId, "client", labState("ready", passed("fetch")), t0),
      ] }),
    }, `/api/local/runs/${solved.runId}/report`), solved.runId)).status).toBe(200);
    expect((await end(solved.runId)).status).toBe(200);
    const strangers = (await view(await start(theirs, {}, "desktop-key-3"))).run;
    await env.DB.prepare("UPDATE scenario_runs SET created_at = 1000, runtime = 'host' WHERE run_id = ?1").bind(early.runId).run();
    await env.DB.prepare("UPDATE scenario_runs SET created_at = 2000 WHERE run_id = ?1").bind(solved.runId).run();

    // Signed out, every route refuses.
    expect((await history(null)).status).toBe(401);
    expect((await recap(solved.runId, null)).status).toBe(401);
    expect((await artifact(solved.runId, "a1", null)).status).toBe(401);

    // Only the caller's runs, newest first, local or not.
    const listed = await history(mine);
    expect(listed.protocol).toBe(1);
    expect(listed.runs.map((run) => run.runId)).toEqual([solved.runId, early.runId]);
    expect(listed.runs[0]).toMatchObject({ scenarioId: "intar/web", organizationId: null, local: true, active: false,
      outcome: "succeeded", activity: "settled", createdAt: 2000, solutionAssisted: true, hasReplay: false });
    expect(listed.runs[1]).toMatchObject({ local: false, outcome: "cancelled", solvedAt: null, solveDurationMs: null });
    expect(Object.keys(listed.runs[0]!).sort()).toEqual(["active", "activity", "createdAt", "finishedAt", "hasReplay",
      "local", "organizationId", "outcome", "runId", "scenarioId", "solutionAssisted", "solveDurationMs", "solvedAt", "title"]);

    const won = await recap(solved.runId);
    expect(won).toMatchObject({ status: 200, protocol: 1, recap: { runId: solved.runId, kind: "solved", heading: "Solved",
      hintsRevealed: 1, solutionUsed: true, replay: "none", replayParts: [] } });
    // A task run keeps no objectives; its final checks are its tasks.
    expect(won.recap.checks).toMatchObject([
      { key: "serve", machine: "web", status: "verified", description: TASK_BODY },
      { key: "fetch", machine: "client", status: "verified", description: null },
    ]);
    expect(won.recap.solveDurationMs).toBeGreaterThanOrEqual(0);
    const quit = await recap(early.runId);
    expect(quit.recap).toMatchObject({ kind: "ended_early", heading: "Ended early",
      description: "You can try this scenario again when you are ready.", hintsRevealed: 0, solutionUsed: false, solveDurationMs: null });

    // Another learner's run answers like an unknown one.
    expect(await recap(strangers.runId)).toMatchObject({ status: 404, code: "run_not_found" });
    expect(await recap("unknown-run")).toMatchObject({ status: 404, code: "run_not_found" });

    await drizzle(env.DB).insert(scenarioRunArtifacts).values([solved.runId, strangers.runId].map((runId) => ({
      id: `${runId}:cast`, runId, vmId: `${runId}-vm`, ordinal: 0, kind: "ssh_recording_segment", filename: "session.cast",
      contentType: "application/x-asciicast", sizeBytes: 5, sha256: "a".repeat(64), r2Key: `runs/${runId}/cast`,
      uploadStatus: "uploaded", uploadedAt: Date.now(),
    })));
    for (const runId of [solved.runId, strangers.runId]) await env.VM_RUN_ARTIFACTS_BUCKET.put(`runs/${runId}/cast`, "cast\n");
    const served = await artifact(solved.runId, `${solved.runId}:cast`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("cast\n");
    expect((await artifact(strangers.runId, `${strangers.runId}:cast`)).status).toBe(404);
    expect((await artifact(strangers.runId, `${strangers.runId}:cast`, theirs)).status).toBe(200);
  });

  it("recaps a probe run's final checks and replay as the website does, and nothing more", () => {
    const probe = (id: string, status: string) => ({ id, label: "RAW-LABEL", kind: "http", phase: "scenario" as const, status, error: "RAW-ERROR", value: "RAW-VALUE" });
    const session = (index: number, castArtifactId: string | null) => ({
      index, startTimestampMs: index, durationMs: 1, exitCode: 0, castFilename: "RAW-FILE.cast", castArtifactId, transcriptTruncated: false,
    });
    const vm = (id: string, name: string, ordinal: number, probes: unknown[], sessions: unknown[]) => ({
      id, ordinal, scenarioVmId: name, scenarioVmName: name, runtimeVmName: "RAW-RUNTIME", phase: "completed",
      scenarioProbes: probes, bootProbes: [], sessionTimeline: sessions,
      replayArtifacts: [{ id: `${id}-a`, sizeBytes: 42 }],
    });
    const recap = localRunRecap({
      id: "run-1", scenarioId: "intar/web", title: "Web", phase: "completed", phaseDetail: "RAW-DETAIL",
      activity: "settled", outcome: "succeeded", solvedAt: 5, solveDurationMs: 4, replayState: "ready",
      objectives: [
        { probeName: "p1", vmName: "web", label: "P1", title: "Serve it", bodyMarkdown: "SECRET", hintCount: 0 },
        { probeName: "p2", vmName: "client", label: "P2", title: null, bodyMarkdown: null, hintCount: 0 },
      ],
      vms: [
        vm("vm-c", "client", 1, [probe("p2", "fail")], [session(0, "vm-c-a")]),
        vm("vm-w", "web", 0, [probe("p1", "pass")], [session(0, "vm-w-a"), session(1, null)]),
      ],
      replayArtifacts: [],
      hints: [{ revealed: true }, { revealed: false }, { revealed: true }],
      solution: { revealed: false, assisted: true },
    } as unknown as Parameters<typeof localRunRecap>[0]);
    expect(recap).toEqual({
      runId: "run-1", scenarioId: "intar/web", title: "Web", kind: "solved", heading: "Solved",
      description: "You completed this scenario.", solveDurationMs: 4, hintsRevealed: 2, solutionUsed: true,
      checks: [
        { key: "objective-1", machine: "web", title: "Serve it", description: null, status: "verified", optional: false },
        { key: "objective-2", machine: "client", title: "Repair objective 2", description: null, status: "needs_repair", optional: false },
      ],
      replay: "ready",
      replayParts: [
        { key: "replay-vm-w-a", machineLabel: "web", partLabel: "Part 1", castArtifactId: "vm-w-a", sizeBytes: 42 },
        { key: "replay-vm-c-a", machineLabel: "client", partLabel: "Part 2", castArtifactId: "vm-c-a", sizeBytes: 42 },
      ],
    });
    expect(JSON.stringify(recap)).not.toMatch(/RAW-|SECRET/);
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

describe("the app's offered release", () => {
  const SHA = "ab".repeat(32);
  const ask = (query: string, json: string | undefined, method = "GET") =>
    appReleaseRequest(new Request(`https://intar.test/api/local/app-release${query}`, { method }), { JUMPER_RELEASE_JSON: json });
  const release = async (query: string, json: string | undefined) =>
    ((await ask(query, json).json()) as { release: unknown }).release;

  it("names the pinned release of the app's target, its download and the hash to check it by", async () => {
    const pins = JSON.stringify({ macos_arm64: { version: "0.2.0", sha256: SHA } });
    const response = ask("?os=macos&arch=aarch64", pins);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      protocol: 1,
      release: {
        version: "0.2.0",
        sha256: SHA,
        url: "https://github.com/intar-dev/intar-dev/releases/download/desktop%2Fv0.2.0/intar-desktop_0.2.0_macos_arm64.zip",
      },
    });
  });

  it("offers none without a usable pin for that target", async () => {
    const pins = JSON.stringify({ macos_arm64: { version: "0.2.0", sha256: SHA } });
    // No pin at all, an unreadable one, another target, and no target named.
    expect(await release("?os=macos&arch=aarch64", "")).toBeNull();
    expect(await release("?os=macos&arch=aarch64", undefined)).toBeNull();
    expect(await release("?os=macos&arch=aarch64", "{not json")).toBeNull();
    expect(await release("?os=macos&arch=x86_64", pins)).toBeNull();
    expect(await release("?os=linux&arch=aarch64", pins)).toBeNull();
    expect(await release("", pins)).toBeNull();
    // A pin that is not a version and a hash names nothing to download.
    for (const pin of [{ version: "0.2", sha256: SHA }, { version: "0.2.0", sha256: "abc" }, { version: "0.2.0/../x", sha256: SHA }, "0.2.0"]) {
      expect(await release("?os=macos&arch=aarch64", JSON.stringify({ macos_arm64: pin }))).toBeNull();
    }
    expect(ask("?os=macos&arch=aarch64", pins, "POST").status).toBe(405);
  });
});
