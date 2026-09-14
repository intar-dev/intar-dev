import {
  ARTIFACT_PREFIX,
  IMAGE_CHUNK_PREFIX,
  IMAGE_MANIFEST_PREFIX,
  IMAGE_PREFIX,
  applyRegistryRetention,
  imageObjectKey,
  projectRegistryRetention,
  type ImageRoot,
  type RegistryRetentionProjection,
} from "@/lib/image-artifact-retention";
import {
  acquireRegistrySweep,
  assertRegistrySweepDeletable,
  finishRegistrySweep,
  heartbeatRegistrySweep,
  readRegistryAdmissionState,
  recordRegistryGcProgress,
} from "@/lib/image-registry-admission";
import { sha256Hex } from "@/control-plane/image-registry/shared";
import { validateImageChunkManifest } from "@/control-plane/image-registry/chunks";

/**
 * Registry garbage collection: object scan, retained-object verification,
 * delete plan, delete pass.
 *
 * The retention decision has exactly one authority: projectRegistryRetention in
 * image-artifact-retention.ts. This module does not restate that rule. It reads
 * the projection, proves that every object the projection retains is present in
 * the bucket, and deletes the objects inside its four swept prefixes that no
 * reference retains.
 *
 * Swept prefixes, and nothing else:
 *   image-manifests/v1/<sha256>.json
 *   image-chunks/v1/zstd6/<raw sha256>
 *   images/<image-key>/<sha256>.raw.zst and its .sha256 sidecar
 *   artifacts/<sha256>
 *
 * Never touched: builds/** (source bundles and build logs), guest-tools/**, and
 * the separate run-artifacts bucket.
 *
 * Fail closed. Any of these sets a fault, and a fault stops the sweep before its
 * first delete: the artifacts_retired_at marker is unavailable; a retained
 * manifest is absent, unreadable, mismatched, or invalid; a chunk a retained
 * manifest names is absent; a retained image resolves to neither a legacy object
 * nor a verified chunked manifest; a retained boot artifact is absent; the bucket
 * listing stopped before its last page.
 *
 * A pass that commits a retention decision, including the withdrawal of host
 * cache intents, still completes on its own: the plan it executes is built from
 * the projection that carries the decision, so the objects the decision
 * unroots are already its delete worklist. Only a capped or blocked worklist
 * asks for a resume.
 */

export const IMAGE_REGISTRY_CLEANUP_SCHEMA_VERSION = 1;

export type ImageRegistryCleanupMode = "report-only" | "delete";

export interface ImageRegistryCleanupEnv {
  DB: D1Database;
  VM_IMAGE_REGISTRY_BUCKET: R2Bucket;
}

export interface ImageRegistryCleanupInput {
  mode: ImageRegistryCleanupMode;
  nowMs: number;
}

export interface RegistrySweepCounters {
  scannedObjects: number;
  deletedObjects: number;
  blockedObjects: number;
  bytesReclaimed: number;
}

export const DEFAULT_CLEANUP_OWNER = "image-registry-cleanup";
export const DEFAULT_SWEEP_LEASE_MS = 300_000;
export const DEFAULT_CLEANUP_BATCH_SIZE = 200;
export const DEFAULT_CLEANUP_MAX_DELETES = 5_000;
export const DEFAULT_LIST_PAGE_LIMIT = 1_000;
/** R2 accepts at most 1000 keys per list call. */
export const MAX_LIST_PAGE_LIMIT = 1_000;
export const MAX_ASSERT_KEYS = 512;
/** R2 accepts at most 1000 keys per bulk delete call. */
export const MAX_BULK_DELETE_KEYS = 1_000;
/** Bounded delete-key list per run; the digest always covers every key. */
export const MAX_REPORTED_DELETED_KEYS = 5_000;
/**
 * How many candidate keys one plan carries. The plan is the delete worklist and
 * a single RPC-sized list, not a full dump of the bucket: a capped plan deletes
 * up to the cap and asks for a resume, and the next attempt rebuilds the list
 * against a freshly verified keep-set.
 */
export const DEFAULT_CANDIDATE_LIST_LIMIT = 5_000;

export type CleanupObjectKind =
  | "manifest"
  | "chunk"
  | "legacy_image"
  | "legacy_sidecar"
  | "boot_artifact";

/**
 * A manifest goes first: its chunk set can only be proven unshared while the
 * manifest itself still exists. A sidecar follows its image.
 */
export const CLEANUP_DELETE_ORDER: readonly CleanupObjectKind[] = [
  "manifest",
  "legacy_image",
  "legacy_sidecar",
  "chunk",
  "boot_artifact",
];

export interface SweptObject {
  key: string;
  kind: CleanupObjectKind;
  bytes: number;
  sha256: string | null;
  /** Registry image key for legacy objects: <scenario>-<vm>-<arch>. */
  imageKey: string | null;
}

export interface ImageRegistryCleanupFault {
  code: string;
  detail: string;
}

export interface ImageRegistryCleanupPlanObject {
  key: string;
  bytes: number;
  category: CleanupObjectKind;
  [field: string]: unknown;
}

