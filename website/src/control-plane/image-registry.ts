import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  agentHosts,
  imageBuilds,
  imageBuildBundles,
  vmScenarioVms,
} from "@/db/schema";
import type {
  ImageArchitecture,
  ImageKey,
  ScenarioHintManifestV3,
  ScenarioManifestV3,
  ScenarioProbeManifestV3,
  ScenarioVmManifestV3,
} from "@/generated/catalog";
import type {
  AgentHostRole,
  ImageBuildBundleMeta,
  ImageBuildStatus,
} from "@/db/schema";
import { seedScenarioManifest } from "@/lib/catalog-manifest";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { upsertDesiredCachedImage } from "@/lib/desired-state";
import {
  withImageBuildCoordinationLock,
  type ImageBuildCoordinationLease,
} from "@/lib/image-build-lock";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
} from "@/lib/build-scheduler";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const IMAGE_KEY_RE = /^[A-Za-z0-9._-]+$/;
const BUILD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const EXPECTED_BUILD_FORMAT_VERSION = "intar-image-build-v7";
const TAR_BLOCK_SIZE = 512;
const MAX_BUNDLE_TAR_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES_PER_KEY = 2;
const IMAGE_OBJECT_SUFFIX = ".raw.zst";
const IMAGE_COMPANION_SUFFIX = ".raw.zst.sha256";

export async function handleImageRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/registry/v1/bundles") {
    return handleBundleUpload(request, env);
  }

  if (url.pathname === "/registry/v1/publish") {
    return handlePublish(request, env);
  }

  if (url.pathname === "/registry/v1/uploads") {
    return handleUploadCreate(request, env);
  }

  if (url.pathname === "/registry/v1/uploads/parts") {
    return handleUploadPart(request, env, url);
  }

  if (url.pathname === "/registry/v1/uploads/complete") {
    return handleUploadComplete(request, env);
  }

  if (url.pathname === "/agent/registry/images") {
    return handleAgentImageIndex(request, env);
  }

  const downloadMatch = url.pathname.match(
    /^\/agent\/registry\/images\/([^/]+)\/([A-Fa-f0-9]{64})$/,
  );
  if (downloadMatch) {
    return handleAgentImageDownload(
      request,
      env,
      decodeURIComponent(downloadMatch[1] ?? ""),
      (downloadMatch[2] ?? "").toLowerCase(),
    );
  }

  const artifactMatch = url.pathname.match(
    /^\/agent\/registry\/artifacts\/([A-Fa-f0-9]{64})$/,
  );
  if (artifactMatch) {
    return handleAgentArtifactDownload(
      request,
      env,
      (artifactMatch[1] ?? "").toLowerCase(),
    );
  }

  const bundleMatch = url.pathname.match(
    /^\/agent\/registry\/bundles\/([^/]+)$/,
  );
  if (bundleMatch) {
    return handleAgentBundleDownload(
      request,
      env,
      decodeURIComponent(bundleMatch[1] ?? ""),
    );
  }

  const buildLogMatch = url.pathname.match(/^\/agent\/builds\/([^/]+)\/log$/);
  if (buildLogMatch) {
    return handleAgentBuildLogUpload(
      request,
      env,
      decodeURIComponent(buildLogMatch[1] ?? ""),
    );
  }

  return null;
}

async function handleBundleUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authz = await requireBundleUploadAuth(request, env);
  if (authz) return authz;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }

  const meta = await readBundleMeta(form.get("meta"));
  if (!meta.ok) return meta.response;

  const bundle = form.get("bundle");
  if (!(bundle instanceof File)) {
    return jsonResponse({ error: "bundle form field is required" }, 400);
  }

  const payload = await bundle.arrayBuffer();
  if (payload.byteLength === 0) {
    return jsonResponse({ error: "bundle archive is empty" }, 400);
  }
  const archiveError = await validateBundleArchivePayload(
    payload,
    meta.value.bundleMeta,
  );
  if (archiveError) return archiveError;

  const objectKey = bundleObjectKey(meta.value.rev);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      rev: meta.value.rev,
      kino_version: meta.value.kinoVersion,
    },
  });

  const db = drizzle(env.DB);
  const now = Date.now();
  const queued = await queueImageBuildsFromBundle(db, {
    rev: meta.value.rev,
    r2Key: objectKey,
    kinoVersion: meta.value.kinoVersion,
    meta: meta.value.bundleMeta,
    nowUnixMs: now,
  });
  const assigned = await assignQueuedImageBuilds(db, now);

  return jsonResponse(
    {
      ok: true,
      rev: meta.value.rev,
      bundle_key: objectKey,
      queued: queued.queued,
      assigned,
    },
    202,
  );
}

async function handlePublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authorization = await authorizeManifestPublish(request, env);
  if (!authorization.ok) return authorization.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }

  const manifest = await readManifest(form.get("manifest"));
  if (!manifest.ok) return manifest.response;

  const validationError = validateManifest(manifest.value);
  if (validationError) return validationError;

  const normalizedManifest = normalizePublishManifest(manifest.value);

  let buildFence:
    | (PublishBuildIdentity & { hostId: string; scenarioId: string })
    | null = null;
  if (authorization.kind === "builder") {
    const identity = readPublishBuildIdentity(form);
    if (!identity.ok) return identity.response;
    if (
      !normalizedManifest.vms.every(
        (vm) => vm.image_key.arch === identity.value.architecture,
      )
    ) {
      return inactivePublishBuildResponse();
    }

    buildFence = {
      ...identity.value,
      hostId: authorization.hostId,
      scenarioId: normalizedManifest.scenario_id,
    };
  }

  const db = drizzle(env.DB);
  const persistPreparedPublish = async (
    lease: ImageBuildCoordinationLease | null,
  ): Promise<
    | {
        ok: true;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        preparedImages: PreparedVmImage[];
      }
    | { ok: false; response: Response }
  > => {
    if (buildFence) {
      const assignment = await loadPublishBuildAssignment(
        db,
        buildFence.buildId,
      );
      if (!isActivePublishBuildAssignment(assignment, buildFence)) {
        return { ok: false, response: inactivePublishBuildResponse() };
      }
    }

    const artifacts = await prepareBootArtifacts(env, form, manifest.value);
    if (!artifacts.ok) return artifacts;

    const images = await prepareVmImages(env, form, manifest.value);
    if (!images.ok) return images;

    await storePreparedBootArtifacts(env, artifacts.prepared);
    const uploaded = await storePreparedVmImages(
      env,
      images.prepared,
      normalizedManifest.scenario_id,
    );

    if (buildFence) {
      const assignment = await loadPublishBuildAssignment(
        db,
        buildFence.buildId,
      );
      if (!isActivePublishBuildAssignment(assignment, buildFence)) {
        return { ok: false, response: inactivePublishBuildResponse() };
      }
      await lease?.assertHeld();
    }

    await seedScenarioManifest(db, normalizedManifest, {
      enabled: true,
      nowUnixMs: Date.now(),
    });
    return {
      ok: true,
      uploaded,
      artifacts: artifacts.uploaded,
      preparedImages: images.prepared,
    };
  };

  let published:
    | {
        ok: true;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        preparedImages: PreparedVmImage[];
      }
    | { ok: false; response: Response };
  if (buildFence) {
    const fenceRejected = { response: null as Response | null };
    try {
      published = await withImageBuildCoordinationLock(
        db,
        {
          scenarioId: buildFence.scenarioId,
          arch: buildFence.architecture,
        },
        async (lease) => {
          const result = await persistPreparedPublish(lease);
          if (!result.ok && result.response.status === 409) {
            fenceRejected.response = result.response;
          }
          return result;
        },
      );
    } catch (error) {
      // Once the assignment check has deliberately rejected the publish, a
      // best-effort lease release failure must not turn that 409 into a 500.
      if (fenceRejected.response) return fenceRejected.response;
      throw error;
    }
  } else {
    published = await persistPreparedPublish(null);
  }
  if (!published.ok) return published.response;

  await bumpHostCachedImages(db, normalizedManifest);

  let pruned: PrunedImages[] = [];
  try {
    pruned = await pruneStaleVmImages(env, db, published.preparedImages);
  } catch (error) {
    // Retention is best-effort; a prune failure must never fail the publish.
    console.error("vm image registry prune failed", error);
  }

  return jsonResponse(
    {
      ok: true,
      scenario_id: normalizedManifest.scenario_id,
      images: published.uploaded,
      artifacts: published.artifacts,
      pruned,
    },
    201,
  );
}

