import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import {
  isImageKey,
  readString,
  registryImageKey,
} from "@/control-plane/image-registry/shared";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  vmScenarios,
  ACTIVE_RUNTIME_EXECUTION_STATES,
  imageBuildBundles,
  imageBuilds,
  runtimeExecutions,
  runtimeVms,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  scenarioRuns,
  vmScenarioVms,
  type ImageBuildStatus,
} from "@/db/schema";
import type {
  DesiredCachedImageV1,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import type {
  ImageArchitecture,
  ImageKey,
  ScenarioManifestV4,
} from "@/generated/catalog";

/**
 * Registry artifact retention policy.
 *
 * The registry is a content-addressed object store whose readers are exact
 * references. Retention is therefore a reference question, never an age
 * question:
 *
 *   roots  = every image a live pointer, a retained rollback, a current
 *            candidate intent, an active run, or a host still needs;
 *   keep   = objects reachable from those references, plus every build bundle;
 *   delete = registry objects that no reference and no kept build reaches.
 *
 * A build row stays available (its artifacts are a reason to keep objects)
 * only while every member of its manifest is rooted. A multi-VM build whose
 * second VM has left the catalog is not reusable, so it stops pinning
 * anything: the per-object root set decides which of its objects survive.
 *
 * This module is shared with the cleanup collector, so it imports no
 * control-plane runtime state. projectRegistryRetention is read-only and is
 * what a report-only preview uses; applyRegistryRetention is the only writer
 * and runs under the collector's exclusive sweep lease.
 */

export const ARTIFACT_PREFIX = "artifacts/";
export const IMAGE_PREFIX = "images/";
export const IMAGE_CHUNK_PREFIX = "image-chunks/v1/zstd6/";
export const IMAGE_MANIFEST_PREFIX = "image-manifests/v1/";
export const BUNDLE_PREFIX = "builds/bundles/";

const ACTIVE_BUILD_STATUSES: ImageBuildStatus[] = [
  "queued",
  "assigned",
  "building",
];

export type ImageRootSource =
  | "host_actual"
  | "live_pointer"
  | "rollback_snapshot"
  | "candidate_intent"
  | "active_run"
  | "host_desired";

export interface ImageRoot {
  scenarioId: string;
  vmName: string;
  arch: ImageArchitecture;
  imageId: string;
  source: ImageRootSource;
}

/** Root identity of one image slot: one VM of one scenario on one arch. */
export function imageRootKey(input: {
  scenarioId: string;
  vmName: string;
  arch: string;
}): string {
  return input.scenarioId + ":" + input.vmName + ":" + input.arch;
}

/**
 * The registry image key has one authority: the control-plane shared module.
 * A second copy here could drift from it, and then the sweep would resolve a
 * key that the publisher never wrote.
 */
export { registryImageKey };

export function imageObjectKey(imageKey: ImageKey, imageId: string): string {
  return IMAGE_PREFIX + registryImageKey(imageKey) + "/" + imageId + ".raw.zst";
}

export function imageChunkObjectKey(rawSha256: string): string {
  return IMAGE_CHUNK_PREFIX + rawSha256;
}

export function imageManifestObjectKey(manifestSha256: string): string {
  return IMAGE_MANIFEST_PREFIX + manifestSha256 + ".json";
}

export function bootArtifactObjectKey(sha256: string): string {
  return ARTIFACT_PREFIX + sha256;
}

export function bundleObjectKey(rev: string): string {
  return BUNDLE_PREFIX + rev + ".tar.gz";
}

/** Root members of one published manifest, one per VM. */
export function manifestImageMembers(
  manifest: ScenarioManifestV4,
  source: ImageRootSource = "live_pointer",
): ImageRoot[] {
  const scenarioId = manifest.scenario_id.trim();
  return manifest.vms.map((vm) => ({
    scenarioId,
    vmName: vm.name.trim(),
    arch: vm.image_key.arch,
    imageId: vm.image_id,
    source,
  }));
}

export function manifestImageIds(manifest: ScenarioManifestV4): string[] {
  return [...new Set(manifest.vms.map((vm) => vm.image_id))].sort();
}

export function manifestBootArtifactSha256s(
  manifest: ScenarioManifestV4,
): string[] {
  const shas = new Set<string>();
  for (const vm of manifest.vms) {
    if (vm.boot?.kernel_sha256) shas.add(vm.boot.kernel_sha256);
    if (vm.boot?.initrd_sha256) shas.add(vm.boot.initrd_sha256);
  }
  return [...shas].sort();
}

export function manifestChunkManifestSha256s(
  manifest: ScenarioManifestV4,
): string[] {
  return [
    ...new Set(
      manifest.vms
        .map((vm) => vm.chunk_manifest_sha256)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
}

/**
 * Raised when a retained reference cannot be read in full.
 *
 * The collector must delete nothing in that case: an unreadable reference may
 * name objects that are still needed, so an empty or partial root set would
 * delete live data.
 */
export class RegistryRetentionFault extends Error {
  readonly reference: string;

  constructor(reference: string, detail: string) {
    super("registry retention fault: " + reference + ": " + detail);
    this.name = "RegistryRetentionFault";
    this.reference = reference;
  }
}

/** Reads the first non-empty string of the given keys, camelCase first. */
function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function readArrayField(
  record: Record<string, unknown>,
  keys: readonly string[],
  reference: string,
): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new RegistryRetentionFault(reference, key + " is not an array");
    }
    return value;
  }
  return [];
}

