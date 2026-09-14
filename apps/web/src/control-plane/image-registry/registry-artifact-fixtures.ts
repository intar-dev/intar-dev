import { REGISTRY_ADMISSION_KEY } from "@/lib/image-registry-admission";
import { canonicalImageChunkManifest } from "./chunks";

/**
 * Real registry artifacts for worker tests.
 *
 * The cleanup sweep verifies every retained object, and a chunked image is
 * proven by hashing its manifest body, so a fixture cannot invent ids: this
 * helper derives them from the bytes it stores. A test that seeds through here
 * exercises the same verification that production runs.
 */

export interface SeededChunkedImage {
  imageId: string;
  /** The virtual size the manifest declares; a pointer row must match it. */
  virtualSizeBytes: number;
  chunkManifestSha256: string;
  objectKey: string;
  chunkRawSha256: string;
  kernelSha256: string;
  initrdSha256: string;
}

const encoder = new TextEncoder();

export async function sha256HexOf(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A deterministic sha256-shaped id derived from a label. */
export async function sha256OfLabel(label: string): Promise<string> {
  return sha256HexOf(encoder.encode(label));
}

export interface SeedChunkedImageOptions {
  label: string;
  /** Virtual size in bytes. Defaults to one 4 KiB image. */
  virtualSizeBytes?: number;
}

const DEFAULT_VIRTUAL_SIZE_BYTES = 4_096;

export async function seedChunkedImage(
  bucket: R2Bucket,
  options: SeedChunkedImageOptions,
): Promise<SeededChunkedImage> {
  const chunkRawSha256 = await sha256OfLabel(options.label + ":chunk");
  const chunkObjectKey = "image-chunks/v1/zstd6/" + chunkRawSha256;
  await bucket.put(chunkObjectKey, new Uint8Array([1, 2, 3, 4]));

  const virtualSizeBytes =
    options.virtualSizeBytes ?? DEFAULT_VIRTUAL_SIZE_BYTES;
  const manifest = await canonicalImageChunkManifest({
    virtualSizeBytes,
    chunkRawSha256s: [chunkRawSha256],
  });
  const body = JSON.stringify(manifest);
  const bodyBytes = encoder.encode(body);
  const chunkManifestSha256 = await sha256HexOf(bodyBytes);
  const objectKey = "image-manifests/v1/" + chunkManifestSha256 + ".json";
  // The publish path verifies all three of these fields before it accepts a
  // pre-uploaded manifest, so a fixture must satisfy the real check.
  await bucket.put(objectKey, bodyBytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      manifest_sha256: chunkManifestSha256,
      image_id: manifest.image_id,
      virtual_size_bytes: String(virtualSizeBytes),
    },
  });

  return {
    imageId: manifest.image_id,
    virtualSizeBytes,
    chunkManifestSha256,
    objectKey,
    chunkRawSha256,
    kernelSha256: await seedBootArtifact(bucket, options.label + ":kernel"),
    initrdSha256: await seedBootArtifact(bucket, options.label + ":initrd"),
  };
}

export async function seedBootArtifact(
  bucket: R2Bucket,
  label: string,
): Promise<string> {
  const sha256 = await sha256OfLabel(label);
  // The publish path reuses an artifact only when this metadata matches, so a
  // fixture that omits it would force an upload instead.
  await bucket.put("artifacts/" + sha256, encoder.encode(label), {
    customMetadata: { artifact_sha256: sha256 },
  });
  return sha256;
}

/** Seeds the legacy raw object a pre-chunked pointer names. */
export async function seedLegacyImage(
  bucket: R2Bucket,
  input: { scenario: string; vm: string; arch: string; sha256: string },
): Promise<string> {
  const key =
    "images/" +
    input.scenario +
    "-" +
    input.vm +
    "-" +
    input.arch +
    "/" +
    input.sha256 +
    ".raw.zst";
  await bucket.put(key, encoder.encode("legacy"));
  return key;
}

/**
 * Deletes happen only under enforcement, exactly as in production. A test that
 * expects the sweep to remove objects must enable it.
 */
export async function enableRegistryDeletion(db: D1Database): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO image_registry_admission (key, protocol_version, enforcement, epoch, state, updated_at) VALUES (?1, 1, 'enforce', 0, 'open', ?2)",
    )
    .bind(REGISTRY_ADMISSION_KEY, Date.now())
    .run();
  await db
    .prepare(
      "UPDATE image_registry_admission SET enforcement = 'enforce' WHERE key = ?1",
    )
    .bind(REGISTRY_ADMISSION_KEY)
    .run();
}
