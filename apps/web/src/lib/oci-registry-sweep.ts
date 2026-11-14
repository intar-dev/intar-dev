import { HEX_RE, DIGEST_RE, OCI_PREFIX } from "@/control-plane/image-registry/push";
import { KINO_ARTIFACT_TYPE } from "@/generated/constants";
import { HOST_DESIRED_STATE_SCHEMA_VERSION_V3 } from "@/lib/desired-state-store";
import { ACTIVE_EXECUTIONS, KEPT_REVISIONS_CTE } from "@/lib/kept-revisions";
import {
  acquireRegistrySweep,
  assertRegistrySweepDeletable,
  finishRegistrySweep,
  heartbeatRegistrySweep,
  readRegistryAdmissionState,
  recordRegistryGcProgress,
} from "@/lib/image-registry-admission";

/**
 * Mark and sweep of the OCI store, `oci/sha256/<hex>` in the image registry
 * bucket, and the revision rows nothing needs any more.
 *
 * Mark: one SQL root set, then the index closure of its manifests:
 *   - revisions that may still be used: live, candidate, building, the three
 *     newest verified of each scenario, and any a running run started from;
 *     their machine images, learn and verify specs, and the current image of
 *     each machine's build key
 *   - machine builds in flight, and any build that moved within the age guard
 *   - the snapshot (image, spec, Kino) of every run whose execution is active
 *   - every bridge 9 desired state: VM images, specs and Kino, cached images,
 *     the Kino pin
 *   - unexpired personal image preparations
 *   - every Kino pin, current and previous, and every Kino artifact
 *   - manifests indexed within the age guard, so a push that has not posted
 *     its result yet keeps its blobs
 * A manifest root is closed over `registry_manifest_blobs` (config and
 * layers); a spec root is a blob of its own.
 *
 * Sweep: one key window of the listing per pass, from a cursor kept on the
 * pass's gc-run row. An object is deleted only when it is unmarked, older than
 * the age guard, inside `oci/sha256/`, and the pass holds the exclusive sweep
 * lease, which no writer may hold at the same time.
 *
 * Fail closed: an unreadable Kino pin set, a malformed root digest, a manifest
 * root without its index row or without blob rows, a marked object the
 * listing lacks, a listing that stops early, or any D1 error stops the pass
 * before its first delete.
 */

export const OCI_SWEEP_OWNER = "oci-registry-sweep";
/** Nothing younger is deleted: a blob lands before its manifest, a spec before its revision. */
export const OCI_SWEEP_AGE_GUARD_MS = 24 * 60 * 60 * 1000;

export interface OciSweepOptions {
  /** R2 list pages per pass. */
  listPages?: number;
  /** Keys per R2 list page; R2 allows at most 1000. */
  listPageLimit?: number;
  /** Deletes per pass. */
  maxDeletes?: number;
  /** Keys per delete batch, each re-checked against the gate. */
  batchSize?: number;
  /** Revision rows removed per pass. */
  revisionLimit?: number;
  leaseMs?: number;
}

const DEFAULTS: Required<OciSweepOptions> = {
  listPages: 20,
  listPageLimit: 1000,
  maxDeletes: 1000,
  batchSize: 200,
  revisionLimit: 100,
  leaseMs: 5 * 60 * 1000,
};
const FAULT_SAMPLE = 20;
const KEY_SAMPLE = 50;

export interface OciSweepFault {
  code: string;
  detail: string;
}

export interface OciSweepReport {
  mode: "report-only" | "delete";
  /** The pass finished the whole listing, deleted every candidate and faulted nowhere. */
  completed: boolean;
  /** More keys remain after this pass's window. */
  resumeRequired: boolean;
  faults: OciSweepFault[];
  /** The hex after which this pass listed, null from the start. */
  startAfter: string | null;
  /** Where the next pass starts; null wraps to the start. */
  nextStartAfter: string | null;
  listedObjects: number;
  listedBytes: number;
  /** Keys under the prefix that are not a digest: never deleted. */
  unrecognizedObjects: number;
  markedObjects: number;
  youngObjects: number;
  candidateObjects: number;
  candidateBytes: number;
  /** A bounded sample of candidate keys. */
  candidateSample: string[];
  deletedObjects: number;
  deletedBytes: number;
  revisionCandidates: number;
  deletedRevisions: number;
  error: string | null;
}