export interface ImageRegistryCleanupPlanDetails {
  faults: ImageRegistryCleanupFault[];
  deleteAllowedByReferences: boolean;
  candidatesByCategory: Record<string, { objects: number; bytes: number }>;
  retainedByCategory: Record<string, { objects: number; bytes: number }>;
  unrecognizedObjects: number;
  /** Keys outside the four swept prefixes: reported, never touched. */
  outOfScopeObjects: number;
  retainedImages: number;
  retainedManifests: number;
  retainedChunks: number;
  retainedBootArtifacts: number;
  /**
   * Legacy objects kept only because their digest is retained by a root that
   * names a different image key. Over-retention is recoverable, a delete is not.
   */
  retainedByDigestOnly: number;
  candidateTotal: number;
  /** True when candidateObjects is a bounded sample of candidateTotal. */
  candidateSampleCapped: boolean;
  /**
   * Deterministic identity of the three key sets a sweep reasons about, so one
   * report can be compared with the next: scanned (whole recognized scope),
   * retained (what a delete must not touch), and candidates (the worklist, always
   * the full count even when candidateObjects is capped).
   */
  keysets: {
    scanned: CleanupKeysetSummary;
    retained: CleanupKeysetSummary;
    candidates: CleanupKeysetSummary;
  };
  projectedRetirements: {
    consumedRetiredBuildIds: number;
    newlyRetiredBuildIds: number;
    trimmedSnapshotIds: number;
    deletedSnapshotIds: number;
    deletedCandidateIds: number;
    /**
     * Cache intents the sweep withdraws before it deletes their objects. A
     * withdrawn intent is what makes its object a candidate on the next pass,
     * so this number is the warm-cache half of the reclaim.
     */
    trimmedHostCacheImageIds: number;
  };
}

export interface ImageRegistryCleanupPlan {
  schemaVersion: typeof IMAGE_REGISTRY_CLEANUP_SCHEMA_VERSION;
  generatedAtMs: number;
  mode: ImageRegistryCleanupMode;
  objectsScanned: number;
  retainedObjects: number;
  candidateObjects: ImageRegistryCleanupPlanObject[];
  candidateBytes: number;
  truncated: boolean;
  details: ImageRegistryCleanupPlanDetails;
}

export interface ImageRegistryCleanupRunResult {
  /**
   * Claimed by the delete calls: objects whose bulk delete returned. The bytes
   * come from the listing, not from a re-read. `verifiedDeletedObjects` and
   * `verifiedDeletedBytes` are the proof of the same work.
   */
  deletedObjects: number;
  deletedBytes: number;
  failedObjects: number;
  skippedObjects: number;
  wouldDeleteObjects: number;
  wouldDeleteBytes: number;
  blockedObjects: number;
  /**
   * The only signal that means "this sweep finished the worklist and proved it".
   * A partial pass, a blocked batch, a failed call, an unproven delete, or a
   * change to the bucket all leave it false.
   */
  completed: boolean;
  /** Plan statistics for the plan this run actually executed. */
  planSummary: ImageRegistryCleanupPlanSummary | null;
  /** The re-listed end state, so a later report can be compared with it. */
  postState: {
    scanned: CleanupKeysetSummary;
    /**
     * The keyset the run expects after its proven deletes: the baseline scan
     * minus exactly the keys it verified absent. Counts and bytes alone cannot
     * tell one key from another, so this digest is what the comparison uses.
     */
    expected: CleanupKeysetSummary;
    /**
     * True only when the post-scan keyset is byte-identical to `expected`:
     * same digest over the same keys, same count, same bytes. Equal-size or
     * equal-count substitution fails here.
     */
    unchanged: boolean;
    truncated: boolean;
    unrecognizedObjects: number;
  } | null;
  /**
   * Deletes this run confirmed absent by re-reading the key. `deletedObjects`
   * counts the delete calls that returned; only these are proof.
   */
  verifiedDeletedObjects: number;
  verifiedDeletedBytes: number;
  /** Deletes that returned but whose key was still present on re-read. */
  unverifiedObjects: number;
  unverifiedKeys: string[];
  /** The verified delete set: bounded list, full-count digest. */
  deletedKeys: string[];
  deletedKeysTruncated: boolean;
  deletedKeysDigest: string;
  resumeRequired: boolean;
  phases: Record<string, number>;
  error: string | null;
}

/**
 * A plan without its key list, for a run result. The collector reports plan
 * metadata from here instead of listing the bucket a second time.
 */
export interface ImageRegistryCleanupPlanSummary {
  schemaVersion: typeof IMAGE_REGISTRY_CLEANUP_SCHEMA_VERSION;
  generatedAtMs: number;
  mode: ImageRegistryCleanupMode;
  objectsScanned: number;
  retainedObjects: number;
  candidateTotal: number;
  candidateBytes: number;
  truncated: boolean;
  details: ImageRegistryCleanupPlanDetails;
}

export function summarizeCleanupPlan(
  plan: ImageRegistryCleanupPlan,
): ImageRegistryCleanupPlanSummary {
  return {
    schemaVersion: plan.schemaVersion,
    generatedAtMs: plan.generatedAtMs,
    mode: plan.mode,
    objectsScanned: plan.objectsScanned,
    retainedObjects: plan.retainedObjects,
    candidateTotal: plan.details.candidateTotal,
    candidateBytes: plan.candidateBytes,
    truncated: plan.truncated,
    details: plan.details,
  };
}

export interface ImageRegistryCleanupCoreOptions {
  owner?: string;
  leaseMs?: number;
  batchSize?: number;
  maxDeletesPerRun?: number;
  listPageLimit?: number;
  /** Candidate keys carried by one plan, which is also one run's worklist. */
  candidateListLimit?: number;
  now?: () => number;
}

const LEGACY_SUFFIX = ".raw.zst";
const SIDECAR_SUFFIX = ".sha256";
const SHA256_RE = /^[a-f0-9]{64}$/;