function readRecordField(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function requireImageArchitecture(
  value: string | null,
  reference: string,
): ImageArchitecture {
  if (value !== "x86_64" && value !== "aarch64") {
    throw new RegistryRetentionFault(
      reference,
      "arch is missing or unsupported: " + String(value),
    );
  }
  return value;
}

export interface RetentionBuildRow {
  buildId: string;
  status: ImageBuildStatus;
  /** One VM image member per VM of the published manifest. */
  members: ImageRoot[];
  /** Chunk manifests the published manifest depends on. */
  chunkManifestSha256s: string[];
  /** Kernel and initrd objects the published manifest depends on. */
  bootArtifactSha256s: string[];
  artifactsRetired: boolean;
}

export interface BuildRetentionPlan {
  /** Builds that keep pinning objects; their retirement marker is cleared. */
  keepBuildIds: string[];
  /** Builds whose artifacts nothing needs any more. */
  retireBuildIds: string[];
}

/**
 * A build is reusable only while every member of its manifest is rooted. One
 * unrooted member means the build can no longer be fetched as published, so it
 * stops pinning its objects.
 */
export function planBuildRetention(input: {
  builds: readonly RetentionBuildRow[];
  roots: readonly ImageRoot[];
  /**
   * Chunk manifests and boot artifacts that a direct pointer still needs.
   * A build is available only when every artifact it depends on is rooted,
   * so a historical build can never keep an unreferenced kernel alive.
   */
  chunkManifestSha256s: ReadonlySet<string>;
  bootArtifactSha256s: ReadonlySet<string>;
}): BuildRetentionPlan {
  // A slot can legitimately carry several rooted images at once: the live
  // pointer plus the retained rollback pointer. Both are admissible members.
  const rootedSlots = new Map<string, Set<string>>();
  for (const root of input.roots) {
    const key = imageRootKey({
      scenarioId: root.scenarioId,
      vmName: root.vmName,
      arch: root.arch,
    });
    const images = rootedSlots.get(key) ?? new Set<string>();
    images.add(root.imageId);
    rootedSlots.set(key, images);
  }

  const keepBuildIds: string[] = [];
  const retireBuildIds: string[] = [];
  for (const build of input.builds) {
    // A row with no published manifest owns no image members, so it has
    // nothing to keep and nothing to retire.
    if (build.members.length === 0) continue;
    const artifactsRooted =
      build.chunkManifestSha256s.every((sha256) =>
        input.chunkManifestSha256s.has(sha256),
      ) &&
      build.bootArtifactSha256s.every((sha256) =>
        input.bootArtifactSha256s.has(sha256),
      );
    const reusable =
      ACTIVE_BUILD_STATUSES.includes(build.status) ||
      (artifactsRooted &&
        build.members.every(
        (member) =>
          rootedSlots
            .get(
              imageRootKey({
                scenarioId: member.scenarioId,
                vmName: member.vmName,
                arch: member.arch,
              }),
            )
            ?.has(member.imageId) === true,
        ));
    if (reusable) {
      keepBuildIds.push(build.buildId);
      continue;
    }
    if (build.artifactsRetired) continue;
    retireBuildIds.push(build.buildId);
  }
  return {
    keepBuildIds: keepBuildIds.sort(),
    retireBuildIds: retireBuildIds.sort(),
  };
}

export interface CandidateIntentRow {
  id: string;
  scenarioId: string;
  organizationId: string | null;
  /** The revision the candidate was staged for. */
  revision: string;
  members: ImageRoot[];
  stagedAt: number;
}

export interface CandidateIntentPlan {
  keepIds: string[];
  retireIds: string[];
}

/**
 * The candidate a run in flight was admitted from. The run resolves the
 * manifest it boots through that row, so the row outlives its intent.
 */
export interface ActiveRunCandidateRef {
  scenarioId: string;
  organizationId: string | null;
  revision: string;
}

/**
 * Identity of one candidate row: the three fields that name it. The build id
 * is deliberately absent, so a row that a later bundle overwrote in place is
 * still kept while a run that started from it is active.
 */
function candidateRefKey(input: {
  scenarioId: string;
  organizationId: string | null;
  revision: string;
}): string {
  return (
    input.scenarioId + "\n" + (input.organizationId ?? "") + "\n" + input.revision
  );
}

/**
 * A candidate row is the intent "this revision becomes the catalog for this
 * scenario". Two rules decide it:
 *
 *   - only the newest row per scenario can be that intent, so older rows are
 *     history;
 *   - an intent is fulfilled only when the catalog carries that exact
 *     revision. A candidate can change the kernel, the initrd, the probes, or
 *     the metadata while its disk image is byte-identical, so image equality
 *     never proves that the intent was promoted.
 *   - a row an active run was admitted from is kept whatever its intent has
 *     become: the agent index resolves that run's manifest through it, so
 *     retiring it would leave a queued run with no way to find its image.
 *
 * The revision comparison must be scoped by the same publication the row
 * belongs to: the caller passes the live revision of that tenant's scenario.
 */
export function planCandidateIntentRetention(input: {
  rows: readonly CandidateIntentRow[];
  liveRevisionByScenario: ReadonlyMap<string, string | null>;
  activeRunCandidates?: readonly ActiveRunCandidateRef[];
}): CandidateIntentPlan {
  const active = new Set(
    (input.activeRunCandidates ?? []).map(candidateRefKey),
  );
  const newest = new Map<string, CandidateIntentRow>();
  for (const row of input.rows) {
    const current = newest.get(row.scenarioId);
    if (
      !current ||
      row.stagedAt > current.stagedAt ||
      (row.stagedAt === current.stagedAt && row.id > current.id)
    ) {
      newest.set(row.scenarioId, row);
    }
  }
  const keepIds: string[] = [];
  const retireIds: string[] = [];
  for (const row of input.rows) {
    if (active.has(candidateRefKey(row))) {
      keepIds.push(row.id);
      continue;
    }
    if (newest.get(row.scenarioId) !== row) {
      retireIds.push(row.id);
      continue;
    }
    if (input.liveRevisionByScenario.get(row.scenarioId) === row.revision) {
      retireIds.push(row.id);
      continue;
    }
    keepIds.push(row.id);
  }
  return { keepIds: keepIds.sort(), retireIds: retireIds.sort() };
}

export interface SnapshotRetentionRow {
  id: string;
  createdAt: number;
  snapshot: unknown;
}

export interface SnapshotTrim {
  id: string;
  /** The snapshot with covered scenarios removed from every array. */
  snapshot: Record<string, unknown>;
}

export interface SnapshotRetentionPlan {
  keepIds: string[];
  trims: SnapshotTrim[];
  deleteIds: string[];
}

export interface SnapshotCoverage {
  targetScenarioIds: string[];
  scenarios: unknown[];
  vms: Array<Record<string, unknown>>;
  probes: unknown[];
}

/**
 * Rollback retention keeps exactly one recoverable state per scenario.
 *
 * A newer snapshot that covers a scenario is that scenario's rollback. An
 * older snapshot that also covers a scenario therefore stops reserving it, and
 * the row is trimmed down to the scenarios only it covers. A row whose whole
 * coverage is superseded is deleted. Trimming is what stops a few large
 * multi-scenario rollbacks from reserving the same images forever.
 */
export function planSnapshotRetention(input: {
  rows: readonly SnapshotRetentionRow[];
}): SnapshotRetentionPlan {
  const ordered = [...input.rows].sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );
  const covered = new Set<string>();
  const keepIds: string[] = [];
  const trims: SnapshotTrim[] = [];
  const deleteIds: string[] = [];
  for (const row of ordered) {
    const snapshot = readSnapshot(row.snapshot);
    if (!snapshot) {
      deleteIds.push(row.id);
      continue;
    }
    const uncovered = snapshot.targetScenarioIds.filter(
      (scenarioId) => !covered.has(scenarioId),
    );
    for (const scenarioId of snapshot.targetScenarioIds) covered.add(scenarioId);
    if (uncovered.length === 0) {
      deleteIds.push(row.id);
      continue;
    }
    if (uncovered.length === snapshot.targetScenarioIds.length) {
      keepIds.push(row.id);
      continue;
    }
    trims.push({ id: row.id, snapshot: trimSnapshot(snapshot, uncovered) });
  }
  return {
    keepIds: keepIds.sort(),
    trims: trims.sort((left, right) => left.id.localeCompare(right.id)),
    deleteIds: deleteIds.sort(),
  };
}

/**
 * Reads a rollback snapshot in full.
 *
 * A snapshot row is a retained pointer, so an unreadable one is a fault rather
 * than an empty coverage: the collector must delete nothing when it cannot
 * read what a rollback still needs.
 */
export function readSnapshot(value: unknown): SnapshotCoverage {
  const reference = "scenario_catalog_snapshots.snapshot_json";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RegistryRetentionFault(reference, "snapshot is not an object");
  }
  const record = value as Record<string, unknown>;
  const targets = readArrayField(record, ["targetScenarioIds"], reference);
  const targetScenarioIds: string[] = [];
  for (const entry of targets) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new RegistryRetentionFault(
        reference,
        "targetScenarioIds contains a non-string entry",
      );
    }
    targetScenarioIds.push(entry.trim());
  }
  if (targetScenarioIds.length === 0) {
    throw new RegistryRetentionFault(reference, "targetScenarioIds is empty");
  }
  const vms = readArrayField(record, ["vms"], reference).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RegistryRetentionFault(reference, "vms contains a non-object entry");
    }
    return entry as Record<string, unknown>;
  });
  return {
    targetScenarioIds,
    scenarios: readArrayField(record, ["scenarios"], reference),
    vms,
    probes: readArrayField(record, ["probes"], reference),
  };
}

function trimSnapshot(
  snapshot: SnapshotCoverage,
  keepScenarioIds: readonly string[],
): Record<string, unknown> {
  const keep = new Set(keepScenarioIds);
  return {
    ...(snapshot as unknown as Record<string, unknown>),
    schemaVersion: 1,
    targetScenarioIds: [...keep].sort(),
    scenarios: snapshot.scenarios.filter((entry) =>
      keep.has(readRecordScenarioId(entry)),
    ),
    vms: snapshot.vms.filter((entry) => keep.has(readRecordScenarioId(entry))),
    probes: snapshot.probes.filter((entry) => keep.has(readRecordScenarioId(entry))),
  };
}

function readRecordScenarioId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return (
    readStringField(value as Record<string, unknown>, [
      "scenarioId",
      "scenario_id",
    ]) ?? ""
  );
}

export interface SnapshotArtifactRoots {
  roots: ImageRoot[];
  chunkManifestSha256s: string[];
  bootArtifactSha256s: string[];
  /**
   * The same VMs by registry identity, so an active run that boots an image
   * which only a retained rollback still describes can resolve it. A direct
   * publish writes no build row, and its candidate row can be gone, so the
   * rollback record is then the only place that metadata survives.
   */
  imageClosures: ImageClosureByIdentity[];
}