type PrunedImages = {
  image_key: string;
  deleted_sha256s: string[];
};

async function catalogReferencedImageShas(
  db: DrizzleD1Database,
): Promise<Set<string>> {
  const rows = await db
    .select({
      imageKey: vmScenarioVms.imageKeyJson,
      imageSha256: vmScenarioVms.imageSha256,
    })
    .from(vmScenarioVms)
    .where(isNotNull(vmScenarioVms.imageSha256));

  const referenced = new Set<string>();
  for (const row of rows) {
    if (!isImageKey(row.imageKey)) continue;
    const sha256 = normalizeSha256(row.imageSha256 ?? "");
    if (!sha256) continue;
    referenced.add(`${registryImageKey(row.imageKey)}:${sha256}`);
  }
  return referenced;
}

async function listImageKeyObjects(
  env: Cloudflare.Env,
  imageKey: string,
): Promise<Array<{ key: string; uploaded: Date }>> {
  const objects: Array<{ key: string; uploaded: Date }> = [];
  let cursor: string | undefined;
  do {
    const result = await env.VM_IMAGE_REGISTRY_BUCKET.list({
      prefix: `images/${imageKey}/`,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of result.objects) {
      objects.push({ key: object.key, uploaded: object.uploaded });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return objects;
}

async function pruneStaleVmImages(
  env: Cloudflare.Env,
  db: DrizzleD1Database,
  published: PreparedVmImage[],
): Promise<PrunedImages[]> {
  const publishedShasByImageKey = new Map<string, Set<string>>();
  for (const image of published) {
    const shas = publishedShasByImageKey.get(image.imageKey) ?? new Set();
    shas.add(image.imageSha256);
    publishedShasByImageKey.set(image.imageKey, shas);
  }
  if (publishedShasByImageKey.size === 0) return [];

  const referenced = await catalogReferencedImageShas(db);
  const pruned: PrunedImages[] = [];

  for (const [imageKey, publishedShas] of publishedShasByImageKey) {
    const prefix = `images/${imageKey}/`;
    const entries = new Map<
      string,
      { uploaded: Date | null; companion: boolean }
    >();
    for (const object of await listImageKeyObjects(env, imageKey)) {
      const basename = object.key.slice(prefix.length);
      if (basename.endsWith(IMAGE_COMPANION_SUFFIX)) {
        const sha256 = normalizeSha256(
          basename.slice(0, -IMAGE_COMPANION_SUFFIX.length),
        );
        if (!sha256) continue;
        const entry = entries.get(sha256) ?? {
          uploaded: null,
          companion: false,
        };
        entry.companion = true;
        entries.set(sha256, entry);
      } else if (basename.endsWith(IMAGE_OBJECT_SUFFIX)) {
        const sha256 = normalizeSha256(
          basename.slice(0, -IMAGE_OBJECT_SUFFIX.length),
        );
        if (!sha256) continue;
        const entry = entries.get(sha256) ?? {
          uploaded: null,
          companion: false,
        };
        entry.uploaded = object.uploaded;
        entries.set(sha256, entry);
      }
    }

    const mostRecent = [...entries.entries()]
      .filter(([, entry]) => entry.uploaded !== null)
      .sort(
        (a, b) =>
          (b[1].uploaded?.getTime() ?? 0) - (a[1].uploaded?.getTime() ?? 0),
      )
      .slice(0, MAX_IMAGES_PER_KEY)
      .map(([sha256]) => sha256);

    // A reused image keeps its original R2 uploaded timestamp, so recency
    // alone would evict the image that was just published or is still the
    // live catalog pointer — both are always kept.
    const keep = new Set([...publishedShas, ...mostRecent]);

    const deleteKeys: string[] = [];
    const deletedShas: string[] = [];
    for (const [sha256, entry] of entries) {
      if (keep.has(sha256) || referenced.has(`${imageKey}:${sha256}`)) {
        continue;
      }
      if (entry.uploaded !== null) {
        deleteKeys.push(imageObjectKey(imageKey, sha256));
      }
      if (entry.companion) {
        deleteKeys.push(`${imageObjectKey(imageKey, sha256)}.sha256`);
      }
      deletedShas.push(sha256);
    }
    if (deleteKeys.length === 0) continue;

    await env.VM_IMAGE_REGISTRY_BUCKET.delete(deleteKeys);
    pruned.push({ image_key: imageKey, deleted_sha256s: deletedShas.sort() });
  }

  return pruned;
}

// Cloudflare caps request bodies well below typical image sizes, so images
// and boot artifacts are uploaded ahead of publish as R2 multipart uploads
// split into parts that each fit in one request. The assembled object's
// sha256 is NOT re-verified here (hashing multi-hundred-MB objects exceeds
// the worker CPU budget); agents verify the sha256 on download instead.
const UPLOAD_MAX_PART_NUMBER = 10_000;

type UploadTarget = {
  objectKey: string;
  customMetadata: Record<string, string>;
};

function uploadTargetFromBody(
  body: Record<string, unknown>,
): { ok: true; target: UploadTarget } | { ok: false; response: Response } {
  const kind = readString(body.kind);
  const sha256 = normalizeSha256(readString(body.sha256) ?? "");
  if (!sha256) {
    return {
      ok: false,
      response: jsonResponse({ error: "valid sha256 is required" }, 400),
    };
  }

  if (kind === "artifact") {
    return {
      ok: true,
      target: {
        objectKey: artifactObjectKey(sha256),
        customMetadata: { artifact_sha256: sha256 },
      },
    };
  }

  if (kind === "image") {
    const imageKey = readString(body.image_key);
    const scenarioId = readString(body.scenario_id);
    const vmName = readString(body.vm_name);
    if (
      !imageKey ||
      !IMAGE_KEY_RE.test(imageKey) ||
      !scenarioId ||
      !isSafeRegistrySlug(scenarioId) ||
      !vmName ||
      !isSafeRegistrySlug(vmName)
    ) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "image uploads require image_key, scenario_id, and vm_name",
          },
          400,
        ),
      };
    }
    return {
      ok: true,
      target: {
        objectKey: imageObjectKey(imageKey, sha256),
        customMetadata: {
          image_key: imageKey,
          image_sha256: sha256,
          scenario_id: scenarioId,
          vm_name: vmName,
        },
      },
    };
  }

  return {
    ok: false,
    response: jsonResponse({ error: "kind must be image or artifact" }, 400),
  };
}