/** Parses a key inside a swept prefix; null means outside the sweep. */
export function parseSweptObjectKey(
  key: string,
  bytes: number,
): SweptObject | null {
  if (key.startsWith(IMAGE_MANIFEST_PREFIX)) {
    const rest = key.slice(IMAGE_MANIFEST_PREFIX.length);
    const sha256 = rest.endsWith(".json") ? rest.slice(0, -".json".length) : "";
    if (!SHA256_RE.test(sha256)) return null;
    return { key, kind: "manifest", bytes, sha256, imageKey: null };
  }
  if (key.startsWith(IMAGE_CHUNK_PREFIX)) {
    const sha256 = key.slice(IMAGE_CHUNK_PREFIX.length);
    if (!SHA256_RE.test(sha256)) return null;
    return { key, kind: "chunk", bytes, sha256, imageKey: null };
  }
  if (key.startsWith(ARTIFACT_PREFIX)) {
    const sha256 = key.slice(ARTIFACT_PREFIX.length);
    if (!SHA256_RE.test(sha256)) return null;
    return { key, kind: "boot_artifact", bytes, sha256, imageKey: null };
  }
  if (key.startsWith(IMAGE_PREFIX)) {
    const rest = key.slice(IMAGE_PREFIX.length);
    const separator = rest.lastIndexOf("/");
    if (separator <= 0) return null;
    const imageKey = rest.slice(0, separator);
    const filename = rest.slice(separator + 1);
    const sidecar = filename.endsWith(SIDECAR_SUFFIX)
      ? filename.slice(0, -SIDECAR_SUFFIX.length)
      : null;
    const base = sidecar ?? filename;
    const sha256 = base.endsWith(LEGACY_SUFFIX)
      ? base.slice(0, -LEGACY_SUFFIX.length)
      : "";
    if (!SHA256_RE.test(sha256)) return null;
    return {
      key,
      kind: sidecar === null ? "legacy_image" : "legacy_sidecar",
      bytes,
      sha256,
      imageKey,
    };
  }
  return null;
}

interface BucketScan {
  objects: Map<string, SweptObject>;
  unrecognized: number;
  outOfScope: number;
  truncated: boolean;
}

/**
 * One paginated listing is the only source of truth about what exists. The
 * dashboard and the bucket-info command report analytics, not objects.
 */
async function scanBucket(
  bucket: R2Bucket,
  pageLimit: number,
): Promise<BucketScan> {
  const objects = new Map<string, SweptObject>();
  let unrecognized = 0;
  let outOfScope = 0;
  let cursor: string | undefined;
  for (;;) {
    const options: R2ListOptions = cursor
      ? { limit: pageLimit, cursor }
      : { limit: pageLimit };
    const page = await bucket.list(options);
    for (const object of page.objects) {
      const parsed = parseSweptObjectKey(object.key, object.size);
      if (parsed) {
        objects.set(parsed.key, parsed);
        continue;
      }
      // It parsed as neither a swept key nor a recognizable prefix, so it is a
      // malformed key inside the sweep when its prefix is one the sweep owns, and
      // simply out of scope otherwise. Either way it is reported, never touched.
      if (
        object.key.startsWith(IMAGE_MANIFEST_PREFIX) ||
        object.key.startsWith(IMAGE_CHUNK_PREFIX) ||
        object.key.startsWith(ARTIFACT_PREFIX) ||
        object.key.startsWith(IMAGE_PREFIX)
      ) {
        unrecognized += 1;
      } else {
        outOfScope += 1;
      }
    }
    if (!page.truncated) {
      return { objects, unrecognized, outOfScope, truncated: false };
    }
    if (!page.cursor) {
      return { objects, unrecognized, outOfScope, truncated: true };
    }
    cursor = page.cursor;
  }
}

const RETIREMENT_MARKER_FAULT = "retirement_marker_unavailable";
const PROJECTION_FAULT = "retention_projection_unavailable";

/**
 * The retired marker is the only signal that separates a live build from an
 * audit row. Without the column the sweep cannot tell them apart, so it refuses
 * instead of guessing.
 */
async function readRetirementMarkerAvailable(
  env: ImageRegistryCleanupEnv,
): Promise<boolean> {
  try {
    await env.DB.prepare(
      "SELECT artifacts_retired_at FROM image_builds LIMIT 1",
    ).first();
    return true;
  } catch {
    return false;
  }
}

interface RetainedCoverage {
  retainedKeys: Set<string>;
  retainedByDigestOnly: number;
  faults: ImageRegistryCleanupFault[];
}

interface ManifestBody {
  imageId: string;
  chunkRawSha256s: string[];
}

/**
 * The one manifest validator. A retained manifest is the only record of which
 * chunks exist, so it is read with the same rule that published it: full header,
 * ordered indices, per-chunk sizes, and an image_id that matches the Merkle
 * digest over the ordered raw chunks. Anything weaker would let a corrupted
 * manifest vouch for chunks that no longer exist, and the sweep would delete
 * them.
 *
 * A sparse manifest is valid: an empty chunk list with a positive virtual size
 * is a manifest of zero chunks, and it pins no chunk object.
 */
async function readRetainedManifest(
  bytes: ArrayBuffer,
): Promise<{ ok: true; body: ManifestBody } | { ok: false; detail: string }> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, detail: "the body is not valid JSON" };
  }
  const validated = await validateImageChunkManifest(decoded);
  if (!validated.ok) {
    const detail = await readValidationError(validated.response);
    return { ok: false, detail };
  }
  return {
    ok: true,
    body: {
      imageId: validated.value.image_id,
      chunkRawSha256s: validated.value.chunks.map((chunk) => chunk.raw_sha256),
    },
  };
}

