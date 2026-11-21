/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  bundles,
  member,
  organization,
  pipelineUploadSessions,
  scenarioRevisions,
  scenarioSourceCommits,
  scenarioSources,
  scenarios,
  scopeMachineImages,
  user,
} from "@/db/schema";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import { GITHUB_ACTIONS_ISSUER } from "@/lib/github-oidc";
import {
  acquireRegistrySweep,
  compactRegistryAdmissionHistory,
  heartbeatRegistrySweep,
  REGISTRY_PIPELINE_WRITER_GRACE_MS,
  REGISTRY_REAP_GRACE_MS,
  REGISTRY_SESSION_HEADER,
  setRegistryEnforcement,
  type RegistryOperationLease,
} from "@/lib/image-registry-admission";
import { OCI_SWEEP_AGE_GUARD_MS, runOciSweep } from "@/lib/oci-registry-sweep";
import {
  PIPELINE_OPEN_SESSIONS_PER_SCOPE,
  PIPELINE_ORGANIZATION_LIMITS,
  PIPELINE_PLATFORM_LIMITS,
  PIPELINE_SESSION_MAX_BYTES,
  PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW,
} from "@/lib/pipeline-upload-sessions";
import { ingestSourceBundle } from "@/lib/scenario-bundles";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { moveLiveRevision } from "@/lib/scenario-revisions";
import { changeScenarioSource, scenarioSourceCard, scenarioSourceScope } from "@/lib/scenario-sources";
import { driveDeployJob } from "@/lib/source-deploy-job";
import { arm64MachineImages } from "@/lib/scenario-runs/revision-begin";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { blob, machineConfig, manifestOf, type PushedBlob } from "./oci-test-fixtures";
import {
  PIPELINE_SESSIONS_CLOSE_PATH,
  PIPELINE_SESSIONS_PATH,
  PIPELINE_SESSION_TTL_MS,
} from "./pipeline-sessions";
import { handleBuildResult, handleManifestPut, KINO_CONFIG_MEDIA_TYPE, OCI_MANIFEST_MEDIA_TYPE } from "./push";
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
/** The build key of the seeded bundle's one machine, and one no bundle names. */
const KEY_HEX = "b".repeat(64);
const KEY = `sha256:${KEY_HEX}`;
const FOREIGN_HEX = "f".repeat(64);

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
  input: {
    rev?: string; producer?: "builder" | "pipeline"; state?: "building" | "ready" | "failed"; keys?: string[];
  } = {},
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
    scenarioId: "intar/lab", rev, guestContract: 3, state: input.state ?? "building",
    docJson: { machines: (input.keys ?? [KEY]).map((key, index) => ({ name: `m${index}`, build_key: key })) } as never,
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

async function refusal(response: Response, status: number, code: string | undefined) {
  expect(response.status).toBe(status);
  if (code !== undefined) expect(await response.json()).toMatchObject({ code });
}

const putBlob = (pushed: PushedBlob, bearer: string) =>
  call("PUT", `/registry/v1/blobs/${pushed.digest}`, { bearer, body: pushed.bytes });
const putManifest = async (manifest: unknown, bearer: string) => {
  const pushed = await blob(JSON.stringify(manifest));
  return call("PUT", `/registry/v1/manifests/${pushed.digest}`, {
    bearer, body: pushed.bytes, headers: { "content-type": OCI_MANIFEST_MEDIA_TYPE },
  });
};
/** The blobs and the manifest of a small machine image for `keyHex`. */
async function machineImage(keyHex: string, input: { architecture?: string; label?: string } = {}) {
  const label = `${input.label ?? "image"} ${input.architecture ?? "amd64"}`;
  const config = await blob(JSON.stringify(machineConfig(`sha256:${keyHex}`, { architecture: input.architecture ?? "amd64" })));
  const kernel = await blob(`kernel ${label}`);
  const chunk = await blob(`chunk ${label}`);
  const manifest = manifestOf("application/vnd.intar.machine.v1", config, "application/vnd.intar.machine.config.v1+json", [
    ["application/vnd.intar.kernel.v1", kernel],
    ["application/vnd.intar.disk.chunk.v1+zstd", chunk],
  ]);
  return { blobs: [config, kernel, chunk], manifest, digest: (await blob(JSON.stringify(manifest))).digest };
}