function isUploadableObjectKey(objectKey: string): boolean {
  return objectKey.startsWith("images/") || objectKey.startsWith("artifacts/");
}

async function handleUploadCreate(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  if (!isRecord(body)) {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  const parsed = uploadTargetFromBody(body);
  if (!parsed.ok) return parsed.response;

  const sha256 = normalizeSha256(readString(body.sha256) ?? "") ?? "";
  const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(
    parsed.target.objectKey,
  );
  const existingSha = normalizeSha256(
    existing?.customMetadata?.image_sha256 ??
      existing?.customMetadata?.artifact_sha256 ??
      "",
  );
  if (existing && existingSha === sha256) {
    return jsonResponse({
      ok: true,
      object_key: parsed.target.objectKey,
      already_exists: true,
    });
  }

  const upload = await env.VM_IMAGE_REGISTRY_BUCKET.createMultipartUpload(
    parsed.target.objectKey,
    {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: parsed.target.customMetadata,
    },
  );
  return jsonResponse(
    {
      ok: true,
      object_key: upload.key,
      upload_id: upload.uploadId,
      already_exists: false,
    },
    201,
  );
}

async function handleUploadPart(
  request: Request,
  env: Cloudflare.Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  const objectKey = url.searchParams.get("object_key") ?? "";
  const uploadId = url.searchParams.get("upload_id") ?? "";
  const partNumber = Number.parseInt(
    url.searchParams.get("part_number") ?? "",
    10,
  );
  if (!isUploadableObjectKey(objectKey) || !uploadId) {
    return jsonResponse({ error: "invalid object_key or upload_id" }, 400);
  }
  if (
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > UPLOAD_MAX_PART_NUMBER
  ) {
    return jsonResponse({ error: "invalid part_number" }, 400);
  }

  const payload = await request.arrayBuffer();
  if (payload.byteLength === 0) {
    return jsonResponse({ error: "part body is empty" }, 400);
  }

  try {
    const upload = env.VM_IMAGE_REGISTRY_BUCKET.resumeMultipartUpload(
      objectKey,
      uploadId,
    );
    const part = await upload.uploadPart(partNumber, payload);
    return jsonResponse({
      ok: true,
      part_number: part.partNumber,
      etag: part.etag,
    });
  } catch (error) {
    return jsonResponse({ error: `part upload failed: ${String(error)}` }, 400);
  }
}

async function handleUploadComplete(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  if (!isRecord(body)) {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }

  const objectKey = readString(body.object_key) ?? "";
  const uploadId = readString(body.upload_id) ?? "";
  if (!isUploadableObjectKey(objectKey) || !uploadId) {
    return jsonResponse({ error: "invalid object_key or upload_id" }, 400);
  }
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return jsonResponse({ error: "parts array is required" }, 400);
  }
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const rawPart of body.parts) {
    if (!isRecord(rawPart)) {
      return jsonResponse({ error: "invalid part entry" }, 400);
    }
    const partNumber = rawPart.part_number;
    const etag = readString(rawPart.etag);
    if (
      typeof partNumber !== "number" ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > UPLOAD_MAX_PART_NUMBER ||
      !etag
    ) {
      return jsonResponse({ error: "invalid part entry" }, 400);
    }
    parts.push({ partNumber, etag });
  }

  try {
    const upload = env.VM_IMAGE_REGISTRY_BUCKET.resumeMultipartUpload(
      objectKey,
      uploadId,
    );
    const object = await upload.complete(parts);
    return jsonResponse({
      ok: true,
      object_key: objectKey,
      bytes: object.size,
    });
  } catch (error) {
    return jsonResponse(
      { error: `upload completion failed: ${String(error)}` },
      400,
    );
  }
}

type PreparedBootArtifact = {
  sha256: string;
  objectKey: string;
  bytes: number;
  reused: boolean;
  payload: ArrayBuffer | null;
};

type PublishedBootArtifact = {
  sha256: string;
  object_key: string;
  bytes: number;
  reused: boolean;
};

type PreparedVmImage = {
  vmName: string;
  imageKey: string;
  imageSha256: string;
  objectKey: string;
  bytes: number;
  reused: boolean;
  payload: ArrayBuffer | null;
};

type PublishedVmImage = {
  image_key: string;
  image_sha256: string;
  object_key: string;
  bytes: number;
  reused: boolean;
};

async function prepareBootArtifacts(
  env: Cloudflare.Env,
  form: FormData,
  manifest: ScenarioManifestV3,
): Promise<
  | {
      ok: true;
      prepared: PreparedBootArtifact[];
      uploaded: PublishedBootArtifact[];
    }
  | { ok: false; response: Response }