export interface OciSweepEnv {
  DB: D1Database;
  VM_IMAGE_REGISTRY_BUCKET: R2Bucket;
}

export interface OciSweepInput {
  mode: "report-only" | "delete";
  nowMs: number;
  /** `KINO_PINS_JSON` of the serving control plane; null when it could not be read. */
  kinoPinsJson: string | null;
  /**
   * Report-only: the hex to plan after, "" for the start. Absent, a plan
   * covers the window the next delete pass would, from the saved cursor.
   */
  startAfter?: string;
}

/** `sha256:` and 64 lowercase hex; D1 refuses a GLOB pattern that spells out 64 classes. */
const validDigest = (column: string) =>
  `(typeof(${column}) = 'text' AND length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:'
    AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`;

/** `roots(kind, digest, source)`. ?1 is the age-guard cutoff, ?2 the Kino pins as a JSON array. */
const ROOTS_SQL = `WITH ${KEPT_REVISIONS_CTE},
machines AS (
  SELECT revision.scenario_id || '@' || revision.rev AS source, machine.value AS m
    FROM kept_revisions revision, json_each(revision.doc_json, '$.machines') machine),
desired AS (
  SELECT host_id, doc_json FROM host_desired_state
   WHERE json_extract(doc_json, '$.schema_version') = ${HOST_DESIRED_STATE_SCHEMA_VERSION_V3}),
desired_vms AS (
  SELECT desired.host_id, vm.value AS v FROM desired, json_each(desired.doc_json, '$.vms') vm),
run_vms AS (
  SELECT vm.execution_id, vm.image_sha256, vm.image_key_json FROM runtime_vms vm
    JOIN runtime_executions execution ON execution.id = vm.execution_id
   WHERE execution.state IN (${ACTIVE_EXECUTIONS}) AND json_type(vm.image_key_json, '$.kino') IS NOT NULL),
revision_roots(kind, digest, source) AS (
  SELECT 'manifest', json_extract(m, '$.image_digest'), 'revision ' || source FROM machines
  UNION ALL SELECT 'blob', json_extract(m, '$.spec'), 'revision ' || source FROM machines
  UNION ALL SELECT 'blob', json_extract(m, '$.verify_spec'), 'revision ' || source FROM machines
  UNION ALL SELECT 'manifest', build.image_digest, 'build ' || build.build_key
    FROM machines JOIN machine_builds build ON build.build_key = json_extract(m, '$.build_key')),
activity_roots(kind, digest, source) AS (
  SELECT 'manifest', image_digest, 'build ' || build_key FROM machine_builds
   WHERE state IN ('queued', 'assigned', 'building') OR updated_at >= ?1
  UNION ALL SELECT 'manifest', image_sha256, 'run ' || execution_id FROM run_vms
  UNION ALL SELECT 'blob', json_extract(image_key_json, '$.spec'), 'run ' || execution_id FROM run_vms
  UNION ALL SELECT 'manifest', json_extract(image_key_json, '$.kino'), 'run ' || execution_id FROM run_vms
  UNION ALL SELECT 'manifest', image.value, 'preparation ' || prep.user_id
    FROM personal_image_preparations prep, json_each(prep.images_json) image
   WHERE prep.expires_at >= ?1 AND image.type = 'text'),
desired_roots(kind, digest, source) AS (
  SELECT 'manifest', json_extract(v, '$.image'), 'desired ' || host_id FROM desired_vms
  UNION ALL SELECT 'manifest', json_extract(v, '$.kino'), 'desired ' || host_id FROM desired_vms
  UNION ALL SELECT 'blob', json_extract(v, '$.spec'), 'desired ' || host_id FROM desired_vms
  UNION ALL SELECT 'manifest', cached.value, 'desired ' || desired.host_id
    FROM desired, json_each(desired.doc_json, '$.cached_images') cached
  UNION ALL SELECT 'manifest', json_extract(doc_json, '$.kino_pin'), 'desired ' || host_id FROM desired),
pin_roots(kind, digest, source) AS (
  SELECT 'manifest', pin.value, 'kino pin' FROM json_each(?2) pin
  -- Every Kino artifact: an artifact can be pinned long after its push, and a
  -- re-push keeps its first created_at. They are few and small.
  UNION ALL SELECT 'manifest', digest, 'kino artifact' FROM registry_manifests WHERE artifact_type = '${KINO_ARTIFACT_TYPE}'
  UNION ALL SELECT 'manifest', digest, 'young manifest' FROM registry_manifests WHERE created_at >= ?1),
-- D1 allows five terms per compound SELECT, hence the four parts.
roots(kind, digest, source) AS (
  SELECT * FROM revision_roots UNION ALL SELECT * FROM activity_roots
  UNION ALL SELECT * FROM desired_roots UNION ALL SELECT * FROM pin_roots)`;

