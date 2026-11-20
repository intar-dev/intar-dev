/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  bundles,
  pipelineUploadSessions,
  scenarioRevisions,
  scenarioSourceCommits,
  scenarioSources,
  scenarios,
  user,
} from "@/db/schema";
import { GITHUB_ACTIONS_ISSUER } from "@/lib/github-oidc";
import {
  acquireRegistrySweep,
  compactRegistryAdmissionHistory,
  heartbeatRegistrySweep,
  REGISTRY_REAP_GRACE_MS,
  REGISTRY_SESSION_HEADER,
  setRegistryEnforcement,
} from "@/lib/image-registry-admission";
import { OCI_SWEEP_AGE_GUARD_MS, runOciSweep } from "@/lib/oci-registry-sweep";
import { PIPELINE_SESSION_MAX_BYTES } from "@/lib/pipeline-upload-sessions";
import { changeScenarioSource, scenarioSourceScope } from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { blob, machineConfig, manifestOf, type PushedBlob } from "./oci-test-fixtures";
import {
  PIPELINE_BYTES_PER_SCOPE_PER_WINDOW,
  PIPELINE_OPEN_SESSIONS_PER_SCOPE,
  PIPELINE_SESSIONS_CLOSE_PATH,
  PIPELINE_SESSIONS_PATH,
  PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW,
  PIPELINE_SESSION_TTL_MS,
} from "./pipeline-sessions";
import { KINO_CONFIG_MEDIA_TYPE, OCI_MANIFEST_MEDIA_TYPE } from "./push";
import { handleImageRegistryRequest } from "./router";

const ORIGIN = "https://intar.test";
const ADMIN = "admin";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const PUBLISH = "test-publish-token";
const SCOPE = "public";
// Repository 42 is bound to the public scope; 43 is bound to nothing.
const REPO = 42;
const REV = `git-${REPO}-${SHA}-digest`;

let testEnv: Cloudflare.Env;
let oidcKey: CryptoKey;
let jwks: unknown;
const db = () => drizzle(env.DB);

beforeAll(async () => {
  const oidc = await generateKeyPair("RS256", { extractable: true });
  oidcKey = oidc.privateKey;
  jwks = { keys: [{ ...(await exportJWK(oidc.publicKey)), kid: "k1", alg: "RS256" }] };
  testEnv = { ...env, SCENARIO_PUBLISH_WORKFLOW_SHAS: WORKFLOW_SHA } as unknown as Cloudflare.Env;
});

beforeEach(async () => {
  await resetD1Database();
  await createFixtureMember({ d1: env.DB, userId: ADMIN, role: "admin", githubAccountId: "1000" });
  await db().insert(scenarioSources).values({
    scopeKey: SCOPE,
    organizationId: null,
    githubInstallationId: REPO,
    githubRepositoryId: REPO,
    githubRepository: "intar/scenarios",
    defaultBranch: "main",
    mode: "push",
    imageProducer: "pipeline",
    boundByUserId: ADMIN,
  });
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: "oci/" });
  if (listed.objects.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(listed.objects.map((object) => object.key));
  }
  // GitHub answers only its OIDC keys: opening a session calls nothing else.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    return path === "/.well-known/jwks" ? Response.json(jwks) : new Response(null, { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A bundle of `rev` as ingest leaves it, with one revision in `state`. */
async function seedBundle(
  input: { rev?: string; producer?: "builder" | "pipeline"; state?: "building" | "ready" | "failed" } = {},
) {
  const rev = input.rev ?? REV;
  await db().insert(bundles).values({
    rev, scopeKey: SCOPE, organizationId: null, compilerVersion: "1.0.0", r2Key: `builds/${rev}`,
    imageProducer: input.producer ?? "pipeline",
  });
  await db().insert(scenarios).values({
    id: "intar/lab", namespace: "intar", slug: "lab", scopeKey: SCOPE, enabled: true, play: true,
  }).onConflictDoNothing();
  await db().insert(scenarioRevisions).values({
    scenarioId: "intar/lab", rev, guestContract: 3, docJson: {} as never, state: input.state ?? "building",
  });
}