> {
  const prepared: PreparedBootArtifact[] = [];
  const uploaded = [];
  for (const sha256 of bootArtifactSha256s(manifest)) {
    const objectKey = artifactObjectKey(sha256);
    const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
    if (bootArtifactObjectMatchesSha(existing, sha256)) {
      prepared.push({
        sha256,
        objectKey,
        bytes: existing.size,
        reused: true,
        payload: null,
      });
      uploaded.push({
        sha256,
        object_key: objectKey,
        bytes: existing.size,
        reused: true,
      });
      continue;
    }

    const file = artifactFileForSha(form, sha256);
    if (!file) {
      return {
        ok: false,
        response: jsonResponse(
          { error: `missing boot artifact ${sha256}` },
          400,
        ),
      };
    }

    const payload = await file.arrayBuffer();
    const actualSha256 = await sha256Hex(payload);
    if (actualSha256 !== sha256) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "boot artifact sha256 mismatch",
            expected: sha256,
            actual: actualSha256,
          },
          422,
        ),
      };
    }

    prepared.push({
      sha256,
      objectKey,
      bytes: payload.byteLength,
      reused: false,
      payload,
    });
    uploaded.push({
      sha256,
      object_key: objectKey,
      bytes: payload.byteLength,
      reused: false,
    });
  }

  return { ok: true, prepared, uploaded };
}

async function prepareVmImages(
  env: Cloudflare.Env,
  form: FormData,
  manifest: ScenarioManifestV3,
): Promise<
  { ok: true; prepared: PreparedVmImage[] } | { ok: false; response: Response }
> {
  const prepared: PreparedVmImage[] = [];
  for (const vm of manifest.vms) {
    const imageKey = registryImageKey(vm.image_key);
    const expectedSha256 = normalizeSha256(vm.image_sha256);
    if (!expectedSha256) {
      return {
        ok: false,
        response: jsonResponse(
          { error: `invalid image_sha256 for vm ${vm.name}` },
          400,
        ),
      };
    }

    const objectKey = imageObjectKey(imageKey, expectedSha256);
    const file = imageFileForVm(form, vm);
    if (!file) {
      // Large images are uploaded ahead of publish via /registry/v1/uploads;
      // accept the manifest when the content-addressed object already exists.
      const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
      if (imageObjectMatchesSha(existing, imageKey, expectedSha256)) {
        prepared.push({
          vmName: vm.name.trim(),
          imageKey,
          imageSha256: expectedSha256,
          objectKey,
          bytes: existing.size,
          reused: true,
          payload: null,
        });
        continue;
      }
      return {
        ok: false,
        response: jsonResponse(
          {
            error: `missing image for vm ${vm.name}: attach it to the form or upload it via /registry/v1/uploads first`,
          },
          400,
        ),
      };
    }

    const payload = await file.arrayBuffer();
    const actualSha256 = await sha256Hex(payload);
    if (actualSha256 !== expectedSha256) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: `sha256 mismatch for vm ${vm.name}`,
            expected: expectedSha256,
            actual: actualSha256,
          },
          422,
        ),
      };
    }

    prepared.push({
      vmName: vm.name.trim(),
      imageKey,
      imageSha256: expectedSha256,
      objectKey,
      bytes: payload.byteLength,
      reused: false,
      payload,
    });
  }
  return { ok: true, prepared };
}

async function storePreparedBootArtifacts(
  env: Cloudflare.Env,
  artifacts: PreparedBootArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.reused || !artifact.payload) {
      continue;
    }
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      artifact.objectKey,
      artifact.payload,
      {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { artifact_sha256: artifact.sha256 },
      },
    );
  }
}

async function storePreparedVmImages(
  env: Cloudflare.Env,
  images: PreparedVmImage[],
  scenarioId: string,
): Promise<PublishedVmImage[]> {
  const uploaded: PublishedVmImage[] = [];
  for (const image of images) {
    if (image.payload) {
      await env.VM_IMAGE_REGISTRY_BUCKET.put(image.objectKey, image.payload, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          image_key: image.imageKey,
          image_sha256: image.imageSha256,
          scenario_id: scenarioId,
          vm_name: image.vmName,
        },
      });
    }
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      `${image.objectKey}.sha256`,
      textEncoder.encode(`${image.imageSha256}  ${image.imageKey}.raw.zst\n`),
      { httpMetadata: { contentType: "text/plain; charset=utf-8" } },
    );
    uploaded.push({
      image_key: image.imageKey,
      image_sha256: image.imageSha256,
      object_key: image.objectKey,
      bytes: image.bytes,
      reused: image.reused,
    });
  }
  return uploaded;
}

async function handleAgentBundleDownload(
  request: Request,
  env: Cloudflare.Env,
  rev: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBundleRev(rev)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }

  const rows = await drizzle(env.DB)
    .select({ r2Key: imageBuildBundles.r2Key })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, rev))
    .limit(1);
  const objectKey = rows[0]?.r2Key;
  if (!objectKey) {
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!object) {
    return jsonResponse({ error: "bundle object not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-build-bundle-rev": rev,
    },
  });
}

async function handleAgentBuildLogUpload(
  request: Request,
  env: Cloudflare.Env,
  buildId: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, 400);
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({ hostId: imageBuilds.hostId })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  const build = rows[0];
  if (!build) {
    return jsonResponse({ error: "build not found" }, 404);
  }
  if (build.hostId !== verified.agent.hostId) {
    return jsonResponse(
      { error: "build is not assigned to this builder" },
      409,
    );
  }

  const payload = await request.arrayBuffer();
  const objectKey = `builds/logs/${buildId}.log`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      build_id: buildId,
      host_id: verified.agent.hostId,
    },
  });

  const updated = await db
    .update(imageBuilds)
    .set({
      logR2Key: objectKey,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(imageBuilds.id, buildId),
        eq(imageBuilds.hostId, verified.agent.hostId),
      ),
    )
    .returning({ id: imageBuilds.id });
  if (!updated.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(objectKey);
    return jsonResponse(
      { error: "build assignment changed during log upload" },
      409,
    );
  }

  return jsonResponse({ ok: true, build_id: buildId, log_key: objectKey });
}

async function bumpHostCachedImages(
  db: DrizzleD1Database,
  manifest: ScenarioManifestV3,
): Promise<void> {
  const nowUnixMs = Date.now();
  const images = manifest.vms.map((vm) => ({
    image_key: vm.image_key,
    image_sha256: vm.image_sha256,
  }));
  const hosts = await db
    .select({
      id: agentHosts.id,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
    })
    .from(agentHosts)
    .where(eq(agentHosts.disabled, false));

  for (const host of hosts) {
    if (!isRuntimeImageCacheHost(host)) {
      continue;
    }
    await mutateStoredHostDesiredState(db, host.id, nowUnixMs, (draft) => {
      for (const image of images) {
        upsertDesiredCachedImage(draft, image);
      }
    });
    await tryWakeHostRuntime(host.id);
  }
}

