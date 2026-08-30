import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import type {
  ImageChunkManifestV1,
  ImageChunkV1,
} from "@/generated/catalog";
import { requireBlobUploadAuth } from "./uploads";
import {
  isRecord,
  jsonResponse,
  normalizeSha256,
  readString,
  sha256Hex,
  textEncoder,
} from "./shared";

const CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED_CHUNK_BYTES = CHUNK_SIZE_BYTES * 2;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_EXISTS_HASHES = 512;
const HEAD_BATCH_SIZE = 64;
const IMAGE_CHUNK_ENCODING = "zstd-v1-level-6";
const FULL_ZERO_CHUNK_SHA256 =
  "bb9f8df61474d25e71fa00722318cd387396ca1736605e1248821cc0de3d3af8";

export function imageChunkObjectKey(rawSha256: string): string {
  return `image-chunks/v1/zstd6/${rawSha256}`;
}

export function imageManifestObjectKey(manifestSha256: string): string {
  return `image-manifests/v1/${manifestSha256}.json`;
}

export async function handleImageChunkExists(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  const body = await readJsonRecord(request);
  if (!body.ok) return body.response;
  if (
    !Array.isArray(body.value.raw_sha256) ||
    body.value.raw_sha256.length > MAX_EXISTS_HASHES
  ) {
    return jsonResponse({ error: "raw_sha256 must contain at most 512 hashes" }, 400);
  }
  const hashes: string[] = [];
  for (const raw of body.value.raw_sha256) {
    const hash = normalizeSha256(readString(raw) ?? "");
    if (!hash) {
      return jsonResponse({ error: "raw_sha256 contains an invalid hash" }, 400);
    }
    hashes.push(hash);
  }

  const existing: Array<Omit<ImageChunkV1, "index">> = [];
  for (const batch of batches(hashes, HEAD_BATCH_SIZE)) {
    const objects = await Promise.all(
      batch.map((hash) => env.VM_IMAGE_REGISTRY_BUCKET.head(imageChunkObjectKey(hash))),
    );
    objects.forEach((object, index) => {
      const hash = batch[index];
      const descriptor = hash ? chunkObjectDescriptor(object, hash) : null;
      if (descriptor) existing.push(descriptor);
    });
  }
  return jsonResponse({ existing });
}

export async function handleImageChunkUpload(
  request: Request,
  env: Cloudflare.Env,
  pathRawSha256: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  const rawSha256 = normalizeSha256(pathRawSha256);
  const headerRawSha256 = normalizeSha256(
    request.headers.get("x-intar-raw-sha256") ?? "",
  );
  const encodedSha256 = normalizeSha256(
    request.headers.get("x-intar-encoded-sha256") ?? "",
  );
  const rawSizeBytes = parsePositiveIntegerHeader(request, "x-intar-raw-size");
  const encodedSizeBytes = parsePositiveIntegerHeader(
    request,
    "x-intar-encoded-size",
  );
  if (
    !rawSha256 ||
    headerRawSha256 !== rawSha256 ||
    !encodedSha256 ||
    rawSizeBytes === null ||
    rawSizeBytes > CHUNK_SIZE_BYTES ||
    encodedSizeBytes === null ||
    encodedSizeBytes > MAX_ENCODED_CHUNK_BYTES
  ) {
    return jsonResponse({ error: "invalid image chunk metadata" }, 400);
  }

  const payload = await request.arrayBuffer();
  if (payload.byteLength !== encodedSizeBytes) {
    return jsonResponse({ error: "encoded image chunk size mismatch" }, 400);
  }
  if ((await sha256Hex(payload)) !== encodedSha256) {
    return jsonResponse({ error: "encoded image chunk SHA-256 mismatch" }, 400);
  }

  const objectKey = imageChunkObjectKey(rawSha256);
  const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
  if (existing) {
    if (
      chunkObjectMatchesDescriptor(existing, {
        index: 0,
        raw_size_bytes: rawSizeBytes,
        raw_sha256: rawSha256,
        encoded_size_bytes: encodedSizeBytes,
        encoded_sha256: encodedSha256,
      })
    ) {
      return jsonResponse({ ok: true, object_key: objectKey, already_exists: true });
    }
    return jsonResponse({ error: "immutable image chunk already differs" }, 409);
  }

  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "application/zstd" },
    customMetadata: {
      raw_sha256: rawSha256,
      encoded_sha256: encodedSha256,
      raw_size_bytes: String(rawSizeBytes),
      encoded_size_bytes: String(encodedSizeBytes),
      encoding: IMAGE_CHUNK_ENCODING,
    },
  });
  return jsonResponse({ ok: true, object_key: objectKey, already_exists: false }, 201);
}