/** Pushes that image's blobs and its manifest as `bearer`. */
async function pushImage(bearer: string, keyHex: string, input: { architecture?: string; label?: string } = {}) {
  const image = await machineImage(keyHex, input);
  for (const pushed of image.blobs) await putBlob(pushed, bearer);
  return { ...image, response: await putManifest(image.manifest, bearer) };
}

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

  it("refuses when no revision of the rev in its scope still takes images", async () => {
    await seedBundle({ state: "failed" });
    await refusal(await open(), 409, "superseded");
    await db().update(scenarioRevisions).set({ state: "building" });
    expect((await open()).status).toBe(201);
    // A revision that is ready has its amd64 images; its arm64 ones may
    // follow while it is one that is kept: here, its scenario's candidate.
    await db().update(scenarioRevisions).set({ state: "ready" });
    await refusal(await open(), 409, "superseded");
    await db().update(scenarios).set({ candidateRev: REV });
    expect((await open()).status).toBe(201);
    await db().update(scenarios).set({ candidateRev: null, liveRev: REV });
    await db().update(scenarioRevisions).set({ state: "verified" });
    expect((await open()).status).toBe(201);

    // A verified revision behind three newer verified ones is kept no more.
    await db().update(scenarios).set({ liveRev: null });
    await db().update(scenarioRevisions).set({ createdAt: 1 });
    for (const newer of ["n1", "n2", "n3"]) {
      await db().insert(scenarioRevisions).values({
        scenarioId: "intar/lab", rev: newer, guestContract: 3, docJson: { machines: [] } as never, state: "verified", createdAt: 2,
      });
    }
    await refusal(await open(), 409, "superseded");
    await db().update(scenarios).set({ liveRev: REV });
    expect((await open()).status).toBe(201);
    await db().update(scenarios).set({ scopeKey: "organization:acme" });
    await refusal(await open(), 409, "superseded");
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
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_PLATFORM_LIMITS.windowBytes, closedAt: Date.now() });
    await refusal(await open(), 429, "pipeline_session_limit");

    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_PLATFORM_LIMITS.windowBytes - 1 });
    expect((await open()).status).toBe(201);
    // What an older session stored is not counted.
    await db().update(pipelineUploadSessions).set({ bytesPut: PIPELINE_PLATFORM_LIMITS.windowBytes, closedAt: Date.now() });
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

  it("pushes a machine manifest for a key of its bundle, and nothing else", async () => {
    await seedBundle();
    const token = await session();
    const mine = await pushImage(token, KEY_HEX);
    expect(mine.response.status).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifest_blobs WHERE manifest_digest = ?1")
      .bind(mine.digest).first("n")).toBe(3);

    // A key no revision of its commit names, and one only another scope's does.
    await refusal((await pushImage(token, FOREIGN_HEX)).response, 403, "build_key_not_in_bundle");
    await db().insert(scenarios).values({
      id: "acme/lab", namespace: "acme", slug: "lab", scopeKey: "organization:acme", enabled: true, play: true,
    });
    await db().insert(scenarioRevisions).values({
      scenarioId: "acme/lab", rev: REV, guestContract: 3, state: "building",
      docJson: { machines: [{ name: "m", build_key: `sha256:${FOREIGN_HEX}` }] } as never,
    });
    await refusal((await pushImage(token, FOREIGN_HEX)).response, 403, "build_key_not_in_bundle");

    const kinoConfig = await blob(JSON.stringify({ guest_contract: 3, version: "1.0.0" }));
    const binary = await blob("kino");
    for (const pushed of [kinoConfig, binary]) expect((await putBlob(pushed, token)).status).toBe(201);
    const kino = manifestOf("application/vnd.intar.kino.v1", kinoConfig, KINO_CONFIG_MEDIA_TYPE, [
      ["application/octet-stream", binary],
    ]);
    expect((await putManifest(kino, token)).status).toBe(403);
    // The publish token's own push of the same manifest is as it was, and a
    // machine manifest is still not its to push.
    expect((await putManifest(kino, PUBLISH)).status).toBe(201);
    expect((await pushImage(PUBLISH, KEY_HEX, { label: "other" })).response.status).toBe(403);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifests").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
  });

  it("pushes a manifest of more blobs than one statement indexes, and makes a stored one young again", async () => {
    await seedBundle();
    const token = await session();
    const config = await blob(JSON.stringify(machineConfig(KEY)));
    const chunks = await Promise.all(Array.from({ length: 120 }, (_, index) => blob(`chunk ${index}`)));
    for (const pushed of [config, ...chunks]) expect((await putBlob(pushed, token)).status).toBe(201);
    const manifest = manifestOf("application/vnd.intar.machine.v1", config, "application/vnd.intar.machine.config.v1+json",
      chunks.map((chunk) => ["application/vnd.intar.disk.chunk.v1+zstd", chunk] as [string, PushedBlob]));
    expect((await putManifest(manifest, token)).status).toBe(201);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifest_blobs").first("n")).toBe(121);

    // Pushed again long after, it protects its blobs like a new one.
    await env.DB.prepare("UPDATE registry_manifests SET created_at = 1").run();
    expect((await putManifest(manifest, token)).status).toBe(201);
    expect(await env.DB.prepare("SELECT created_at FROM registry_manifests").first<number>("created_at")).toBeGreaterThan(1);
  });

  it("refuses an image over the size a pipeline may push before it looks for a blob", async () => {
    await seedBundle();
    const token = await session();
    const image = await machineImage(KEY_HEX);
    image.manifest.layers[1]!.size = PIPELINE_SESSION_MAX_BYTES;
    await refusal(await putManifest(image.manifest, token), 413, "image_too_large");
  });

  it("is told to push a blob again when it went missing before the manifest", async () => {
    await seedBundle();
    const token = await session();
    const image = await machineImage(KEY_HEX);
    for (const pushed of image.blobs) expect((await putBlob(pushed, token)).status).toBe(201);
    // A sweep between the upload and the manifest may have deleted it.
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(`oci/sha256/${image.blobs[2]!.hex}`);
    await refusal(await putManifest(image.manifest, token), 409, "blob_unknown");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifests").first("n")).toBe(0);
  });

  it("writes nothing once its writer's lease has run out", async () => {
    await seedBundle();
    const token = await session();
    const image = await machineImage(KEY_HEX);
    for (const pushed of image.blobs) expect((await putBlob(pushed, token)).status).toBe(201);
    const pushed = await blob(JSON.stringify(image.manifest));
    const request = () => new Request(`${ORIGIN}/registry/v1/manifests/${pushed.digest}`, {
      method: "PUT", body: pushed.bytes,
      headers: { authorization: `Bearer ${token}`, "content-type": OCI_MANIFEST_MEDIA_TYPE, "content-length": String(pushed.bytes.length) },
    });
    // As the handler runs when the sweep's acquire has removed its writer.
    const gone: RegistryOperationLease = { operationId: "gone", sessionId: null, epoch: 0, complete: async () => undefined };
    await refusal(await handleManifestPut(request(), testEnv, pushed.hex, gone), 409, "registry_writer_expired");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifests").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifest_blobs").first("n")).toBe(0);

    expect((await putManifest(image.manifest, token)).status).toBe(201);
    const result = new Request(`${ORIGIN}/registry/v1/builds/${KEY_HEX}/result`, {
      method: "POST", body: JSON.stringify({ image_digest: pushed.digest }),
      headers: { authorization: `Bearer ${token}`, "content-length": String(JSON.stringify({ image_digest: pushed.digest }).length) },
    });
    await refusal(await handleBuildResult(result, testEnv, KEY_HEX, gone), 409, "registry_writer_expired");
    expect(await db().select().from(scopeMachineImages)).toEqual([]);
  });

  it("holds nothing when a manifest or a result is cut off, and the sweep removes a writer past its lease", async () => {
    await seedBundle();
    const token = await session();
    for (const [method, path] of [
      ["PUT", `/registry/v1/manifests/sha256:${"e".repeat(64)}`],
      ["POST", `/registry/v1/builds/${KEY_HEX}/result`],
    ] as const) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("cut off")); } });
      await expect(handleImageRegistryRequest(
        new Request(`${ORIGIN}${path}`, {
          method, body, duplex: "half",
          headers: { authorization: `Bearer ${token}`, "content-type": OCI_MANIFEST_MEDIA_TYPE, "content-length": "10" },
        } as RequestInit),
        testEnv,
      )).rejects.toThrow();
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);

    // A Worker that died mid-request leaves its row. It holds the sweep for
    // as long as its lease could still write, and no longer.
    const left = (id: string, expiresAt: number) => env.DB.prepare(
      `INSERT INTO image_registry_operation_writers
         (id, session_id, owner_kind, owner_id, operation, epoch, outcome, created_at, heartbeat_at, expires_at)
       VALUES (?1, NULL, 'pipeline', 'session', 'manifest_put', 0, 'pending', ?2, ?2, ?2)`,
    ).bind(id, expiresAt).run();
    await left("live", Date.now() + 60_000);
    expect(await acquireRegistrySweep(env, { owner: "collector-a" })).toMatchObject({ ok: false, code: "registry_admission_busy" });
    await env.DB.prepare("UPDATE image_registry_operation_writers SET expires_at = ?1")
      .bind(Date.now() - REGISTRY_PIPELINE_WRITER_GRACE_MS - 1).run();
    expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
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

