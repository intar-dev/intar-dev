import {
  DISK_CHUNK_MEDIA_TYPE,
  GUEST_CONTRACT,
  IMAGE_FORMAT,
  INITRD_MEDIA_TYPE,
  KERNEL_MEDIA_TYPE,
  KINO_ARTIFACT_TYPE,
  MACHINE_ARTIFACT_TYPE,
  MACHINE_CONFIG_MEDIA_TYPE,
} from "@/generated/constants";
import validateManifest from "@/generated/contracts/oci-manifest-v1.validate";
import validateMachineConfig from "@/generated/contracts/oci-machine-config-v1.validate";
import validateKinoConfig from "@/generated/contracts/oci-kino-config-v1.validate";
import { readRegistryAuth } from "@/lib/image-registry-admission";
import { chargePipelineSession, refundPipelineSession } from "@/lib/pipeline-upload-sessions";
import { isRecord, jsonResponse, sha256Hex } from "./shared";

/**
 * The push side of the OCI registry: blobs and manifests under one
 * content-addressed prefix, `oci/sha256/<hex>`, and the result of a machine
 * build. Builders push machine images; the publish token pushes Kino
 * artifacts. A pipeline (#441) may ask for and store blobs within its
 * session's byte budget; a manifest and a result are not its to push yet.
 * The router admits every write as a registry writer.
 */

export const OCI_PREFIX = "oci/sha256/";
export const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const KINO_CONFIG_MEDIA_TYPE = "application/vnd.intar.kino.config.v1+json";
const KINO_BINARY_MEDIA_TYPE = "application/octet-stream";
/** A kernel is about 11 MB and a chunk at most 8 MiB; a Worker body is capped at 100 MB. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 4096;
/** Two binds per row, under D1's 100 per statement. */
const INDEX_ROWS_PER_STATEMENT = 49;
const HEAD_BATCH = 50;
const MAX_ATTEMPT = 0xffff_ffff;

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
export const HEX_RE = /^[a-f0-9]{64}$/;

const MACHINE_LAYER_MEDIA_TYPES = new Set([
  KERNEL_MEDIA_TYPE,
  INITRD_MEDIA_TYPE,
  DISK_CHUNK_MEDIA_TYPE,
]);

export function ociObjectKey(digest: string): string {
  return OCI_PREFIX + digest.slice("sha256:".length);
}

/** A build's id on the push routes is its build key's hex. */
export function machineBuildKey(buildId: string): string | null {
  return HEX_RE.test(buildId) ? `sha256:${buildId}` : null;
}

export async function handleBlobHead(
  request: Request,
  env: Cloudflare.Env,
  hex: string,
): Promise<Response> {
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(OCI_PREFIX + hex);
  return new Response(null, {
    status: object ? 200 : 404,
    headers: object ? { "docker-content-digest": `sha256:${hex}` } : {},
  });
}

/**
 * Stores one blob. R2 checks the SHA-256 before the object becomes visible,
 * and the body is hashed here too, so a mismatch is told apart from a
 * storage failure.
 */