async function oidcToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository_id: String(REPO),
    ref: "refs/heads/main",
    sha: SHA,
    event_name: "push",
    runner_environment: "github-hosted",
    run_id: "17700000001",
    run_attempt: "2",
    job_workflow_ref:
      "intar-dev/intar-dev/.github/workflows/scenario-publish.yml@refs/tags/scenario-publish-v1",
    job_workflow_sha: WORKFLOW_SHA,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(GITHUB_ACTIONS_ISSUER)
    .setAudience(env.BETTER_AUTH_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(oidcKey);
}

async function call(
  method: string,
  path: string,
  init: { bearer?: string; body?: Uint8Array<ArrayBuffer> | string; headers?: Record<string, string> } = {},
) {
  const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
  const headers = new Headers(init.headers);
  if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
  if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(body.length));
  const response = await handleImageRegistryRequest(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body }) }),
    testEnv,
  );
  if (!response) throw new Error(`no route for ${method} ${path}`);
  return response;
}

async function open(input: { claims?: Record<string, unknown>; rev?: unknown; bearer?: string } = {}) {
  return call("POST", PIPELINE_SESSIONS_PATH, {
    bearer: input.bearer ?? (await oidcToken(input.claims)),
    body: JSON.stringify({ rev: "rev" in input ? input.rev : REV }),
    headers: { "content-type": "application/json" },
  });
}