export function isRuntimeImageCacheHost(host: {
  role: AgentHostRole;
  disabled: boolean;
  scenarioEnabled: boolean;
}): boolean {
  // Maintenance disables placement, not cache convergence. Keeping this
  // independent from scenarioEnabled lets a drained host prewarm the newly
  // published generation before starts are re-enabled.
  return host.role === "agent" && !host.disabled;
}

async function handleAgentImageIndex(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      imageKey: vmScenarioVms.imageKeyJson,
      imageSha256: vmScenarioVms.imageSha256,
      imageFormat: vmScenarioVms.imageFormat,
      imageVirtualSizeBytes: vmScenarioVms.imageVirtualSizeBytes,
      kernelSha256: vmScenarioVms.kernelSha256,
      initrdSha256: vmScenarioVms.initrdSha256,
      bootCmdline: vmScenarioVms.bootCmdline,
    })
    .from(vmScenarioVms);

  const byKey = new Map<
    string,
    {
      image_key: string;
      image_sha256: string;
      image_format: string;
      image_virtual_size_bytes: number;
      boot: {
        kernel_sha256: string;
        initrd_sha256: string;
        cmdline: string;
      };
      bytes: number;
      download_url: string;
    }
  >();

  for (const row of rows) {
    if (!isImageKey(row.imageKey)) continue;
    const sha256 = normalizeSha256(row.imageSha256 ?? "");
    if (!sha256) continue;
    const kernelSha256 = normalizeSha256(row.kernelSha256 ?? "");
    const initrdSha256 = normalizeSha256(row.initrdSha256 ?? "");
    const bootCmdline = row.bootCmdline?.trim() ?? "";
    if (
      row.imageFormat !== "raw_zstd" ||
      row.imageVirtualSizeBytes <= 0 ||
      !kernelSha256 ||
      !initrdSha256 ||
      !bootCmdline
    ) {
      continue;
    }

    const imageKey = registryImageKey(row.imageKey);
    const objectKey = imageObjectKey(imageKey, sha256);
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
    if (!imageObjectMatchesSha(object, imageKey, sha256)) continue;
    if (!(await bootArtifactsExist(env, [kernelSha256, initrdSha256]))) {
      continue;
    }

    byKey.set(`${imageKey}:${sha256}`, {
      image_key: imageKey,
      image_sha256: sha256,
      image_format: row.imageFormat,
      image_virtual_size_bytes: row.imageVirtualSizeBytes,
      boot: {
        kernel_sha256: kernelSha256,
        initrd_sha256: initrdSha256,
        cmdline: bootCmdline,
      },
      bytes: object.size,
      download_url: `/agent/registry/images/${encodeURIComponent(imageKey)}/${sha256}`,
    });
  }

  return jsonResponse({
    images: [...byKey.values()].sort((a, b) =>
      a.image_key.localeCompare(b.image_key),
    ),
  });
}

async function bootArtifactsExist(
  env: Cloudflare.Env,
  sha256s: string[],
): Promise<boolean> {
  const objectKeys = [...new Set(sha256s.map(artifactObjectKey))];
  const heads = await Promise.all(
    objectKeys.map((objectKey) => env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey)),
  );
  return heads.every((head, index) => {
    const objectKey = objectKeys[index];
    const sha256 = objectKey?.slice("artifacts/".length) ?? "";
    return bootArtifactObjectMatchesSha(head, sha256);
  });
}

function imageObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, imageKey: string, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.image_sha256 ??
      object.customMetadata?.imageSha256 ??
      "",
  );
  const metadataImageKey =
    readString(object.customMetadata?.image_key) ??
    readString(object.customMetadata?.imageKey);
  return metadataSha256 === sha256 && metadataImageKey === imageKey;
}

function bootArtifactObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.artifact_sha256 ??
      object.customMetadata?.artifactSha256 ??
      "",
  );
  return metadataSha256 === sha256;
}

async function handleAgentImageDownload(
  request: Request,
  env: Cloudflare.Env,
  imageKey: string,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!IMAGE_KEY_RE.test(imageKey) || !SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid image key or sha256" }, 400);
  }

  const objectKey = imageObjectKey(imageKey, sha256);
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!imageObjectMatchesSha(object, imageKey, sha256)) {
    return jsonResponse({ error: "image not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-image-key": imageKey,
      "x-image-sha256": sha256,
    },
  });
}

async function handleAgentArtifactDownload(
  request: Request,
  env: Cloudflare.Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid artifact sha256" }, 400);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    artifactObjectKey(sha256),
  );
  if (!bootArtifactObjectMatchesSha(object, sha256)) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-artifact-sha256": sha256,
    },
  });
}

type ManifestPublishAuthorization =
  | { ok: true; kind: "trusted-token" }
  | { ok: true; kind: "builder"; hostId: string }
  | { ok: false; response: Response };

type PublishBuildIdentity = {
  buildId: string;
  rev: string;
  contentHash: string;
  architecture: ImageArchitecture;
};

type PublishBuildAssignment = {
  id: string;
  hostId: string | null;
  status: ImageBuildStatus;
  scenarioId: string;
  arch: ImageArchitecture;
  rev: string;
  contentHash: string;
};

async function authorizeManifestPublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<ManifestPublishAuthorization> {
  // The repository publication token is an administrative path used by the
  // release pipeline. Builder agents use their host identity and are fenced
  // against the exact active build assignment below.
  if (await hasRegistryPublishToken(request, env)) {
    return { ok: true, kind: "trusted-token" };
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified;
  return {
    ok: true,
    kind: "builder",
    hostId: verified.agent.hostId,
  };
}

function readPublishBuildIdentity(
  form: FormData,
):
  | { ok: true; value: PublishBuildIdentity }
  | { ok: false; response: Response } {
  const buildId = readString(form.get("build_id"));
  const rev = readString(form.get("rev"));
  const contentHash = normalizeSha256(
    readString(form.get("content_hash")) ?? "",
  );
  const architecture = readString(form.get("architecture"));
  if (
    !buildId ||
    !isSafeBuildId(buildId) ||
    !rev ||
    !isSafeBundleRev(rev) ||
    !contentHash ||
    !isImageArchitecture(architecture)
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error:
            "builder publish requires valid build_id, rev, content_hash, and architecture",
        },
        400,
      ),
    };
  }
  return {
    ok: true,
    value: { buildId, rev, contentHash, architecture },
  };
}