export async function handleImageManifestUpload(
  request: Request,
  env: Cloudflare.Env,
  pathManifestSha256: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;
  const manifestSha256 = normalizeSha256(pathManifestSha256);
  const headerSha256 = normalizeSha256(
    request.headers.get("x-intar-manifest-sha256") ?? "",
  );
  if (!manifestSha256 || headerSha256 !== manifestSha256) {
    return jsonResponse({ error: "invalid image manifest SHA-256" }, 400);
  }

  const payload = await request.arrayBuffer();
  if (payload.byteLength === 0 || payload.byteLength > 4 * 1024 * 1024) {
    return jsonResponse({ error: "invalid image manifest size" }, 400);
  }
  if ((await sha256Hex(payload)) !== manifestSha256) {
    return jsonResponse({ error: "image manifest SHA-256 mismatch" }, 400);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return jsonResponse({ error: "image manifest must be valid JSON" }, 400);
  }
  const validated = await validateImageChunkManifest(decoded);
  if (!validated.ok) return validated.response;

  for (const batch of batches(validated.value.chunks, HEAD_BATCH_SIZE)) {
    const objects = await Promise.all(
      batch.map((chunk) =>
        env.VM_IMAGE_REGISTRY_BUCKET.head(imageChunkObjectKey(chunk.raw_sha256)),
      ),
    );
    for (let index = 0; index < batch.length; index += 1) {
      const chunk = batch[index];
      if (!chunk || !chunkObjectMatchesDescriptor(objects[index] ?? null, chunk)) {
        return jsonResponse(
          { error: `missing or mismatched image chunk at index ${chunk?.index ?? -1}` },
          409,
        );
      }
    }
  }

  const objectKey = imageManifestObjectKey(manifestSha256);
  const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
  if (existing) {
    const metadata = existing.customMetadata ?? {};
    if (
      metadata.manifest_sha256 === manifestSha256 &&
      metadata.image_id === validated.value.image_id &&
      existing.size === payload.byteLength
    ) {
      return jsonResponse({ ok: true, object_key: objectKey, already_exists: true });
    }
    return jsonResponse({ error: "immutable image manifest already differs" }, 409);
  }
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      manifest_sha256: manifestSha256,
      image_id: validated.value.image_id,
      virtual_size_bytes: String(validated.value.virtual_size_bytes),
      chunk_size_bytes: String(CHUNK_SIZE_BYTES),
      encoding: IMAGE_CHUNK_ENCODING,
    },
  });
  return jsonResponse({ ok: true, object_key: objectKey, already_exists: false }, 201);
}

export async function handleAgentImageChunkDownload(
  request: Request,
  env: Cloudflare.Env,
  rawSha256: string,
): Promise<Response> {
  return handleAgentImmutableDownload(
    request,
    env,
    imageChunkObjectKey(rawSha256),
    "application/zstd",
  );
}

export async function handleAgentImageManifestDownload(
  request: Request,
  env: Cloudflare.Env,
  manifestSha256: string,
): Promise<Response> {
  return handleAgentImmutableDownload(
    request,
    env,
    imageManifestObjectKey(manifestSha256),
    "application/json",
  );
}

export async function handleAgentToolsDiskDownload(
  request: Request,
  env: Cloudflare.Env,
  toolsDiskSha256: string,
): Promise<Response> {
  return handleAgentImmutableDownload(
    request,
    env,
    `guest-tools/scenario/disks/${toolsDiskSha256}.ext4.zst`,
    "application/zstd",
  );
}

