/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, handleAgentConnect, mintRegistryToken, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens, agentHosts, courseCatalogs, member, organization, runtimeExecutions,
  scenarioRevisions, scenarioRuns, scenarios, user, vmScenarios,
} from "@/db/schema";
import { handleMaintenanceMode } from "@/maintenance";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { handleOciRequest, parseRange } from "./oci";
import { blob, machineConfig, manifestOf, type PushedBlob } from "./oci-test-fixtures";
import { KINO_CONFIG_MEDIA_TYPE } from "./push";

const ORIGIN = "https://intar.test";
const SCENARIO = "private-assigned";
let limited = false;
const testEnv = () => ({
  ...env,
  REGISTRY_TOKEN_RATE_LIMITER: { limit: async () => ({ success: !limited }) },
}) as Cloudflare.Env;

interface Stored { manifest: string; blobs: PushedBlob[] }

/** Puts an artifact into R2 and the index, as the push routes leave it. */
async function store(artifactType: string, configMediaType: string, config: unknown, layers: Array<[string, string]>): Promise<Stored> {
  const configBlob = await blob(JSON.stringify(config));
  const layerBlobs = await Promise.all(layers.map(async ([mediaType, content]) => [mediaType, await blob(content)] as [string, PushedBlob]));
  const manifest = await blob(JSON.stringify(manifestOf(artifactType, configBlob, configMediaType, layerBlobs)));
  const blobs = [configBlob, ...layerBlobs.map(([, layer]) => layer)];
  for (const entry of [...blobs, manifest]) await env.VM_IMAGE_REGISTRY_BUCKET.put(`oci/sha256/${entry.hex}`, entry.bytes);
  await env.DB.prepare("INSERT INTO registry_manifests (digest, media_type, artifact_type, size) VALUES (?1, ?2, ?3, ?4)")
    .bind(manifest.digest, "application/vnd.oci.image.manifest.v1+json", artifactType, manifest.bytes.length).run();
  for (const entry of blobs) {
    await env.DB.prepare("INSERT OR IGNORE INTO registry_manifest_blobs (manifest_digest, blob_digest) VALUES (?1, ?2)")
      .bind(manifest.digest, entry.digest).run();
  }
  return { manifest: manifest.digest, blobs };
}

const machine = (label: string) => store("application/vnd.intar.machine.v1", "application/vnd.intar.machine.config.v1+json",
  machineConfig(`sha256:${"b".repeat(64)}`, { boot: { cmdline: label } }),
  [["application/vnd.intar.kernel.v1", `kernel ${label}`], ["application/vnd.intar.disk.chunk.v1+zstd", `chunk ${label} ${"x".repeat(100)}`]]);

async function spec(label: string): Promise<PushedBlob> {
  const pushed = await blob(JSON.stringify({ spec: label }));
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`oci/sha256/${pushed.hex}`, pushed.bytes);
  return pushed;
}