describe("a pipeline recording its image", () => {
  const record = (token: string, digest: string, hex = KEY_HEX, query = "") =>
    call("POST", `/registry/v1/builds/${hex}/result${query}`, { bearer: token, body: JSON.stringify({ image_digest: digest }) });
  const rows = () => db().select().from(scopeMachineImages).orderBy(scopeMachineImages.architecture);

  it("records the first image of a key with what its session says of the run", async () => {
    await seedBundle();
    const token = await session();
    const image = await pushImage(token, KEY_HEX);
    const recorded = await record(token, image.digest);
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toEqual({ ok: true, image_digest: image.digest });
    expect(await rows()).toEqual([expect.objectContaining({
      scopeKey: SCOPE, buildKey: KEY, architecture: "amd64", imageDigest: image.digest, imageFormat: "intar-image-4",
      sizeBytes: image.blobs.reduce((sum, pushed) => sum + pushed.bytes.length, 0),
      githubRepositoryId: REPO, githubRepository: "intar/scenarios", sha: SHA, runId: "17700000001", runAttempt: 2,
      runnerEnvironment: "github-hosted", jobWorkflowSha: WORKFLOW_SHA,
    })]);
    // It has no build row, no attempt and nothing to read back.
    expect(await env.DB.prepare("SELECT count(*) AS n FROM machine_builds").first("n")).toBe(0);
    expect((await call("GET", `/registry/v1/builds/${KEY_HEX}/result`, { bearer: token })).status).toBe(405);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n")).toBe(0);
  });

  it("pokes an automatic source when an image is recorded, and never a manual one", async () => {
    await seedBundle();
    const token = await session();
    const poked = () => env.DB.prepare("SELECT poked_at FROM scenario_sources WHERE scope_key = ?1").bind(SCOPE).first<number | null>("poked_at");
    await env.DB.prepare("UPDATE scenario_sources SET poked_at = NULL WHERE scope_key = ?1").bind(SCOPE).run();
    const amd64 = await pushImage(token, KEY_HEX);
    expect((await record(token, amd64.digest)).status).toBe(201);
    expect(await poked()).toBeNull();
    // The arm64 image settles no revision: only its own record can poke.
    await env.DB.prepare("UPDATE scenario_sources SET promotion = 'automatic' WHERE scope_key = ?1").bind(SCOPE).run();
    const arm64 = await pushImage(token, KEY_HEX, { architecture: "arm64", label: "arm" });
    expect((await record(token, arm64.digest, KEY_HEX, "?arch=arm64")).status).toBe(201);
    expect(await poked()).not.toBeNull();
    // A repeat records nothing and pokes nothing.
    await env.DB.prepare("UPDATE scenario_sources SET poked_at = NULL WHERE scope_key = ?1").bind(SCOPE).run();
    expect((await record(token, arm64.digest, KEY_HEX, "?arch=arm64")).status).toBe(200);
    expect(await poked()).toBeNull();
  });

  it("makes its revision ready with the amd64 image, on the first record and on a repeat", async () => {
    await seedBundle();
    const token = await session();
    const state = async () => (await db().select({ state: scenarioRevisions.state }).from(scenarioRevisions))[0]?.state;
    const arm = await pushImage(token, KEY_HEX, { architecture: "arm64" });
    expect((await record(token, arm.digest, KEY_HEX, "?arch=arm64")).status).toBe(201);
    expect(await state()).toBe("building");
    const image = await pushImage(token, KEY_HEX);
    expect((await record(token, image.digest)).status).toBe(201);
    expect(await state()).toBe("ready");

    // A result whose settle was lost is settled by the pipeline's retry.
    await db().update(scenarioRevisions).set({ state: "building" });
    expect((await record(token, image.digest)).status).toBe(200);
    expect(await state()).toBe("ready");
  });

  it("records only a manifest pushed in its own session, also by another session since", async () => {
    await seedBundle();
    const token = await session();
    const image = await pushImage(token, KEY_HEX);
    // Stored before this session was opened: some of its blobs may be gone.
    await env.DB.prepare("UPDATE registry_manifests SET created_at = 1").run();
    await refusal(await record(token, image.digest), 409, "image_unknown");
    expect(await rows()).toEqual([]);

    // Another session pushes it again: every blob was just seen, for both.
    const other = await session();
    expect((await putManifest(image.manifest, other)).status).toBe(201);
    expect((await record(token, image.digest)).status).toBe(201);
  });

  it("gives a local arm64 run of its revision its own scope's arm64 images and no other", async () => {
    await seedBundle();
    const token = await session();
    const revision = { scenarioId: "intar/lab", rev: REV, doc: { machines: [{ build_key: KEY }] } as never };
    // A builder's arm64 image of the same key is not a pipeline revision's.
    const builders = await pushImage(token, KEY_HEX, { architecture: "arm64", label: "builder" });
    await env.DB.prepare(`INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, arm64_asked, arm64_state, arm64_image_digest)
      VALUES (?1, 'intar-image-4', 'b', 'succeeded', 1, 'succeeded', ?2)`).bind(KEY, builders.digest).run();
    expect(await arm64MachineImages(env.DB, revision)).toBeNull();

    const arm = await pushImage(token, KEY_HEX, { architecture: "arm64" });
    expect((await record(token, arm.digest, KEY_HEX, "?arch=arm64")).status).toBe(201);
    expect(await arm64MachineImages(env.DB, revision)).toEqual(new Map([[KEY, arm.digest]]));
    // The rev stays a pipeline's when its source is set back to the builder.
    await db().update(scenarioSources).set({ imageProducer: "builder" });
    expect(await arm64MachineImages(env.DB, revision)).toEqual(new Map([[KEY, arm.digest]]));

    // Another scope's record, a stale format and a missing manifest are none.
    await db().update(scopeMachineImages).set({ scopeKey: "organization:acme" });
    expect(await arm64MachineImages(env.DB, revision)).toBeNull();
    await db().update(scopeMachineImages).set({ scopeKey: SCOPE, imageFormat: "intar-image-3" });
    expect(await arm64MachineImages(env.DB, revision)).toBeNull();
    await db().update(scopeMachineImages).set({ imageFormat: "intar-image-4" });
    await env.DB.prepare("DELETE FROM registry_manifests WHERE digest = ?1").bind(arm.digest).run();
    expect(await arm64MachineImages(env.DB, revision)).toBeNull();

    // A builder's revision reads its build, as before.
    await db().update(bundles).set({ imageProducer: "builder" });
    expect(await arm64MachineImages(env.DB, revision)).toEqual(new Map([[KEY, builders.digest]]));
  });

  it("answers a second image of the same key with the recorded one", async () => {
    await seedBundle();
    const first = await session();
    const second = await session();
    const image = await pushImage(first, KEY_HEX);
    const other = await pushImage(second, KEY_HEX, { label: "baked again" });
    expect((await record(first, image.digest)).status).toBe(201);
    for (const digest of [other.digest, image.digest]) {
      const again = await record(second, digest);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, image_digest: image.digest, recorded: true });
    }
    expect(await rows()).toHaveLength(1);
  });

  it("records arm64 by itself, and each image only as its own architecture", async () => {
    await seedBundle();
    const token = await session();
    const arm = await pushImage(token, KEY_HEX, { architecture: "arm64" });
    await refusal(await record(token, arm.digest), 409, "architecture_mismatch");
    await refusal(await record(token, arm.digest, KEY_HEX, "?arch=riscv"), 400, undefined);
    expect((await record(token, arm.digest, KEY_HEX, "?arch=arm64")).status).toBe(201);
    const amd = await pushImage(token, KEY_HEX);
    // The arm64 image stands, so nothing is asked of another one.
    expect(await (await record(token, amd.digest, KEY_HEX, "?arch=arm64")).json())
      .toEqual({ ok: true, image_digest: arm.digest, recorded: true });
    expect((await record(token, amd.digest, KEY_HEX, "?arch=amd64")).status).toBe(201);
    expect((await rows()).map((row) => [row.architecture, row.imageDigest])).toEqual([["amd64", amd.digest], ["arm64", arm.digest]]);
  });

  it("refuses a key of another bundle, an image of another key and one that is not stored", async () => {
    await seedBundle({ keys: [KEY, `sha256:${"c".repeat(64)}`] });
    const token = await session();
    const image = await pushImage(token, KEY_HEX);
    await refusal(await record(token, image.digest, FOREIGN_HEX), 403, "build_key_not_in_bundle");
    await refusal(await record(token, image.digest, "c".repeat(64)), 409, "build_key_mismatch");
    await refusal(await record(token, `sha256:${"9".repeat(64)}`), 409, "image_unknown");
    await refusal(await record(token, "latest"), 400, undefined);
    expect(await rows()).toEqual([]);
  });

  it("replaces a recorded image whose manifest is gone or whose format is stale", async () => {
    await seedBundle();
    const token = await session();
    const lost = await pushImage(token, KEY_HEX, { label: "lost" });
    expect((await record(token, lost.digest)).status).toBe(201);
    await env.DB.prepare("DELETE FROM registry_manifests WHERE digest = ?1").bind(lost.digest).run();
    const next = await pushImage(token, KEY_HEX, { label: "next" });
    expect((await record(token, next.digest)).status).toBe(201);

    await db().update(scopeMachineImages).set({ imageFormat: "intar-image-3" });
    const newer = await pushImage(token, KEY_HEX, { label: "newer" });
    expect((await record(token, newer.digest)).status).toBe(201);
    expect((await rows()).map((row) => [row.imageDigest, row.imageFormat])).toEqual([[newer.digest, "intar-image-4"]]);
  });

  it("counts a scope's storage over the images a kept revision names", async () => {
    const kept = `sha256:${"c".repeat(64)}`;
    await seedBundle({ keys: [KEY, kept] });
    const token = await session();
    const image = await pushImage(token, KEY_HEX);
    const size = image.blobs.reduce((sum, pushed) => sum + pushed.bytes.length, 0);
    const held = (buildKey: string, scopeKey: string, sizeBytes: number) => db().insert(scopeMachineImages).values({
      scopeKey, buildKey, architecture: "arm64", imageDigest: `sha256:${"1".repeat(64)}`, imageFormat: "intar-image-4",
      sizeBytes, githubRepositoryId: REPO, githubRepository: "intar/scenarios", sha: SHA, runId: "1", runAttempt: 1,
      runnerEnvironment: "github-hosted", jobWorkflowSha: WORKFLOW_SHA,
    });
    // Neither an image no kept revision names nor another scope's counts.
    await held(`sha256:${FOREIGN_HEX}`, SCOPE, PIPELINE_PLATFORM_LIMITS.storageBytes);
    await held(kept, "organization:acme", PIPELINE_PLATFORM_LIMITS.storageBytes);
    await held(kept, SCOPE, PIPELINE_PLATFORM_LIMITS.storageBytes - size + 1);
    await refusal(await record(token, image.digest), 409, "scope_storage_exceeded");

    await db().update(scopeMachineImages).set({ sizeBytes: PIPELINE_PLATFORM_LIMITS.storageBytes - size })
      .where(and(eq(scopeMachineImages.buildKey, kept), eq(scopeMachineImages.scopeKey, SCOPE)));
    expect((await record(token, image.digest)).status).toBe(201);
    // A second run of a recorded key needs no room at all.
    await db().update(scopeMachineImages).set({ sizeBytes: PIPELINE_PLATFORM_LIMITS.storageBytes })
      .where(and(eq(scopeMachineImages.buildKey, kept), eq(scopeMachineImages.scopeKey, SCOPE)));
    expect((await record(token, image.digest)).status).toBe(200);
  });

  it("stops with its session", async () => {
    await seedBundle();
    const token = await session();
    const image = await pushImage(token, KEY_HEX);
    await db().update(pipelineUploadSessions).set({ closedAt: Date.now() });
    expect((await record(token, image.digest)).status).toBe(401);
    expect(await rows()).toEqual([]);
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

describe("the rate limit on a pipeline's calls", () => {
  const BLOB = `/registry/v1/blobs/sha256:${"e".repeat(64)}`;
  let keys: string[];
  let answer: () => Promise<{ success: boolean }>;

  beforeEach(() => {
    keys = [];
    answer = async () => ({ success: false });
    testEnv = {
      ...testEnv,
      REGISTRY_PIPELINE_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return answer(); } },
    } as unknown as Cloudflare.Env;
  });

  it("refuses a session's blob, manifest and result calls before its token is looked up", async () => {
    // A token no session has would be answered 401 by the lookup.
    const made = "ips_made-up";
    for (const [method, path] of [
      ["HEAD", BLOB], ["PUT", BLOB], ["PUT", `/registry/v1/manifests/sha256:${"e".repeat(64)}`],
      ["POST", `/registry/v1/builds/${KEY_HEX}/result`],
    ] as const) {
      const response = await call(method, path, { bearer: made });
      expect([method, response.status, response.headers.get("retry-after")]).toEqual([method, 429, "10"]);
    }
    // Counted on the session, by a key that does not hold the token.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^session:[a-f0-9]{64}$/);
    expect(keys[0]).not.toContain(made);
    await call("HEAD", BLOB, { bearer: "ips_another" });
    expect(new Set(keys).size).toBe(2);
  });

  it("counts an open on the client's address, before its token is verified", async () => {
    const response = await call("POST", PIPELINE_SESSIONS_PATH, {
      bearer: "not-a-token", body: "{}", headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect(response.status).toBe(429);
    expect(keys).toEqual(["open:203.0.113.7"]);
  });

  it("limits neither the routes the CLI does not try again nor any other credential", async () => {
    await seedBundle();
    answer = async () => ({ success: true });
    const token = await session();
    keys = [];
    answer = async () => ({ success: false });
    // A heartbeat, a completion and a close under a session token.
    for (const path of ["/registry/v1/upload-sessions", "/registry/v1/upload-sessions/heartbeat", "/registry/v1/upload-sessions/complete"]) {
      expect((await call("POST", path, { bearer: token, body: "{}" })).status).not.toBe(429);
    }
    expect((await call("POST", PIPELINE_SESSIONS_CLOSE_PATH, { bearer: token })).status).toBe(200);
    // The publish token and a made-up agent credential on a limited path.
    expect((await call("HEAD", BLOB, { bearer: "test-publish-token" })).status).not.toBe(429);
    expect((await call("HEAD", BLOB, { bearer: "some.agent.jwt" })).status).not.toBe(429);
    expect(keys).toEqual([]);
  });

  it("admits when the limiter cannot be asked", async () => {
    await seedBundle();
    answer = async () => { throw new Error("limiter down"); };
    const token = await session();
    expect((await pushImage(token, KEY_HEX)).response.status).toBe(201);
    expect(keys.length).toBeGreaterThan(2);
  });
});

describe("an organization's own pipeline", () => {
  const ORG = "org-a";
  const ORG_SCOPE = `organization:${ORG}`;
  const OWNER = "org-owner";
  const ORG_REPO = 77;
  const LAB = "acme/broken-nginx";
  let rev: string;
  let digest: string;

  beforeEach(async () => {
    digest = await sourceCompileDigest();
    rev = `git-${ORG_REPO}-${SHA}-${digest}`;
    await createFixtureMember({ d1: env.DB, userId: OWNER, githubAccountId: "2000" });
    await db().insert(organization).values({ id: ORG, name: "Acme", slug: "acme", createdAt: new Date() });
    await db().insert(member).values({ id: "m-owner", organizationId: ORG, userId: OWNER, role: "owner", createdAt: new Date() });
    await db().insert(scenarioSources).values({
      scopeKey: ORG_SCOPE, organizationId: ORG, githubInstallationId: ORG_REPO, githubRepositoryId: ORG_REPO,
      githubRepository: "acme/labs", defaultBranch: "main", mode: "push", imageProducer: "pipeline",
      promotion: "automatic", headSha: SHA, boundByUserId: OWNER,
    });
  });

  const orgClaims = { repository_id: String(ORG_REPO) };
  const images = () => db().select().from(scopeMachineImages).orderBy(scopeMachineImages.architecture);
  const lab = () => env.DB.prepare("SELECT live_rev, scope_key, organization_id FROM scenarios WHERE id = ?1").bind(LAB)
    .first<{ live_rev: string | null; scope_key: string; organization_id: string | null }>();
  const revisionState = () => env.DB.prepare("SELECT state FROM scenario_revisions WHERE scenario_id = ?1 AND rev = ?2")
    .bind(LAB, rev).first<string>("state");

  it("publishes a lab from its own repository into its own scope: bundle, session, images, check, live", async () => {
    // The bundle its workflow uploaded, ingested for a pipeline.
    expect(await ingestSourceBundle(env, {
      organizationId: ORG, rev, gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
      imageProducer: "pipeline", pipelineCanPush: true,
    })).toBeNull();
    await db().insert(scenarioSourceCommits).values({
      id: "head", scopeKey: ORG_SCOPE, purpose: "deploy", sha: SHA, rev, via: "push", state: "building", attempt: 1,
    });
    expect(await lab()).toEqual({ live_rev: null, scope_key: ORG_SCOPE, organization_id: ORG });
    expect(await revisionState()).toBe("building");
    const keyHex = (await env.DB.prepare(
      "SELECT json_extract(doc_json, '$.machines[0].build_key') AS key FROM scenario_revisions WHERE scenario_id = ?1",
    ).bind(LAB).first<string>("key"))!.slice("sha256:".length);

    // Its pipeline opens a session with its own repository's token, and no other's.
    // The platform repository's token names another repository than the rev.
    expect((await open({ rev, claims: { repository_id: String(REPO) } })).status).toBe(400);
    const opened = await open({ rev, claims: orgClaims });
    expect(opened.status).toBe(201);
    const token = ((await opened.json()) as { token: string }).token;
    expect(await db().select({ scopeKey: pipelineUploadSessions.scopeKey, repo: pipelineUploadSessions.githubRepositoryId })
      .from(pipelineUploadSessions)).toEqual([{ scopeKey: ORG_SCOPE, repo: ORG_REPO }]);

    // It pushes and records both architectures; the amd64 image makes the revision ready.
    const record = (imageDigest: string, query: string) => call("POST", `/registry/v1/builds/${keyHex}/result${query}`, {
      bearer: token, body: JSON.stringify({ image_digest: imageDigest }),
    });
    const amd64 = await pushImage(token, keyHex);
    expect(amd64.response.status).toBe(201);
    expect((await record(amd64.digest, "")).status).toBe(201);
    expect(await revisionState()).toBe("ready");
    const arm64 = await pushImage(token, keyHex, { architecture: "arm64", label: "arm" });
    expect((await record(arm64.digest, "?arch=arm64")).status).toBe(201);
    expect((await images()).map((image) => [image.scopeKey, image.architecture, image.githubRepositoryId])).toEqual([
      [ORG_SCOPE, "amd64", ORG_REPO], [ORG_SCOPE, "arm64", ORG_REPO],
    ]);

    // Its source's job checks the lab and puts it live. The verify run is
    // a stand-in: it passes at once.
    const stored = new Map<string, unknown>();
    const storage = {
      get: async <T>(key: string) => stored.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
      delete: async (key: string) => stored.delete(key),
    } as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">;
    const started: string[] = [];
    const deps = {
      beginVerifyRun: async (input: { scenarioId: string; rev: string; restoreCheck?: boolean }) => {
        if (input.restoreCheck) throw new Error("no restore check here");
        started.push(input.scenarioId);
        await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified', verify_run_id = 'run-1' WHERE scenario_id = ?1 AND rev = ?2")
          .bind(input.scenarioId, input.rev).run();
        return { runId: "run-1" };
      },
      endVerifyRun: async () => undefined,
      moveLive: moveLiveRevision,
    };
    const drive = () => driveDeployJob({ db: env.DB, storage, scopeKey: ORG_SCOPE, digest, now: Date.now(), deps });
    await drive();
    expect(started).toEqual([LAB]);
    await drive();
    expect(await lab()).toMatchObject({ live_rev: rev });
    expect(await env.DB.prepare("SELECT state FROM scenario_source_commits WHERE id = 'head'").first("state")).toBe("live");
    // The catalog is its scope's, and nothing of it reached the platform's.
    expect(await env.DB.prepare("SELECT scope_key, source_revision FROM course_catalogs").all().then((rows) => rows.results))
      .toEqual([{ scope_key: ORG_SCOPE, source_revision: rev }]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM scenarios WHERE scope_key = 'public'").first("n")).toBe(0);
  });

  it("has an organization's limits, lower than the platform's, and its card shows what it used of them", async () => {
    await ingestSourceBundle(env, {
      organizationId: ORG, rev, gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
      imageProducer: "pipeline", pipelineCanPush: true,
    });
    const key = (await env.DB.prepare(
      "SELECT json_extract(doc_json, '$.machines[0].build_key') AS key FROM scenario_revisions WHERE scenario_id = ?1",
    ).bind(LAB).first<string>("key"))!;
    const keyHex = key.slice("sha256:".length);
    const { storageBytes, windowBytes } = PIPELINE_ORGANIZATION_LIMITS;
    expect(storageBytes).toBeLessThan(PIPELINE_PLATFORM_LIMITS.storageBytes);
    expect(windowBytes).toBeLessThan(PIPELINE_PLATFORM_LIMITS.windowBytes);

    // A day's uploads: refused at the organization's limit, which the platform's scope is far below.
    const token = ((await (await open({ rev, claims: orgClaims })).json()) as { token: string }).token;
    const image = await pushImage(token, keyHex);
    await db().update(pipelineUploadSessions).set({ bytesPut: windowBytes });
    await refusal(await open({ rev, claims: orgClaims }), 429, "pipeline_session_limit");
    await db().update(pipelineUploadSessions).set({ bytesPut: windowBytes - 1 });
    expect((await open({ rev, claims: orgClaims })).status).toBe(201);

    // Its counted images: the arm64 image of the lab's key takes all but one byte too many.
    const size = image.blobs.reduce((sum, pushed) => sum + pushed.bytes.length, 0);
    await db().insert(scopeMachineImages).values({
      scopeKey: ORG_SCOPE, buildKey: key, architecture: "arm64", imageDigest: `sha256:${"1".repeat(64)}`,
      imageFormat: "intar-image-4", sizeBytes: storageBytes - size + 1, githubRepositoryId: ORG_REPO,
      githubRepository: "acme/labs", sha: SHA, runId: "7", runAttempt: 2, runnerEnvironment: "self-hosted",
      jobWorkflowSha: WORKFLOW_SHA,
    });
    const record = () => call("POST", `/registry/v1/builds/${keyHex}/result`, {
      bearer: token, body: JSON.stringify({ image_digest: image.digest }),
    });
    await refusal(await record(), 409, "scope_storage_exceeded");
    await db().update(scopeMachineImages).set({ sizeBytes: storageBytes - size });
    expect((await record()).status).toBe(201);
    // An image no kept revision names is listed and not counted.
    await db().insert(scopeMachineImages).values({
      scopeKey: ORG_SCOPE, buildKey: `sha256:${FOREIGN_HEX}`, architecture: "amd64", imageDigest: `sha256:${"2".repeat(64)}`,
      imageFormat: "intar-image-4", sizeBytes: 5, githubRepositoryId: ORG_REPO, githubRepository: "acme/labs", sha: SHA,
      runId: "8", runAttempt: 1, runnerEnvironment: "github-hosted", jobWorkflowSha: WORKFLOW_SHA, createdAt: 1,
    });

    const { usage } = await scenarioSourceCard(scenarioSourceScope(ORG), undefined, "scope");
    expect(usage).toMatchObject({
      openSessions: { used: 2, limit: PIPELINE_OPEN_SESSIONS_PER_SCOPE },
      sessions: { used: 2, limit: PIPELINE_SESSIONS_PER_SCOPE_PER_WINDOW },
      uploadedBytes: { used: windowBytes - 1, limit: windowBytes },
      countedBytes: { used: storageBytes, limit: storageBytes },
      imageCount: 3,
    });
    expect(usage!.images.map((row) => [row.architecture, row.counted, row.runId, row.runnerEnvironment]).sort()).toEqual([
      ["amd64", false, "8", "github-hosted"], ["amd64", true, expect.any(String), "github-hosted"],
      ["arm64", true, "7", "self-hosted"],
    ]);
    // Without a reader who administers the scope, the card tells none of it.
    expect((await scenarioSourceCard(scenarioSourceScope(ORG))).usage).toBeUndefined();
    // The platform's scope has the platform's limits.
    expect((await scenarioSourceCard(scenarioSourceScope(null), undefined, "platform")).usage).toMatchObject({
      uploadedBytes: { used: 0, limit: PIPELINE_PLATFORM_LIMITS.windowBytes },
      countedBytes: { used: 0, limit: PIPELINE_PLATFORM_LIMITS.storageBytes },
      imageCount: 0,
    });
  });

  it("serves only its own scope: the platform's revision of the same build key stays without an image", async () => {
    await ingestSourceBundle(env, {
      organizationId: ORG, rev, gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
      imageProducer: "pipeline", pipelineCanPush: true,
    });
    const platformRev = `git-${REPO}-${SHA}-${digest}`;
    await ingestSourceBundle(env, {
      organizationId: null, rev: platformRev, gzip: new Uint8Array(gzipSync(JSON.stringify(bundleFixture))), stored: false,
      imageProducer: "pipeline", pipelineCanPush: true,
    });
    const keys = await env.DB.prepare(
      "SELECT scenario_id, json_extract(doc_json, '$.machines[0].build_key') AS key FROM scenario_revisions ORDER BY scenario_id",
    ).all<{ scenario_id: string; key: string }>();
    // The same lab definition has the same key in both scopes.
    expect(new Set(keys.results.map((row) => row.key)).size).toBe(1);
    const keyHex = keys.results[0]!.key.slice("sha256:".length);

    const token = ((await (await open({ rev, claims: orgClaims })).json()) as { token: string }).token;
    const image = await pushImage(token, keyHex);
    expect((await call("POST", `/registry/v1/builds/${keyHex}/result`, {
      bearer: token, body: JSON.stringify({ image_digest: image.digest }),
    })).status).toBe(201);
    const states = await env.DB.prepare("SELECT scenario_id, state FROM scenario_revisions ORDER BY scenario_id")
      .all<{ scenario_id: string; state: string }>();
    expect(states.results).toEqual([
      { scenario_id: LAB, state: "ready" }, { scenario_id: "intar/broken-nginx", state: "building" },
    ]);
  });
});