/** An open session's token, for the seeded bundle. */
async function session(): Promise<string> {
  const response = await open();
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

const putBlob = (pushed: PushedBlob, bearer: string) =>
  call("PUT", `/registry/v1/blobs/${pushed.digest}`, { bearer, body: pushed.bytes });
const putManifest = async (manifest: unknown, bearer: string) => {
  const pushed = await blob(JSON.stringify(manifest));
  return call("PUT", `/registry/v1/manifests/${pushed.digest}`, {
    bearer, body: pushed.bytes, headers: { "content-type": OCI_MANIFEST_MEDIA_TYPE },
  });
};
const bytesPut = async () =>
  (await db().select({ bytesPut: pipelineUploadSessions.bytesPut }).from(pipelineUploadSessions))[0]?.bytesPut;

describe("opening a pipeline upload session", () => {
  it("opens for the default branch and keeps only the token's hash", async () => {
    await seedBundle();
    const before = Date.now();
    const response = await open();
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      token: expect.stringMatching(/^ips_[A-Za-z0-9_-]{43}$/),
      expires_at_unix_ms: expect.any(Number),
      max_bytes: 16 * 1024 * 1024 * 1024,
    });
    expect(body.expires_at_unix_ms as number).toBeGreaterThanOrEqual(before + PIPELINE_SESSION_TTL_MS);
    expect(body.expires_at_unix_ms as number).toBeLessThanOrEqual(Date.now() + PIPELINE_SESSION_TTL_MS);

    const rows = await db().select().from(pipelineUploadSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: await sha256Text(body.token as string),
      scopeKey: SCOPE,
      githubRepositoryId: REPO,
      githubRepository: "intar/scenarios",
      ref: "refs/heads/main",
      sha: SHA,
      rev: REV,
      runId: "17700000001",
      runAttempt: 2,
      runnerEnvironment: "github-hosted",
      jobWorkflowSha: WORKFLOW_SHA,
      bytesPut: 0,
      expiresAt: body.expires_at_unix_ms,
      closedAt: null,
    });
    expect(JSON.stringify(rows)).not.toContain(body.token as string);
  });

  it("refuses a caller without a GitHub Actions token before it says anything else", async () => {
    await seedBundle();
    expect((await call("POST", PIPELINE_SESSIONS_PATH, { body: JSON.stringify({ rev: REV }) })).status).toBe(401);
    expect((await open({ bearer: "not-a-token" })).status).toBe(401);
    expect((await open({ bearer: PUBLISH })).status).toBe(401);
    // No rev either: the token is judged first.
    expect((await open({ bearer: "not-a-token", rev: 7 })).status).toBe(401);
    expect((await call("GET", PIPELINE_SESSIONS_PATH, { bearer: await oidcToken() })).status).toBe(405);
    expect(await db().select().from(pipelineUploadSessions)).toEqual([]);
  });

  it("refuses another branch at the same commit", async () => {
    await seedBundle();
    await refusal(await open({ claims: { ref: "refs/heads/feature" } }), 403, "ref_not_default_branch");
    await refusal(await open({ claims: { ref: "refs/tags/main" } }), 403, "ref_not_default_branch");
    expect(await db().select().from(pipelineUploadSessions)).toEqual([]);
  });

  it("refuses another repository's token", async () => {
    await seedBundle();
    // Not connected at all.
    await refusal(await open({ claims: { repository_id: "43" } }), 409, "binding_inactive");
    // Connected to another scope: its token cannot name this repository's rev.
    await createFixtureMember({ d1: env.DB, userId: "owner", githubAccountId: "1001" });
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org-a', 'Acme', 'acme', 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m', 'org-a', 'owner', 'owner', 0)",
    ).run();
    await db().insert(scenarioSources).values({
      scopeKey: "organization:org-a", organizationId: "org-a", githubInstallationId: 43, githubRepositoryId: 43,
      githubRepository: "acme/labs", defaultBranch: "main", mode: "push", imageProducer: "pipeline", boundByUserId: "owner",
    });
    await refusal(await open({ claims: { repository_id: "43" } }), 400, "rev_invalid");
    // Nor a rev of its own that is another scope's bundle.
    await db().update(bundles).set({ rev: `git-43-${SHA}-digest` });
    await db().update(scenarioRevisions).set({ rev: `git-43-${SHA}-digest` });
    await refusal(
      await open({ claims: { repository_id: "43" }, rev: `git-43-${SHA}-digest` }),
      409,
      "superseded",
    );
    expect(await db().select().from(pipelineUploadSessions)).toEqual([]);
  });

  it("refuses a rev of another commit, and a body that names none", async () => {
    await seedBundle();
    await seedBundle({ rev: `git-${REPO}-${OTHER_SHA}-digest` });
    await refusal(await open({ rev: `git-${REPO}-${OTHER_SHA}-digest` }), 400, "rev_invalid");
    await refusal(await open({ rev: `git-${REPO}-${SHA}` }), 400, "rev_invalid");
    await refusal(await open({ rev: 7 }), 400, "rev_invalid");
    const notJson = await call("POST", PIPELINE_SESSIONS_PATH, { bearer: await oidcToken(), body: "rev" });
    await refusal(notJson, 400, "rev_invalid");
  });

  it("follows the bundle's stamp, not the source's setting", async () => {
    await seedBundle({ producer: "builder" });
    await refusal(await open(), 409, "pipeline_images_disabled");

    // A pipeline-stamped bundle stays the pipeline's after the source is switched.
    await db().update(bundles).set({ imageProducer: "pipeline" });
    await db().update(scenarioSources).set({ imageProducer: "builder" });
    expect((await open()).status).toBe(201);
  });

  it("refuses a builder source that has no bundle yet", async () => {
    await db().update(scenarioSources).set({ imageProducer: "builder" });
    await db().insert(scenarioSourceCommits).values({
      id: "c1", scopeKey: SCOPE, purpose: "deploy", sha: SHA, rev: REV, via: "push", state: "ingesting",
    });
    await refusal(await open(), 409, "pipeline_images_disabled");
  });

  it("asks a pipeline to come back while its bundle is ingested", async () => {
    await db().insert(scenarioSourceCommits).values({
      id: "c1", scopeKey: SCOPE, purpose: "deploy", sha: SHA, rev: REV, via: "push", state: "ingesting",
    });
    const pending = await open();
    expect(pending.headers.get("retry-after")).toBe("5");
    await refusal(pending, 409, "bundle_pending");

    await db().update(scenarioSourceCommits).set({ state: "superseded" });
    const gone = await open();
    expect(gone.headers.get("retry-after")).toBeNull();
    await refusal(gone, 409, "superseded");
    await db().delete(scenarioSourceCommits);
    await refusal(await open(), 409, "superseded");
  });

  it("refuses when no revision of the rev is building", async () => {
    await seedBundle({ state: "ready" });
    await refusal(await open(), 409, "superseded");
    await db().update(scenarioRevisions).set({ state: "failed" });
    await refusal(await open(), 409, "superseded");
    await db().update(scenarioRevisions).set({ state: "building" });
    expect((await open()).status).toBe(201);
  });

  it("refuses a self-hosted runner unless the source allows it", async () => {
    await seedBundle();
    const refused = await open({ claims: { runner_environment: "self-hosted" } });
    await refusal(refused, 401, "unauthorized");
    await db().update(scenarioSources).set({ allowSelfHostedRunners: true });
    expect((await open({ claims: { runner_environment: "self-hosted" } })).status).toBe(201);
    expect((await db().select().from(pipelineUploadSessions))[0]?.runnerEnvironment).toBe("self-hosted");
  });

  it("refuses a paused or disconnected source", async () => {
    await seedBundle();
    await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });
    await refusal(await open(), 409, "binding_inactive");
    await db().update(scenarioSources).set({ pausedAt: null, pauseReason: null, disconnectedAt: 1 });
    await refusal(await open(), 409, "binding_inactive");
  });

  it("limits the open sessions of a scope", async () => {
    await seedBundle();
    const tokens: string[] = [];
    for (let index = 0; index < PIPELINE_OPEN_SESSIONS_PER_SCOPE; index += 1) tokens.push(await session());
    await refusal(await open(), 429, "pipeline_session_limit");

    // A closed one and an expired one each make room.
    expect((await call("POST", PIPELINE_SESSIONS_CLOSE_PATH, { bearer: tokens[0]! })).status).toBe(200);
    expect((await open()).status).toBe(201);
    await refusal(await open(), 429, "pipeline_session_limit");
    await db().update(pipelineUploadSessions).set({ expiresAt: Date.now() - 1 })
      .where(eq(pipelineUploadSessions.tokenHash, await sha256Text(tokens[1]!)));
    expect((await open()).status).toBe(201);
  });

  it("limits the sessions a scope opens in a day", async () => {
    await seedBundle();
    const now = Date.now();
    const closed = (index: number, createdAt: number) => ({
      id: `old-${index}`, tokenHash: `hash-${index}`, scopeKey: SCOPE, githubRepositoryId: REPO,
      githubRepository: "intar/scenarios", ref: "refs/heads/main", sha: SHA, rev: REV, runId: "1", runAttempt: 1,
      runnerEnvironment: "github-hosted", jobWorkflowSha: WORKFLOW_SHA, createdAt, expiresAt: createdAt + 1, closedAt: createdAt + 1,
    });
    const rows = Array.from({ length: PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW }, (_, index) => closed(index, now - 60_000));
    for (let start = 0; start < rows.length; start += 5) {
      await db().insert(pipelineUploadSessions).values(rows.slice(start, start + 5));
    }
    await refusal(await open(), 429, "pipeline_session_limit");

    // One of them falls out of the window.
    await db().update(pipelineUploadSessions).set({ createdAt: now - 25 * 60 * 60 * 1000 })
      .where(eq(pipelineUploadSessions.id, "old-0"));
    expect((await open()).status).toBe(201);
  });

  it("limits the bytes a scope's sessions store in a day", async () => {
    await seedBundle();
    await session();
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_BYTES_PER_SCOPE_PER_WINDOW, closedAt: Date.now() });
    await refusal(await open(), 429, "pipeline_session_limit");

    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_BYTES_PER_SCOPE_PER_WINDOW - 1 });
    expect((await open()).status).toBe(201);
    // What an older session stored is not counted.
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_BYTES_PER_SCOPE_PER_WINDOW, closedAt: Date.now() });
    await refusal(await open(), 429, "pipeline_session_limit");
    await db().update(pipelineUploadSessions).set({ createdAt: Date.now() - 25 * 60 * 60 * 1000 });
    expect((await open()).status).toBe(201);
  });
});