const FAULTS_SQL = `${ROOTS_SQL}
SELECT code, source, digest FROM (
  SELECT 'malformed_root' AS code, source, CAST(digest AS TEXT) AS digest FROM roots
   WHERE digest IS NOT NULL AND NOT ${validDigest("digest")}
  UNION ALL SELECT 'manifest_row_missing', source, digest FROM roots root
   WHERE kind = 'manifest' AND ${validDigest("digest")}
     AND NOT EXISTS (SELECT 1 FROM registry_manifests manifest WHERE manifest.digest = root.digest)
  UNION ALL SELECT 'index_rows_missing', source, digest FROM roots root
   WHERE kind = 'manifest' AND ${validDigest("digest")}
     AND EXISTS (SELECT 1 FROM registry_manifests manifest WHERE manifest.digest = root.digest)
     AND NOT EXISTS (SELECT 1 FROM registry_manifest_blobs blob WHERE blob.manifest_digest = root.digest))
LIMIT ${FAULT_SAMPLE}`;

/** Marked digests in (?3, ?4], at most ?5 of them. */
const MARKED_SQL = `${ROOTS_SQL},
manifests AS (SELECT DISTINCT digest FROM roots WHERE kind = 'manifest' AND ${validDigest("digest")}),
marked(digest) AS (
  SELECT digest FROM roots WHERE ${validDigest("digest")}
  UNION SELECT blob.blob_digest FROM manifests JOIN registry_manifest_blobs blob ON blob.manifest_digest = manifests.digest)
SELECT digest FROM marked WHERE digest > ?3 AND digest <= ?4 ORDER BY digest LIMIT ?5`;

/** Revisions nothing keeps, created before ?1. */
const UNKEPT_REVISIONS_SQL = `SELECT revision.rowid FROM scenario_revisions revision
   WHERE revision.created_at <= ?1
     AND NOT EXISTS (SELECT 1 FROM kept_revisions kept
       WHERE kept.scenario_id = revision.scenario_id AND kept.rev = revision.rev)`;

interface ListedObject {
  key: string;
  hex: string | null;
  size: number;
  uploadedMs: number;
}

interface Plan {
  candidates: ListedObject[];
  /** The window's last key's hex, null when the listing reached its end. */
  windowEnd: string | null;
}

