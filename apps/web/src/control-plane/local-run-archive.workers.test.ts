/// <reference types="@cloudflare/vitest-plugin/types" />

// The desktop app's archive routes (`/api/local/archive/...`): a learner's
// app stores the replay of a run on their own computer through the handlers
// an agent host uses, as a narrower writer.

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { sha256Hex } from "@/control-plane/auth";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { user } from "@/db/schema";
import { hashStoredOAuthToken } from "@/lib/auth";
import { DESKTOP_OAUTH_CLIENT_ID, localRunRequest, startLocalRunRequest, type LocalRunView } from "@/lib/desktop-channel";
import { endLocalRun } from "@/lib/local-runs";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import desktopClientSeed from "../../seeds/desktop-oauth-client.sql?raw";
import {
  KINO, LEARNER, ORIGIN, STRANGER, machineImage, revisionDoc, seedScenario, specBlob, store,
} from "@/lib/scenario-runs/revision-test-fixtures";

const FAR = 9_999_999_999_999;
const CAST_TYPE = "application/x-asciicast; charset=utf-8";
const CAST = '{"version":3,"term":{"cols":80,"rows":24}}\n[0.1,"o","hello"]\n';
let allow = true;
const channelEnv = {
  ...env,
  ACCESS_INVITE_RATE_LIMITER: { limit: async () => ({ success: allow }) },
} as unknown as Cloudflare.Env;