export async function handleBlobPut(
  request: Request,
  env: Cloudflare.Env,
  hex: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed("HEAD, PUT");
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const length = declaredLength(request, MAX_BLOB_BYTES);
  if (length instanceof Response) return length;

  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  const key = OCI_PREFIX + hex;
  if (await bucket.head(key)) {
    await request.body?.cancel();
    return stored(hex);
  }
  // A pipeline pays for what it stores, and only for that: a blob that is
  // already there costs nothing, and one that fails gives its bytes back.
  const payer = auth.owner.kind === "pipeline" ? auth.owner.id : null;
  if (payer && !(await chargePipelineSession(env, payer, length))) {
    await request.body?.cancel();
    return jsonResponse(
      { error: "this upload session has stored all the bytes it may", code: "pipeline_session_bytes" },
      413,
    );
  }
  // The DOM typing of `crypto` hides the Workers DigestStream.
  const hasher = new (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream("SHA-256");
  const sized = new FixedLengthStream(length);
  const copied = copyAndHash(request.body, hasher, sized.writable);
  try {
    await bucket.put(key, sized.readable, { sha256: hex });
  } catch (error) {
    if (payer) await refundPipelineSession(env, payer, length).catch(() => undefined);
    const actual = await copied;
    if (actual !== null && actual !== hex) {
      return jsonResponse({ error: "the blob does not hash to its digest", code: "digest_mismatch" }, 409);
    }
    throw error;
  }
  await copied;
  return stored(hex);
}

/** Copies `body` into `out`, hashing it on the way; the hex digest, or null on a failure. */
async function copyAndHash(
  body: ReadableStream<Uint8Array> | null,
  hasher: DigestStream,
  out: WritableStream<Uint8Array>,
): Promise<string | null> {
  const hash = hasher.getWriter();
  const writer = out.getWriter();
  try {
    if (body) {
      const reader = body.getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        await hash.write(part.value);
        await writer.write(part.value);
      }
    }
    await hash.close();
    await writer.close();
    return hexOf(await hasher.digest);
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    return null;
  }
}

/**
 * Stores one manifest after checking it as the agent will read it: schema,
 * media types, every blob present with its stated size, and a config of the
 * current guest contract. The D1 index is written last, so a failure leaves
 * nothing a reader can reach.
 */