async function loadPublishBuildAssignment(
  db: DrizzleD1Database,
  buildId: string,
): Promise<PublishBuildAssignment | undefined> {
  const rows = await db
    .select({
      id: imageBuilds.id,
      hostId: imageBuilds.hostId,
      status: imageBuilds.status,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  return rows[0];
}

function isActivePublishBuildAssignment(
  assignment: PublishBuildAssignment | undefined,
  expected: PublishBuildIdentity & { hostId: string; scenarioId: string },
): boolean {
  return Boolean(
    assignment &&
    assignment.id === expected.buildId &&
    assignment.hostId === expected.hostId &&
    (assignment.status === "assigned" || assignment.status === "building") &&
    assignment.scenarioId === expected.scenarioId &&
    assignment.arch === expected.architecture &&
    assignment.rev === expected.rev &&
    assignment.contentHash === expected.contentHash,
  );
}

function inactivePublishBuildResponse(): Response {
  return jsonResponse({ error: "build is not active for this builder" }, 409);
}

async function requireBlobUploadAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  if (await hasRegistryPublishToken(request, env)) {
    return null;
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (verified.ok) {
    if (verified.agent.role === "builder") {
      return null;
    }
    return jsonResponse({ error: "builder role required" }, 403);
  }

  return jsonResponse({ error: "unauthorized" }, 401);
}

async function requireBundleUploadAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  if (await hasRegistryPublishToken(request, env)) {
    return null;
  }
  return jsonResponse({ error: "unauthorized" }, 401);
}

async function hasRegistryPublishToken(
  request: Request,
  env: Cloudflare.Env,
): Promise<boolean> {
  const expected = env.REGISTRY_PUBLISH_TOKEN?.trim();
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!expected || !bearer) {
    return false;
  }

  const [expectedHash, bearerHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(bearer)),
  ]);
  return timingSafeHashEqual(expectedHash, bearerHash);
}

function timingSafeHashEqual(
  expected: ArrayBuffer,
  actual: ArrayBuffer,
): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(expected, actual);
  }

  // Node's Web Crypto test runtime does not yet expose timingSafeEqual. Both
  // inputs are fixed-size SHA-256 digests, so this loop preserves the same
  // constant-work comparison without leaking the original token length.
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

function isSafeBuildId(value: string): boolean {
  return value !== "." && value !== ".." && BUILD_ID_RE.test(value);
}

async function readManifest(
  value: FormDataEntryValue | null,
): Promise<
  { ok: true; value: ScenarioManifestV3 } | { ok: false; response: Response }
> {
  if (!value) {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest form field is required" }, 400),
    };
  }

  const raw = typeof value === "string" ? value : await value.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest is not valid JSON" }, 400),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest is not a JSON object" }, 400),
    };
  }
  return { ok: true, value: parsed as unknown as ScenarioManifestV3 };
}

async function readBundleMeta(value: FormDataEntryValue | null): Promise<
  | {
      ok: true;
      value: {
        rev: string;
        kinoVersion: string;
        bundleMeta: ImageBuildBundleMeta;
      };
    }
  | { ok: false; response: Response }
> {
  if (!value) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta form field is required" }, 400),
    };
  }

  const raw = typeof value === "string" ? value : await value.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "meta is not valid JSON" }, 400),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta is not a JSON object" }, 400),
    };
  }

  const rev = readString(parsed.rev);
  const kinoVersion =
    readString(parsed.kino_version) ?? readString(parsed.kinoVersion);
  if (!rev || !isSafeBundleRev(rev)) {
    return { ok: false, response: jsonResponse({ error: "invalid rev" }, 400) };
  }
  if (!kinoVersion) {
    return {
      ok: false,
      response: jsonResponse({ error: "kino_version is required" }, 400),
    };
  }
  if (!isSafeKinoVersion(kinoVersion)) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid kino_version" }, 400),
    };
  }
  const buildFormatVersion =
    readString(parsed.build_format_version) ??
    readString(parsed.buildFormatVersion);
  if (buildFormatVersion !== EXPECTED_BUILD_FORMAT_VERSION) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "unsupported build_format_version" },
        400,
      ),
    };
  }

  if (!Array.isArray(parsed.scenarios)) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta.scenarios is required" }, 400),
    };
  }
  const scenarios: ImageBuildBundleMeta["scenarios"] = [];
  for (const rawScenario of parsed.scenarios) {
    const scenario = normalizeBundleScenario(rawScenario);
    if (!scenario) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "meta.scenarios contains an invalid scenario entry" },
          400,
        ),
      };
    }
    scenarios.push(scenario);
  }
  if (!scenarios.length) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta.scenarios is required" }, 400),
    };
  }
  const scenarioKeys = new Set<string>();
  for (const scenario of scenarios) {
    const key = `${scenario.scenarioId}:${scenario.arch}`;
    if (scenarioKeys.has(key)) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "meta contains duplicate scenario/arch entries" },
          400,
        ),
      };
    }
    scenarioKeys.add(key);
  }

  return {
    ok: true,
    value: {
      rev,
      kinoVersion,
      bundleMeta: {
        ...parsed,
        buildFormatVersion,
        scenarios,
      },
    },
  };
}

function normalizeBundleScenario(
  value: unknown,
): ImageBuildBundleMeta["scenarios"][number] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const scenarioId = readString(raw.scenario_id) ?? readString(raw.scenarioId);
  const arch = readString(raw.arch);
  const contentHash =
    normalizeSha256(readString(raw.content_hash) ?? "") ??
    normalizeSha256(readString(raw.contentHash) ?? "");
  if (
    !scenarioId ||
    !isSafeBundleRev(scenarioId) ||
    !isImageArchitecture(arch) ||
    !contentHash
  ) {
    return null;
  }
  return {
    scenarioId,
    arch,
    contentHash,
  };
}

async function validateBundleArchivePayload(
  payload: ArrayBuffer,
  meta: ImageBuildBundleMeta,
): Promise<Response | null> {
  const archive = await readGzipBundleArchive(payload);
  if (!archive.ok) return archive.response;

  const entries = inspectTarArchive(archive.bytes);
  if (!entries.ok) {
    return jsonResponse({ error: entries.error }, 400);
  }

  for (const requiredPath of requiredBundlePaths(meta)) {
    if (!entries.files.has(requiredPath)) {
      return jsonResponse(
        { error: `bundle archive is missing ${requiredPath}` },
        400,
      );
    }
  }

  return null;
}

async function readGzipBundleArchive(
  payload: ArrayBuffer,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; response: Response }
> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([payload])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "bundle archive is not valid gzip" },
        400,
      ),
    };
  }

  try {
    return await readLimitedBundleArchiveStream(stream);
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "bundle archive is not valid gzip" },
        400,
      ),
    };
  }
}

async function readLimitedBundleArchiveStream(
  stream: ReadableStream<Uint8Array>,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; response: Response }
> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    length += value.byteLength;
    if (length > MAX_BUNDLE_TAR_BYTES) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      return {
        ok: false,
        response: jsonResponse({ error: "bundle archive is too large" }, 413),
      };
    }
    chunks.push(value);
  }
  reader.releaseLock();

  return { ok: true, bytes: concatUint8Arrays(chunks, length) };
}

function concatUint8Arrays(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === length) {
    return chunks[0];
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type TarInspectionResult =
  | { ok: true; files: Set<string> }
  | { ok: false; error: string };

function inspectTarArchive(bytes: Uint8Array): TarInspectionResult {
  if (bytes.length === 0) {
    return {
      ok: false,
      error: "bundle archive tar is empty",
    };
  }

  const files = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;

    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) {
        break;
      }
      continue;
    }
    zeroBlocks = 0;

    const path = tarHeaderPath(header);
    if (!path || !isSafeBundleArchivePath(path)) {
      return { ok: false, error: "bundle archive contains an unsafe path" };
    }
    if (!hasValidTarHeaderChecksum(header)) {
      return { ok: false, error: "bundle archive contains an invalid header" };
    }

    const size = tarHeaderSize(header);
    if (size === null) {
      return { ok: false, error: "bundle archive contains an invalid size" };
    }
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const dataEnd = offset + size;
    const paddedEnd = offset + paddedSize;
    if (dataEnd > bytes.length || paddedEnd > bytes.length) {
      return { ok: false, error: "bundle archive is truncated" };
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "\0" || typeflag === "0") {
      files.add(path);
    } else if (typeflag === "5") {
      // Directory entry.
    } else {
      return {
        ok: false,
        error: "bundle archive contains an unsupported entry type",
      };
    }

    offset = paddedEnd;
  }

  if (zeroBlocks < 2) {
    return { ok: false, error: "bundle archive is missing tar terminator" };
  }
  if (files.size === 0) {
    return { ok: false, error: "bundle archive contains no files" };
  }

  return { ok: true, files };
}

function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function tarHeaderPath(header: Uint8Array): string | null {
  const name = tarHeaderString(header.subarray(0, 100));
  const prefix = tarHeaderString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  return path || null;
}

function tarHeaderString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return textDecoder.decode(bytes.subarray(0, end)).trim();
}