export async function runOciSweep(
  env: OciSweepEnv,
  input: OciSweepInput,
  options: OciSweepOptions = {},
): Promise<OciSweepReport> {
  const settings = { ...DEFAULTS, ...options };
  settings.listPageLimit = Math.min(Math.max(1, settings.listPageLimit), 1000);
  settings.batchSize = Math.min(Math.max(1, settings.batchSize), 500);
  const report = emptyReport(input.mode);

  if (input.mode !== "delete") {
    // Report-only takes no lease and writes nothing.
    try {
      await plan(env, input, settings, report);
      report.revisionCandidates = await countUnkeptRevisions(env, input.nowMs, settings.revisionLimit);
    } catch (error) {
      report.faults.push({ code: "d1_read_failed", detail: describe(error) });
    }
    report.error = describeFaults(report.faults);
    return report;
  }

  const admission = { DB: env.DB };
  let acquired: Awaited<ReturnType<typeof acquireRegistrySweep>>;
  try {
    acquired = await acquireRegistrySweep(admission, { owner: OCI_SWEEP_OWNER, leaseMs: settings.leaseMs });
  } catch (error) {
    report.error = describe(error);
    report.resumeRequired = true;
    return report;
  }
  if (!acquired.ok) {
    report.error = "registry admission is busy";
    report.resumeRequired = true;
    return report;
  }
  const sweepToken = acquired.lease.sweepToken;
  try {
    const state = await readRegistryAdmissionState(admission);
    if (state.enforcement !== "enforce") {
      report.error = "registry admission enforcement is " + state.enforcement;
    } else if (!acquired.lease.deleteAllowed) {
      report.error = acquired.lease.blockedReason ?? "registry admission did not allow deletion";
    }
    if (report.error) {
      report.resumeRequired = true;
      await finishRegistrySweep(admission, { sweepToken, outcome: "failed", error: report.error });
      return report;
    }

    let planned: Plan | null = null;
    try {
      planned = await plan(env, input, settings, report);
    } catch (error) {
      report.faults.push({ code: "d1_read_failed", detail: describe(error) });
    }
    if (!planned || report.faults.length) {
      report.error = "the mark stopped the sweep: " + describeFaults(report.faults);
      report.resumeRequired = true;
      await finishRegistrySweep(admission, { sweepToken, outcome: "failed", error: report.error });
      return report;
    }

    const selected = planned.candidates.slice(0, settings.maxDeletes);
    const capped = selected.length < planned.candidates.length;
    for (let start = 0; start < selected.length && !report.error; start += settings.batchSize) {
      const batch = selected.slice(start, start + settings.batchSize);
      report.error = await deleteBatch(env, sweepToken, settings.leaseMs, batch);
      if (report.error) break;
      report.deletedObjects += batch.length;
      report.deletedBytes += batch.reduce((total, object) => total + object.size, 0);
      await recordRegistryGcProgress(admission, {
        sweepToken,
        counters: { scannedObjects: report.listedObjects, deletedObjects: report.deletedObjects, bytesReclaimed: report.deletedBytes },
      });
    }

    if (!report.error) {
      report.deletedRevisions = await deleteUnkeptRevisions(env, input.nowMs, settings.revisionLimit);
      // A capped pass resumes after its last delete, so nothing it left is skipped.
      report.nextStartAfter = capped ? selected.at(-1)!.hex : planned.windowEnd;
      report.resumeRequired = report.nextStartAfter !== null || report.deletedRevisions === settings.revisionLimit;
      report.completed = !report.resumeRequired;
    } else {
      report.nextStartAfter = report.startAfter;
      report.resumeRequired = true;
    }
    // Only a completed outcome moves the cursor; a failed pass repeats its window.
    await recordRegistryGcProgress(admission, {
      sweepToken,
      counters: { scannedObjects: report.listedObjects, deletedObjects: report.deletedObjects, bytesReclaimed: report.deletedBytes },
      detail: { start_after: report.startAfter, next_start_after: report.nextStartAfter, deleted_revisions: report.deletedRevisions },
    });
    await finishRegistrySweep(admission, {
      sweepToken,
      outcome: report.error ? "failed" : "completed",
      error: report.error,
    });
    return report;
  } catch (error) {
    report.error = describe(error);
    report.resumeRequired = true;
    report.completed = false;
    await finishRegistrySweep(admission, { sweepToken, outcome: "failed", error: report.error });
    return report;
  }
}

/**
 * Lists one window, marks it and picks the candidates. Faults land in
 * `report.faults`; a null plan or any fault means nothing may be deleted.
 */
