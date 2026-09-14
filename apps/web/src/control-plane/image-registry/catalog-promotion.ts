import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  vmScenarioVms,
  vmScenarios,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type {
  ImageArchitecture,
  ScenarioManifestV4,
} from "@/generated/catalog";
import { catalogRowsFromScenarioManifest } from "@/lib/catalog-manifest";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  type CachedImageRetentionScope,
  loadLiveFamilyImageIds,
} from "@/lib/image-artifact-retention";
import { pruneSupersededHostCachedImages } from "@/lib/registry-host-cache-eviction";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import {
  REGISTRY_CLEANUP_WAIT_BUDGET_MS,
  registryCleanupService,
  runRegistryCleanup,
  type RegistryCleanupServiceBinding,
} from "@/lib/registry-cleanup-client";
import {
  admitRegistryOperation,
  createRegistryWriterGuard,
} from "@/lib/image-registry-admission";
import { withImageBuildCoordinationLocks } from "@/lib/image-build-lock";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import {
  catalogRollbackSnapshotStatement,
  loadOutgoingReferenceBlockers,
  loadScenarioCatalogRollback,
  nextCatalogRollbackTimestamp,
  probeInsert,
  scenarioUpsert,
  vmInsert,
  type ScenarioCatalogRollbackV1,
} from "@/lib/scenario-catalog-rollback";
import { reconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import {
  hasRegistryPublishToken,
  isImageArchitecture,
  isSafeBundleRev,
  jsonResponse,
} from "./shared";

/**
 * The committed result of one candidate promotion. Every field is read under
 * the per-family lock, so it describes the state this promotion installed.
 */
interface CandidatePromotionOutcome {
  scenarioIds: string[];
  changedHostIds: string[];
  failedHostIds: string[];
  alreadyPromoted: boolean;
  evictedHostIds: string[];
}

export async function handleCandidateCatalogPromotion(
  request: Request,
  env: Cloudflare.Env,
  revision: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!(await hasRegistryPublishToken(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!isSafeBundleRev(revision)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }
  if (request.headers.get("x-intar-drained") !== "true") {
    return jsonResponse({ error: "catalog promotion requires a drained host fleet" }, 409);
  }

  const gate = await env.DB.prepare(
    "SELECT state FROM runtime_operation_gates WHERE key = ?",
  )
    .bind(IMAGE_CUTOVER_GATE)
    .first<{ state: string }>();
  if (gate?.state !== "drained") {
    return jsonResponse({ error: "runtime cutover gate is not drained" }, 409);
  }

  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM host_desired_state, json_each(host_desired_state.doc_json, '$.vms') AS vm
      WHERE json_extract(vm.value, '$.desired_phase') = 'running'`,
  ).first<{ count: number }>();
  if ((active?.count ?? 0) !== 0) {
    return jsonResponse({ error: "catalog promotion requires zero running desired VMs" }, 409);
  }

  const db = drizzle(env.DB);
  const bundles = await db
    .select({
      organizationId: imageBuildBundles.organizationId,
      meta: imageBuildBundles.metaJson,
    })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, revision))
    .limit(1);
  const bundle = bundles[0];
  if (!bundle || bundle.meta.catalogChannel !== "candidate") {
    return jsonResponse({ error: "candidate bundle revision not found" }, 404);
  }
  if (bundle.meta.buildFormatVersion !== IMAGE_BUILD_FORMAT_VERSION) {
    return jsonResponse(
      { error: "candidate bundle uses an unsupported image build format" },
      409,
    );
  }
  // Promotion is not complete until retired artifacts are actually gone, so
  // the cleanup service must be reachable. This check runs after the request
  // validation above, so a bad request keeps its own status code, and it still
  // precedes every catalog write below.
  const cleanupService = registryCleanupService(env);
  if (!cleanupService) {
    return jsonResponse(
      { error: "registry cleanup service is not configured" },
      503,
    );
  }
  // A report-only collector lists candidates and deletes nothing, so a
  // promotion that ran now would leave retired artifacts in the bucket while
  // reporting success. Refuse before the first catalog write instead.
  const cleanupReadiness = await readCleanupReadiness(cleanupService);
  if (!cleanupReadiness.deletes) {
    return jsonResponse(
      {
        error:
          "registry cleanup cannot delete: promotion needs a collector in delete mode",
        code: "registry_cleanup_not_deleting",
        cleanup: {
          state: cleanupReadiness.status,
          mode: cleanupReadiness.mode,
          hold: cleanupReadiness.hold,
        },
      },
      503,
    );
  }
  const now = Date.now();
  // The writer is admitted BEFORE the first source read and held through the
  // commit and the cache updates, so the collector cannot retire the candidate
  // build, the candidate rows, or their artifacts while this promotion is
  // still deciding what to install. It is settled before the sweep is asked to
  // run, which is what lets the collector take its exclusive lease after.
  const admitted = await admitRegistryOperation(request, env, {
    operation: "pointer_mutation",
    requireSession: false,
  });
  if (!admitted.ok) return admitted.response;
  const writer = createRegistryWriterGuard(admitted.lease);
  let promoted: CandidatePromotionOutcome | undefined;
  try {
    const expected = bundle.meta.scenarios;
    // The candidate and build reads are deliberately inside the same per-family
    // locks a direct live publish takes, so no other replacement can move the
    // catalog between the read and the commit.
    const locked = await withImageBuildCoordinationLocks(
      db,
      expected.map((item) => ({ scenarioId: item.scenarioId, arch: item.arch })),
      async () => {
        const builds = await db
          .select({
            id: imageBuilds.id,
            scenarioId: imageBuilds.scenarioId,
            arch: imageBuilds.arch,
            contentHash: imageBuilds.contentHash,
            status: imageBuilds.status,
            manifest: imageBuilds.publishedManifestJson,
          })
          .from(imageBuilds)
          .where(inArray(imageBuilds.contentHash, expected.map((item) => item.contentHash)));
        const exactBuilds = expected.map((item) =>
          builds.find(
            (build) =>
              build.scenarioId === item.scenarioId &&
              build.arch === item.arch &&
              build.contentHash === item.contentHash,
          ),
        );
        if (
          exactBuilds.some(
            (build) => !build || build.status !== "succeeded" || !build.manifest,
          )
        ) {
          return jsonResponse({ error: "candidate builds are not complete" }, 409);
        }

        const expectedScenarioIds = [...new Set(expected.map((item) => item.scenarioId))].sort();
        const incomingFamilies = incomingFamilyImages(expected, exactBuilds);
        const liveImageIdsByFamily = await loadFamilyImageIdsMap(db, incomingFamilies);
        // A retry of an already promoted revision must not re-snapshot the promoted
        // catalog into the rollback slot, and must not re-validate candidate rows
        // the first attempt already consumed.
        const alreadyPromoted = await isCatalogAtRevision(
          db,
          revision,
          incomingFamilies,
          liveImageIdsByFamily,
        );
        const outgoingImageIds = outgoingFamilyImageIds(
          incomingFamilies,
          liveImageIdsByFamily,
        );

        const candidates = alreadyPromoted
          ? []
          : await db
          .select({
            scenarioId: scenarioCatalogCandidates.scenarioId,
            buildId: scenarioCatalogCandidates.buildId,
            manifest: scenarioCatalogCandidates.manifestJson,
          })
          .from(scenarioCatalogCandidates)
          .where(
            and(
              eq(scenarioCatalogCandidates.revision, revision),
              bundle.organizationId
                ? eq(scenarioCatalogCandidates.organizationId, bundle.organizationId)
                : isNull(scenarioCatalogCandidates.organizationId),
            ),
          );
        const candidateScenarioIds = candidates.map((item) => item.scenarioId).sort();
        if (
          !alreadyPromoted &&
          JSON.stringify(candidateScenarioIds) !== JSON.stringify(expectedScenarioIds)
        ) {
          return jsonResponse({ error: "candidate catalog is incomplete" }, 409);
        }

        const ownership = await db
          .select({
            scenarioId: vmScenarios.scenarioId,
            organizationId: vmScenarios.organizationId,
          })
          .from(vmScenarios)
          .where(inArray(vmScenarios.scenarioId, expectedScenarioIds));
        if (
          ownership.some(
            (row) => row.organizationId !== bundle.organizationId,
          )
        ) {
          return jsonResponse({ error: "candidate catalog ownership conflict" }, 409);
        }

        const blockers = await loadOutgoingReferenceBlockers(db, {
          organizationId: bundle.organizationId,
          scenarioIds: expectedScenarioIds,
          outgoingImageIds,
        });
        if (blockers.executionIds.length || blockers.hostIds.length) {
          return jsonResponse(
            {
              error: "catalog promotion is blocked by active image use",
              blocking_execution_ids: blockers.executionIds,
              blocking_host_ids: blockers.hostIds,
              outgoing_image_ids: outgoingImageIds,
            },
            409,
          );
        }

          // The previous rows are the rollback of record. They are captured through
        // the shared replacement helper, so a promotion and a direct live publish
        // record the same shape and neither can rotate a rollback on a repeat.
        const rollbackSnapshot = await loadScenarioCatalogRollback(
          db,
          expectedScenarioIds,
        );
        const statements: D1PreparedStatement[] = [];
        if (!alreadyPromoted) {
          statements.push(
            catalogRollbackSnapshotStatement(env.DB, {
              id: catalogSnapshotId(bundle.organizationId, revision),
              revision,
              organizationId: bundle.organizationId,
              rollback: rollbackSnapshot,
              // The record must be the newest one for the family, so a live publish
              // that already recorded a rollback cannot carry a later timestamp than
              // the promotion that replaced it.
              createdAt: await nextCatalogRollbackTimestamp(db, {
                organizationId: bundle.organizationId,
                previous: rollbackSnapshot,
                nowUnixMs: now,
              }),
            }),
          );
        }
        for (const candidate of candidates) {
          const rows = catalogRowsFromScenarioManifest(candidate.manifest, {
            enabled: true,
            organizationId: bundle.organizationId,
            sourceRevision: revision,
            nowUnixMs: now,
          });
          statements.push(
            scenarioUpsert(env.DB, rows.scenario),
            env.DB.prepare("DELETE FROM vm_scenario_probes WHERE scenario_id = ?").bind(
              rows.scenario.scenarioId,
            ),
            env.DB.prepare("DELETE FROM vm_scenario_vms WHERE scenario_id = ?").bind(
              rows.scenario.scenarioId,
            ),
          );
          for (const vm of rows.vms) statements.push(vmInsert(env.DB, vm));
          for (const probe of rows.probes) statements.push(probeInsert(env.DB, probe));
        }
        // The first mutating write of this promotion. From here a throw must
        // leave the writer unresolved instead of claiming nothing changed.
        writer.markWriteStarted();
        if (statements.length) await env.DB.batch(statements);

        const retention = await applyImageRetentionAfterCatalogChange(db, env, {
          organizationId: bundle.organizationId,
          incomingFamilies,
          previousImageIdsByFamily: liveImageIdsByFamily,
          nowUnixMs: now,
        });
        const cache = await reconcileScenarioImagesForPublicationScope(db, {
          publicationOrganizationId: bundle.organizationId,
          nowUnixMs: now,
          wakeHostRuntime: (hostId) =>
            tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
        });
        return {
          scenarioIds: expectedScenarioIds,
          changedHostIds: cache.changedHostIds,
          failedHostIds: cache.failedHostIds,
          alreadyPromoted,
          evictedHostIds: retention.evictedHostIds,
        };
      },
    );
    if (locked instanceof Response) return locked;
    promoted = locked;
    // Every write of this promotion has landed: the rollback record, the catalog
    // rows, the retirement markers, and the host cache updates. The writer is
    // settled here and not later, because the sweep below is exactly the work a
    // held writer would block.
    await writer.release("ok");
  } finally {
    await writer.finish();
  }

  if (promoted === undefined) {
    // Every path through the guarded section either returns a refusal or
    // assigns the outcome, so this branch is defensive only.
    return jsonResponse({ error: "catalog promotion did not run" }, 500);
  }
  if (promoted.failedHostIds.length > 0) {
    return jsonResponse(
      {
        error: "catalog promoted but host desired-state reconciliation failed",
        failed_host_ids: promoted.failedHostIds,
      },
      503,
    );
  }

  // The guard is released here, so the collector can hold its exclusive sweep.
  // The collector computes the root set itself, so it needs no scope argument.
  const cleanup = await runRegistryCleanup(cleanupService, {
    nowUnixMs: now,
    waitBudgetMs: REGISTRY_CLEANUP_WAIT_BUDGET_MS,
  });
  // The catalog is committed either way. Only a pass that applied deletions and
  // finished its whole worklist completes the promotion: a report-only, paused,
  // busy, fenced, refused, or partial collector leaves the deletion half
  // pending and says so.
  if (!cleanup.applied || cleanup.partial) {
    return jsonResponse(
      {
        error:
          cleanup.error ??
          (cleanup.partial
            ? "registry artifacts are not deleted yet: the sweep did not finish"
            : "registry artifacts are not deleted yet: cleanup did not apply"),
        catalog_promoted: true,
        retry: true,
        cleanup: cleanupPayload(cleanup),
      },
      503,
    );
  }

  return jsonResponse({
    ok: true,
    revision,
    scenario_ids: promoted.scenarioIds,
    changed_host_ids: promoted.changedHostIds,
    rollback_snapshot_retained: true,
    retried: promoted.alreadyPromoted,
    evicted_host_ids: promoted.evictedHostIds,
    cleanup: cleanupPayload(cleanup),
  });
}

/**
 * Asks the collector whether a pass would actually delete. A paused or
 * report-only collector answers no, and the promotion refuses before it
 * mutates anything.
 */
async function readCleanupReadiness(
  service: RegistryCleanupServiceBinding,
): Promise<{ deletes: boolean; mode: string; status: string; hold: string }> {
  try {
    const status = await service.status();
    const hold = status.paused ? "drained" : "open";
    return {
      deletes: status.mode === "delete" && status.modeValid && hold === "open",
      mode: status.mode,
      status: status.running ? "running" : status.idle ? "idle" : "unknown",
      hold,
    };
  } catch (error) {
    return {
      deletes: false,
      mode: "unavailable",
      status: error instanceof Error ? error.message : "status failed",
      hold: "unknown",
    };
  }
}

/**
 * A report-only or failed pass is not completed retention: the caller must
 * treat the deletion half of the promotion as pending, not as done.
 */
function cleanupPayload(cleanup: {
  ok: boolean;
  applied: boolean;
  partial: boolean;
  status: string;
  deletedObjects: number;
  deletedBytes: number;
  failedObjects: number;
  candidates: number;
  truncated: boolean;
}) {
  return {
    state: cleanup.status,
    applied: cleanup.applied,
    partial: cleanup.partial,
    pending: !cleanup.applied,
    deleted_objects: cleanup.deletedObjects,
    deleted_bytes: cleanup.deletedBytes,
    failed_objects: cleanup.failedObjects,
    candidate_objects: cleanup.candidates,
    truncated: cleanup.truncated,
  };
}

export async function handleCatalogRollback(
  request: Request,
  env: Cloudflare.Env,
  revision: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!(await hasRegistryPublishToken(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!isSafeBundleRev(revision)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }
  if (request.headers.get("x-intar-drained") !== "true") {
    return jsonResponse({ error: "catalog rollback requires a drained host fleet" }, 409);
  }
  const gate = await env.DB.prepare(
    "SELECT state FROM runtime_operation_gates WHERE key = ?",
  )
    .bind(IMAGE_CUTOVER_GATE)
    .first<{ state: string }>();
  if (gate?.state !== "drained") {
    return jsonResponse({ error: "runtime cutover gate is not drained" }, 409);
  }
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM host_desired_state, json_each(host_desired_state.doc_json, '$.vms') AS vm
      WHERE json_extract(vm.value, '$.desired_phase') = 'running'`,
  ).first<{ count: number }>();
  if ((active?.count ?? 0) !== 0) {
    return jsonResponse({ error: "catalog rollback requires zero running desired VMs" }, 409);
  }

  // The writer is admitted BEFORE the snapshot read and held through the
  // restore and the cache updates, so a sweep cannot retire the rollback this
  // request is about to replay. It is settled before the response.
  const admitted = await admitRegistryOperation(request, env, {
    operation: "pointer_mutation",
    requireSession: false,
  });
  if (!admitted.ok) return admitted.response;
  const writer = createRegistryWriterGuard(admitted.lease);
  let restored:
    | {
        scenarioIds: string[];
        changedHostIds: string[];
        failedHostIds: string[];
      }
    | undefined;
  try {
    const db = drizzle(env.DB);
    const snapshots = await db
      .select({
        organizationId: scenarioCatalogSnapshots.organizationId,
        snapshot: scenarioCatalogSnapshots.snapshotJson,
      })
      .from(scenarioCatalogSnapshots)
      .where(eq(scenarioCatalogSnapshots.revision, revision));
    if (snapshots.length !== 1) {
      return jsonResponse({ error: "exact rollback snapshot is unavailable or ambiguous" }, 409);
    }
    const stored = snapshots[0];
    const snapshot = stored?.snapshot as unknown as ScenarioCatalogRollbackV1;
    if (
      !stored ||
      snapshot?.schemaVersion !== 1 ||
      !Array.isArray(snapshot.targetScenarioIds) ||
      snapshot.targetScenarioIds.length === 0 ||
      !Array.isArray(snapshot.scenarios) ||
      !Array.isArray(snapshot.vms) ||
      !Array.isArray(snapshot.probes)
    ) {
      return jsonResponse({ error: "rollback snapshot is invalid" }, 409);
    }

    const restoredFamilies = familiesFromSnapshotRows(snapshot.vms);
    // The same per-family locks a direct live publish takes, so the restore
    // cannot interleave with a live replacement of the same catalog.
    const locked = await withImageBuildCoordinationLocks(
      db,
      restoredFamilies.map((family) => ({
        scenarioId: family.scenarioId,
        arch: family.arch,
      })),
      async () => {
        const placeholders = snapshot.targetScenarioIds.map(() => "?").join(",");
        // The pointers the rollback replaces are the rollback image of the restored
        // state; read them before the restore rewrites the catalog.
        const replacedImageIdsByFamily = new Map<string, string[]>(
          await Promise.all(
            restoredFamilies.map(
              async (family) =>
                [
                  familyKey(family),
                  await loadLiveFamilyImageIds(db, {
                    scenarioId: family.scenarioId,
                    arch: family.arch,
                  }),
                ] as const,
            ),
          ),
        );
        const statements: D1PreparedStatement[] = [
          env.DB
            .prepare(
              `DELETE FROM vm_scenario_probes WHERE scenario_id IN (${placeholders})`,
            )
            .bind(...snapshot.targetScenarioIds),
          env.DB
            .prepare(`DELETE FROM vm_scenario_vms WHERE scenario_id IN (${placeholders})`)
            .bind(...snapshot.targetScenarioIds),
          env.DB
            .prepare(`DELETE FROM vm_scenarios WHERE scenario_id IN (${placeholders})`)
            .bind(...snapshot.targetScenarioIds),
        ];
        for (const scenario of snapshot.scenarios) {
          statements.push(scenarioUpsert(env.DB, scenario));
        }
        for (const vm of snapshot.vms) statements.push(vmInsert(env.DB, vm));
        for (const probe of snapshot.probes) statements.push(probeInsert(env.DB, probe));
        // The first mutating write of this rollback. From here a throw must
        // leave the writer unresolved instead of claiming nothing changed.
        writer.markWriteStarted();
        await env.DB.batch(statements);

        await applyImageRetentionAfterCatalogChange(db, env, {
          organizationId: stored.organizationId,
          incomingFamilies: restoredFamilies,
          previousImageIdsByFamily: replacedImageIdsByFamily,
          nowUnixMs: Date.now(),
        });
        const cache = await reconcileScenarioImagesForPublicationScope(db, {
          publicationOrganizationId: stored.organizationId,
          nowUnixMs: Date.now(),
          wakeHostRuntime: (hostId) =>
            tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
        });
        return {
          scenarioIds: snapshot.targetScenarioIds,
          changedHostIds: cache.changedHostIds,
          failedHostIds: cache.failedHostIds,
        };
      },
    );
    restored = locked;
    await writer.release("ok");
  } finally {
    await writer.finish();
  }

  if (restored === undefined) {
    // Every path through the guarded section either returns a refusal or
    // assigns the outcome, so this branch is defensive only.
    return jsonResponse({ error: "catalog rollback did not run" }, 500);
  }
  if (restored.failedHostIds.length > 0) {
    return jsonResponse(
      {
        error: "catalog rolled back but host desired-state reconciliation failed",
        failed_host_ids: restored.failedHostIds,
      },
      503,
    );
  }
  return jsonResponse({
    ok: true,
    revision,
    restored_scenario_ids: restored.scenarioIds,
    changed_host_ids: restored.changedHostIds,
  });
}

function catalogSnapshotId(
  organizationId: string | null,
  revision: string,
): string {
  return `${organizationId ?? "public"}:${revision}:pre-promotion`;
}

export interface IncomingFamily {
  scenarioId: string;
  arch: ImageArchitecture;
  imageIds: string[];
}

/** Restored snapshot rows grouped into the (scenario, arch) families they own. */
function familiesFromSnapshotRows(
  vms: Array<typeof vmScenarioVms.$inferSelect>,
): IncomingFamily[] {
  const families = new Map<string, IncomingFamily>();
  for (const vm of vms) {
    const arch = vm.imageKeyJson?.arch;
    if (!isImageArchitecture(arch)) continue;
    const key = familyKey({ scenarioId: vm.scenarioId, arch });
    const family = families.get(key) ?? {
      scenarioId: vm.scenarioId,
      arch,
      imageIds: [],
    };
    if (vm.imageSha256) family.imageIds.push(vm.imageSha256);
    families.set(key, family);
  }
  return [...families.values()]
    .map((family) => ({
      ...family,
      imageIds: [...new Set(family.imageIds)].sort(),
    }))
    .sort((left, right) => familyKey(left).localeCompare(familyKey(right)));
}


export function familyKey(family: {
  scenarioId: string;
  arch: string;
}): string {
  return `${family.scenarioId}:${family.arch}`;
}

/** Image ids each (scenario, arch) family installs when it is promoted. */
export function incomingFamilyImages(
  expected: ImageBuildBundleMeta["scenarios"],
  exactBuilds: Array<{ manifest: ScenarioManifestV4 | null } | undefined>,
): IncomingFamily[] {
  const families = new Map<string, IncomingFamily>();
  expected.forEach((item, index) => {
    const key = familyKey(item);
    const family = families.get(key) ?? {
      scenarioId: item.scenarioId,
      arch: item.arch,
      imageIds: [],
    };
    for (const vm of exactBuilds[index]?.manifest?.vms ?? []) {
      if (vm.image_key.arch === item.arch) family.imageIds.push(vm.image_id);
    }
    families.set(key, family);
  });
  return [...families.values()]
    .map((family) => ({
      ...family,
      imageIds: [...new Set(family.imageIds)].sort(),
    }))
    .sort((left, right) => familyKey(left).localeCompare(familyKey(right)));
}

async function loadFamilyImageIdsMap(
  db: DrizzleD1Database,
  families: readonly IncomingFamily[],
): Promise<Map<string, string[]>> {
  const byFamily = new Map<string, string[]>(
    families.map((family) => [familyKey(family), []]),
  );
  if (!families.length) return byFamily;
  const rows = await db
    .select({
      scenarioId: vmScenarioVms.scenarioId,
      arch: sql<unknown>`json_extract(${vmScenarioVms.imageKeyJson}, '$.arch')`,
      imageId: vmScenarioVms.imageSha256,
    })
    .from(vmScenarioVms)
    .where(
      inArray(
        vmScenarioVms.scenarioId,
        [...new Set(families.map((family) => family.scenarioId))],
      ),
    );
  for (const row of rows) {
    const key = familyKey({
      scenarioId: row.scenarioId,
      arch: String(row.arch),
    });
    const list = byFamily.get(key);
    if (list && typeof row.imageId === "string") list.push(row.imageId);
  }
  for (const [key, list] of byFamily) {
    byFamily.set(key, [...new Set(list)].sort());
  }
  return byFamily;
}

/** Live images the promotion replaces and that may still be needed. */
function outgoingFamilyImageIds(
  families: readonly IncomingFamily[],
  liveImageIdsByFamily: Map<string, string[]>,
): string[] {
  const incoming = new Set(families.flatMap((family) => family.imageIds));
  const outgoing = new Set<string>();
  for (const live of liveImageIdsByFamily.values()) {
    for (const imageId of live) {
      if (!incoming.has(imageId)) outgoing.add(imageId);
    }
  }
  return [...outgoing].sort();
}

/**
 * True when the live catalog already carries exactly this revision and image
 * set, which makes the promotion request a retry of a committed promotion.
 */
async function isCatalogAtRevision(
  db: DrizzleD1Database,
  revision: string,
  families: readonly IncomingFamily[],
  liveImageIdsByFamily: Map<string, string[]>,
): Promise<boolean> {
  if (!families.length) return false;
  const scenarioIds = [...new Set(families.map((family) => family.scenarioId))];
  const scenarios = await db
    .select({
      scenarioId: vmScenarios.scenarioId,
      sourceRevision: vmScenarios.sourceRevision,
    })
    .from(vmScenarios)
    .where(inArray(vmScenarios.scenarioId, scenarioIds));
  if (scenarios.length !== scenarioIds.length) return false;
  if (scenarios.some((row) => row.sourceRevision !== revision)) return false;
  return families.every((family) => {
    const live = liveImageIdsByFamily.get(familyKey(family)) ?? [];
    return (
      JSON.stringify([...live].sort()) === JSON.stringify([...family.imageIds].sort())
    );
  });
}

/**
 * Promotion blockers:
 *  - an active runtime execution whose VM still boots the outgoing image,
 *  - a host with an active VM or an unfinished transfer for an outgoing image.
 * Ready local cache entries that desired state no longer requires are not
 * blockers; promotion evicts them through the desired-state path afterwards.
 */
async function applyImageRetentionAfterCatalogChange(
  db: DrizzleD1Database,
  env: Cloudflare.Env,
  input: {
    organizationId: string | null;
    incomingFamilies: readonly IncomingFamily[];
    previousImageIdsByFamily: Map<string, string[]>;
    nowUnixMs: number;
  },
): Promise<{
  evictedHostIds: string[];
}> {
  const retentionScopes: CachedImageRetentionScope[] = [];
  for (const family of input.incomingFamilies) {
    const previous =
      input.previousImageIdsByFamily.get(familyKey(family)) ?? [];
    retentionScopes.push({
      scenarioId: family.scenarioId,
      arch: family.arch,
      keepImageIds: [...new Set([...family.imageIds, ...previous])].sort(),
    });
  }

  const evicted = await pruneSupersededHostCachedImages(db, {
    organizationId: input.organizationId,
    scenarios: retentionScopes,
    nowUnixMs: input.nowUnixMs,
    wakeHost: (hostId) => tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
  });
  return { evictedHostIds: evicted.changedHostIds };
}