/**
 * Reads every VM a retained snapshot still pins. Legacy rows are supported
 * through their snake_case field names; a raw_chunks_v1 row without its chunk
 * manifest is a fault, and a missing arch or image id always is.
 */
export function snapshotArtifactRoots(
  coverage: SnapshotCoverage,
  source: ImageRootSource,
): SnapshotArtifactRoots {
  const reference = "scenario_catalog_snapshots.vms";
  const roots: ImageRoot[] = [];
  const chunkManifestSha256s = new Set<string>();
  const bootArtifactSha256s = new Set<string>();
  const imageClosures: ImageClosureByIdentity[] = [];
  for (const vm of coverage.vms) {
    const scenarioId = readStringField(vm, ["scenarioId", "scenario_id"]);
    const vmName = readStringField(vm, ["vmName", "vm_name"]);
    const imageId = readStringField(vm, ["imageSha256", "image_sha256"]);
    const imageKey = readRecordField(vm, ["imageKeyJson", "image_key_json"]);
    const arch = requireImageArchitecture(
      imageKey ? readStringField(imageKey, ["arch"]) : null,
      reference,
    );
    if (!scenarioId || !vmName || !imageId) {
      throw new RegistryRetentionFault(
        reference,
        "snapshot vm " + vmName + " is missing scenarioId, vmName, or imageSha256",
      );
    }
    roots.push({ scenarioId, vmName, arch, imageId, source });
    const chunkManifestSha256 = readStringField(vm, [
      "chunkManifestSha256",
      "chunk_manifest_sha256",
    ]);
    const imageFormat = readStringField(vm, ["imageFormat", "image_format"]);
    // A booted VM needs its kernel and initrd whatever the image format is.
    // The chunk manifest is the chunked format's dependency; every other
    // known format resolves its image from a single object.
    const boot: RunImageClosure = {
      chunkManifestSha256,
      kernelSha256: null,
      initrdSha256: null,
    };
    for (const key of ["kernelSha256", "initrdSha256"] as const) {
      const sha256 = readStringField(vm, [key, toSnakeCase(key)]);
      if (!sha256) {
        throw new RegistryRetentionFault(
          reference,
          "snapshot vm " + vmName + " has no " + key,
        );
      }
      boot[key] = sha256;
      bootArtifactSha256s.add(sha256);
    }
    if (imageFormat === "raw_chunks_v1") {
      if (!chunkManifestSha256) {
        throw new RegistryRetentionFault(
          reference,
          "snapshot vm " + vmName + " has no chunk manifest",
        );
      }
      chunkManifestSha256s.add(chunkManifestSha256);
    } else if (chunkManifestSha256) {
      chunkManifestSha256s.add(chunkManifestSha256);
    }
    imageClosures.push({
      identity:
        registryImageKey({ scenario: scenarioId, vm: vmName, arch }) +
        ":" +
        imageId,
      imageKey: { scenario: scenarioId, vm: vmName, arch },
      imageId,
      closure: boot,
    });
  }
  return {
    roots,
    chunkManifestSha256s: [...chunkManifestSha256s].sort(),
    bootArtifactSha256s: [...bootArtifactSha256s].sort(),
    imageClosures,
  };
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
}

export interface HostImageReferenceEvaluation {
  /** Outgoing image ids a host still needs from R2 right now. */
  blocking: Array<{
    imageId: string;
    reason: "active_vm" | "transfer_in_flight";
  }>;
  /** Ready local cache entries that no desired entry requires. */
  leftover: string[];
}

/**
 * A ready local copy that desired state no longer requires is leftover cache
 * and never blocks a promotion; an active VM or an unfinished transfer does.
 */
export function evaluateHostImageReferences(input: {
  outgoingImageIds: readonly string[];
  desired: HostDesiredStateV2 | null;
  actual: HostStateReportV2 | null;
}): HostImageReferenceEvaluation {
  const outgoing = new Set(input.outgoingImageIds);
  if (!outgoing.size) return { blocking: [], leftover: [] };

  const actualPhaseById = new Map<string, string>();
  for (const image of input.actual?.cached_images ?? []) {
    actualPhaseById.set(image.image_id, image.phase);
  }
  // Only a running VM blocks from desired state: an absent tombstone is not a
  // reference. An actual VM that can still need its image blocks too, because
  // replacing it would break a VM that is running, stopping, or stuck in a
  // failed delete, none of which desired state can see.
  const activeVmImageIds = new Set<string>();
  for (const vm of input.desired?.vms ?? []) {
    if (!desiredVmNeedsImage(vm) || !vm.image_id) continue;
    activeVmImageIds.add(vm.image_id);
  }
  for (const vm of input.actual?.vms ?? []) {
    if (!actualVmNeedsImage(vm) || !vm.image_id) continue;
    activeVmImageIds.add(vm.image_id);
  }
  const desiredCacheIds = new Set(
    (input.desired?.cached_images ?? []).map((image) => image.image_id),
  );

  const blocking: HostImageReferenceEvaluation["blocking"] = [];
  const leftover: string[] = [];
  for (const imageId of outgoing) {
    if (activeVmImageIds.has(imageId)) {
      blocking.push({ imageId, reason: "active_vm" });
      continue;
    }
    const phase = actualPhaseById.get(imageId);
    if (phase === "queued" || phase === "downloading") {
      blocking.push({ imageId, reason: "transfer_in_flight" });
      continue;
    }
    if (desiredCacheIds.has(imageId) && phase !== "ready") {
      blocking.push({ imageId, reason: "transfer_in_flight" });
      continue;
    }
    if (phase === "ready") leftover.push(imageId);
  }

  return {
    blocking: blocking.sort((left, right) =>
      left.imageId.localeCompare(right.imageId),
    ),
    leftover: leftover.sort(),
  };
}

/**
 * True when the platform still wants the VM to run.
 *
 * This mirrors the agent exactly: `required_cache_pins` in
 * crates/intar-agent/src/bridge.rs pins an image only for
 * `DesiredVmPhase::Running`, and its test proves that flipping running to
 * absent drops the pin. An `absent` entry is a tombstone the platform wrote
 * when a run ended, so it is not a reference and must not prove a family.
 *
 * Only an explicit `absent` is a tombstone. The stored document is a JSON cast
 * with no runtime validation, so an unknown or missing phase is kept: dropping
 * an image on a phase this policy does not understand would delete live data.
 */
export function desiredVmNeedsImage(vm: { desired_phase?: unknown }): boolean {
  return vm.desired_phase !== "absent";
}

/**
 * True when a VM the host reports can still need its image.
 *
 * Every branch is grounded in the agent lifecycle:
 *
 *  - `pending`, `pulling_image`, `creating_disks`, `booting`, `running`
 *    are pre-running or running, and `should_resume_live_vm_on_startup`
 *    resumes `BootingVm` and `Running` across an agent restart.
 *  - `ready` and `solved` are running states with passing probes.
 *  - `stopping` covers `DeletingVm` and `ArchivingArtifacts`. Both are
 *    present on disk and both take `StartupCleanupMode::Archive`, so the VM
 *    is still there and the teardown can still fail back to `DeleteFailed`.
 *  - `failed` is ambiguous by design: report phase `failed` maps from both
 *    `Failed` and `DeleteFailed`. `DeleteFailed` carries an archive record, so
 *    any archive evidence keeps the image. A `failed` VM with no archive
 *    record at all is `Failed`, whose local state the agent has dropped.
 *  - `stopped` is not emitted by the agent today but the contract allows it,
 *    and nothing proves a stopped VM cannot still be read, so it is kept.
 *
 * Provably gone, and therefore not a reference: an `archive.phase` of
 * `complete`, or host-confirmed `absent` with no unfinished archive.
 */