describe("a pipeline session token as a registry credential", () => {
  it("opens, heartbeats and closes its own admission session", async () => {
    await seedBundle();
    const token = await session();
    const created = await call("POST", "/registry/v1/upload-sessions", { bearer: token });
    expect(created.status).toBe(201);
    const { session_id: sessionId } = (await created.json()) as { session_id: string };
    const row = await env.DB.prepare(
      "SELECT owner_kind, owner_id, state FROM image_registry_upload_sessions WHERE id = ?1",
    ).bind(sessionId).first();
    const [pipeline] = await db().select().from(pipelineUploadSessions);
    expect(row).toEqual({ owner_kind: "pipeline", owner_id: pipeline!.id, state: "open" });

    const headers = { [REGISTRY_SESSION_HEADER]: sessionId };
    expect((await call("POST", "/registry/v1/upload-sessions/heartbeat", { bearer: token, headers })).status).toBe(200);
    // Another credential cannot use it.
    expect((await call("POST", "/registry/v1/upload-sessions/heartbeat", { bearer: PUBLISH, headers })).status).toBe(403);
    const pushed = await blob("under a session");
    expect((await call("PUT", `/registry/v1/blobs/${pushed.digest}`, { bearer: token, body: pushed.bytes, headers })).status).toBe(201);
    const completed = await call("POST", "/registry/v1/upload-sessions/complete", {
      bearer: token, headers, body: JSON.stringify({ outcome: "abandoned" }),
    });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ state: "abandoned" });
  });

  it("asks for and stores blobs, and is charged what it stores", async () => {
    await seedBundle();
    const token = await session();
    const first = await blob("first blob");
    const head = () => call("HEAD", `/registry/v1/blobs/${first.digest}`, { bearer: token });
    expect((await head()).status).toBe(404);
    expect((await putBlob(first, token)).status).toBe(201);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`oci/sha256/${first.hex}`)).not.toBeNull();
    expect((await head()).status).toBe(200);
    expect(await bytesPut()).toBe(first.bytes.length);

    // A blob that is already stored costs nothing; a new one adds its size.
    expect((await putBlob(first, token)).status).toBe(201);
    expect(await bytesPut()).toBe(first.bytes.length);
    const second = await blob("second");
    expect((await putBlob(second, token)).status).toBe(201);
    expect(await bytesPut()).toBe(first.bytes.length + second.bytes.length);

    // One that is refused gives its bytes back.
    const claimed = await blob("claimed");
    const mismatch = await call("PUT", `/registry/v1/blobs/${claimed.digest}`, { bearer: token, body: "something else" });
    expect(mismatch.status).toBe(409);
    expect(await bytesPut()).toBe(first.bytes.length + second.bytes.length);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
  });

  it("refuses a blob over the session's byte budget and stores nothing", async () => {
    await seedBundle();
    const token = await session();
    const pushed = await blob("ten bytes!");
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_SESSION_MAX_BYTES - pushed.bytes.length + 1 });
    await refusal(await putBlob(pushed, token), 413, "pipeline_session_bytes");
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`oci/sha256/${pushed.hex}`)).toBeNull();
    expect(await bytesPut()).toBe(PIPELINE_SESSION_MAX_BYTES - pushed.bytes.length + 1);

    // Exactly the rest of the budget still fits.
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_SESSION_MAX_BYTES - pushed.bytes.length });
    expect((await putBlob(pushed, token)).status).toBe(201);
    expect(await bytesPut()).toBe(PIPELINE_SESSION_MAX_BYTES);
    // The budget is the session's, not the publish token's.
    const other = await blob("by the publish token");
    expect((await putBlob(other, PUBLISH)).status).toBe(201);
  });

  it("cannot push a machine manifest, a Kino manifest or a result", async () => {
    await seedBundle();
    const token = await session();
    const buildKeyHex = "b".repeat(64);
    const config = await blob(JSON.stringify(machineConfig(`sha256:${buildKeyHex}`)));
    const kernel = await blob("kernel bytes");
    const chunk = await blob("chunk bytes");
    for (const pushed of [config, kernel, chunk]) expect((await putBlob(pushed, token)).status).toBe(201);
    const machine = manifestOf("application/vnd.intar.machine.v1", config, "application/vnd.intar.machine.config.v1+json", [
      ["application/vnd.intar.kernel.v1", kernel],
      ["application/vnd.intar.disk.chunk.v1+zstd", chunk],
    ]);
    expect((await putManifest(machine, token)).status).toBe(403);

    const kinoConfig = await blob(JSON.stringify({ guest_contract: 3, version: "1.0.0" }));
    const binary = await blob("kino");
    for (const pushed of [kinoConfig, binary]) expect((await putBlob(pushed, token)).status).toBe(201);
    const kino = manifestOf("application/vnd.intar.kino.v1", kinoConfig, KINO_CONFIG_MEDIA_TYPE, [
      ["application/octet-stream", binary],
    ]);
    expect((await putManifest(kino, token)).status).toBe(403);
    // The publish token's own push of the same manifest is as it was.
    expect((await putManifest(kino, PUBLISH)).status).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifests").first("n")).toBe(1);

    const result = `/registry/v1/builds/${buildKeyHex}/result?attempt=1`;
    const posted = await call("POST", result, {
      bearer: token, body: JSON.stringify({ image_digest: `sha256:${"d".repeat(64)}` }),
    });
    expect(posted.status).toBe(403);
    expect((await call("GET", result, { bearer: token })).status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
  });

  it("is refused a manifest or a result before its body is read, so an interrupted one holds nothing", async () => {
    await seedBundle();
    const token = await session();
    for (const [method, path] of [
      ["PUT", `/registry/v1/manifests/sha256:${"e".repeat(64)}`],
      ["POST", `/registry/v1/builds/${"b".repeat(64)}/result?attempt=1`],
    ] as const) {
      // A body that never arrives: the answer cannot have waited for it.
      const body = new ReadableStream<Uint8Array>();
      const response = await handleImageRegistryRequest(
        new Request(`${ORIGIN}${path}`, {
          method, body, duplex: "half",
          headers: { authorization: `Bearer ${token}`, "content-type": OCI_MANIFEST_MEDIA_TYPE },
        } as RequestInit),
        testEnv,
      );
      expect(response?.status).toBe(403);
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
    expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
  });

  it("is refused by admission control, the cutover gate and the agent routes", async () => {
    await seedBundle();
    const token = await session();
    const json = { "content-type": "application/json" };
    expect((await call("GET", "/registry/v1/admission", { bearer: token })).status).toBe(403);
    expect((await call("POST", "/registry/v1/admission/pause", {
      bearer: token, headers: json, body: JSON.stringify({ paused: true }),
    })).status).toBe(403);
    expect((await call("POST", "/registry/v1/admission/enforcement", {
      bearer: token, headers: json, body: JSON.stringify({ mode: "enforce" }),
    })).status).toBe(403);
    expect((await call("POST", "/registry/v1/admission/reap", { bearer: token })).status).toBe(403);
    // Nothing was paused, enforced or reaped: the gate row was never written.
    expect(await env.DB.prepare("SELECT enforcement, paused_at FROM image_registry_admission").first()).toBeNull();

    expect((await call("GET", "/registry/v1/cutover/gate", { bearer: token })).status).toBe(401);
    expect((await call("POST", "/registry/v1/cutover/gate", {
      bearer: token, headers: json, body: JSON.stringify({ state: "drained" }),
    })).status).toBe(401);
    expect((await call("GET", `/agent/registry/bundles/${REV}`, { bearer: token })).status).toBe(401);
    expect((await call("GET", "/agent/registry/sources/c1", { bearer: token })).status).toBe(401);
    expect((await call("POST", "/agent/registry/sources/c1/result", { bearer: token, body: "{}" })).status).toBe(401);
    expect((await call("PUT", "/agent/builds/build-1/log", { bearer: token, body: "log" })).status).toBe(401);
    // The routes are still the publish token's and a builder's.
    expect((await call("GET", "/registry/v1/admission", { bearer: PUBLISH })).status).toBe(200);
    expect((await call("GET", "/registry/v1/cutover/gate", { bearer: PUBLISH })).status).toBe(200);
  });

  it("stops working when it expires", async () => {
    await seedBundle();
    const token = await session();
    const pushed = await blob("blob");
    expect((await call("HEAD", `/registry/v1/blobs/${pushed.digest}`, { bearer: token })).status).toBe(404);
    await db().update(pipelineUploadSessions).set({ expiresAt: Date.now() - 1 });
    expect((await call("HEAD", `/registry/v1/blobs/${pushed.digest}`, { bearer: token })).status).toBe(401);
    expect((await putBlob(pushed, token)).status).toBe(401);
    expect((await call("POST", "/registry/v1/upload-sessions", { bearer: token })).status).toBe(401);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`oci/sha256/${pushed.hex}`)).toBeNull();
  });

  it("stops working when it is closed, and closes again without complaint", async () => {
    await seedBundle();
    const token = await session();
    const other = await session();
    const close = (bearer?: string) =>
      call("POST", PIPELINE_SESSIONS_CLOSE_PATH, bearer === undefined ? {} : { bearer });
    const first = await close(token);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const closedAt = (await db().select().from(pipelineUploadSessions)
      .where(eq(pipelineUploadSessions.tokenHash, await sha256Text(token))))[0]?.closedAt;
    expect(closedAt).toEqual(expect.any(Number));
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);

    // Again: the same answer, and the first close's time stays.
    const again = await close(token);
    expect(again.status).toBe(200);
    expect((await db().select().from(pipelineUploadSessions)
      .where(eq(pipelineUploadSessions.tokenHash, await sha256Text(token))))[0]?.closedAt).toBe(closedAt);
    // Only its own session was closed.
    expect((await putBlob(await blob("blob"), other)).status).toBe(201);

    expect((await close()).status).toBe(401);
    expect((await close(`ips_${"x".repeat(43)}`)).status).toBe(401);
    expect((await close(PUBLISH)).status).toBe(401);
    expect((await call("GET", PIPELINE_SESSIONS_CLOSE_PATH, { bearer: token })).status).toBe(405);
  });

  it("stops working while its source is paused", async () => {
    await seedBundle();
    const token = await session();
    await db().update(scenarioSources).set({ pausedAt: Date.now(), pauseReason: "admin" });
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);
    await db().update(scenarioSources).set({ pausedAt: null, pauseReason: null });
    expect((await putBlob(await blob("blob"), token)).status).toBe(201);
  });

  it("stops working when its source is switched to pull mode or bound to another repository", async () => {
    await seedBundle();
    const token = await session();
    await db().update(scenarioSources).set({ mode: "pull" });
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);
    await db().update(scenarioSources).set({ mode: "push", githubRepositoryId: REPO + 1 });
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);
    await db().update(scenarioSources).set({ githubRepositoryId: REPO });
    expect((await putBlob(await blob("blob"), token)).status).toBe(201);
  });

  it("stops working when its binder no longer holds the scope", async () => {
    await seedBundle();
    const token = await session();
    await db().update(user).set({ role: "user" }).where(eq(user.id, ADMIN));
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);
  });

  it("is closed by a disconnect and stays closed after a reconnect", async () => {
    await seedBundle();
    const token = await session();
    await changeScenarioSource({
      scope: scenarioSourceScope(null),
      actorUserId: ADMIN,
      body: { action: "disconnect" },
      startedAt: Date.now(),
    });
    const [source] = await db().select().from(scenarioSources);
    expect(source?.disconnectedAt).toEqual(expect.any(Number));
    expect((await db().select().from(pipelineUploadSessions))[0]?.closedAt).toBe(source?.disconnectedAt);
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);

    await db().update(scenarioSources).set({ disconnectedAt: null, disconnectReason: null });
    expect((await putBlob(await blob("blob"), token)).status).toBe(401);
  });

  it("leaves a disconnect that did not apply without effect", async () => {
    await seedBundle();
    const token = await session();
    await createFixtureMember({ d1: env.DB, userId: "stranger", githubAccountId: "1002" });
    await changeScenarioSource({
      scope: scenarioSourceScope(null),
      actorUserId: "stranger",
      body: { action: "disconnect" },
      startedAt: Date.now(),
    }).catch(() => undefined);
    expect((await db().select().from(scenarioSources))[0]?.disconnectedAt).toBeNull();
    expect((await db().select().from(pipelineUploadSessions))[0]?.closedAt).toBeNull();
    expect((await putBlob(await blob("blob"), token)).status).toBe(201);
  });

  it("does not hold the sweep with its session or its blob uploads", async () => {
    await seedBundle();
    const token = await session();
    const created = await call("POST", "/registry/v1/upload-sessions", { bearer: token });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };
    expect((await call("PUT", `/registry/v1/blobs/${(await blob("a")).digest}`, {
      bearer: token, body: "a", headers: { [REGISTRY_SESSION_HEADER]: sessionId },
    })).status).toBe(201);

    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);
    // The live session is left open for its pipeline.
    expect(await env.DB.prepare("SELECT state FROM image_registry_upload_sessions WHERE id = ?1").bind(sessionId).first("state"))
      .toBe("open");
    // While the sweep holds the gate the pipeline's writes wait like anyone's.
    const during = await putBlob(await blob("during the sweep"), token);
    expect(during.status).toBe(409);
    expect(await during.json()).toMatchObject({ code: "registry_sweep_in_progress" });
  });

  it("lets the sweep delete while its session is open and a blob upload was cut off", async () => {
    await setRegistryEnforcement({ DB: env.DB }, "enforce");
    await seedBundle();
    const token = await session();
    const created = await call("POST", "/registry/v1/upload-sessions", { bearer: token });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };
    // A blob upload that never settled, as an aborted request leaves it.
    const cutOff = (id: string, expiresAt: number) => env.DB.prepare(
      `INSERT INTO image_registry_operation_writers
         (id, session_id, owner_kind, owner_id, operation, epoch, outcome, created_at, heartbeat_at, expires_at)
       SELECT ?1, id, owner_kind, owner_id, 'blob_put', 0, 'pending', ?2, ?2, ?2
         FROM image_registry_upload_sessions WHERE id = ?3`,
    ).bind(id, expiresAt, sessionId).run();
    await cutOff("recent", Date.now());
    await cutOff("old", Date.now() - REGISTRY_REAP_GRACE_MS - 1);

    // What the platform reads says the same as what the sweep is allowed.
    const status = await call("GET", "/registry/v1/admission", { bearer: PUBLISH });
    expect(await status.json()).toMatchObject({ idle: true, idle_blocked_reason: null });

    const orphan = await blob("an object nothing names");
    const key = `oci/sha256/${orphan.digest.slice("sha256:".length)}`;
    await env.VM_IMAGE_REGISTRY_BUCKET.put(key, orphan.bytes);
    const report = await runOciSweep(env, { mode: "delete", nowMs: Date.now() + 2 * OCI_SWEEP_AGE_GUARD_MS, kinoPinsJson: "" });
    expect(report.error).toBeNull();
    expect(report.deletedObjects).toBe(1);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(key)).toBeNull();

    // The sweep removed the writer nothing else would, and kept the recent one.
    const writers = await env.DB.prepare("SELECT id FROM image_registry_operation_writers").all<{ id: string }>();
    expect(writers.results.map((row) => row.id)).toEqual(["recent"]);

    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok && (await heartbeatRegistrySweep(env, { sweepToken: acquired.lease.sweepToken })))
      .toMatchObject({ ok: true, deleteAllowed: true, blockedReason: null });
  });

  it("leaves nothing behind once its session has ended", async () => {
    await seedBundle();
    const token = await session();
    const created = await call("POST", "/registry/v1/upload-sessions", { bearer: token });
    const { session_id: sessionId } = (await created.json()) as { session_id: string };
    await env.DB.prepare(
      `INSERT INTO image_registry_operation_writers
         (id, session_id, owner_kind, owner_id, operation, epoch, outcome, created_at, heartbeat_at, expires_at)
       SELECT 'cut-off', id, owner_kind, owner_id, 'blob_put', 0, 'pending', ?1, ?1, ?1
         FROM image_registry_upload_sessions WHERE id = ?2`,
    ).bind(Date.now() - REGISTRY_REAP_GRACE_MS - 1, sessionId).run();
    await db().update(pipelineUploadSessions).set({ expiresAt: Date.now() - 1 });

    // The acquire ends the admission session and drops the writer; the
    // history pass then removes the session row.
    expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
    expect(await compactRegistryAdmissionHistory({ DB: env.DB }, { retainClosedSessionsMs: -1000 }))
      .toMatchObject({ removedSessions: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_upload_sessions").first("n")).toBe(0);
  });
});