/** The validator answers with a JSON error body; its message is the detail. */
async function readValidationError(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the status text.
  }
  return "the manifest failed validation with status " + response.status;
}

function legacyImageKeyOf(root: ImageRoot): string {
  return imageObjectKey(
    { scenario: root.scenarioId, vm: root.vmName, arch: root.arch },
    root.imageId,
  );
}

/**
 * Proves that everything the projection retains is present, and returns the
 * exact key set the sweep must keep. Every retained manifest is read and hashed:
 * a manifest is the only record of which chunks exist, so its body decides
 * whether its chunks may go.
 */
async function verifyRetainedObjects(
  env: ImageRegistryCleanupEnv,
  projection: RegistryRetentionProjection,
  inventory: Map<string, SweptObject>,
): Promise<RetainedCoverage> {
  const faults: ImageRegistryCleanupFault[] = [];
  const retainedKeys = new Set<string>();
  const manifestCoveredImageIds = new Set<string>();

  for (const manifestSha256 of projection.chunkManifestSha256s) {
    const key = IMAGE_MANIFEST_PREFIX + manifestSha256 + ".json";
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key);
    if (!object) {
      faults.push({
        code: inventory.has(key)
          ? "retained_manifest_unreadable"
          : "retained_manifest_missing",
        detail: "a retained image manifest is not readable: " + key,
      });
      continue;
    }
    const bytes = await object.arrayBuffer();
    if ((await sha256Hex(bytes)) !== manifestSha256) {
      faults.push({
        code: "retained_manifest_mismatch",
        detail: "an image manifest body does not match its reference: " + key,
      });
      continue;
    }
    const read = await readRetainedManifest(bytes);
    if (!read.ok) {
      faults.push({
        code: "retained_manifest_invalid",
        detail: "an image manifest is invalid (" + read.detail + "): " + key,
      });
      continue;
    }
    const body = read.body;
    retainedKeys.add(key);
    manifestCoveredImageIds.add(body.imageId);
    for (const rawSha256 of body.chunkRawSha256s) {
      const chunkKey = IMAGE_CHUNK_PREFIX + rawSha256;
      if (!inventory.has(chunkKey)) {
        faults.push({
          code: "retained_chunk_missing",
          detail: "a retained image chunk is not in the bucket: " + chunkKey,
        });
        continue;
      }
      retainedKeys.add(chunkKey);
    }
  }

  for (const root of projection.roots) {
    const key = legacyImageKeyOf(root);
    if (inventory.has(key)) {
      retainedKeys.add(key);
      continue;
    }
    if (manifestCoveredImageIds.has(root.imageId)) continue;
    faults.push({
      code: "retained_image_missing",
      detail:
        "a retained image resolves to neither a legacy object nor a chunked " +
        "manifest: " +
        key,
    });
  }

  const retainedImageIds = new Set(projection.imageIds);
  let retainedByDigestOnly = 0;
  for (const object of inventory.values()) {
    if (object.kind !== "legacy_image" || !object.sha256) continue;
    if (retainedKeys.has(object.key)) continue;
    if (!retainedImageIds.has(object.sha256)) continue;
    retainedKeys.add(object.key);
    retainedByDigestOnly += 1;
  }

  for (const sha256 of projection.bootArtifactSha256s) {
    const key = ARTIFACT_PREFIX + sha256;
    if (!inventory.has(key)) {
      faults.push({
        code: "retained_boot_artifact_missing",
        detail: "a retained boot artifact is not in the bucket: " + key,
      });
      continue;
    }
    retainedKeys.add(key);
  }

  return { retainedKeys, retainedByDigestOnly, faults };
}

interface CandidateSelection {
  candidates: ImageRegistryCleanupPlanObject[];
  candidateBytes: number;
  candidateTotal: number;
  candidatesByCategory: Record<string, { objects: number; bytes: number }>;
  candidateKeysDigest: string;
}

/**
 * Deterministic identity of a key set: object count, byte count, and the SHA-256
 * of every `key<TAB>bytes` line sorted by key. Two runs over one unchanged bucket
 * produce one digest, so an operator can compare a baseline against every later
 * run, including one whose candidate list was capped.
 */
export interface CleanupKeysetSummary {
  objects: number;
  bytes: number;
  digest: string;
}