export async function handleManifestPut(
  request: Request,
  env: Cloudflare.Env,
  hex: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed("PUT");
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType !== OCI_MANIFEST_MEDIA_TYPE) {
    return jsonResponse({ error: `the manifest must be ${OCI_MANIFEST_MEDIA_TYPE}` }, 415);
  }
  const length = declaredLength(request, MAX_MANIFEST_BYTES);
  if (length instanceof Response) return length;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength !== length) return invalid("the manifest is not its declared length");
  if ((await sha256Hex(bytes)) !== hex) {
    return jsonResponse({ error: "the manifest does not hash to its digest", code: "digest_mismatch" }, 409);
  }
  const manifest = parseJson(bytes);
  if (!validateManifest(manifest)) return invalid("the manifest is not an OCI manifest this registry stores");
  if (manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE) return invalid("unsupported manifest media type");

  const machine = manifest.artifactType === MACHINE_ARTIFACT_TYPE;
  if (!machine && manifest.artifactType !== KINO_ARTIFACT_TYPE) {
    return invalid("unsupported artifact type");
  }
  // A pipeline is neither: it pushes no manifest yet.
  if (auth.owner.kind !== (machine ? "builder" : "publish_token")) {
    return jsonResponse({ error: `${machine ? "a builder" : "the publish token"} pushes this artifact` }, 403);
  }
  const mediaTypesAllowed = machine
    ? manifest.config.mediaType === MACHINE_CONFIG_MEDIA_TYPE &&
      manifest.layers.every((layer) => MACHINE_LAYER_MEDIA_TYPES.has(layer.mediaType))
    : manifest.config.mediaType === KINO_CONFIG_MEDIA_TYPE &&
      manifest.layers.length === 1 &&
      manifest.layers[0]!.mediaType === KINO_BINARY_MEDIA_TYPE;
  if (!mediaTypesAllowed) return invalid("unsupported config or layer media type");
  if (manifest.config.size > MAX_MANIFEST_BYTES) return invalid("the config is over the size limit");

  const sizes = new Map<string, number>();
  for (const descriptor of [manifest.config, ...manifest.layers]) {
    const known = sizes.get(descriptor.digest);
    if (known !== undefined && known !== descriptor.size) {
      return invalid("one digest is named with two sizes");
    }
    sizes.set(descriptor.digest, descriptor.size);
  }
  const blobs = [...sizes.keys()];
  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  for (let start = 0; start < blobs.length; start += HEAD_BATCH) {
    const batch = blobs.slice(start, start + HEAD_BATCH);
    const objects = await Promise.all(batch.map((digest) => bucket.head(ociObjectKey(digest))));
    const wrong = batch.findIndex((digest, index) => objects[index]?.size !== sizes.get(digest));
    if (wrong >= 0) {
      return jsonResponse({
        error: `blob ${batch[wrong]} is not stored with the size the manifest names`,
        code: "blob_unknown",
      }, 409);
    }
  }

  const config = await readJsonObject(env, manifest.config.digest);
  if (machine ? !validateMachineConfig(config) : !validateKinoConfig(config)) {
    return invalid("the config is not one this registry stores");
  }
  const { guest_contract: guestContract } = config as { guest_contract: number };
  if (guestContract !== GUEST_CONTRACT) {
    return jsonResponse({ error: `guest contract ${guestContract} is not ${GUEST_CONTRACT}`, code: "guest_contract" }, 409);
  }
  if (machine && (config as { image_format: string }).image_format !== IMAGE_FORMAT) {
    return jsonResponse({ error: `the image format is not ${IMAGE_FORMAT}`, code: "image_format" }, 409);
  }
  // Every image of this format says which machines it boots on.
  if (machine && (config as { architecture?: string }).architecture === undefined) {
    return jsonResponse({ error: "the image config names no architecture", code: "architecture" }, 409);
  }

  const digest = `sha256:${hex}`;
  await bucket.put(OCI_PREFIX + hex, bytes, {
    sha256: hex,
    httpMetadata: { contentType: OCI_MANIFEST_MEDIA_TYPE },
  });
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO registry_manifests (digest, media_type, artifact_type, size, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(digest, manifest.mediaType, manifest.artifactType, bytes.byteLength, Date.now()),
  ];
  for (let start = 0; start < blobs.length; start += INDEX_ROWS_PER_STATEMENT) {
    const rows = blobs.slice(start, start + INDEX_ROWS_PER_STATEMENT);
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO registry_manifest_blobs (manifest_digest, blob_digest) VALUES ${rows
          .map((_, index) => `(?${index * 2 + 1}, ?${index * 2 + 2})`)
          .join(", ")}`,
      ).bind(...rows.flatMap((blob) => [digest, blob])),
    );
  }
  await env.DB.batch(statements);
  return stored(hex);
}

/**
 * Records the image of one attempt of a machine build. Only the builder the
 * attempt is assigned to may record it, only for an image built for the
 * build's key, and only once: a replay of the same digest is accepted, a
 * different one is refused.
 *
 * `?arch=arm64` records the job's arm64 image instead, after the amd64 one
 * and only when the attempt was asked for it. Each must be an image for
 * exactly that architecture.
 *
 * A refusal of a different image names the recorded one, and a GET answers
 * both recorded digests, to the same builder and attempt only: a builder that
 * restarted in the middle of a job carries on from what it already recorded.
 */
export async function handleBuildResult(
  request: Request,
  env: Cloudflare.Env,
  buildId: string,
): Promise<Response> {
  const read = request.method === "GET";
  if (!read && request.method !== "POST") return methodNotAllowed("GET, POST");
  const auth = await readRegistryAuth(request, env);
  if (!auth.ok) return auth.response;
  // A pipeline has no build row to record on; its own result route is not
  // built yet.
  if (auth.owner.kind !== "builder") {
    return jsonResponse({ error: "a builder records build results" }, 403);
  }
  const buildKey = machineBuildKey(buildId);
  const query = new URL(request.url).searchParams;
  const architecture = query.get("arch") ?? "amd64";
  if (architecture !== "amd64" && architecture !== "arm64") return invalid("a result is for amd64 or arm64");
  const attemptText = query.get("attempt") ?? "";
  const attempt = /^[1-9][0-9]{0,9}$/.test(attemptText) ? Number(attemptText) : 0;
  if (!buildKey || attempt < 1 || attempt > MAX_ATTEMPT) {
    return invalid("a result names a build id and an attempt");
  }
  let imageDigest = "";
  if (!read) {
    const length = declaredLength(request, MAX_RESULT_BYTES);
    if (length instanceof Response) return length;
    const body = parseJson(await request.arrayBuffer());
    const named = isRecord(body) && Object.keys(body).length === 1 ? body.image_digest : null;
    if (typeof named !== "string" || !DIGEST_RE.test(named)) {
      return invalid("the result is {\"image_digest\":\"sha256:<hex>\"}");
    }
    imageDigest = named;
  }

  const build = await env.DB.prepare(
    `SELECT host_id, attempt, state, image_digest, image_format, arm64_asked, arm64_state, arm64_image_digest
       FROM machine_builds WHERE build_key = ?1`,
  ).bind(buildKey).first<{
    host_id: string | null;
    attempt: number;
    state: string;
    image_digest: string | null;
    image_format: string;
    arm64_asked: number;
    arm64_state: string | null;
    arm64_image_digest: string | null;
  }>();
  if (!build) return jsonResponse({ error: "unknown build" }, 404);
  if (build.host_id !== auth.owner.id || build.attempt !== attempt) {
    return jsonResponse({ error: "this attempt is not the build's current one", code: "build_superseded" }, 409);
  }
  if (read) return jsonResponse({ image_digest: build.image_digest, arm64_image_digest: build.arm64_image_digest });
  const arm64 = architecture === "arm64";
  if (arm64 && (build.arm64_asked !== 1 || build.image_digest === null)) {
    return jsonResponse({ error: "this attempt has no arm64 image to record yet", code: "arm64_not_expected" }, 409);
  }
  const recorded = arm64 ? build.arm64_image_digest : build.image_digest;
  if (recorded !== null) {
    return recorded === imageDigest
      ? jsonResponse({ ok: true, image_digest: imageDigest })
      // The caller is the build's own host and attempt: it may know its image.
      : jsonResponse({
          error: "this attempt already recorded another image", code: "build_result_recorded", image_digest: recorded,
        }, 409);
  }

  const manifest = await env.DB.prepare(
    `SELECT 1 AS present FROM registry_manifests WHERE digest = ?1 AND artifact_type = ?2`,
  ).bind(imageDigest, MACHINE_ARTIFACT_TYPE).first();
  const config = manifest ? await readStoredConfig(env, imageDigest) : null;
  if (!config || !validateMachineConfig(config)) {
    return jsonResponse({ error: "the image is not a stored machine image", code: "image_unknown" }, 409);
  }
  if (config.build_key !== buildKey || config.image_format !== build.image_format) {
    return jsonResponse({ error: "the image was built for another build key", code: "build_key_mismatch" }, 409);
  }
  // Both images of a job carry the same key; only this tells them apart.
  if (config.architecture !== architecture) {
    return jsonResponse({ error: `the image is not an ${architecture} image`, code: "architecture_mismatch" }, 409);
  }

  const updated = await env.DB.prepare(
    arm64
      ? `UPDATE machine_builds SET arm64_image_digest = ?1, arm64_state = 'succeeded', arm64_error = NULL, updated_at = ?2
          WHERE build_key = ?3 AND host_id = ?4 AND attempt = ?5
            AND state IN ('assigned', 'building') AND arm64_state = 'building' AND arm64_image_digest IS NULL
          RETURNING build_key`
      : `UPDATE machine_builds SET image_digest = ?1, updated_at = ?2
          WHERE build_key = ?3 AND host_id = ?4 AND attempt = ?5
            AND state IN ('assigned', 'building') AND image_digest IS NULL
          RETURNING build_key`,
  ).bind(imageDigest, Date.now(), buildKey, auth.owner.id, attempt).first();
  if (!updated) {
    return jsonResponse({ error: "the build moved on before this result", code: "build_superseded" }, 409);
  }
  return jsonResponse({ ok: true, image_digest: imageDigest }, 201);
}

export interface KinoPin {
  current: string;
  previous: string | null;
}

/**
 * The Kino pin of one guest contract from `KINO_PINS_JSON`. Null unless each
 * pinned digest is a stored Kino artifact whose config names that contract.
 */
export async function readKinoPin(
  env: Cloudflare.Env,
  guestContract: number,
  architecture: "amd64" | "arm64" = "amd64",
): Promise<KinoPin | null> {
  const pins = parseJsonText(env.KINO_PINS_JSON ?? "");
  const contractEntry = isRecord(pins) ? pins[String(guestContract)] : null;
  // The amd64 pair is the entry itself; another architecture's is nested in it.
  const entry = isRecord(contractEntry) && architecture !== "amd64" ? contractEntry[architecture] : contractEntry;
  if (!isRecord(entry)) return null;
  const { current, previous = null } = entry;
  const valid = (value: unknown): value is string => typeof value === "string" && DIGEST_RE.test(value);
  if (!valid(current) || (previous !== null && !valid(previous))) return null;
  // Every lab start and every dispatch to a host asks, so the digests are
  // checked side by side.
  const contracts = await Promise.all((previous === null ? [current] : [current, previous]).map(async (digest) => {
    const kino = await env.DB.prepare(
      `SELECT 1 AS present FROM registry_manifests WHERE digest = ?1 AND artifact_type = ?2`,
    ).bind(digest, KINO_ARTIFACT_TYPE).first();
    return { digest, kino: kino ? await kinoIdentity(env, digest) : null };
  }));
  for (const { digest, kino } of contracts) {
    // A pin is a root of trust: the binary must be for this contract and for
    // these guests, or a host would be handed one it cannot run.
    if (kino?.contract !== guestContract || kino.architecture !== architecture) {
      console.error(JSON.stringify({ event: "kino_pin_invalid", guest_contract: guestContract, architecture, digest }));
      return null;
    }
  }
  return { current, previous };
}

/**
 * The guest contract and the architecture a stored Kino artifact's config
 * names, or null. An artifact from before configs named one is amd64. A
 * digest names its content, so what was read once from the bucket holds for
 * as long as the manifest is stored, which the caller asks the database.
 */
async function kinoIdentity(
  env: Cloudflare.Env,
  digest: string,
): Promise<{ contract: number; architecture: string } | null> {
  const known = kinoIdentities.get(digest);
  if (known !== undefined) return known;
  const config = await readStoredConfig(env, digest);
  if (!validateKinoConfig(config)) return null;
  const identity = { contract: config.guest_contract, architecture: config.architecture ?? "amd64" };
  kinoIdentities.set(digest, identity);
  return identity;
}

const kinoIdentities = new Map<string, { contract: number; architecture: string }>();

/** The parsed config blob of a stored manifest. */
async function readStoredConfig(env: Cloudflare.Env, manifestDigest: string): Promise<unknown> {
  const manifest = await readJsonObject(env, manifestDigest);
  return validateManifest(manifest) ? readJsonObject(env, manifest.config.digest) : null;
}

async function readJsonObject(env: Cloudflare.Env, digest: string): Promise<unknown> {
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(ociObjectKey(digest));
  if (!object) return null;
  if (object.size > MAX_MANIFEST_BYTES) {
    await object.body.cancel();
    return null;
  }
  return parseJson(await object.arrayBuffer());
}

/** The Content-Length of a request, required and at most `limit`. */
function declaredLength(request: Request, limit: number): number | Response {
  const header = request.headers.get("content-length") ?? "";
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(header)) {
    return jsonResponse({ error: "a Content-Length is required" }, 411);
  }
  const length = Number(header);
  return length > limit ? jsonResponse({ error: `the body is over ${limit} bytes` }, 413) : length;
}

function parseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hexOf(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stored(hex: string): Response {
  return new Response(null, {
    status: 201,
    headers: { "docker-content-digest": `sha256:${hex}` },
  });
}

function invalid(error: string): Response {
  return jsonResponse({ error }, 400);
}

function methodNotAllowed(allow: string): Response {
  const response = jsonResponse({ error: "method not allowed" }, 405);
  response.headers.set("allow", allow);
  return response;
}