export function actualVmNeedsImage(vm: {
  phase?: unknown;
  archive?: { phase?: unknown } | null;
}): boolean {
  const archivePhase = vm.archive?.phase;
  // The agent deletes the VM once its artifacts are archived, so a complete
  // archive is the one unambiguous "this VM is gone" the contract carries.
  if (archivePhase === "complete") return false;
  const unfinishedArchive =
    archivePhase === "pending" ||
    archivePhase === "uploading" ||
    archivePhase === "failed";
  if (vm.phase === "absent") return unfinishedArchive;
  // `failed` is the one ambiguous phase: the agent reports it for both
  // `Failed` and `DeleteFailed`. DeleteFailed carries an archive record
  // (`VMArchivePhase::Failed`), so any archive evidence keeps the image.
  // Only a failed VM with no archive record at all proves local was dropped,
  // and an unrecognised archive phase counts as evidence.
  if (vm.phase === "failed") return archivePhase != null;
  return true;
}

export interface CachedImageRetentionScope {
  scenarioId: string;
  arch: ImageArchitecture;
  /** Incoming live image ids plus the single previous rollback image. */
  keepImageIds: readonly string[];
}

/**
 * Keeps the live image and one rollback image per promoted scenario/arch,
 * drops older cache entries of the same family, and leaves every other
 * scenario or tenant entry untouched.
 */
export function pruneSupersededCachedImages(
  images: readonly DesiredCachedImageV1[],
  scopes: readonly CachedImageRetentionScope[],
): DesiredCachedImageV1[] {
  if (!scopes.length) return [...images];
  return images.filter((image) => {
    const scope = scopes.find(
      (candidate) =>
        candidate.scenarioId === image.image_key.scenario &&
        candidate.arch === image.image_key.arch,
    );
    return !scope || scope.keepImageIds.includes(image.image_id);
  });
}

/**
 * One VM a host can still need its image for: a VM the platform wants
 * running, or a VM the host reports that has not been torn down.
 *
 * The image id alone proves nothing, because a chunked image is reachable
 * only through its manifest and boot artifacts. Resolution happens against
 * the same index the active runs use, so a host VM and an active run get
 * exactly the same closure.
 */
export interface HostOperationalReference {
  /** A label for a fault, naming the row that needs the image. */
  reference: string;
  imageId: string;
  /** Null when the host state carries no unambiguous key for this image. */
  imageKey: ImageKey | null;
  source: "host_desired" | "host_actual";
}

export interface HostCacheIntentRow {
  hostId: string;
  cachedImages: readonly DesiredCachedImageV1[];
  /** Images a VM of this host needs now, from its desired and actual state. */
  neededImageIds: readonly string[];
  /** Images a transfer on this host is already fetching. */
  inFlightImageIds: readonly string[];
}

export interface HostCacheIntentTrim {
  hostId: string;
  imageIds: string[];
}

/**
 * Warm-cache trim: the cache intents a host no longer has a reason to hold.
 *
 * A host caches every image its desired state names, and an old desired-state
 * version can name hundreds of images that no live reference roots any more
 * (measured in production: 425 pinned images against 27 advertised). Such an
 * intent would keep pinning its R2 object, or fail the sweep when the object
 * is already gone, so the intent goes before the object can.
 *
 * Only a family that a catalog, candidate, snapshot, or build record still
 * manages is trimmable, matched on scenario, VM, and arch together. An
 * unmanaged intent (an operator request, another tenant) is preserved, as is
 * every image a VM of that host needs now or a transfer is already fetching.
 * A managed scenario that no retained reference roots any more is trimmed
 * down to nothing, which is the normal end state of a removed scenario.
 */
export function planHostCacheIntentRetention(input: {
  hosts: readonly HostCacheIntentRow[];
  managedFamilies: ReadonlySet<string>;
  /**
   * Image ids a live reference still roots, which is the whole point of the
   * cache: the live pointer, the rollback, the staged candidate, the VM a host
   * runs, and the images a run in flight needs.
   */
  keepImageIds: ReadonlySet<string>;
}): HostCacheIntentTrim[] {
  const trims: HostCacheIntentTrim[] = [];
  for (const host of input.hosts) {
    const required = new Set([
      ...host.neededImageIds,
      ...host.inFlightImageIds,
    ]);
    const trimmed = new Set<string>();
    for (const image of host.cachedImages) {
      const family = cachedImageFamily(image);
      // An entry this module cannot identify is kept: over-retention is
      // recoverable, a delete is not.
      if (!family || !input.managedFamilies.has(family)) continue;
      if (input.keepImageIds.has(image.image_id)) continue;
      if (required.has(image.image_id)) continue;
      trimmed.add(image.image_id);
    }
    if (trimmed.size) {
      trims.push({ hostId: host.hostId, imageIds: [...trimmed].sort() });
    }
  }
  return trims.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

/** Root identity of a cached image, or null when the entry is unusable. */
function cachedImageFamily(image: DesiredCachedImageV1): string | null {
  const imageKey = image?.image_key;
  if (!imageKey || typeof image.image_id !== "string" || !image.image_id) {
    return null;
  }
  if (
    typeof imageKey.scenario !== "string" ||
    typeof imageKey.vm !== "string" ||
    typeof imageKey.arch !== "string"
  ) {
    return null;
  }
  return imageRootKey({
    scenarioId: imageKey.scenario,
    vmName: imageKey.vm,
    arch: imageKey.arch,
  });
}

/**
 * Live image ids of one (scenario, arch) family. A publish reads this before it
 * rewrites the pointers: the result is the rollback image of the new state.
 */
export async function loadLiveFamilyImageIds(
  db: DrizzleD1Database,
  input: { scenarioId: string; arch: ImageArchitecture },
): Promise<string[]> {
  const rows = await db
    .select({
      imageId: vmScenarioVms.imageSha256,
      imageKey: vmScenarioVms.imageKeyJson,
    })
    .from(vmScenarioVms)
    .where(eq(vmScenarioVms.scenarioId, input.scenarioId));
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.imageKey?.arch !== input.arch) continue;
    if (row.imageId) ids.add(row.imageId);
  }
  return [...ids].sort();
}