/** Codepoint order, not locale order: the digest must not depend on the runtime. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function digestKeyLines(lines: readonly string[]): Promise<string> {
  const canonical = lines.join("\n");
  return sha256Hex(
    new TextEncoder().encode(canonical).buffer as ArrayBuffer,
  );
}

async function summarizeKeyset(
  objects: readonly { key: string; bytes: number }[],
): Promise<CleanupKeysetSummary> {
  const ordered = [...objects].sort((left, right) =>
    compareKeys(left.key, right.key),
  );
  let bytes = 0;
  const lines: string[] = [];
  for (const object of ordered) {
    bytes += object.bytes;
    lines.push(object.key + "\t" + object.bytes);
  }
  return {
    objects: ordered.length,
    bytes,
    digest: await digestKeyLines(lines),
  };
}

async function selectCandidates(
  inventory: Map<string, SweptObject>,
  retainedKeys: Set<string>,
  candidateListLimit: number,
): Promise<CandidateSelection> {
  const retained = new Set(retainedKeys);
  for (const key of retainedKeys) {
    // A retained image keeps its own sidecar: the two describe one object.
    if (key.endsWith(LEGACY_SUFFIX)) retained.add(key + SIDECAR_SUFFIX);
  }
  const order = new Map(
    CLEANUP_DELETE_ORDER.map((kind, index) => [kind, index]),
  );
  const objects = [...inventory.values()].sort(
    (left, right) =>
      (order.get(left.kind) ?? 99) - (order.get(right.kind) ?? 99) ||
      left.key.localeCompare(right.key),
  );
  const candidates: ImageRegistryCleanupPlanObject[] = [];
  const candidatesByCategory: Record<string, { objects: number; bytes: number }> = {};
  // The digest covers the whole worklist, never just the capped list.
  const candidateLines: string[] = [];
  let candidateBytes = 0;
  let candidateTotal = 0;
  for (const object of objects) {
    if (retained.has(object.key)) continue;
    candidateTotal += 1;
    candidateBytes += object.bytes;
    candidateLines.push(object.key + "\t" + object.bytes);
    const bucket = candidatesByCategory[object.kind] ?? { objects: 0, bytes: 0 };
    bucket.objects += 1;
    bucket.bytes += object.bytes;
    candidatesByCategory[object.kind] = bucket;
    if (candidates.length < candidateListLimit) {
      candidates.push({
        key: object.key,
        bytes: object.bytes,
        category: object.kind,
        image_key: object.imageKey,
      });
    }
  }
  candidateLines.sort(compareKeys);
  return {
    candidates,
    candidateBytes,
    candidateTotal,
    candidatesByCategory,
    candidateKeysDigest: await digestKeyLines(candidateLines),
  };
}

interface BuiltPlan {
  plan: ImageRegistryCleanupPlan;
  projection: RegistryRetentionProjection | null;
  /**
   * The compact baseline of the recognized scope: key to byte size. The applier
   * keeps it so it can compute the exact keyset it expects after its own proven
   * deletes, instead of trusting equal counts and equal bytes.
   */
  baseline: Map<string, SweptObject>;
}

async function buildPlan(
  env: ImageRegistryCleanupEnv,
  input: ImageRegistryCleanupInput,
  options: { listPageLimit: number; candidateListLimit: number },
): Promise<BuiltPlan> {
  const faults: ImageRegistryCleanupFault[] = [];
  const inventory = await scanBucket(
    env.VM_IMAGE_REGISTRY_BUCKET,
    options.listPageLimit,
  );
  if (inventory.truncated) {
    faults.push({
      code: "listing_truncated",
      detail: "the bucket listing stopped before its last page",
    });
  }
  if (!(await readRetirementMarkerAvailable(env))) {
    faults.push({
      code: RETIREMENT_MARKER_FAULT,
      detail:
        "image_builds.artifacts_retired_at is unavailable, so a retired build " +
        "cannot be told apart from a live one; apply the pending migration " +
        "before sweeping",
    });
  }

  let projection: RegistryRetentionProjection | null = null;
  try {
    projection = await projectRegistryRetention(env, { nowUnixMs: input.nowMs });
  } catch (error) {
    faults.push({
      code: PROJECTION_FAULT,
      detail:
        "the retention projection could not be read: " +
        (error instanceof Error ? error.message : "unknown error"),
    });
  }

  let coverage: RetainedCoverage = {
    retainedKeys: new Set(),
    retainedByDigestOnly: 0,
    faults: [],
  };
  if (projection) {
    coverage = await verifyRetainedObjects(env, projection, inventory.objects);
    faults.push(...coverage.faults);
  }

  const selection = await selectCandidates(
    inventory.objects,
    coverage.retainedKeys,
    options.candidateListLimit,
  );
  const retainedByCategory: Record<string, { objects: number; bytes: number }> = {};
  for (const key of coverage.retainedKeys) {
    const object = inventory.objects.get(key);
    if (!object) continue;
    const bucket = retainedByCategory[object.kind] ?? { objects: 0, bytes: 0 };
    bucket.objects += 1;
    bucket.bytes += object.bytes;
    retainedByCategory[object.kind] = bucket;
  }
  const count = (kind: CleanupObjectKind): number =>
    retainedByCategory[kind]?.objects ?? 0;
  const recognized = [...inventory.objects.values()];
  const retainedObjects = recognized.filter((object) =>
    coverage.retainedKeys.has(object.key),
  );
  const [scannedKeyset, retainedKeyset] = await Promise.all([
    summarizeKeyset(recognized),
    summarizeKeyset(retainedObjects),
  ]);
  const plan: ImageRegistryCleanupPlan = {
    schemaVersion: IMAGE_REGISTRY_CLEANUP_SCHEMA_VERSION,
    generatedAtMs: input.nowMs,
    mode: input.mode,
    objectsScanned: inventory.objects.size,
    retainedObjects: coverage.retainedKeys.size,
    candidateObjects: selection.candidates,
    candidateBytes: selection.candidateBytes,
    truncated: inventory.truncated,
    details: {
      faults,
      deleteAllowedByReferences: faults.length === 0,
      candidatesByCategory: selection.candidatesByCategory,
      retainedByCategory,
      unrecognizedObjects: inventory.unrecognized,
      outOfScopeObjects: inventory.outOfScope,
      retainedImages: count("legacy_image"),
      retainedManifests: count("manifest"),
      retainedChunks: count("chunk"),
      retainedBootArtifacts: count("boot_artifact"),
      retainedByDigestOnly: coverage.retainedByDigestOnly,
      candidateTotal: selection.candidateTotal,
      candidateSampleCapped:
        selection.candidates.length < selection.candidateTotal,
      keysets: {
        scanned: scannedKeyset,
        retained: retainedKeyset,
        candidates: {
          objects: selection.candidateTotal,
          bytes: selection.candidateBytes,
          digest: selection.candidateKeysDigest,
        },
      },
      projectedRetirements: {
        consumedRetiredBuildIds: projection?.builds.retiredBuildIds.length ?? 0,
        newlyRetiredBuildIds: projection?.builds.retireBuildIds.length ?? 0,
        trimmedSnapshotIds: projection?.snapshots.trims.length ?? 0,
        deletedSnapshotIds: projection?.snapshots.deleteIds.length ?? 0,
        deletedCandidateIds: projection?.candidates.retireIds.length ?? 0,
        trimmedHostCacheImageIds:
          projection?.hostCacheTrims.reduce(
            (total, trim) => total + trim.imageIds.length,
            0,
          ) ?? 0,
      },
    },
  };
  return { plan, projection, baseline: inventory.objects };
}

