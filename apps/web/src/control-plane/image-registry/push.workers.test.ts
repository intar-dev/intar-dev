/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import { agentBootstrapTokens, agentHosts, machineBuilds, user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { handleImageRegistryRequest } from "./router";
import { KINO_CONFIG_MEDIA_TYPE, MAX_BLOB_BYTES, OCI_MANIFEST_MEDIA_TYPE, readKinoPin } from "./push";
import { blob, machineConfig, manifestOf, type PushedBlob } from "./oci-test-fixtures";

const ORIGIN = "https://intar.test/registry/v1";
const PUBLISH = "test-publish-token";
const encoder = new TextEncoder();

const BUILD_KEY_HEX = "b".repeat(64);
const BUILD_KEY = `sha256:${BUILD_KEY_HEX}`;
let token: string;

async function seedBuilder(id: string): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: `${id}-owner`, name: id, email: `${id}@example.test` }).onConflictDoNothing();
  await db.insert(agentHosts).values({
    id, userId: `${id}-owner`, name: id, role: "builder", scope: "platform", credentialGeneration: 1, disabled: false,
  });
  await db.insert(agentBootstrapTokens).values({
    id: `${id}-c2`, hostId: id, tokenHash: await sha256Hex(`${id}-secret`), credentialGeneration: 1, expiresAt: null,
  });
  const response = await handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
    method: "POST", headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
    body: JSON.stringify({ hostId: id, bootstrapToken: `${id}-secret` }),
  }), env);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function call(method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; headers?: Record<string, string>; bearer?: string } = {}) {
  const body = typeof init.body === "string" ? encoder.encode(init.body) : init.body;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.bearer ?? token}`);
  if (body !== undefined && !headers.has("content-length")) headers.set("content-length", String(body.length));
  const response = await handleImageRegistryRequest(new Request(`${ORIGIN}${path}`, {
    method, headers, ...(body === undefined ? {} : { body }),
  }), env);
  if (!response) throw new Error(`no route for ${method} ${path}`);
  return response;
}

const putBlob = (pushed: PushedBlob, bearer?: string) =>
  call("PUT", `/blobs/${pushed.digest}`, { body: pushed.bytes, headers: { "content-type": "application/octet-stream" }, ...(bearer ? { bearer } : {}) });
const putManifest = async (manifest: unknown, bearer?: string) => {
  const pushed = await blob(JSON.stringify(manifest));
  const response = await call("PUT", `/manifests/${pushed.digest}`, {
    body: pushed.bytes, headers: { "content-type": OCI_MANIFEST_MEDIA_TYPE }, ...(bearer ? { bearer } : {}),
  });
  return { response, digest: pushed.digest };
};
const postResult = (digest: string, attempt: number, bearer?: string, arch = "") =>
  call("POST", `/builds/${BUILD_KEY_HEX}/result?attempt=${attempt}${arch}`, {
    body: JSON.stringify({ image_digest: digest }), headers: { "content-type": "application/json" }, ...(bearer ? { bearer } : {}),
  });

async function machineImage(buildKey = BUILD_KEY, configOverrides: Record<string, unknown> = {}) {
  const config = await blob(JSON.stringify(machineConfig(buildKey, configOverrides)));
  const kernel = await blob("kernel bytes");
  const chunk = await blob("chunk bytes");
  return {
    blobs: [config, kernel, chunk],
    manifest: manifestOf("application/vnd.intar.machine.v1", config, "application/vnd.intar.machine.config.v1+json", [
      ["application/vnd.intar.kernel.v1", kernel],
      ["application/vnd.intar.disk.chunk.v1+zstd", chunk],
      ["application/vnd.intar.disk.chunk.v1+zstd", chunk],
    ]),
  };
}

async function pushBlobs(blobs: PushedBlob[], bearer?: string) {
  for (const pushed of blobs) expect((await putBlob(pushed, bearer)).status).toBe(201);
}

describe("registry push routes", () => {
  beforeEach(async () => {
    await resetD1Database();
    token = await seedBuilder("builder-a");
    await drizzle(env.DB).insert(machineBuilds).values({
      buildKey: BUILD_KEY, imageFormat: "intar-image-4", bundleRev: "rev", state: "building", attempt: 2, hostId: "builder-a",
    });
  });

  it("replays the builder's push sequence", async () => {
    const opened = await call("POST", "/upload-sessions", { body: JSON.stringify({ intent: "image_build" }), headers: { "content-type": "application/json" } });
    expect(opened.status).toBeLessThan(300);
    const session = ((await opened.json()) as { session_id: string }).session_id;
    const headers = { "x-intar-registry-session": session };
    const image = await machineImage();
    for (const pushed of image.blobs) {
      expect((await call("HEAD", `/blobs/${pushed.digest}`, { headers })).status).toBe(404);
      const put = await call("PUT", `/blobs/${pushed.digest}`, { body: pushed.bytes, headers: { ...headers, "content-type": "application/octet-stream" } });
      expect(put.status, await put.clone().text()).toBe(201);
      expect((await call("HEAD", `/blobs/${pushed.digest}`, { headers })).status).toBe(200);
    }
    const manifest = await blob(JSON.stringify(image.manifest));
    const put = await call("PUT", `/manifests/${manifest.digest}`, { body: manifest.bytes, headers: { ...headers, "content-type": OCI_MANIFEST_MEDIA_TYPE } });
    expect(put.status, await put.clone().text()).toBe(201);
    const result = await call("POST", `/builds/${BUILD_KEY_HEX}/result?attempt=2`, {
      body: JSON.stringify({ image_digest: manifest.digest }), headers: { ...headers, "content-type": "application/json" },
    });
    expect(result.status, await result.clone().text()).toBe(201);
    expect((await postResult(manifest.digest, 2)).status).toBe(200);
    expect((await call("POST", "/upload-sessions/complete", { body: JSON.stringify({ outcome: "published" }), headers: { ...headers, "content-type": "application/json" } })).status).toBeLessThan(300);

    const row = await env.DB.prepare("SELECT image_digest, state FROM machine_builds").first();
    expect(row).toEqual({ image_digest: manifest.digest, state: "building" });
    const index = await env.DB.prepare("SELECT artifact_type, size FROM registry_manifests WHERE digest = ?1").bind(manifest.digest).first();
    expect(index).toEqual({ artifact_type: "application/vnd.intar.machine.v1", size: manifest.bytes.length });
    const indexed = await env.DB.prepare("SELECT blob_digest FROM registry_manifest_blobs ORDER BY blob_digest").all();
    expect(indexed.results.map((entry) => entry.blob_digest)).toEqual(image.blobs.map((entry) => entry.digest).sort());
    expect(await env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers WHERE outcome = 'pending'").first("n")).toBe(0);
  });

  it("refuses a blob that does not hash to its digest and stores nothing", async () => {
    const claimed = await blob("claimed");
    const response = await call("PUT", `/blobs/${claimed.digest}`, { body: "something else" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "digest_mismatch" });
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`oci/sha256/${claimed.hex}`)).toBeNull();
  });

  it("has room for a Talos initramfs within a Worker body", () => {
    expect(MAX_BLOB_BYTES).toBeGreaterThan(92 * 1000 * 1000);
    expect(MAX_BLOB_BYTES).toBeLessThan(100 * 1000 * 1000);
  });

  it("refuses an oversized, unsized or malformed blob", async () => {
    const pushed = await blob("x");
    expect((await call("PUT", `/blobs/${pushed.digest}`, { body: pushed.bytes, headers: { "content-length": String(MAX_BLOB_BYTES + 1) } })).status).toBe(413);
    expect((await call("PUT", `/blobs/${pushed.digest}`, { body: pushed.bytes, headers: { "content-length": "nope" } })).status).toBe(411);
    expect((await call("PUT", `/blobs/sha256:${"A".repeat(64)}`, { body: pushed.bytes })).status).toBe(400);
    expect((await call("PUT", `/blobs/${pushed.hex}`, { body: pushed.bytes })).status).toBe(400);
    expect((await call("PUT", `/blobs/${pushed.digest}`, { body: pushed.bytes, bearer: "wrong" })).status).toBe(401);
  });

  it("refuses a manifest whose blob is missing or of another size", async () => {
    const image = await machineImage();
    await pushBlobs(image.blobs.slice(0, 2));
    expect((await putManifest(image.manifest)).response.status).toBe(409);
    await pushBlobs(image.blobs.slice(2));
    const wrongSize = structuredClone(image.manifest);
    wrongSize.layers[0]!.size += 1;
    expect((await putManifest(wrongSize)).response.status).toBe(409);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM registry_manifests").first("n")).toBe(0);
    expect((await putManifest(image.manifest)).response.status).toBe(201);
  });

  it("refuses an unknown field, media type or guest contract", async () => {
    const image = await machineImage();
    await pushBlobs(image.blobs);
    expect((await putManifest({ ...image.manifest, annotations: {} })).response.status).toBe(400);
    const notText = await blob(new Uint8Array([0xff]));
    const notJson = await call("PUT", `/manifests/${notText.digest}`, {
      body: notText.bytes, headers: { "content-type": OCI_MANIFEST_MEDIA_TYPE },
    });
    expect(notJson.status).toBe(400);
    const layer = structuredClone(image.manifest);
    layer.layers[0]!.mediaType = "application/vnd.oci.image.layer.v1.tar";
    expect((await putManifest(layer)).response.status).toBe(400);
    const old = await machineImage(BUILD_KEY, { guest_contract: 2 });
    await pushBlobs(old.blobs);
    const refused = await putManifest(old.manifest);
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toMatchObject({ code: "guest_contract" });
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`oci/sha256/${refused.digest.slice(7)}`)).toBeNull();
  });

  it("fences the result on host, attempt, build key and one image", async () => {
    const image = await machineImage();
    await pushBlobs(image.blobs);
    const { digest } = await putManifest(image.manifest);
    expect((await postResult(digest, 1)).status).toBe(409);
    const other = await seedBuilder("builder-b");
    expect((await postResult(digest, 2, other)).status).toBe(409);
    expect((await postResult(digest, 2, PUBLISH)).status).toBe(403);

    const foreign = await machineImage(`sha256:${"c".repeat(64)}`);
    await pushBlobs(foreign.blobs);
    const foreignDigest = (await putManifest(foreign.manifest)).digest;
    expect(await (await postResult(foreignDigest, 2)).json()).toMatchObject({ code: "build_key_mismatch" });
    expect((await postResult(`sha256:${"d".repeat(64)}`, 2)).status).toBe(409);

    expect((await postResult(digest, 2)).status).toBe(201);
    const second = await machineImage(BUILD_KEY, { boot: { cmdline: "console=ttyS0" } });
    await pushBlobs(second.blobs);
    const secondDigest = (await putManifest(second.manifest)).digest;
    const refused = await postResult(secondDigest, 2);
    expect(refused.status).toBe(409);
    // The refusal tells the attempt's own builder which image it recorded.
    expect(await refused.json()).toMatchObject({ code: "build_result_recorded", image_digest: digest });
    expect(await env.DB.prepare("SELECT image_digest FROM machine_builds").first("image_digest")).toBe(digest);
  });

  it("answers what an attempt has recorded to its own builder only", async () => {
    const read = (attempt: number, bearer?: string) =>
      call("GET", `/builds/${BUILD_KEY_HEX}/result?attempt=${attempt}`, bearer ? { bearer } : {});
    expect(await (await read(2)).json()).toEqual({ image_digest: null, arm64_image_digest: null });
    const image = await machineImage();
    await pushBlobs(image.blobs);
    const { digest } = await putManifest(image.manifest);
    expect((await postResult(digest, 2)).status).toBe(201);
    const writers = () => env.DB.prepare("SELECT count(*) AS n FROM image_registry_operation_writers").first("n");
    const before = await writers();

    const answer = await read(2);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ image_digest: digest, arm64_image_digest: null });
    // Another attempt, another builder and another kind of caller learn nothing.
    for (const refused of [await read(1), await read(2, await seedBuilder("builder-b"))]) {
      expect(refused.status).toBe(409);
      expect(await refused.json()).not.toHaveProperty("image_digest");
    }
    expect((await read(2, PUBLISH)).status).toBe(403);
    expect((await read(2, "wrong")).status).toBe(401);
    expect((await call("GET", `/builds/${"c".repeat(64)}/result?attempt=2`)).status).toBe(404);
    expect((await call("PUT", `/builds/${BUILD_KEY_HEX}/result?attempt=2`)).status).toBe(405);
    // A read registers no writer.
    expect(await writers()).toBe(before);
  });

  it("records the arm64 image of a job after its amd64 one, each only as its own architecture", async () => {
    const code = async (response: Response) => [response.status, ((await response.json()) as { code?: string }).code];
    const push = async (overrides: Record<string, unknown>) => {
      const image = await machineImage(BUILD_KEY, overrides);
      await pushBlobs(image.blobs);
      return putManifest(image.manifest);
    };
    // An image that names no architecture is not stored.
    const unnamed = await push({ architecture: undefined });
    expect(await code(unnamed.response)).toEqual([409, "architecture"]);

    const amd64 = (await push({})).digest;
    const arm64 = (await push({ architecture: "arm64" })).digest;
    expect(await code(await postResult(arm64, 2))).toEqual([409, "architecture_mismatch"]);
    expect((await postResult(arm64, 2, undefined, "&arch=riscv64")).status).toBe(400);

    // Not asked of this attempt, then asked but before the amd64 image.
    expect((await postResult(amd64, 2)).status).toBe(201);
    expect(await code(await postResult(arm64, 2, undefined, "&arch=arm64"))).toEqual([409, "arm64_not_expected"]);
    await env.DB.prepare("UPDATE machine_builds SET arm64_asked = 1, arm64_state = 'building', image_digest = NULL").run();
    expect(await code(await postResult(arm64, 2, undefined, "&arch=arm64"))).toEqual([409, "arm64_not_expected"]);
    expect((await postResult(amd64, 2)).status).toBe(201);

    expect(await code(await postResult(amd64, 2, undefined, "&arch=arm64"))).toEqual([409, "architecture_mismatch"]);
    expect((await postResult(arm64, 2, undefined, "&arch=arm64")).status).toBe(201);
    expect((await postResult(arm64, 2, undefined, "&arch=arm64")).status).toBe(200);
    expect(await env.DB.prepare("SELECT image_digest, arm64_image_digest, arm64_state, state FROM machine_builds").first())
      .toEqual({ image_digest: amd64, arm64_image_digest: arm64, arm64_state: "succeeded", state: "building" });
  });

  it("takes Kino artifacts only with the publish token and reads the pin", async () => {
    const config = await blob(JSON.stringify({ guest_contract: 3, version: "1.0.0" }));
    const binary = await blob("kino binary");
    const manifest = manifestOf("application/vnd.intar.kino.v1", config, KINO_CONFIG_MEDIA_TYPE, [["application/octet-stream", binary]]);
    await pushBlobs([config, binary], PUBLISH);
    expect((await putManifest(manifest)).response.status).toBe(403);
    const { response, digest } = await putManifest(manifest, PUBLISH);
    expect(response.status).toBe(201);

    const image = await machineImage();
    await pushBlobs(image.blobs);
    expect((await putManifest(image.manifest, PUBLISH)).response.status).toBe(403);
    const machineDigest = (await putManifest(image.manifest)).digest;

    const pins = (value: unknown) => ({ ...env, KINO_PINS_JSON: JSON.stringify(value) });
    expect(await readKinoPin(pins({ 3: { current: digest } }), 3)).toEqual({ current: digest, previous: null });
    expect(await readKinoPin(pins({ 3: { current: digest } }), 2)).toBeNull();
    expect(await readKinoPin(pins({ 2: { current: digest } }), 2)).toBeNull();
    expect(await readKinoPin(pins({ 3: { current: machineDigest } }), 3)).toBeNull();
    expect(await readKinoPin(pins({ 3: { current: digest, previous: "sha256:nope" } }), 3)).toBeNull();
    expect(await readKinoPin({ ...env, KINO_PINS_JSON: "not json" }, 3)).toBeNull();

    // The arm64 pair is nested in the contract's entry, and each pair holds only its own architecture.
    const armConfig = await blob(JSON.stringify({ guest_contract: 3, version: "1.0.0", architecture: "arm64" }));
    await pushBlobs([armConfig], PUBLISH);
    const arm = (await putManifest(manifestOf("application/vnd.intar.kino.v1", armConfig, KINO_CONFIG_MEDIA_TYPE,
      [["application/octet-stream", binary]]), PUBLISH)).digest;
    const both = pins({ 3: { current: digest, arm64: { current: arm } } });
    expect(await readKinoPin(both, 3)).toEqual({ current: digest, previous: null });
    expect(await readKinoPin(both, 3, "arm64")).toEqual({ current: arm, previous: null });
    expect(await readKinoPin(pins({ 3: { current: digest } }), 3, "arm64")).toBeNull();
    expect(await readKinoPin(pins({ 3: { current: digest, arm64: { current: digest } } }), 3, "arm64")).toBeNull();
    expect(await readKinoPin(pins({ 3: { current: arm } }), 3)).toBeNull();
  });
});