/** Reads the "this build is retired" marker for a set of build rows. */
export async function loadRetiredBuildIds(
  db: DrizzleD1Database,
  buildIds: readonly string[],
): Promise<Set<string>> {
  if (!buildIds.length) return new Set();
  const rows = await db
    .select({ id: imageBuilds.id })
    .from(imageBuilds)
    .where(
      and(
        isNotNull(imageBuilds.artifactsRetiredAt),
        // D1 allows 100 bound parameters per query, and a caller asks about
        // every build row at once, so the ids travel as one JSON array.
        sql`${imageBuilds.id} IN (SELECT value FROM json_each(${JSON.stringify(buildIds)}))`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

export interface RegistryRetentionProjection {
  nowUnixMs: number;
  /** Slot roots: these prove a build member is still reachable. */
  roots: ImageRoot[];
  /**
   * Images a surviving host cache intent still names: kept without proving a
   * catalog slot. A run in flight is a root instead, because it needs the whole
   * closure and not only the object.
   */
  objectOnlyImageIds: string[];
  builds: {
    keepBuildIds: string[];
    retireBuildIds: string[];
    retiredBuildIds: string[];
  };
  candidates: CandidateIntentPlan;
  snapshots: SnapshotRetentionPlan;
  /**
   * Cache intents a sweep withdraws before it deletes the objects they name.
   * Report-only mode projects them and writes nothing.
   */
  hostCacheTrims: HostCacheIntentTrim[];
  /** Bundle objects stay readable: they are the rebuild source. */
  bundleRevs: string[];
  imageIds: string[];
  chunkManifestSha256s: string[];
  bootArtifactSha256s: string[];
}

export interface RegistryRetentionDb {
  DB: D1Database;
}

/**
 * Read-only retention projection.
 *
 * Nothing is written: a report-only collector previews exactly the decisions
 * that an apply would make, and the apply recomputes them under the exclusive
 * sweep lease.
 */
export async function projectRegistryRetention(
  env: RegistryRetentionDb,
  input: { nowUnixMs: number },
): Promise<RegistryRetentionProjection> {
  const db = drizzle(env.DB);
  const [liveRows, snapshotRows, candidateRows, buildRows, bundleRows, runRows] =
    await Promise.all([
      db
        .select({
          scenarioId: vmScenarioVms.scenarioId,
          sourceRevision: vmScenarios.sourceRevision,
          vmName: vmScenarioVms.vmName,
          imageKey: vmScenarioVms.imageKeyJson,
          imageId: vmScenarioVms.imageSha256,
          imageFormat: vmScenarioVms.imageFormat,
          chunkManifestSha256: vmScenarioVms.chunkManifestSha256,
          kernelSha256: vmScenarioVms.kernelSha256,
          initrdSha256: vmScenarioVms.initrdSha256,
        })
        .from(vmScenarioVms)
        .innerJoin(vmScenarios, eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId)),
      db
        .select({
          id: scenarioCatalogSnapshots.id,
          createdAt: scenarioCatalogSnapshots.createdAt,
          snapshot: scenarioCatalogSnapshots.snapshotJson,
        })
        .from(scenarioCatalogSnapshots),
      db
        .select({
          id: scenarioCatalogCandidates.id,
          scenarioId: scenarioCatalogCandidates.scenarioId,
          organizationId: scenarioCatalogCandidates.organizationId,
          revision: scenarioCatalogCandidates.revision,
          manifest: scenarioCatalogCandidates.manifestJson,
          updatedAt: scenarioCatalogCandidates.updatedAt,
        })
        .from(scenarioCatalogCandidates),
      db
        .select({
          id: imageBuilds.id,
          status: imageBuilds.status,
          manifest: imageBuilds.publishedManifestJson,
          artifactsRetiredAt: imageBuilds.artifactsRetiredAt,
        })
        .from(imageBuilds),
      db.select({ rev: imageBuildBundles.rev }).from(imageBuildBundles),
      db
        .select({
          runId: scenarioRuns.runId,
          scenarioId: scenarioRuns.scenarioId,
          organizationId: scenarioRuns.organizationId,
          candidateRevision: sql<string | null>`json_extract(${scenarioRuns.requestScopeJson}, '$.candidateRevision')`,
          runtimeVmName: runtimeVms.runtimeVmName,
          imageKey: runtimeVms.imageKeyJson,
          imageId: runtimeVms.imageSha256,
        })
        .from(runtimeVms)
        .innerJoin(
          runtimeExecutions,
          eq(runtimeExecutions.id, runtimeVms.executionId),
        )
        .innerJoin(
          scenarioRuns,
          eq(scenarioRuns.runtimeExecutionId, runtimeExecutions.id),
        )
        .where(inArray(runtimeExecutions.state, [...ACTIVE_RUNTIME_EXECUTION_STATES])),
    ]);

  const liveRoots: ImageRoot[] = [];
  const chunkManifestSha256s = new Set<string>();
  const bootArtifactSha256s = new Set<string>();
  const liveRevisionByScenario = new Map<string, string | null>();
  for (const row of liveRows) {
    // A published live pointer must be readable in full. Skipping a malformed
    // row would drop its manifest, kernel, and initrd from the root set and
    // let the sweep delete objects a running scenario still needs.
    const reference = "vm_scenario_vms." + row.scenarioId + ":" + row.vmName;
    const arch = requireImageArchitecture(
      row.imageKey ? (row.imageKey.arch ?? null) : null,
      reference,
    );
    if (!row.imageId) {
      throw new RegistryRetentionFault(reference, "image_sha256 is missing");
    }
    if (row.imageFormat === "raw_chunks_v1" && !row.chunkManifestSha256) {
      throw new RegistryRetentionFault(
        reference,
        "a chunked live pointer has no chunk manifest",
      );
    }
    liveRoots.push({
      scenarioId: row.scenarioId,
      vmName: row.vmName,
      arch,
      imageId: row.imageId,
      source: "live_pointer",
    });
    // The catalog row carries the revision it was published from, which is
    // what proves whether a staged candidate has become the live catalog.
    liveRevisionByScenario.set(row.scenarioId, row.sourceRevision ?? null);
    if (row.chunkManifestSha256) chunkManifestSha256s.add(row.chunkManifestSha256);
    if (row.kernelSha256) bootArtifactSha256s.add(row.kernelSha256);
    if (row.initrdSha256) bootArtifactSha256s.add(row.initrdSha256);
  }

  const snapshots = planSnapshotRetention({ rows: snapshotRows });
  const retainedSnapshots = snapshotRows.filter(
    (row) =>
      snapshots.keepIds.includes(row.id) ||
      snapshots.trims.some((trim) => trim.id === row.id),
  );
  const rollbackRoots: ImageRoot[] = [];
  const snapshotClosures: ImageClosureByIdentity[] = [];
  for (const row of retainedSnapshots) {
    const trim = snapshots.trims.find((entry) => entry.id === row.id);
    const coverage = readSnapshot(trim ? trim.snapshot : row.snapshot);
    const artifacts = snapshotArtifactRoots(coverage, "rollback_snapshot");
    rollbackRoots.push(...artifacts.roots);
    snapshotClosures.push(...artifacts.imageClosures);
    for (const sha256 of artifacts.chunkManifestSha256s) {
      chunkManifestSha256s.add(sha256);
    }
    for (const sha256 of artifacts.bootArtifactSha256s) {
      bootArtifactSha256s.add(sha256);
    }
  }

  const candidates = planCandidateIntentRetention({
    rows: candidateRows.map((row) => ({
      id: row.id,
      scenarioId: row.scenarioId,
      organizationId: row.organizationId,
      revision: row.revision,
      members: manifestImageMembers(row.manifest, "candidate_intent"),
      stagedAt: row.updatedAt,
    })),
    liveRevisionByScenario,
    // A run in flight keeps the candidate row it was admitted from, whether or
    // not that row is still the current intent.
    activeRunCandidates: runRows.flatMap((row) =>
      row.candidateRevision
        ? [
            {
              scenarioId: row.scenarioId,
              organizationId: row.organizationId,
              revision: row.candidateRevision,
            },
          ]
        : [],
    ),
  });
  const candidateRoots = candidateRows
    .filter((row) => candidates.keepIds.includes(row.id))
    .flatMap((row) => manifestImageMembers(row.manifest, "candidate_intent"));
  for (const row of candidateRows) {
    if (!candidates.keepIds.includes(row.id)) continue;
    for (const sha of manifestChunkManifestSha256s(row.manifest)) {
      chunkManifestSha256s.add(sha);
    }
    for (const sha of manifestBootArtifactSha256s(row.manifest)) {
      bootArtifactSha256s.add(sha);
    }
  }

  // A run in flight needs its image whatever the catalog now publishes, and a
  // run image is not a cache entry: its manifest, kernel, and initrd are part
  // of the closure. Resolve every active runtime VM to the full reference of
  // the record that describes it, which after a direct publish is the retained
  // rollback and not the live pointer.
  const imageIdIndex = buildImageIdIndex({
    snapshotClosures,
    liveRows,
    candidateRows,
    buildRows,
  });
  const runImageIndex = buildRunImageIndex({
    liveRows,
    // Only retained rollbacks are references, and a trimmed row carries what
    // it still covers: both come from the same read as the rollback roots.
    snapshotClosures,
    candidateRows,
    buildRows,
  });
  const runRoots: ImageRoot[] = [];
  for (const row of runRows) {
    const reference =
      "scenario_runs." + row.runId + ":" + row.runtimeVmName;
    if (!isImageKey(row.imageKey)) {
      throw new RegistryRetentionFault(
        reference,
        "an active runtime VM has no usable image key",
      );
    }
    // A run resolves through its own key, and every variant that key and id
    // describe is merged: one id can carry several boot variants, and pinning
    // one of them would delete the other.
    const resolved = mergeImageClosures({
      subject: "active run",
      reference,
      imageKey: row.imageKey,
      imageId: row.imageId,
      exact: runImageIndex,
      byImageId: imageIdIndex,
      allowIdFallback: false,
    });
    if (!resolved) {
      throw new RegistryRetentionFault(
        reference,
        "the image of an active run resolves to no live, rollback, candidate, " +
          "or build record: " +
          registryImageKey(row.imageKey) +
          ":" +
          row.imageId,
      );
    }
    for (const sha256 of resolved.chunkManifestSha256s) {
      chunkManifestSha256s.add(sha256);
    }
    for (const sha256 of resolved.bootArtifactSha256s) {
      bootArtifactSha256s.add(sha256);
    }
    runRoots.push({
      scenarioId: row.imageKey.scenario,
      vmName: row.imageKey.vm,
      arch: row.imageKey.arch,
      imageId: row.imageId,
      source: "active_run",
    });
  }

  const hostReferences = await loadHostImageReferences(db);
  // A host VM is resolved exactly like an active run, because it needs the
  // same closure: its manifest, its chunks, and both boot artifacts. Every
  // matching variant is merged, an unresolvable image is a fault rather than a
  // guess, and the merged closure is pinned for this reference only, so a
  // historical manifest nothing operational names stays unrooted.
  const hostOperationalRoots: ImageRoot[] = [];
  for (const reference of hostReferences.operational) {
    const resolved = mergeImageClosures({
      subject: "operational host VM",
      reference: reference.reference,
      imageKey: reference.imageKey,
      imageId: reference.imageId,
      exact: runImageIndex,
      byImageId: imageIdIndex,
      allowIdFallback: true,
    });
    if (!resolved) {
      // No record describes this image. A vm_keyed host still proves its slot,
      // and the verifier then fails the sweep unless the object is really
      // there: a chunked image with no record reaches neither a legacy object
      // nor a verified manifest, so it faults rather than being dropped.
      // Without a key there is no slot to prove, so that is a fault here.
      if (!reference.imageKey) {
        throw new RegistryRetentionFault(
          reference.reference,
          "the image of an operational host VM resolves to no live, rollback, " +
            "candidate, or build record: " +
            reference.imageId,
        );
      }
      hostOperationalRoots.push({
        scenarioId: reference.imageKey.scenario,
        vmName: reference.imageKey.vm,
        arch: reference.imageKey.arch,
        imageId: reference.imageId,
        source: reference.source,
      });
      continue;
    }
    for (const sha256 of resolved.chunkManifestSha256s) {
      chunkManifestSha256s.add(sha256);
    }
    for (const sha256 of resolved.bootArtifactSha256s) {
      bootArtifactSha256s.add(sha256);
    }
    hostOperationalRoots.push({
      scenarioId: resolved.imageKey.scenario,
      vmName: resolved.imageKey.vm,
      arch: resolved.imageKey.arch,
      imageId: reference.imageId,
      source: reference.source,
    });
  }
  const roots = [
    ...liveRoots,
    ...rollbackRoots,
    ...candidateRoots,
    ...runRoots,
    ...hostOperationalRoots,
  ];
  const buildInputs = buildRows.map((row) => ({
    buildId: row.id,
    status: row.status,
    members: row.manifest ? manifestImageMembers(row.manifest) : [],
    chunkManifestSha256s: row.manifest
      ? manifestChunkManifestSha256s(row.manifest)
      : [],
    bootArtifactSha256s: row.manifest
      ? manifestBootArtifactSha256s(row.manifest)
      : [],
    artifactsRetired: row.artifactsRetiredAt !== null,
  }));
  const builds = planBuildRetention({
    builds: buildInputs,
    roots,
    chunkManifestSha256s,
    bootArtifactSha256s,
  });

  // The keep set that decides the warm trim excludes every cache intent: an
  // intent is what the trim removes, so it can never justify itself.
  const keepImageIds = new Set<string>(
    runRows
      .map((row) => row.imageId)
      .filter((imageId): imageId is string => Boolean(imageId)),
  );
  for (const root of roots) keepImageIds.add(root.imageId);

  const keepBuildIds = new Set(builds.keepBuildIds);
  for (const build of buildInputs) {
    if (!keepBuildIds.has(build.buildId)) continue;
    for (const member of build.members) keepImageIds.add(member.imageId);
    for (const sha of build.chunkManifestSha256s) chunkManifestSha256s.add(sha);
    for (const sha of build.bootArtifactSha256s) bootArtifactSha256s.add(sha);
  }

  const hostCacheTrims = planHostCacheIntentRetention({
    hosts: hostReferences.hosts,
    managedFamilies: collectManagedFamilies([
      ...liveRoots,
      ...rollbackRoots,
      ...candidateRoots,
      ...buildInputs.flatMap((build) => build.members),
    ]),
    keepImageIds,
  });
  const trimmedImageIds = new Set(
    hostCacheTrims.flatMap((trim) => trim.imageIds),
  );

  // The cache intents that survive the trim: kept without proving a catalog
  // slot of their own. A run in flight is a root, not an object-only reason.
  const objectOnlyImageIds = new Set<string>();
  for (const host of hostReferences.hosts) {
    for (const image of host.cachedImages) {
      if (!image?.image_id || trimmedImageIds.has(image.image_id)) continue;
      objectOnlyImageIds.add(image.image_id);
      // A retained intent that is a chunked image needs its whole closure, not
      // only its image id: the id alone would leave the manifest and chunks
      // unpinned. An id the index cannot resolve stays on the legacy path the
      // verifier proves, which is the pre-chunked behaviour.
      const resolved = mergeImageClosures({
        subject: "retained cache intent",
        reference: "host_cached_image:" + host.hostId,
        imageKey: isImageKey(image.image_key) ? image.image_key : null,
        imageId: image.image_id,
        exact: runImageIndex,
        byImageId: imageIdIndex,
        allowIdFallback: true,
      });
      if (!resolved) continue;
      for (const sha256 of resolved.chunkManifestSha256s) {
        chunkManifestSha256s.add(sha256);
      }
      for (const sha256 of resolved.bootArtifactSha256s) {
        bootArtifactSha256s.add(sha256);
      }
    }
  }
  const imageIds = new Set<string>([...keepImageIds, ...objectOnlyImageIds]);

  return {
    nowUnixMs: input.nowUnixMs,
    roots,
    objectOnlyImageIds: [...objectOnlyImageIds].sort(),
    builds: {
      keepBuildIds: builds.keepBuildIds,
      retireBuildIds: builds.retireBuildIds,
      retiredBuildIds: buildRows
        .filter((row) => row.artifactsRetiredAt !== null)
        .map((row) => row.id)
        .sort(),
    },
    candidates,
    snapshots,
    hostCacheTrims,
    bundleRevs: bundleRows.map((row) => row.rev).sort(),
    imageIds: [...imageIds].sort(),
    chunkManifestSha256s: [...chunkManifestSha256s].sort(),
    bootArtifactSha256s: [...bootArtifactSha256s].sort(),
  };
}

/**
 * Every image a live agent host references: the VMs it runs (a slot root) and
 * the cache intents it holds (an object-only reason), with the images its VMs
 * actually need and the transfers already under way.
 */
async function loadHostImageReferences(db: DrizzleD1Database): Promise<{
  operational: HostOperationalReference[];
  hosts: HostCacheIntentRow[];
}> {
  const rows = await db
    .select({
      hostId: agentHosts.id,
      desired: hostDesiredState.docJson,
      actual: hostActualState.reportJson,
    })
    .from(hostDesiredState)
    .innerJoin(agentHosts, eq(agentHosts.id, hostDesiredState.hostId))
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(and(eq(agentHosts.role, "agent"), eq(agentHosts.disabled, false)));
  const operational: HostOperationalReference[] = [];
  const hosts: HostCacheIntentRow[] = [];
  for (const row of rows) {
    const neededImageIds = new Set<string>();
    for (const vm of row.desired?.vms ?? []) {
      // A tombstone is not a reference. Requiring the running phase here
      // matches the agent cache pins and stops an ended run from rooting an
      // image, or from proving its family managed, forever.
      if (!desiredVmNeedsImage(vm)) continue;
      // The phase decides first, so a tombstone without an id still drops.
      // Once the VM is operational, a missing id is an incomplete reference:
      // an incomplete collection stops deletion instead of being ignored.
      if (!vm.image_id) {
        throw new RegistryRetentionFault(
          "host_desired:" + row.hostId + ":" + vm.vm_name,
          "an operational desired VM has no image id",
        );
      }
      neededImageIds.add(vm.image_id);
      operational.push({
        reference: "host_desired:" + row.hostId + ":" + vm.vm_name,
        imageId: vm.image_id,
        imageKey: isImageKey(vm.image_key) ? vm.image_key : null,
        source: "host_desired",
      });
    }
    // A VM the host reports is a reference in its own right: desired state can
    // lag a boot, and withdrawing its image would break a running VM.
    for (const vm of row.actual?.vms ?? []) {
      // A live report covers the lag. A torn-down VM does not: an archived
      // VM keeps its last report forever, so counting it would pin its image
      // for good. See actualVmNeedsImage for the evidence behind each branch.
      if (!actualVmNeedsImage(vm)) continue;
      // Phase first, for the same reason as desired state, and a missing id on
      // a VM that can still boot is an incomplete reference, not a tombstone.
      if (!vm.image_id) {
        throw new RegistryRetentionFault(
          "host_actual:" + row.hostId + ":" + vm.vm_name,
          "an operational actual VM has no image id",
        );
      }
      neededImageIds.add(vm.image_id);
      operational.push({
        reference: "host_actual:" + row.hostId + ":" + vm.vm_name,
        imageId: vm.image_id,
        imageKey: isImageKey(vm.image_key) ? vm.image_key : null,
        source: "host_actual",
      });
    }
    const inFlightImageIds = new Set<string>();
    for (const image of row.actual?.cached_images ?? []) {
      if (!image.image_id) continue;
      if (image.phase !== "queued" && image.phase !== "downloading") continue;
      inFlightImageIds.add(image.image_id);
    }
    hosts.push({
      hostId: row.hostId,
      cachedImages: row.desired?.cached_images ?? [],
      neededImageIds: [...neededImageIds].sort(),
      inFlightImageIds: [...inFlightImageIds].sort(),
    });
  }
  return { operational, hosts };
}

/**
 * The families a platform record still manages: what the catalog publishes,
 * what a retained rollback still covers, what a staged candidate intends, and
 * what a build manifest published. A family only an operator or another tenant
 * named is absent, and its intents are never trimmed.
 */
function collectManagedFamilies(roots: readonly ImageRoot[]): Set<string> {
  const families = new Set<string>();
  for (const root of roots) {
    families.add(
      imageRootKey({
        scenarioId: root.scenarioId,
        vmName: root.vmName,
        arch: root.arch,
      }),
    );
  }
  return families;
}

/** Objects an image needs in the bucket: its manifest and its boot artifacts. */
export interface RunImageClosure {
  chunkManifestSha256: string | null;
  kernelSha256: string | null;
  initrdSha256: string | null;
}

/** One image of a record, by the identity a registry reader resolves it with. */
export interface ImageClosureByIdentity {
  identity: string;
  imageKey: ImageKey;
  imageId: string;
  closure: RunImageClosure;
}

/** One record that describes an image, by the identity a reader resolves it with. */
export interface ImageClosureCandidate {
  imageKey: ImageKey;
  closure: RunImageClosure;
}

/**
 * Every closure that could describe one image, merged conservatively.
 *
 * One image id does not identify one boot variant: a later revision can
 * republish the same disk image with a different kernel or initrd, and the
 * registry keeps both. Merging every matching closure pins all of them;
 * picking the first would pin one variant and delete the other.
 *
 * An ambiguous image id (two distinct registry keys) is a fault, and so is a
 * chunked closure whose manifest names no boot artifact: half a manifest is
 * not a usable image, and guessing which half to drop is how a live VM breaks.
 *
 * Nothing is merged into a global keep-set: the caller decides what to do with
 * the result, so a historical closure that no operational reference names stays
 * unrooted.
 */
function mergeImageClosures(input: {
  subject: string;
  reference: string;
  imageKey: ImageKey | null;
  imageId: string;
  exact: ReadonlyMap<string, readonly ImageClosureCandidate[]>;
  byImageId: ReadonlyMap<string, readonly ImageClosureCandidate[]>;
  /** A run resolves through its own key only; a host VM may resolve by id. */
  allowIdFallback: boolean;
}): { imageKey: ImageKey; chunkManifestSha256s: string[]; bootArtifactSha256s: string[] } | null {
  const candidates: ImageClosureCandidate[] = [];
  if (input.imageKey) {
    const identity = registryImageKey(input.imageKey) + ":" + input.imageId;
    candidates.push(...(input.exact.get(identity) ?? []));
  }
  if (!candidates.length && (!input.imageKey || input.allowIdFallback)) {
    candidates.push(...(input.byImageId.get(input.imageId) ?? []));
  }
  if (!candidates.length) return null;
  const distinctKeys = new Set(
    candidates.map((candidate) => registryImageKey(candidate.imageKey)),
  );
  if (distinctKeys.size > 1) {
    throw new RegistryRetentionFault(
      input.reference,
      "the image id resolves to more than one registry image key: " +
        input.imageId,
    );
  }
  const chunkManifestSha256s = new Set<string>();
  const bootArtifactSha256s = new Set<string>();
  for (const candidate of candidates) {
    const manifestSha256 = candidate.closure.chunkManifestSha256;
    if (manifestSha256) {
      chunkManifestSha256s.add(manifestSha256);
      // A chunked image boots through its manifest and both boot artifacts, so
      // half a manifest is an unresolved reference and not a reason to delete.
      for (const field of ["kernelSha256", "initrdSha256"] as const) {
        const sha256 = candidate.closure[field];
        if (!sha256) {
          throw new RegistryRetentionFault(
            input.reference,
            "the manifest of an " + input.subject + " has no " + field,
          );
        }
        bootArtifactSha256s.add(sha256);
      }
      continue;
    }
    // A legacy, single-object image is self-booting, so nothing is required of
    // it. Every boot artifact it does record is still a reference: skipping
    // them because there is no chunk manifest would delete them.
    for (const field of ["kernelSha256", "initrdSha256"] as const) {
      const sha256 = candidate.closure[field];
      if (sha256) bootArtifactSha256s.add(sha256);
    }
  }
  return {
    imageKey: candidates[0]!.imageKey,
    chunkManifestSha256s: [...chunkManifestSha256s].sort(),
    bootArtifactSha256s: [...bootArtifactSha256s].sort(),
  };
}

/**
 * Every image the platform can still describe, by the identity a registry
 * reader uses: the registry image key plus the image id.
 *
 * The order is the source precedence, and the first source that knows an
 * identity supplies its closure: the publication that is live now, then the
 * retained rollback records, then the staged candidates, then the build audit
 * records. A run image keeps its identity through every later pointer move,
 * which is why this index, and not the current catalog, decides a run's root,
 * and why a rollback record has to be in it: after a direct publish moved the
 * pointer on, that record is the only place the run's metadata survives.
 */
function buildRunImageIndex(input: {
  liveRows: ReadonlyArray<{
    imageKey: unknown;
    imageId: string | null;
    chunkManifestSha256: string | null;
    kernelSha256: string | null;
    initrdSha256: string | null;
  }>;
  snapshotClosures: readonly ImageClosureByIdentity[];
  candidateRows: ReadonlyArray<{ manifest: ScenarioManifestV4 }>;
  buildRows: ReadonlyArray<{ manifest: ScenarioManifestV4 | null }>;
}): Map<string, ImageClosureCandidate[]> {
  // Multi-valued: one identity can carry several boot variants, and every one
  // of them is kept.
  const index = new Map<string, ImageClosureCandidate[]>();
  const add = (
    identity: string,
    imageKey: ImageKey,
    closure: RunImageClosure,
  ): void => {
    const entries = index.get(identity) ?? [];
    entries.push({ imageKey, closure });
    index.set(identity, entries);
  };
  for (const row of input.liveRows) {
    if (!isImageKey(row.imageKey) || !row.imageId) continue;
    add(registryImageKey(row.imageKey) + ":" + row.imageId, row.imageKey, {
      chunkManifestSha256: row.chunkManifestSha256,
      kernelSha256: row.kernelSha256,
      initrdSha256: row.initrdSha256,
    });
  }
  for (const entry of input.snapshotClosures) {
    add(entry.identity, entry.imageKey, entry.closure);
  }
  for (const row of input.candidateRows) addManifestClosures(index, row.manifest);
  for (const row of input.buildRows) {
    if (row.manifest) addManifestClosures(index, row.manifest);
  }
  return index;
}

/**
 * The same closures, indexed by image id alone.
 *
 * An actual VM report often carries only an image id, so this is how such a
 * VM reaches its manifest and boot artifacts. Only sources that carry a full
 * image key contribute: a live pointer row, a staged candidate manifest, and
 * a build manifest. Two different keys for one id stay two entries, and the
 * caller fails closed on that ambiguity instead of guessing.
 */
function buildImageIdIndex(input: {
  snapshotClosures: readonly ImageClosureByIdentity[];
  liveRows: ReadonlyArray<{
    imageKey: unknown;
    imageId: string | null;
    chunkManifestSha256: string | null;
    kernelSha256: string | null;
    initrdSha256: string | null;
  }>;
  candidateRows: ReadonlyArray<{ manifest: ScenarioManifestV4 }>;
  buildRows: ReadonlyArray<{ manifest: ScenarioManifestV4 | null }>;
}): Map<string, Array<{ imageKey: ImageKey; closure: RunImageClosure }>> {
  const index = new Map<
    string,
    Array<{ imageKey: ImageKey; closure: RunImageClosure }>
  >();
  const add = (
    imageKey: ImageKey,
    imageId: string,
    closure: RunImageClosure,
  ): void => {
    const entries = index.get(imageId) ?? [];
    // Only an exact closure is a duplicate. One key and one image id can
    // describe several boot variants, so deduping by key would drop the
    // second variant and leave the kernel and initrd a VM boots unpinned.
    const identity = registryImageKey(imageKey);
    const duplicate = entries.some(
      (entry) =>
        registryImageKey(entry.imageKey) === identity &&
        entry.closure.chunkManifestSha256 === closure.chunkManifestSha256 &&
        entry.closure.kernelSha256 === closure.kernelSha256 &&
        entry.closure.initrdSha256 === closure.initrdSha256,
    );
    if (duplicate) return;
    entries.push({ imageKey: { ...imageKey }, closure });
    index.set(imageId, entries);
  };
  for (const entry of input.snapshotClosures) {
    // A retained rollback is a reason to keep a whole closure: a direct publish
    // whose previous release exists only as a snapshot is what a host still
    // boots when its report carries no key.
    add(entry.imageKey, entry.imageId, entry.closure);
  }
  for (const row of input.liveRows) {
    if (!isImageKey(row.imageKey) || !row.imageId) continue;
    add(row.imageKey, row.imageId, {
      chunkManifestSha256: row.chunkManifestSha256,
      kernelSha256: row.kernelSha256,
      initrdSha256: row.initrdSha256,
    });
  }
  const manifestRows: Array<{ manifest: ScenarioManifestV4 | null }> = [
    ...input.candidateRows,
    ...input.buildRows,
  ];
  for (const row of manifestRows) {
    const vms = row.manifest?.vms;
    if (!Array.isArray(vms)) continue;
    for (const vm of vms) {
      if (!isImageKey(vm?.image_key)) continue;
      const imageId = typeof vm.image_id === "string" ? vm.image_id.trim() : "";
      if (!imageId) continue;
      add(vm.image_key, imageId, {
        chunkManifestSha256: readString(vm.chunk_manifest_sha256),
        kernelSha256: readString(vm.boot?.kernel_sha256),
        initrdSha256: readString(vm.boot?.initrd_sha256),
      });
    }
  }
  return index;
}
function addManifestClosures(
  index: Map<string, ImageClosureCandidate[]>,
  manifest: ScenarioManifestV4,
): void {
  const vms = manifest?.vms;
  if (!Array.isArray(vms)) return;
  for (const vm of vms) {
    if (!isImageKey(vm?.image_key)) continue;
    const imageId = typeof vm.image_id === "string" ? vm.image_id.trim() : "";
    if (!imageId) continue;
    const identity = registryImageKey(vm.image_key) + ":" + imageId;
    const entries = index.get(identity) ?? [];
    entries.push({
      imageKey: vm.image_key,
      closure: {
        chunkManifestSha256: readString(vm.chunk_manifest_sha256),
        kernelSha256: readString(vm.boot?.kernel_sha256),
        initrdSha256: readString(vm.boot?.initrd_sha256),
      },
    });
    index.set(identity, entries);
  }
}


/**
 * Commits the policy decisions. This is the only writer in this module, and
 * the collector calls it inside the exclusive sweep lease, before deletes.
 */
export async function applyRegistryRetention(
  env: RegistryRetentionDb,
  projection: RegistryRetentionProjection,
): Promise<{
  retiredBuildIds: string[];
  activatedBuildIds: string[];
  trimmedSnapshotIds: string[];
  deletedSnapshotIds: string[];
  deletedCandidateIds: string[];
  trimmedHostCacheImageIds: string[];
}> {
  const db = drizzle(env.DB);
  const now = projection.nowUnixMs;
  const statements: D1PreparedStatement[] = [];
  // D1 allows 100 bound parameters per query
  // (https://developers.cloudflare.com/d1/platform/limits/), and a sweep
  // decides every build and candidate row at once, so each id list travels as
  // one JSON array against SQLite json_each. All writes share one batch, so
  // one transaction commits the whole decision.

  // The host cache intents go first, before any object can be deleted: an
  // intent that still protects an object has to be withdrawn first, and the
  // version-guarded write is what proves the withdrawal landed. A lost version
  // race throws out of here, so the sweep stops with nothing deleted.
  const trimmedHostCacheImageIds: string[] = [];
  for (const trim of projection.hostCacheTrims) {
    const withdrawn = new Set(trim.imageIds);
    await mutateStoredHostDesiredState(db, trim.hostId, now, (draft) => {
      draft.cached_images = draft.cached_images.filter(
        (image) => !withdrawn.has(image.image_id),
      );
    });
    trimmedHostCacheImageIds.push(...trim.imageIds);
  }
  const trimmedHostCacheImageIdSet = new Set(trimmedHostCacheImageIds);

  if (projection.builds.retireBuildIds.length) {
    statements.push(
      env.DB
        .prepare(
          "UPDATE image_builds SET artifacts_retired_at = ?1, updated_at = ?1 " +
            "WHERE artifacts_retired_at IS NULL AND id IN (SELECT value FROM json_each(?2))",
        )
        .bind(now, JSON.stringify(projection.builds.retireBuildIds)),
    );
  }
  const activate = projection.builds.keepBuildIds.filter((buildId) =>
    projection.builds.retiredBuildIds.includes(buildId),
  );
  if (activate.length) {
    statements.push(
      env.DB
        .prepare(
          "UPDATE image_builds SET artifacts_retired_at = NULL, updated_at = ?1 " +
            "WHERE id IN (SELECT value FROM json_each(?2))",
        )
        .bind(now, JSON.stringify(activate)),
    );
  }
  for (const trim of projection.snapshots.trims) {
    statements.push(
      env.DB
        .prepare(
          "UPDATE scenario_catalog_snapshots SET snapshot_json = ?1 WHERE id = ?2",
        )
        .bind(JSON.stringify(trim.snapshot), trim.id),
    );
  }
  if (projection.snapshots.deleteIds.length) {
    statements.push(
      env.DB
        .prepare(
          "DELETE FROM scenario_catalog_snapshots WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .bind(JSON.stringify(projection.snapshots.deleteIds)),
    );
  }
  if (projection.candidates.retireIds.length) {
    statements.push(
      env.DB
        .prepare(
          "DELETE FROM scenario_catalog_candidates WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .bind(JSON.stringify(projection.candidates.retireIds)),
    );
  }
  if (statements.length) await env.DB.batch(statements);

  return {
    retiredBuildIds: projection.builds.retireBuildIds,
    activatedBuildIds: activate,
    trimmedSnapshotIds: projection.snapshots.trims.map((trim) => trim.id),
    deletedSnapshotIds: projection.snapshots.deleteIds,
    deletedCandidateIds: projection.candidates.retireIds,
    trimmedHostCacheImageIds: [...trimmedHostCacheImageIdSet].sort(),
  };
}