function emptyResult(error: string | null): ImageRegistryCleanupRunResult {
  return {
    deletedObjects: 0,
    deletedBytes: 0,
    failedObjects: 0,
    skippedObjects: 0,
    wouldDeleteObjects: 0,
    wouldDeleteBytes: 0,
    blockedObjects: 0,
    completed: false,
    planSummary: null,
    postState: null,
    verifiedDeletedObjects: 0,
    verifiedDeletedBytes: 0,
    unverifiedObjects: 0,
    unverifiedKeys: [],
    deletedKeys: [],
    deletedKeysTruncated: false,
    deletedKeysDigest: "",
    resumeRequired: false,
    phases: {},
    error,
  };
}

function countersOf(
  plan: ImageRegistryCleanupPlan,
  result: ImageRegistryCleanupRunResult,
): RegistrySweepCounters {
  return {
    scannedObjects: plan.objectsScanned,
    deletedObjects: result.deletedObjects,
    blockedObjects: result.blockedObjects,
    bytesReclaimed: result.deletedBytes,
  };
}

function describeFaults(plan: ImageRegistryCleanupPlan): string | null {
  if (!plan.details.faults.length) return null;
  return plan.details.faults
    .map((fault) => fault.code + ": " + fault.detail)
    .slice(0, 5)
    .join(" | ");
}

/**
 * Deletes the candidates in the fixed order, re-asserting admission before every
 * batch. A batch the gate blocks stops the sweep: a blocked key means a writer
 * exists, and the sweep must not route around it.
 */

export interface CleanupDeleteSelection {
  /** The batches this run will attempt, in delete order. */
  batches: ImageRegistryCleanupPlanObject[][];
  /** Keys this run selected. Keys left out by the budget or the cap are not here. */
  selectedKeyCount: number;
  /** True when the worklist is longer than one run may attempt. */
  resumeRequired: boolean;
}

/**
 * Splits the worklist into bounded batches. This is the only place that decides
 * what one run attempts, so the blocked count can never reach a key the run did
 * not select.
 */
export function planCleanupDeleteSelection(input: {
  candidates: readonly ImageRegistryCleanupPlanObject[];
  batchSize: number;
  maxDeletes: number;
  candidateSampleCapped: boolean;
  faultsPresent: boolean;
}): CleanupDeleteSelection {
  const order = new Map(
    CLEANUP_DELETE_ORDER.map((kind, index) => [kind, index]),
  );
  const ordered = [...input.candidates].sort(
    (left, right) =>
      (order.get(left.category) ?? 99) - (order.get(right.category) ?? 99) ||
      compareKeys(left.key, right.key),
  );
  const all: ImageRegistryCleanupPlanObject[][] = [];
  for (let index = 0; index < ordered.length; index += input.batchSize) {
    all.push(ordered.slice(index, index + input.batchSize));
  }
  const budget = Math.max(1, Math.floor(input.maxDeletes / input.batchSize));
  const batches = all.slice(0, budget);
  return {
    batches,
    selectedKeyCount: batches.reduce(
      (total, batch) => total + batch.length,
      0,
    ),
    resumeRequired:
      batches.length < all.length ||
      input.candidateSampleCapped ||
      input.faultsPresent,
  };
}