async function seedHost(id: string, scope: "personal" | "platform" | "organization", role: "agent" | "builder" = "agent", userId = "runner-owner") {
  const db = drizzle(env.DB);
  await db.insert(agentHosts).values({
    id, userId, name: id, scope, role, credentialGeneration: 1,
    ...(scope === "organization" ? { organizationId: "org-a" } : {}),
  });
  await db.insert(agentBootstrapTokens).values({
    id: `${id}-c2`, hostId: id, tokenHash: await sha256Hex(c2(id)), credentialGeneration: 1, expiresAt: null,
  });
  const response = await handleAgentBootstrap(new Request(`${ORIGIN}/agent/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
    body: JSON.stringify({ hostId: id, bootstrapToken: c2(id) }),
  }), env);
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

const c2 = (id: string) => (id + "0".repeat(64)).slice(0, 64).replace(/[^a-f0-9]/g, "a");

async function desire(hostId: string, scope: string, doc: { vms?: unknown[]; cached_images?: string[] }) {
  await env.DB.prepare("INSERT OR REPLACE INTO host_desired_state (host_id, version, doc_json) VALUES (?1, 1, ?2)")
    .bind(hostId, JSON.stringify({ scope, owner_user_id: "runner-owner", schema_version: 7, host_id: hostId, version: 1,
      generated_at_unix_ms: 0, cached_images: doc.cached_images ?? [], vms: doc.vms ?? [], builds: [], source_compiles: [] })).run();
}

function desiredVm(image: string, specDigest: string, lease = Date.now() + 60_000) {
  return { vm_id: "vm", name: "webserver", run_id: "run", runtime_execution_id: "execution", owner_user_id: "runner-owner",
    generation: 1, desired_phase: "running", lease_expires_at_unix_ms: lease, image, kino: image, spec: specDigest, mode: "learn" };
}

async function seedRun() {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(vmScenarios).values({ scenarioId: SCENARIO, organizationId: "org-a", title: SCENARIO, category: "test",
    description: "", difficulty: "easy", estimatedMinutes: 10, tagsJson: [], briefingMarkdown: "", solutionMarkdown: "",
    hintsJson: [], enabled: true, enabledAt: now, createdAt: now, updatedAt: now });
  await db.insert(courseCatalogs).values({ scopeKey: "organization:org-a", organizationId: "org-a", sourceRevision: "test",
    catalogJson: { version: 2, courses: [{ courseId: "course", title: "Course", summary: "", bodyMarkdown: "", sequential: false,
      lectures: [{ lectureId: SCENARIO, scenarioId: SCENARIO, title: "Lecture", summary: "", bodyMarkdown: "", category: "test",
        tags: [], estimatedMinutes: 10 }] }] } });
  await db.insert(runtimeExecutions).values({ id: "execution", userId: "runner-owner", hostId: "personal", organizationId: "org-a",
    domainKind: "scenario", domainId: "run", generation: 1, state: "ready", leaseExpiresAt: now + 60_000 });
  await db.insert(scenarioRuns).values({ runId: "run", userId: "runner-owner", hostId: "personal", runtimeExecutionId: "execution",
    organizationId: "org-a", scenarioId: SCENARIO, scenarioName: "Private", courseScopeKey: "organization:org-a",
    courseId: "course", lectureId: SCENARIO, activeKey: "runner-owner", title: "Run", tagline: "", briefingMarkdown: "",
    objectivesJson: "[]", difficulty: "easy", estimatedMinutes: 10, tagsJson: [], hintsJson: [], solutionMarkdown: "",
    vmCount: 1, state: "running", stateRank: 2, stateJson: "{}" });
}

async function v2(path: string, init: { token?: string | null; method?: string; headers?: Record<string, string> } = {}, workerEnv = testEnv()) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const response = await handleOciRequest(new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers }), workerEnv);
  if (!response) throw new Error(`no route for ${path}`);
  return response;
}

async function exchange(authorization: string) {
  return v2("/v2/token?service=intar.dev", { headers: { authorization } });
}

async function registryToken(agentJwt: string): Promise<string> {
  const response = await exchange(`Bearer ${agentJwt}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe("/v2 pull API", () => {
  let personal: string;
  let platform: string;
  let personalJwt: string;
  let learner: Stored;
  let kino: Stored;
  let learnSpec: PushedBlob;
  let verifySpec: PushedBlob;
  const machinePath = (image: string, rest: string) => `/v2/machines/${image.slice(7)}/${rest}`;

  beforeEach(async () => {
    limited = false;
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of ["runner-owner", "other-owner"]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    await db.insert(organization).values({ id: "org-a", name: "A", slug: "a", createdAt: new Date() });
    await db.insert(member).values({ id: "membership", organizationId: "org-a", userId: "runner-owner", role: "member", createdAt: new Date() });
    personalJwt = await seedHost("personal", "personal");
    personal = await registryToken(personalJwt);
    platform = await registryToken(await seedHost("platform", "platform"));
    learner = await machine("learner");
    kino = await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "1.0.0" },
      [["application/octet-stream", "kino binary"]]);
    learnSpec = await spec("learn");
    verifySpec = await spec("verify");
    await seedRun();
    await desire("personal", "personal", { vms: [desiredVm(learner.manifest, learnSpec.digest)] });
  });

  it("answers 401 with a challenge on every route without a token", async () => {
    for (const path of ["/v2/", "/v2", machinePath(learner.manifest, "manifests/machine"), machinePath(learner.manifest, `blobs/${learner.blobs[1]!.digest}`),
      `/v2/kino/manifests/${kino.manifest}`, `/v2/specs/blobs/${learnSpec.digest}`, "/v2/_catalog"]) {
      const response = await v2(path, { token: null });
      expect(response.status, path).toBe(401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain(`Bearer realm="${ORIGIN}/v2/token",service="intar.dev"`);
      expect(challenge).not.toContain("invalid_token");
      expect(await response.json()).toEqual({ errors: [{ code: "UNAUTHORIZED", message: expect.any(String), detail: null }] });
    }
    const repository = await v2(machinePath(learner.manifest, "manifests/machine"), { token: "garbage" });
    expect(repository.headers.get("www-authenticate")).toContain(`scope="repository:machines/${learner.manifest.slice(7)}:pull",error="invalid_token"`);
  });

  it("serves an assigned machine image, its blobs and its spec", async () => {
    const manifest = await v2(machinePath(learner.manifest, `manifests/${learner.manifest}`), { token: personal });
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(manifest.headers.get("docker-content-digest")).toBe(learner.manifest);
    expect(manifest.headers.get("cache-control")).toBe("private, no-store");
    expect(`sha256:${await sha256Bytes(await manifest.arrayBuffer())}`).toBe(learner.manifest);
    expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token: personal })).status).toBe(200);
    for (const entry of learner.blobs) {
      const response = await v2(machinePath(learner.manifest, `blobs/${entry.digest}`), { token: personal });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(entry.bytes);
    }
    const head = await v2(machinePath(learner.manifest, `blobs/${learner.blobs[0]!.digest}`), { token: personal, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(learner.blobs[0]!.bytes.length));
    expect((await v2(`/v2/specs/blobs/${learnSpec.digest}`, { token: personal })).status).toBe(200);
    expect(await (await v2("/v2/", { token: personal })).json()).toEqual({});
  });

  it("refuses expired, rotated, bridge and builder tokens", async () => {
    const path = machinePath(learner.manifest, "manifests/machine");
    const expired = await mintRegistryToken(env, { scope: "personal", organizationId: null, credentialGeneration: 1,
      hostId: "personal", userId: "runner-owner", role: "agent" }, Math.floor(Date.now() / 1000) - 1);
    expect((await v2(path, { token: expired!.token })).status).toBe(401);
    expect((await v2(path, { token: personalJwt })).status).toBe(401);
    const builderJwt = await seedHost("builder", "platform", "builder");
    expect((await exchange(`Bearer ${builderJwt}`)).status).toBe(401);
    const builderRegistry = await mintRegistryToken(env, { scope: "platform", organizationId: null, credentialGeneration: 1,
      hostId: "builder", userId: "runner-owner", role: "builder" });
    expect((await v2(path, { token: builderRegistry!.token })).status).toBe(401);
    await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'personal'").run();
    expect((await v2(path, { token: personal })).status).toBe(401);
  });

  it("refuses a registry token on /agent/connect and /v2/token", async () => {
    const connect = await handleAgentConnect(new Request(`${ORIGIN}/agent/connect?hostId=personal`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${personal}` },
    }), env);
    expect(connect.status).toBe(401);
    expect((await exchange(`Bearer ${personal}`)).status).toBe(401);
  });

  it("exchanges a JWT or the host credential and never extends a lifetime", async () => {
    for (const authorization of [`Bearer ${personalJwt}`, `Basic ${btoa(`personal:${personalJwt}`)}`, `Basic ${btoa(`personal:${c2("personal")}`)}`]) {
      const response = await exchange(authorization);
      expect(response.status, authorization.slice(0, 6)).toBe(200);
      const body = await response.json() as { token: string; access_token: string; expires_in: number; issued_at: string };
      expect(body.access_token).toBe(body.token);
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.expires_in).toBeLessThanOrEqual(900);
      expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token: body.token })).status).toBe(200);
    }
    expect((await exchange(`Basic ${btoa(`platform:${personalJwt}`)}`)).status).toBe(401);
    expect((await exchange(`Basic ${btoa(`personal:${"f".repeat(64)}`)}`)).status).toBe(401);

    const agentExp = JSON.parse(atob(personalJwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).exp as number;
    const minted = await mintRegistryToken(env, { scope: "personal", organizationId: null, credentialGeneration: 1,
      hostId: "personal", userId: "runner-owner", role: "agent" }, agentExp - 600);
    expect(minted!.expiresAt).toBe(agentExp - 600);
    expect(await mintRegistryToken({ ...env, AGENT_JWT_AUDIENCE: "intar-registry" } as unknown as Cloudflare.Env,
      { scope: "personal", organizationId: null, credentialGeneration: 1, hostId: "personal", userId: "runner-owner", role: "agent" })).toBeNull();
  });

  it("keeps one host's images, blobs and specs from another", async () => {
    const otherHost = await registryToken(await seedHost("other", "personal", "agent", "other-owner"));
    for (const token of [otherHost, platform]) {
      expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token })).status).toBe(404);
      expect((await v2(machinePath(learner.manifest, `blobs/${learner.blobs[1]!.digest}`), { token })).status).toBe(404);
      expect((await v2(`/v2/specs/blobs/${learnSpec.digest}`, { token })).status).toBe(404);
    }
  });

  it("grants a platform host its desired and cached images and live revisions only", async () => {
    const cached = await machine("cached");
    const live = await machine("live");
    const unlisted = await machine("unlisted");
    await desire("platform", "platform", { cached_images: [cached.manifest] });
    const db = drizzle(env.DB);
    await db.insert(scenarios).values({ id: "intar/web", namespace: "intar", slug: "web", scopeKey: "public", enabled: true, play: false, liveRev: "r1" });
    const revision = { machines: [{ name: "webserver", image_digest: live.manifest }] };
    await db.insert(scenarioRevisions).values({ scenarioId: "intar/web", rev: "r1", guestContract: 3, docJson: revision as never, state: "verified" });
    expect((await v2(machinePath(cached.manifest, "manifests/machine"), { token: platform })).status).toBe(200);
    expect((await v2(machinePath(live.manifest, "manifests/machine"), { token: platform })).status).toBe(200);
    expect((await v2(machinePath(unlisted.manifest, "manifests/machine"), { token: platform })).status).toBe(404);
    await env.DB.prepare("UPDATE scenarios SET enabled = 0").run();
    expect((await v2(machinePath(live.manifest, "manifests/machine"), { token: platform })).status).toBe(404);
    // A personal host's cached images need a preparation behind them.
    await desire("personal", "personal", { cached_images: [cached.manifest] });
    expect((await v2(machinePath(cached.manifest, "manifests/machine"), { token: personal })).status).toBe(404);
  });

  it("denies a personal host once its run's lease expires", async () => {
    await desire("personal", "personal", { vms: [desiredVm(learner.manifest, learnSpec.digest, Date.now() - 1)] });
    expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token: personal })).status).toBe(404);
    await desire("personal", "personal", { vms: [desiredVm(learner.manifest, learnSpec.digest)] });
    await env.DB.prepare("UPDATE runtime_executions SET lease_expires_at = 1").run();
    expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token: personal })).status).toBe(404);
    expect((await v2(`/v2/specs/blobs/${learnSpec.digest}`, { token: personal })).status).toBe(404);
  });

  it.each([
    ["the owner leaves the organization", "DELETE FROM member"],
    ["the scenario is disabled", "UPDATE vm_scenarios SET enabled = 0"],
  ])("denies mid-pull when %s while desired state still lists the image", async (_reason, change) => {
    let changed = false;
    const racing = { ...testEnv(), VM_IMAGE_REGISTRY_BUCKET: {
      head: (key: string) => env.VM_IMAGE_REGISTRY_BUCKET.head(key),
      get: async (key: string, options?: R2GetOptions) => {
        const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key, options);
        if (!changed) {
          changed = true;
          await env.DB.prepare(change).run();
        }
        return object;
      },
    } as unknown as R2Bucket } as Cloudflare.Env;
    expect((await v2(machinePath(learner.manifest, `blobs/${learner.blobs[1]!.digest}`), { token: personal }, racing)).status).toBe(404);
    expect(changed).toBe(true);
    expect((await v2(machinePath(learner.manifest, "manifests/machine"), { token: personal })).status).toBe(404);
  });

  it("serves only blobs indexed under the repository's image", async () => {
    const other = await machine("other");
    expect((await v2(machinePath(learner.manifest, `blobs/${other.blobs[1]!.digest}`), { token: personal })).status).toBe(404);
    expect((await v2(machinePath(learner.manifest, `blobs/${learnSpec.digest}`), { token: personal })).status).toBe(404);
    expect((await v2(machinePath(learner.manifest, `manifests/${other.manifest}`), { token: personal })).status).toBe(404);
  });

  it("keeps verify specs from a learner host", async () => {
    expect((await v2(`/v2/specs/blobs/${verifySpec.digest}`, { token: personal })).status).toBe(404);
  });

  it("serves Kino artifacts only through /v2/kino and nothing else there", async () => {
    expect((await v2(`/v2/kino/manifests/${kino.manifest}`, { token: personal })).status).toBe(200);
    expect((await v2(`/v2/kino/blobs/${kino.blobs[1]!.digest}`, { token: platform })).status).toBe(200);
    expect((await v2(`/v2/kino/manifests/${learner.manifest}`, { token: personal })).status).toBe(404);
    expect((await v2(`/v2/kino/blobs/${learner.blobs[1]!.digest}`, { token: personal })).status).toBe(404);
    expect((await v2(`/v2/kino/blobs/${learnSpec.digest}`, { token: personal })).status).toBe(404);
    expect((await v2(`/v2/specs/blobs/${learner.manifest}`, { token: personal })).status).toBe(404);
    expect((await v2("/v2/kino/manifests/current", { token: personal })).status).toBe(404);
    const pinned = { ...testEnv(), KINO_PINS_JSON: JSON.stringify({ 3: { current: kino.manifest, previous: null } }) } as Cloudflare.Env;
    const current = await v2("/v2/kino/manifests/current", { token: personal }, pinned);
    expect(current.status).toBe(200);
    expect(current.headers.get("docker-content-digest")).toBe(kino.manifest);
  });

  it("answers bad references with 404 or 400", async () => {
    const response = await v2(machinePath(learner.manifest, "manifests/.INVALID_MANIFEST_NAME"), { token: personal });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ errors: [{ code: "MANIFEST_UNKNOWN" }] });
    const digest = await v2(machinePath(learner.manifest, "manifests/sha256:totallywrong"), { token: personal });
    expect(digest.status).toBe(400);
    expect(await digest.json()).toMatchObject({ errors: [{ code: "DIGEST_INVALID" }] });
    expect((await v2("/v2/machines/NOT-HEX/manifests/machine", { token: personal })).status).toBe(400);
    expect((await v2("/v2/_catalog", { token: personal })).status).toBe(404);
    expect((await v2(`/v2/machines/${learner.manifest.slice(7)}/tags/list`, { token: personal })).status).toBe(404);
  });

  it("serves byte ranges", async () => {
    const chunk = learner.blobs[2]!;
    const path = machinePath(learner.manifest, `blobs/${chunk.digest}`);
    const partial = await v2(path, { token: personal, headers: { range: "bytes=10-" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 10-${chunk.bytes.length - 1}/${chunk.bytes.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(chunk.bytes.slice(10));
    const suffix = await v2(path, { token: personal, headers: { range: "bytes=-5" } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(chunk.bytes.slice(-5));
    const multi = await v2(path, { token: personal, headers: { range: "bytes=0-1,4-5" } });
    expect(multi.status).toBe(200);
    expect((await multi.arrayBuffer()).byteLength).toBe(chunk.bytes.length);
    const beyond = await v2(path, { token: personal, headers: { range: `bytes=${chunk.bytes.length}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${chunk.bytes.length}`);
    expect(parseRange("bytes=2-1", 10)).toBeNull();
    expect(parseRange("bytes=5-100", 10)).toEqual({ offset: 5, length: 5 });
  });

  it("refuses writes, limits token requests and answers maintenance as JSON", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await v2(machinePath(learner.manifest, "manifests/machine"), { token: personal, method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
    expect((await v2("/v2/token", { method: "POST" })).status).toBe(404);
    limited = true;
    const limitedResponse = await exchange(`Bearer ${personalJwt}`);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("60");
    expect(await limitedResponse.json()).toMatchObject({ errors: [{ code: "TOOMANYREQUESTS" }] });
    const fenced = await handleMaintenanceMode(new Request(`${ORIGIN}/v2/token`), { ...env, CONTROL_PLANE_MAINTENANCE: "on" } as unknown as Cloudflare.Env);
    expect(fenced?.status).toBe(503);
    expect(fenced?.headers.get("content-type")).toContain("application/json");
    expect(fenced?.headers.get("retry-after")).toBe("60");
  });
});

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