describe("a builder next to a pipeline", () => {
  it("still pushes blobs without a charge and reads admission", async () => {
    const id = "builder-a";
    await db().insert(user).values({ id: `${id}-owner`, name: id, email: `${id}@example.test` });
    await db().insert(agentHosts).values({
      id, userId: `${id}-owner`, name: id, role: "builder", scope: "platform", credentialGeneration: 1, disabled: false,
    });
    await db().insert(agentBootstrapTokens).values({
      id: `${id}-c2`, hostId: id, tokenHash: await sha256Text(`${id}-secret`), credentialGeneration: 1, expiresAt: null,
    });
    const bootstrap = await handleAgentBootstrap(new Request(`${ORIGIN}/agent/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
      body: JSON.stringify({ hostId: id, bootstrapToken: `${id}-secret` }),
    }), env);
    const builder = ((await bootstrap.json()) as { accessToken: string }).accessToken;

    await seedBundle();
    await session();
    expect((await putBlob(await blob("a builder's blob"), builder)).status).toBe(201);
    expect(await bytesPut()).toBe(0);
    expect((await call("GET", "/registry/v1/admission", { bearer: builder })).status).toBe(200);
    // A builder's token is not a way to close or open a pipeline's session.
    expect((await call("POST", PIPELINE_SESSIONS_CLOSE_PATH, { bearer: builder })).status).toBe(401);
    expect((await open({ bearer: builder })).status).toBe(401);
  });
});