async function applyDeletes(
  env: ImageRegistryCleanupEnv,
  plan: ImageRegistryCleanupPlan,
  options: {
    sweepToken: string;
    leaseMs: number;
    batchSize: number;
    maxDeletes: number;
    listPageLimit: number;
    /** The plan's own scan, used to compute the expected post-delete keyset. */
    baseline: Map<string, SweptObject>;
  },
): Promise<ImageRegistryCleanupRunResult> {
  const result = emptyResult(null);
  const admissionEnv = { DB: env.DB };
  const deletedKeys: string[] = [];
  const deletedLines: string[] = [];
  const unverifiedKeys: string[] = [];
  /** Keys whose bulk delete call returned, so the verification pass owns them. */
  const claimedKeys = new Map<string, number>();
  result.wouldDeleteObjects = plan.details.candidateTotal;
  result.wouldDeleteBytes = plan.candidateBytes;

  const selection = planCleanupDeleteSelection({
    candidates: plan.candidateObjects,
    batchSize: options.batchSize,
    maxDeletes: options.maxDeletes,
    candidateSampleCapped: plan.details.candidateSampleCapped,
    faultsPresent: !plan.details.deleteAllowedByReferences,
  });
  const { selectedKeyCount } = selection;
  result.resumeRequired = selection.resumeRequired;

  let processed = 0;
  for (const batch of selection.batches) {
    const heartbeat = await heartbeatRegistrySweep(admissionEnv, {
      sweepToken: options.sweepToken,
      leaseMs: options.leaseMs,
    });
    if (!heartbeat.ok) {
      // Only keys this run selected can be blocked by the gate. Keys the cap or
      // the budget never selected were not attempted, so they are not blocked.
      result.blockedObjects += selectedKeyCount - processed;
      result.resumeRequired = true;
      result.error = "registry_sweep_superseded";
      break;
    }
    if (!heartbeat.deleteAllowed) {
      result.blockedObjects += selectedKeyCount - processed;
      result.resumeRequired = true;
      result.error = heartbeat.blockedReason ?? "registry_admission_blocked";
      break;
    }
    const allowed = await assertRegistrySweepDeletable(admissionEnv, {
      sweepToken: options.sweepToken,
      objectKeys: batch.map((object) => object.key),
    });
    if (!allowed.ok) {
      result.blockedObjects += selectedKeyCount - processed;
      result.resumeRequired = true;
      result.error = allowed.code;
      break;
    }
    if (allowed.blocked.length > 0) {
      result.blockedObjects += selectedKeyCount - processed;
      result.resumeRequired = true;
      result.error =
        "registry admission blocked " + allowed.blocked.length + " key(s)";
      await recordRegistryGcProgress(admissionEnv, {
        sweepToken: options.sweepToken,
        counters: countersOf(plan, result),
        detail: {
          state: "failed",
          blockedSample: allowed.blocked.slice(0, 20),
        },
      });
      break;
    }
    const deletable = new Set(allowed.deletable);
    // One bounded bulk delete per batch: an exclusive sweep must not spend one
    // round trip per key while it holds the registry.
    const claimed = batch.filter((object) => deletable.has(object.key));
    try {
      if (claimed.length) {
        await env.VM_IMAGE_REGISTRY_BUCKET.delete(
          claimed.map((object) => object.key),
        );
        for (const object of claimed) {
          result.deletedObjects += 1;
          result.deletedBytes += object.bytes;
          claimedKeys.set(object.key, object.bytes);
          result.phases[object.category] =
            (result.phases[object.category] ?? 0) + 1;
        }
      }
    } catch (error) {
      // The bulk call is settled, so nothing is still in flight for this batch.
      // No key from a failed call is claimed: only a verified absence counts.
      result.failedObjects += claimed.length;
      result.error =
        "bulk delete failed: " +
        (error instanceof Error ? error.message : "unknown error");
      await recordRegistryGcProgress(admissionEnv, {
        sweepToken: options.sweepToken,
        counters: countersOf(plan, result),
        detail: { state: "failed", failedKeys: claimed.slice(0, 20).map((object) => object.key) },
      });
      // Stop the sweep here. A manifest that is still present is the record of
      // which chunks exist, so deleting chunks after its failed delete would
      // leave retained state unreadable.
      break;
    }
    processed += batch.length;
    await recordRegistryGcProgress(admissionEnv, {
      sweepToken: options.sweepToken,
      counters: countersOf(plan, result),
    });
  }
  result.skippedObjects =
    result.wouldDeleteObjects - result.deletedObjects - result.failedObjects;
  // Re-list and prove the end state. A delete call that returned is a claim; only
  // an absent key is proof, and the post-scan also proves nothing else moved.
  const post = await scanBucket(
    env.VM_IMAGE_REGISTRY_BUCKET,
    options.listPageLimit,
  );
  for (const [key, bytes] of claimedKeys) {
    if (post.objects.has(key)) {
      result.unverifiedObjects += 1;
      if (unverifiedKeys.length < MAX_REPORTED_DELETED_KEYS) {
        unverifiedKeys.push(key);
      }
      continue;
    }
    result.verifiedDeletedObjects += 1;
    result.verifiedDeletedBytes += bytes;
    deletedKeys.push(key);
    deletedLines.push(key + "\t" + bytes);
  }
  const postScanned = await summarizeKeyset([...post.objects.values()]);
  // The exact keyset this run expects: its own baseline minus the keys it proved
  // absent. A digest over the same keys is the only proof that nothing else
  // moved, because one key of the same size can replace another without moving
  // the count or the byte total.
  const expectedAfterDeletes = new Map(options.baseline);
  for (const key of deletedKeys) expectedAfterDeletes.delete(key);
  const expectedScanned = await summarizeKeyset([
    ...expectedAfterDeletes.values(),
  ]);
  result.postState = {
    scanned: postScanned,
    expected: expectedScanned,
    unchanged:
      !post.truncated &&
      postScanned.digest === expectedScanned.digest &&
      postScanned.objects === expectedScanned.objects &&
      postScanned.bytes === expectedScanned.bytes,
    truncated: post.truncated,
    unrecognizedObjects: post.unrecognized,
  };
  if (!result.postState.unchanged && !result.error) {
    result.error =
      "the bucket changed during the sweep: the post-scan keyset does not " +
      "match the scanned keyset minus the verified deletes";
  }
  deletedKeys.sort(compareKeys);
  deletedLines.sort(compareKeys);
  result.deletedKeys = deletedKeys.slice(0, MAX_REPORTED_DELETED_KEYS);
  result.deletedKeysTruncated = deletedKeys.length > result.deletedKeys.length;
  result.deletedKeysDigest = await digestKeyLines(deletedLines);
  result.unverifiedKeys = unverifiedKeys;
  if (result.unverifiedObjects > 0 && !result.error) {
    result.error =
      result.unverifiedObjects + " key(s) survived their delete call";
  }
  // "Completed" is the child's licence to report a finished sweep. A partial
  // pass, a blocked batch, or an unproven delete all withhold it.
  result.completed =
    result.error === null &&
    result.failedObjects === 0 &&
    result.unverifiedObjects === 0 &&
    result.blockedObjects === 0 &&
    result.postState.unchanged &&
    !result.resumeRequired;
  if (result.failedObjects > 0 && !result.error) {
    result.error = result.failedObjects + " object delete(s) failed";
  }
  return result;
}