async function handleAgentImmutableDownload(
  request: Request,
  env: Cloudflare.Env,
  objectKey: string,
  contentType: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!object) return jsonResponse({ error: "object not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
    },
  });
}

export async function validateImageChunkManifest(
  value: unknown,
): Promise<
  | { ok: true; value: ImageChunkManifestV1 }
  | { ok: false; response: Response }
> {
  if (!isRecord(value)) return invalidManifest("manifest must be an object");
  if (
    value.schema_version !== 1 ||
    value.chunk_size_bytes !== CHUNK_SIZE_BYTES ||
    value.encoding !== IMAGE_CHUNK_ENCODING ||
    typeof value.virtual_size_bytes !== "number" ||
    !Number.isSafeInteger(value.virtual_size_bytes) ||
    value.virtual_size_bytes <= 0 ||
    value.virtual_size_bytes > MAX_IMAGE_BYTES ||
    !normalizeSha256(readString(value.image_id) ?? "") ||
    !Array.isArray(value.chunks)
  ) {
    return invalidManifest("invalid image manifest header");
  }

  const virtualSizeBytes = value.virtual_size_bytes;
  const chunkCount = Math.ceil(virtualSizeBytes / CHUNK_SIZE_BYTES);
  const finalChunkSize = virtualSizeBytes % CHUNK_SIZE_BYTES || CHUNK_SIZE_BYTES;
  const finalZeroSha256 =
    finalChunkSize === CHUNK_SIZE_BYTES
      ? FULL_ZERO_CHUNK_SHA256
      : await sha256Hex(new Uint8Array(finalChunkSize).buffer);
  const chunks: ImageChunkV1[] = [];
  let previousIndex = -1;
  for (const rawChunk of value.chunks) {
    if (!isRecord(rawChunk)) return invalidManifest("invalid image chunk entry");
    const rawSha256 = normalizeSha256(readString(rawChunk.raw_sha256) ?? "");
    const encodedSha256 = normalizeSha256(
      readString(rawChunk.encoded_sha256) ?? "",
    );
    if (
      typeof rawChunk.index !== "number" ||
      !Number.isSafeInteger(rawChunk.index) ||
      rawChunk.index <= previousIndex ||
      rawChunk.index >= chunkCount ||
      typeof rawChunk.raw_size_bytes !== "number" ||
      !Number.isSafeInteger(rawChunk.raw_size_bytes) ||
      rawChunk.raw_size_bytes !==
        (rawChunk.index === chunkCount - 1 ? finalChunkSize : CHUNK_SIZE_BYTES) ||
      typeof rawChunk.encoded_size_bytes !== "number" ||
      !Number.isSafeInteger(rawChunk.encoded_size_bytes) ||
      rawChunk.encoded_size_bytes <= 0 ||
      rawChunk.encoded_size_bytes > MAX_ENCODED_CHUNK_BYTES ||
      !rawSha256 ||
      !encodedSha256
    ) {
      return invalidManifest("invalid image chunk entry");
    }
    const zeroSha256 =
      rawChunk.index === chunkCount - 1 ? finalZeroSha256 : FULL_ZERO_CHUNK_SHA256;
    if (rawSha256 === zeroSha256) {
      return invalidManifest("zero chunks must be represented as sparse holes");
    }
    previousIndex = rawChunk.index;
    chunks.push({
      index: rawChunk.index,
      raw_size_bytes: rawChunk.raw_size_bytes,
      raw_sha256: rawSha256,
      encoded_size_bytes: rawChunk.encoded_size_bytes,
      encoded_sha256: encodedSha256,
    });
  }

  const manifest: ImageChunkManifestV1 = {
    schema_version: 1,
    image_id: normalizeSha256(String(value.image_id))!,
    virtual_size_bytes: virtualSizeBytes,
    chunk_size_bytes: CHUNK_SIZE_BYTES,
    encoding: IMAGE_CHUNK_ENCODING,
    chunks,
  };
  if ((await computeImageId(manifest, finalZeroSha256)) !== manifest.image_id) {
    return invalidManifest("image_id does not match ordered raw chunks");
  }
  return { ok: true, value: manifest };
}