function tarHeaderSize(header: Uint8Array): number | null {
  const raw = tarHeaderString(header.subarray(124, 136)).replace(/\0/g, "");
  if (!/^[0-7]*$/.test(raw)) return null;
  const size = raw ? Number.parseInt(raw, 8) : 0;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function hasValidTarHeaderChecksum(header: Uint8Array): boolean {
  const expected = tarHeaderChecksumValue(header);
  return expected !== null && expected === tarHeaderChecksum(header);
}

function tarHeaderChecksumValue(header: Uint8Array): number | null {
  const raw = tarHeaderString(header.subarray(148, 156)).replace(/\0/g, "");
  if (!/^[0-7]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tarHeaderChecksum(header: Uint8Array): number {
  return header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );
}

function isSafeBundleArchivePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function requiredBundlePaths(meta: ImageBuildBundleMeta): string[] {
  return [
    "base-images.hcl",
    "build-tools.hcl",
    ...meta.scenarios.map(
      (scenario) => `scenarios/${scenario.scenarioId}/scenario.hcl`,
    ),
  ];
}

async function requireBuilderAgentRequest(
  request: Request,
  env: Cloudflare.Env,
) {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified;
  if (verified.agent.role !== "builder") {
    return {
      ok: false as const,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  return verified;
}

function validateManifest(manifest: ScenarioManifestV3): Response | null {
  if (manifest.schema_version !== 3) {
    return jsonResponse({ error: "manifest schema_version must be 3" }, 400);
  }
  const scenarioId = manifest.scenario_id?.trim();
  if (!scenarioId) {
    return jsonResponse({ error: "manifest scenario_id is required" }, 400);
  }
  if (!isSafeRegistrySlug(scenarioId)) {
    return jsonResponse({ error: "manifest scenario_id is invalid" }, 400);
  }
  if (!hasValidScenarioMetadata(manifest, scenarioId)) {
    return jsonResponse(
      { error: "manifest contains invalid scenario metadata" },
      400,
    );
  }
  if (!hasValidHintList(manifest.hints)) {
    return jsonResponse(
      { error: "manifest contains invalid scenario hints" },
      400,
    );
  }
  if (!Array.isArray(manifest.vms) || manifest.vms.length === 0) {
    return jsonResponse(
      { error: "manifest must contain at least one vm" },
      400,
    );
  }
  const vmNames = new Set<string>();
  const imageKeys = new Set<string>();
  for (const vm of manifest.vms) {
    const vmName = vm.name?.trim();
    if (!vmName || !isSafeRegistrySlug(vmName) || !isImageKey(vm.image_key)) {
      return jsonResponse({ error: "manifest contains an invalid vm" }, 400);
    }
    if (!hasValidVmResources(vm)) {
      return jsonResponse(
        { error: "manifest contains invalid vm resources" },
        400,
      );
    }
    if (vmNames.has(vmName)) {
      return jsonResponse(
        { error: "manifest contains duplicate vm names" },
        400,
      );
    }
    vmNames.add(vmName);
    if (vm.image_key.scenario !== scenarioId || vm.image_key.vm !== vmName) {
      return jsonResponse(
        { error: "manifest image key must match scenario and vm names" },
        400,
      );
    }
    if (!normalizeSha256(vm.image_sha256)) {
      return jsonResponse(
        { error: "manifest contains invalid image sha256" },
        400,
      );
    }
    const imageKey = registryImageKey(vm.image_key);
    if (imageKeys.has(imageKey)) {
      return jsonResponse(
        { error: "manifest contains duplicate image keys" },
        400,
      );
    }
    imageKeys.add(imageKey);
    const kernelSha256 = normalizeSha256(vm.boot?.kernel_sha256 ?? "");
    const initrdSha256 = normalizeSha256(vm.boot?.initrd_sha256 ?? "");
    const bootCmdline = vm.boot?.cmdline?.trim() ?? "";
    if (
      vm.image_format !== "raw_zstd" ||
      typeof vm.image_virtual_size_bytes !== "number" ||
      !Number.isSafeInteger(vm.image_virtual_size_bytes) ||
      vm.image_virtual_size_bytes <= 0 ||
      !kernelSha256 ||
      !initrdSha256 ||
      !isDirectBootCmdline(bootCmdline)
    ) {
      return jsonResponse(
        { error: "manifest contains invalid boot metadata" },
        400,
      );
    }
    const probeError = validateVmProbes(vm.probes);
    if (probeError) {
      return probeError;
    }
  }
  return null;
}

function isDirectBootCmdline(value: string): boolean {
  return value.split(/\s+/).includes("root=/dev/vda");
}

function normalizePublishManifest(
  manifest: ScenarioManifestV3,
): ScenarioManifestV3 {
  const scenarioId = manifest.scenario_id.trim();
  return {
    ...manifest,
    scenario_id: scenarioId,
    name: scenarioId,
    vms: manifest.vms.map((vm) => {
      const vmName = vm.name.trim();
      return {
        ...vm,
        name: vmName,
        image_key: {
          ...vm.image_key,
          scenario: scenarioId,
          vm: vmName,
        },
        image_sha256: normalizeSha256(vm.image_sha256) ?? vm.image_sha256,
        boot: {
          ...vm.boot,
          kernel_sha256:
            normalizeSha256(vm.boot.kernel_sha256) ?? vm.boot.kernel_sha256,
          initrd_sha256:
            normalizeSha256(vm.boot.initrd_sha256) ?? vm.boot.initrd_sha256,
          cmdline: vm.boot.cmdline.trim(),
        },
      };
    }),
  };
}

function hasValidScenarioMetadata(
  manifest: ScenarioManifestV3,
  scenarioId: string,
): boolean {
  return (
    readString(manifest.name) === scenarioId &&
    Boolean(readString(manifest.title)) &&
    Boolean(readString(manifest.description)) &&
    isScenarioDifficulty(manifest.difficulty) &&
    isPositiveU32(manifest.estimated_minutes) &&
    Array.isArray(manifest.tags) &&
    manifest.tags.every((tag) => Boolean(readString(tag))) &&
    Boolean(readString(manifest.briefing_markdown)) &&
    Boolean(readString(manifest.solution_markdown))
  );
}

function hasValidVmResources(vm: ScenarioVmManifestV3): boolean {
  return (
    isPositiveU32(vm.cpu_millis) &&
    isPositiveU16(vm.vcpu_count) &&
    vm.cpu_millis <= vm.vcpu_count * 1000 &&
    isPositiveU32(vm.memory_mib) &&
    isPositiveU32(vm.disk_mib)
  );
}

function validateVmProbes(probes: ScenarioProbeManifestV3[]): Response | null {
  if (!Array.isArray(probes)) {
    return jsonResponse({ error: "manifest contains an invalid probe" }, 400);
  }
  const probeIds = new Set<string>();
  for (const probe of probes) {
    const probeId = readString(probe.id);
    if (
      !probeId ||
      !isSafeRegistrySlug(probeId) ||
      probeIds.has(probeId) ||
      !isProbePhase(probe.phase) ||
      !readString(probe.kind) ||
      !readString(probe.display_name) ||
      !isOptionalString(probe.title) ||
      !isOptionalString(probe.body_markdown)
    ) {
      return jsonResponse({ error: "manifest contains an invalid probe" }, 400);
    }
    probeIds.add(probeId);
    if (!hasValidHintList(probe.hints)) {
      return jsonResponse(
        { error: "manifest contains invalid probe hints" },
        400,
      );
    }
  }
  return null;
}

function hasValidHintList(hints: ScenarioHintManifestV3[]): boolean {
  if (!Array.isArray(hints)) {
    return false;
  }
  const ids = new Set<string>();
  for (const hint of hints) {
    const id = readString(hint.id);
    if (
      !id ||
      !isSafeRegistrySlug(id) ||
      ids.has(id) ||
      !isOptionalString(hint.title) ||
      !readString(hint.body_markdown)
    ) {
      return false;
    }
    ids.add(id);
  }
  return true;
}

function imageFileForVm(form: FormData, vm: ScenarioVmManifestV3): File | null {
  const field = form.get(`image:${vm.name}`);
  if (field instanceof File) return field;

  const imageKey = `${registryImageKey(vm.image_key)}.raw.zst`;
  for (const entry of form.getAll("image")) {
    if (entry instanceof File && entry.name === imageKey) {
      return entry;
    }
  }

  return null;
}

function artifactFileForSha(form: FormData, sha256: string): File | null {
  const field = form.get(`artifact:${sha256}`);
  if (field instanceof File) return field;

  for (const entry of form.getAll("artifact")) {
    if (entry instanceof File && artifactFilenameMatches(entry.name, sha256)) {
      return entry;
    }
  }

  return null;
}

function artifactFilenameMatches(filename: string, sha256: string): boolean {
  return filename === sha256 || filename === `${sha256}.artifact`;
}

function bootArtifactSha256s(manifest: ScenarioManifestV3): string[] {
  const values = new Set<string>();
  for (const vm of manifest.vms) {
    const kernelSha256 = normalizeSha256(vm.boot.kernel_sha256);
    const initrdSha256 = normalizeSha256(vm.boot.initrd_sha256);
    if (kernelSha256) values.add(kernelSha256);
    if (initrdSha256) values.add(initrdSha256);
  }
  return [...values].sort();
}

function isImageKey(value: unknown): value is ImageKey {
  const maybe = value as Partial<ImageKey> | null;
  return Boolean(
    maybe &&
    typeof maybe.scenario === "string" &&
    typeof maybe.vm === "string" &&
    isImageArchitecture(maybe.arch),
  );
}

function isImageArchitecture(value: unknown): value is ImageArchitecture {
  return value === "x86_64" || value === "aarch64";
}

function isScenarioDifficulty(value: unknown): boolean {
  return value === "easy" || value === "medium" || value === "hard";
}

function isProbePhase(value: unknown): boolean {
  return value === "boot" || value === "scenario";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveU16(value: unknown): boolean {
  return isPositiveInteger(value) && value <= 0xffff;
}

function isPositiveU32(value: unknown): boolean {
  return isPositiveInteger(value) && value <= 0xffff_ffff;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function registryImageKey(imageKey: ImageKey): string {
  return `${safeSlug(imageKey.scenario)}-${safeSlug(imageKey.vm)}-${imageKey.arch}`;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function imageObjectKey(imageKey: string, sha256: string): string {
  return `images/${imageKey}/${sha256}.raw.zst`;
}

function artifactObjectKey(sha256: string): string {
  return `artifacts/${sha256}`;
}

function bundleObjectKey(rev: string): string {
  return `builds/bundles/${rev}.tar.gz`;
}

function normalizeSha256(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : null;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeBundleRev(value: string): boolean {
  return (
    value !== "." && value !== ".." && /^[A-Za-z0-9._-]{1,128}$/.test(value)
  );
}

function isSafeRegistrySlug(value: string): boolean {
  return isSafeBundleRev(value);
}

function isSafeKinoVersion(value: string): boolean {
  return (
    value !== "." &&
    value !== ".." &&
    value.length > 0 &&
    !/[\s/\\]/.test(value)
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