function pickCounters(
  result: ImageRegistryCleanupRunResult,
): Partial<ImageRegistryCleanupRunResult> {
  return {
    deletedObjects: result.deletedObjects,
    deletedBytes: result.deletedBytes,
    failedObjects: result.failedObjects,
    blockedObjects: result.blockedObjects,
  };
}

export function createImageRegistryCleanupCore(
  options: ImageRegistryCleanupCoreOptions,
): {
  plan(
    env: ImageRegistryCleanupEnv,
    input: ImageRegistryCleanupInput,
  ): Promise<ImageRegistryCleanupPlan>;
  run(
    env: ImageRegistryCleanupEnv,
    input: ImageRegistryCleanupInput,
  ): Promise<ImageRegistryCleanupRunResult>;
} {
  const owner = options.owner ?? DEFAULT_CLEANUP_OWNER;
  const leaseMs = options.leaseMs ?? DEFAULT_SWEEP_LEASE_MS;
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_CLEANUP_BATCH_SIZE),
    MAX_ASSERT_KEYS,
    MAX_BULK_DELETE_KEYS,
  );
  const maxDeletes = Math.max(
    batchSize,
    options.maxDeletesPerRun ?? DEFAULT_CLEANUP_MAX_DELETES,
  );
  const listPageLimit = Math.min(
    Math.max(1, options.listPageLimit ?? DEFAULT_LIST_PAGE_LIMIT),
    MAX_LIST_PAGE_LIMIT,
  );
  const candidateListLimit = Math.max(
    1,
    options.candidateListLimit ?? DEFAULT_CANDIDATE_LIST_LIMIT,
  );
  const planOptions = { listPageLimit, candidateListLimit };

  return {
    async plan(env, input) {
      const { plan } = await buildPlan(env, input, planOptions);
      return plan;
    },

    async run(env, input) {
      const admissionEnv = { DB: env.DB };
      // Report-only writes nothing, not even admission state. The projection is
      // read-only, so a preview reports exactly what an apply would decide.
      if (input.mode !== "delete") {
        const { plan } = await buildPlan(env, input, planOptions);
        const result = emptyResult(describeFaults(plan));
        result.wouldDeleteObjects = plan.details.candidateTotal;
        result.wouldDeleteBytes = plan.candidateBytes;
        result.skippedObjects = plan.details.candidateTotal;
        result.blockedObjects = plan.details.faults.length;
        result.resumeRequired = plan.details.faults.length > 0;
        result.planSummary = summarizeCleanupPlan(plan);
        result.completed =
          plan.details.faults.length === 0 && plan.details.candidateTotal === 0;
        return result;
      }

      const acquisition = await acquireRegistrySweep(admissionEnv, {
        owner,
        leaseMs,
      });
      if (!acquisition.ok) {
        const result = emptyResult("registry admission is busy");
        result.resumeRequired = true;
        result.blockedObjects =
          acquisition.counts.openSessions + acquisition.counts.pendingWriters;
        return result;
      }
      const sweepToken = acquisition.lease.sweepToken;

      let result = emptyResult(null);
      try {
        const state = await readRegistryAdmissionState(admissionEnv);
        if (state.enforcement !== "enforce") {
          result = emptyResult(
            "registry admission enforcement is " + state.enforcement,
          );
          result.resumeRequired = true;
          result.blockedObjects = 1;
          return result;
        }
        if (!acquisition.lease.deleteAllowed) {
          result = emptyResult(
            acquisition.lease.blockedReason ??
              "registry admission did not allow deletion",
          );
          result.resumeRequired = true;
          result.blockedObjects = 1;
          return result;
        }

        // Everything is recomputed under the guard, so a released or moved guard
        // can never be followed by a delete against a stale mark.
        const fresh = await buildPlan(env, input, planOptions);
        if (!fresh.plan.details.deleteAllowedByReferences) {
          result = emptyResult(
            "reference verification stopped the sweep: " +
              fresh.plan.details.faults.map((fault) => fault.code).join(","),
          );
          result.blockedObjects = fresh.plan.details.faults.length;
          result.resumeRequired = true;
          return result;
        }

        // Retained state is verified complete, so the policy may record its
        // retirement now. Both steps run inside the exclusive lease.
        if (fresh.projection) {
          const applied = await applyRegistryRetention(env, fresh.projection);
          result.phases.retired_builds = applied.retiredBuildIds.length;
          result.phases.trimmed_snapshots = applied.trimmedSnapshotIds.length;
          result.phases.deleted_snapshots = applied.deletedSnapshotIds.length;
          result.phases.deleted_candidates = applied.deletedCandidateIds.length;
          result.phases.trimmed_host_cache_intents =
            applied.trimmedHostCacheImageIds.length;
        }

        const deleted = await applyDeletes(env, fresh.plan, {
          sweepToken,
          leaseMs,
          batchSize,
          maxDeletes,
          listPageLimit,
          baseline: fresh.baseline,
        });
        result = { ...deleted, phases: { ...deleted.phases, ...result.phases } };
        result.planSummary = summarizeCleanupPlan(fresh.plan);
        await finishRegistrySweep(admissionEnv, {
          sweepToken,
          outcome: result.error ? "failed" : "completed",
          error: result.error,
          counters: countersOf(fresh.plan, result),
        });
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "cleanup run failed";
        await finishRegistrySweep(admissionEnv, {
          sweepToken,
          outcome: "failed",
          error: message,
        });
        return { ...emptyResult(message), ...pickCounters(result) };
      }
    },
  };
}