async function computeImageId(
  manifest: ImageChunkManifestV1,
  finalZeroSha256: string,
): Promise<string> {
  const domain = textEncoder.encode("intar-raw-chunks-v1\0");
  const chunkCount = Math.ceil(manifest.virtual_size_bytes / CHUNK_SIZE_BYTES);
  const bytes = new Uint8Array(domain.length + 8 + 4 + chunkCount * 40);
  bytes.set(domain, 0);
  const view = new DataView(bytes.buffer);
  let offset = domain.length;
  view.setBigUint64(offset, BigInt(manifest.virtual_size_bytes), true);
  offset += 8;
  view.setUint32(offset, CHUNK_SIZE_BYTES, true);
  offset += 4;
  let descriptorIndex = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const rawSize =
      index === chunkCount - 1
        ? manifest.virtual_size_bytes - index * CHUNK_SIZE_BYTES
        : CHUNK_SIZE_BYTES;
    const descriptor = manifest.chunks[descriptorIndex];
    let digest: string;
    if (descriptor?.index === index) {
      digest = descriptor.raw_sha256;
      descriptorIndex += 1;
    } else {
      digest =
        index === chunkCount - 1
          ? finalZeroSha256
          : FULL_ZERO_CHUNK_SHA256;
    }
    view.setUint32(offset, index, true);
    view.setUint32(offset + 4, rawSize, true);
    bytes.set(hexToBytes(digest), offset + 8);
    offset += 40;
  }
  return sha256Hex(bytes.buffer);
}

function chunkObjectMatchesRawHash(object: R2Object | null, rawSha256: string): boolean {
  return chunkObjectDescriptor(object, rawSha256) !== null;
}

function chunkObjectDescriptor(
  object: R2Object | null,
  rawSha256: string,
): Omit<ImageChunkV1, "index"> | null {
  const metadata = object?.customMetadata;
  const encodedSha256 = normalizeSha256(metadata?.encoded_sha256 ?? "");
  const rawSizeBytes = Number(metadata?.raw_size_bytes);
  const encodedSizeBytes = Number(metadata?.encoded_size_bytes);
  if (
    !object ||
    metadata?.raw_sha256 !== rawSha256 ||
    metadata.encoding !== IMAGE_CHUNK_ENCODING ||
    !encodedSha256 ||
    !Number.isSafeInteger(rawSizeBytes) ||
    rawSizeBytes <= 0 ||
    rawSizeBytes > CHUNK_SIZE_BYTES ||
    !Number.isSafeInteger(encodedSizeBytes) ||
    encodedSizeBytes <= 0 ||
    encodedSizeBytes > MAX_ENCODED_CHUNK_BYTES ||
    object.size !== encodedSizeBytes
  ) {
    return null;
  }
  return {
    raw_sha256: rawSha256,
    raw_size_bytes: rawSizeBytes,
    encoded_sha256: encodedSha256,
    encoded_size_bytes: encodedSizeBytes,
  };
}

function chunkObjectMatchesDescriptor(
  object: R2Object | null,
  chunk: ImageChunkV1,
): boolean {
  return Boolean(
    chunkObjectMatchesRawHash(object, chunk.raw_sha256) &&
      object?.customMetadata?.encoded_sha256 === chunk.encoded_sha256 &&
      object.customMetadata?.raw_size_bytes === String(chunk.raw_size_bytes) &&
      object.customMetadata?.encoded_size_bytes ===
        String(chunk.encoded_size_bytes) &&
      object.size === chunk.encoded_size_bytes,
  );
}

function parsePositiveIntegerHeader(request: Request, name: string): number | null {
  const value = Number(request.headers.get(name));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function readJsonRecord(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return { ok: false, response: jsonResponse({ error: "JSON body is required" }, 400) };
  }
  return isRecord(value)
    ? { ok: true, value }
    : { ok: false, response: jsonResponse({ error: "JSON body is required" }, 400) };
}

function invalidManifest(message: string): { ok: false; response: Response } {
  return { ok: false, response: jsonResponse({ error: message }, 400) };
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function batches<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