async function plan(
  env: OciSweepEnv,
  input: OciSweepInput,
  settings: Required<OciSweepOptions>,
  report: OciSweepReport,
): Promise<Plan | null> {
  const pins = readKinoPins(input.kinoPinsJson);
  if ("fault" in pins) {
    report.faults.push(pins.fault);
    return null;
  }
  const cutoff = input.nowMs - OCI_SWEEP_AGE_GUARD_MS;
  const pinsJson = JSON.stringify(pins.digests);

  const faults = await env.DB.prepare(FAULTS_SQL).bind(cutoff, pinsJson)
    .all<{ code: string; source: string; digest: string }>();
  for (const row of faults.results) {
    report.faults.push({ code: row.code, detail: `${row.source}: ${row.digest}` });
  }
  if (report.faults.length) return null;

  if (input.mode !== "delete" && input.startAfter !== undefined) {
    if (input.startAfter !== "" && !HEX_RE.test(input.startAfter)) {
      report.faults.push({ code: "invalid_start_after", detail: "a plan starts after 64 lowercase hex or from the start" });
      return null;
    }
    report.startAfter = input.startAfter || null;
  } else {
    report.startAfter = await readCursor(env);
  }
  const listing = await listWindow(env.VM_IMAGE_REGISTRY_BUCKET, report.startAfter, settings);
  if (listing.truncated) {
    report.faults.push({ code: "listing_truncated", detail: "the bucket listing stopped before its last page" });
    return null;
  }
  const objects = listing.objects;
  report.listedObjects = objects.length;
  report.listedBytes = objects.reduce((total, object) => total + object.size, 0);
  report.unrecognizedObjects = objects.filter((object) => object.hex === null).length;
  const lastHex = objects.findLast((object) => object.hex !== null)?.hex ?? report.startAfter ?? "";
  const windowEnd = listing.complete ? null : lastHex;

  const listed = new Set(objects.flatMap((object) => (object.hex ? [`sha256:${object.hex}`] : [])));
  const marked = await env.DB.prepare(MARKED_SQL)
    .bind(cutoff, pinsJson, `sha256:${report.startAfter ?? ""}`, windowEnd === null ? "sha256:g" : `sha256:${windowEnd}`, listed.size + 1)
    .all<{ digest: string }>();
  const markedSet = new Set(marked.results.map((row) => row.digest));
  const missing = [...markedSet].filter((digest) => !listed.has(digest));
  for (const digest of missing.slice(0, FAULT_SAMPLE)) {
    report.faults.push({ code: "referenced_object_missing", detail: digest });
  }
  if (missing.length) return null;

  report.markedObjects = markedSet.size;
  const candidates: ListedObject[] = [];
  for (const object of objects) {
    if (object.hex === null || markedSet.has(`sha256:${object.hex}`)) continue;
    if (object.uploadedMs > cutoff) {
      report.youngObjects += 1;
      continue;
    }
    candidates.push(object);
  }
  report.candidateObjects = candidates.length;
  report.candidateBytes = candidates.reduce((total, object) => total + object.size, 0);
  report.candidateSample = candidates.slice(0, KEY_SAMPLE).map((object) => object.key);
  report.nextStartAfter = windowEnd;
  report.resumeRequired = windowEnd !== null;
  return { candidates, windowEnd };
}

/** One bounded key window under `oci/sha256/`, after `startAfter`. */
async function listWindow(
  bucket: R2Bucket,
  startAfter: string | null,
  settings: Required<OciSweepOptions>,
): Promise<{ objects: ListedObject[]; complete: boolean; truncated: boolean }> {
  const objects: ListedObject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < settings.listPages; page += 1) {
    const result = await bucket.list({
      prefix: OCI_PREFIX,
      limit: settings.listPageLimit,
      ...(cursor ? { cursor } : startAfter ? { startAfter: OCI_PREFIX + startAfter } : {}),
    });
    for (const object of result.objects) {
      // The prefix bounds the listing; a key outside it is never a candidate.
      if (!object.key.startsWith(OCI_PREFIX)) continue;
      const hex = object.key.slice(OCI_PREFIX.length);
      objects.push({ key: object.key, hex: HEX_RE.test(hex) ? hex : null, size: object.size, uploadedMs: object.uploaded.getTime() });
    }
    if (!result.truncated) return { objects, complete: true, truncated: false };
    if (!result.cursor) return { objects, complete: false, truncated: true };
    cursor = result.cursor;
  }
  return { objects, complete: false, truncated: false };
}