describe("the desktop app's archive routes", () => {
  async function token(id: string, userId: string, options: { expiresAt?: number; revoked?: number } = {}) {
    const secret = `secret-${id}-0123456789abcdef`;
    await env.DB.prepare(
      `INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, revoked, scopes)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)`,
    ).bind(id, await hashStoredOAuthToken(secret), DESKTOP_OAUTH_CLIENT_ID, userId, options.expiresAt ?? FAR,
      options.revoked ?? null, JSON.stringify(["offline_access", "local-runs"])).run();
    return secret;
  }
  /** One call to an archive route; the path is what follows the prefix. */
  const archive = async (secret: string | null, path: string, init: RequestInit = {}, prefix = "/api/local/archive") => {
    const response = await handleAgentRunArtifactRequest(new Request(`${ORIGIN}${prefix}${path}`, {
      method: "POST",
      ...init,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...init.headers },
    }), channelEnv);
    if (!response) throw new Error(`no handler took ${path}`);
    return response;
  };
  const json = (body: unknown): RequestInit => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cast = async (ordinal: number, overrides: Record<string, unknown> = {}) => ({
    ordinal, kind: "ssh_recording_segment", filename: `session-0${ordinal}.cast`, contentType: CAST_TYPE,
    sizeBytes: CAST.length, sha256: await sha256Hex(CAST), ...overrides,
  });
  async function startRun(secret: string): Promise<LocalRunView> {
    const response = await startLocalRunRequest(new Request(`${ORIGIN}/api/local/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "idempotency-key": "archive-key-1" },
      body: JSON.stringify({ protocol: 1, scenarioId: "intar/web", guestContracts: [3], arch: "x86_64" }),
    }), channelEnv);
    expect(response.status).toBe(201);
    return (await response.json() as { run: LocalRunView }).run;
  }
  const begin = (secret: string | null, run: LocalRunView, vmName: string, artifacts: unknown[], prefix?: string) =>
    archive(secret, "/begin", json({ runId: run.executionId, vmName, createdAtMs: 1, deleteRequestedAtMs: 2, deletedAtMs: 3, artifacts }), prefix);
  /** A part as the app sends it: the bytes and how many they are. */
  const put = (body: string): RequestInit => ({ method: "PUT", body, headers: { "content-length": String(body.length) } });
  const vmPath = (run: LocalRunView, vmName: string, tail: string) => `/${run.executionId}/vms/${vmName}/${tail}`;
  const stored = async () =>
    (await env.DB.prepare("SELECT count(*) AS n FROM runtime_artifacts").first<{ n: number }>())?.n;

  beforeEach(async () => {
    allow = true;
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of [LEARNER, STRANGER]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    await env.DB.prepare(desktopClientSeed).run();
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    const images = { web: await machineImage("web"), client: await machineImage("client") };
    const specs = { web: await specBlob("web"), client: await specBlob("client") };
    await seedScenario("intar/web", null, revisionDoc(images, specs));
  });

  it("stores a local run's replay and completes the run", async () => {
    const secret = await token("good", LEARNER);
    const run = await startRun(secret);
    expect(run.machines.map((machine) => machine.runtimeName)).toEqual([`web-${run.runId}`, `client-${run.runId}`]);

    for (const machine of run.machines) {
      const vm = machine.runtimeName;
      expect((await begin(secret, run, vm, [await cast(1)])).status).toBe(200);
      expect(await (await archive(secret, vmPath(run, vm, "artifacts/1/multipart-begin"))).json())
        .toMatchObject({ done: false, nextExpectedPart: 1 });
      expect((await archive(secret, vmPath(run, vm, "artifacts/1/parts/1"), put(CAST))).status).toBe(200);
      expect((await archive(secret, vmPath(run, vm, "artifacts/1/complete"))).status).toBe(200);
      const timeline = { version: 1, sessions: [{ index: 1, startTimestampMs: 1000, durationMs: 500, exitCode: 0,
        castFilename: "session-01.cast", transcript: "hello", transcriptTruncated: false }] };
      expect((await archive(secret, vmPath(run, vm, "timeline"), json(timeline))).status).toBe(200);
      expect((await archive(secret, vmPath(run, vm, "complete"))).status).toBe(200);
    }

    // Both VMs completed: the run is over and the learner's slot is free.
    const row = await env.DB.prepare("SELECT active_key, state_json FROM scenario_runs WHERE run_id = ?1")
      .bind(run.runId).first<{ active_key: string | null; state_json: string }>();
    expect(row?.active_key).toBeNull();
    const state = JSON.parse(row!.state_json) as { vms: Array<{ phase: string; sessionTimeline?: Array<{ castFilename: string }> }> };
    expect(state.vms.map((vm) => [vm.phase, vm.sessionTimeline?.[0]?.castFilename]))
      .toEqual([["completed", "session-01.cast"], ["completed", "session-01.cast"]]);
    const artifact = await env.DB.prepare("SELECT r2_key, upload_status FROM runtime_artifacts LIMIT 1")
      .first<{ r2_key: string; upload_status: string }>();
    expect(artifact?.upload_status).toBe("uploaded");
    expect(await (await env.VM_RUN_ARTIFACTS_BUCKET.get(artifact!.r2_key))?.text()).toBe(CAST);
    // The app's own end afterwards changes nothing.
    expect(await endLocalRun({ d1: env.DB, runId: run.runId, userId: LEARNER })).toBe(true);
    const view = await localRunRequest(new Request(`${ORIGIN}/api/local/runs/${run.runId}`,
      { headers: { authorization: `Bearer ${secret}` } }), run.runId, "read");
    expect((await view.json() as { run: LocalRunView }).run.active).toBe(false);
  });

  it("takes a token replaced in the middle of an upload", async () => {
    const first = await token("first", LEARNER);
    const run = await startRun(first);
    const vm = run.machines[0]!.runtimeName;
    expect((await begin(first, run, vm, [await cast(1)])).status).toBe(200);
    expect((await archive(first, vmPath(run, vm, "artifacts/1/multipart-begin"))).status).toBe(200);
    // The app refreshed: the old token is past its time, the new one carries on.
    await env.DB.prepare("UPDATE oauth_access_token SET expires_at = 1 WHERE id = 'first'").run();
    expect((await archive(first, vmPath(run, vm, "artifacts/1/parts/1"), put(CAST))).status).toBe(401);
    const second = await token("second", LEARNER);
    expect((await archive(second, vmPath(run, vm, "artifacts/1/parts/1"), put(CAST))).status).toBe(200);
    expect((await archive(second, vmPath(run, vm, "artifacts/1/complete"))).status).toBe(200);
  });

  it("lets nobody but the run's learner write, and only through its own prefix", async () => {
    const secret = await token("good", LEARNER);
    const run = await startRun(secret);
    const vm = run.machines[0]!.runtimeName;
    const artifacts = [await cast(1)];

    expect((await begin(null, run, vm, artifacts)).status).toBe(401);
    expect((await begin(await token("revoked", LEARNER, { revoked: 1 }), run, vm, artifacts)).status).toBe(401);
    // Another learner's token: the run does not exist for them.
    expect((await begin(await token("stranger", STRANGER), run, vm, artifacts)).status).toBe(410);
    // The app's token is no host credential.
    expect((await begin(secret, run, vm, artifacts, "/agent/runs")).status).toBe(401);
    expect(await stored()).toBe(0);

    // Too many calls from one learner are refused before anything is read.
    allow = false;
    expect((await begin(secret, run, vm, artifacts)).status).toBe(429);
    allow = true;
    expect(await stored()).toBe(0);

    // A revocation after the request was let in still stops the write.
    expect((await begin(secret, run, vm, artifacts)).status).toBe(200);
    expect((await archive(secret, vmPath(run, vm, "artifacts/1/multipart-begin"))).status).toBe(200);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?1").bind(LEARNER).run();
    expect((await archive(secret, vmPath(run, vm, "artifacts/1/parts/1"), put(CAST))).status).toBe(401);
  });

  it("bounds what the app may store", async () => {
    const secret = await token("good", LEARNER);
    const run = await startRun(secret);
    const vm = run.machines[0]!.runtimeName;
    const refused: Array<[string, unknown[]]> = [
      ["a raw session file", [await cast(1, { kind: "ssh_recording_raw" })]],
      ["a console log", [await cast(1, { kind: "console_log", contentType: "text/plain; charset=utf-8" })]],
      ["another content type", [await cast(1, { contentType: "text/html" })]],
      ["an artifact over 8 MiB", [await cast(1, { sizeBytes: 8 * 1024 * 1024 + 1 })]],
      ["more bytes in all than 64 MiB", await Promise.all(Array.from({ length: 9 }, (_, index) =>
        cast(index + 1, { sizeBytes: 8 * 1024 * 1024 })))],
      ["more artifacts than sessions are shown", await Promise.all(Array.from({ length: 501 }, (_, index) => cast(index + 1)))],
    ];
    for (const [label, artifacts] of refused) {
      expect((await begin(secret, run, vm, artifacts)).status, label).toBe(400);
    }
    expect(await stored()).toBe(0);

    // A part is the whole artifact, of exactly the declared size.
    expect((await begin(secret, run, vm, [await cast(1)])).status).toBe(200);
    expect((await archive(secret, vmPath(run, vm, "artifacts/1/multipart-begin"))).status).toBe(200);
    expect((await archive(secret, vmPath(run, vm, "artifacts/1/parts/1"), { method: "PUT", body: `${CAST}more` })).status).toBe(400);
    expect((await archive(secret, vmPath(run, vm, "artifacts/1/parts/1"), put("short"))).status).toBe(400);

    // An agent's progress route and anything unknown do not exist for the app.
    expect((await archive(secret, vmPath(run, vm, "archive-stage"), json({ stage: "raw_files_saved" }))).status).toBe(404);
    expect((await archive(secret, "/anything-else")).status).toBe(404);
  });

  it("refuses a run that was ended first", async () => {
    const secret = await token("good", LEARNER);
    const run = await startRun(secret);
    const vm = run.machines[0]!.runtimeName;
    expect(await endLocalRun({ d1: env.DB, runId: run.runId, userId: LEARNER })).toBe(true);
    const response = await begin(secret, run, vm, [await cast(1)]);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await stored()).toBe(0);
  });
});