/** Deletes one batch under the lease; the refusal code, or null. */
async function deleteBatch(
  env: OciSweepEnv,
  sweepToken: string,
  leaseMs: number,
  batch: ListedObject[],
): Promise<string | null> {
  const admission = { DB: env.DB };
  const heartbeat = await heartbeatRegistrySweep(admission, { sweepToken, leaseMs });
  if (!heartbeat.ok) return "registry_sweep_superseded";
  if (!heartbeat.deleteAllowed) return heartbeat.blockedReason ?? "registry_admission_blocked";
  const keys = batch.map((object) => object.key);
  const allowed = await assertRegistrySweepDeletable(admission, { sweepToken, objectKeys: keys });
  if (!allowed.ok) return allowed.code;
  // Index rows go first: an object whose delete then fails is unindexed and
  // unmarked, so the next pass deletes it.
  const digests = JSON.stringify(batch.map((object) => `sha256:${object.hex}`));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM registry_manifest_blobs WHERE manifest_digest IN (SELECT value FROM json_each(?1))").bind(digests),
    env.DB.prepare("DELETE FROM registry_manifests WHERE digest IN (SELECT value FROM json_each(?1))").bind(digests),
  ]);
  await env.VM_IMAGE_REGISTRY_BUCKET.delete(keys);
  return null;
}

async function countUnkeptRevisions(env: OciSweepEnv, nowMs: number, limit: number): Promise<number> {
  const row = await env.DB.prepare(`WITH ${KEPT_REVISIONS_CTE} SELECT COUNT(*) AS count FROM (${UNKEPT_REVISIONS_SQL} LIMIT ?2)`)
    .bind(nowMs - OCI_SWEEP_AGE_GUARD_MS, limit).first<{ count: number }>();
  return row?.count ?? 0;
}

/** One statement, so a revision a pointer moves to in the meantime is never removed. */
async function deleteUnkeptRevisions(env: OciSweepEnv, nowMs: number, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `WITH ${KEPT_REVISIONS_CTE} DELETE FROM scenario_revisions WHERE rowid IN (${UNKEPT_REVISIONS_SQL} LIMIT ?2) RETURNING rev`,
  ).bind(nowMs - OCI_SWEEP_AGE_GUARD_MS, limit).all();
  return results.length;
}

/** The cursor the last completed pass left. */
async function readCursor(env: OciSweepEnv): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT json_extract(detail_json, '$.next_start_after') AS next FROM image_registry_gc_runs
      WHERE owner = ?1 AND state = 'completed' ORDER BY started_at DESC LIMIT 1`,
  ).bind(OCI_SWEEP_OWNER).first<{ next: unknown }>();
  return typeof row?.next === "string" && HEX_RE.test(row.next) ? row.next : null;
}

/** Every pinned Kino digest, or a fault when the pins cannot be trusted. */
export function readKinoPins(json: string | null): { digests: string[] } | { fault: OciSweepFault } {
  if (json === null) {
    return { fault: { code: "kino_pins_unavailable", detail: "the control plane did not report its Kino pins" } };
  }
  if (!json.trim()) return { digests: [] };
  const invalid = { fault: { code: "kino_pins_invalid", detail: "KINO_PINS_JSON is not a pin set" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid;
  const digests: string[] = [];
  for (const entry of Object.values(parsed)) {
    if (typeof entry !== "object" || entry === null) return invalid;
    const { current, previous = null } = entry as { current?: unknown; previous?: unknown };
    if (typeof current !== "string" || !DIGEST_RE.test(current)) return invalid;
    if (previous !== null && (typeof previous !== "string" || !DIGEST_RE.test(previous))) return invalid;
    digests.push(current, ...(previous === null ? [] : [previous]));
  }
  return { digests };
}

function emptyReport(mode: OciSweepReport["mode"]): OciSweepReport {
  return {
    mode, completed: false, resumeRequired: false, faults: [], startAfter: null, nextStartAfter: null,
    listedObjects: 0, listedBytes: 0, unrecognizedObjects: 0, markedObjects: 0, youngObjects: 0,
    candidateObjects: 0, candidateBytes: 0, candidateSample: [], deletedObjects: 0, deletedBytes: 0,
    revisionCandidates: 0, deletedRevisions: 0, error: null,
  };
}

function describeFaults(faults: OciSweepFault[]): string | null {
  return faults.length ? faults.slice(0, 5).map((fault) => `${fault.code}: ${fault.detail}`).join(" | ") : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
