import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  ACTIVE_RUNTIME_EXECUTION_STATES,
  agentHosts,
  hostActualState,
  hostDesiredState,
  runtimeExecutions,
  runtimeVms,
  scenarioCatalogSnapshots,
  scenarioRuns,
  vmScenarioProbes,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { appError } from "@/lib/app-error";
import { catalogRowsFromScenarioManifest } from "@/lib/catalog-manifest";
import { evaluateHostImageReferences } from "@/lib/image-artifact-retention";

/**
 * One authority for replacing a live scenario catalog and for the rollback
 * record that makes the replacement reversible.
 *
 * Every live catalog replacement keeps exactly one recoverable previous state:
 * candidate promotion and a direct live publish both capture the rows they
 * replace, in the same D1 batch as the replacement itself. A candidate publish
 * replaces nothing, so it captures nothing.
 *
 * The capture is the ONLY way a replaced image stays referenced. Without it the
 * retention planner keeps the live images plus whatever older snapshot exists,
 * and the immediate previous release becomes unreferenced.
 */

export interface ScenarioCatalogRollbackV1 {
  schemaVersion: 1;
  targetScenarioIds: string[];
  scenarios: Array<typeof vmScenarios.$inferSelect>;
  vms: Array<typeof vmScenarioVms.$inferSelect>;
  probes: Array<typeof vmScenarioProbes.$inferSelect>;
}

export type ScenarioCatalogRows = ReturnType<
  typeof catalogRowsFromScenarioManifest
>;

/**
 * Reads the full previous state of the given scenarios: the catalog rows, the
 * VM rows with their image pointers, and the probe rows. A rollback replay
 * restores all three, so the capture must be complete rather than selective.
 */
export async function loadScenarioCatalogRollback(
  db: DrizzleD1Database,
  scenarioIds: readonly string[],
): Promise<ScenarioCatalogRollbackV1> {
  const ordered = [...new Set(scenarioIds)].sort();
  if (!ordered.length) {
    return {
      schemaVersion: 1,
      targetScenarioIds: [],
      scenarios: [],
      vms: [],
      probes: [],
    };
  }
  const [scenarios, vms, probes] = await Promise.all([
    db.select().from(vmScenarios).where(inArray(vmScenarios.scenarioId, ordered)),
    db
      .select()
      .from(vmScenarioVms)
      .where(inArray(vmScenarioVms.scenarioId, ordered)),
    db
      .select()
      .from(vmScenarioProbes)
      .where(inArray(vmScenarioProbes.scenarioId, ordered)),
  ]);
  return {
    schemaVersion: 1,
    targetScenarioIds: ordered,
    scenarios,
    vms,
    probes,
  };
}

/**
 * The rollback record of one replacement.
 *
 * The primary key is the immutable idempotency key of the caller, so replaying
 * the same replacement inserts nothing and cannot rotate a rollback that is
 * already recorded.
 */
export function catalogRollbackSnapshotStatement(
  database: D1Database,
  input: {
    id: string;
    revision: string;
    organizationId: string | null;
    rollback: ScenarioCatalogRollbackV1;
    createdAt: number;
  },
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO scenario_catalog_snapshots
         (id, revision, organization_id, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.revision,
      input.organizationId,
      JSON.stringify(input.rollback),
      input.createdAt,
    );
}

/** The row writes that install one catalog revision. */
export function catalogReplacementStatements(
  database: D1Database,
  rows: ScenarioCatalogRows,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    scenarioUpsert(database, rows.scenario),
    database
      .prepare("DELETE FROM vm_scenario_probes WHERE scenario_id = ?")
      .bind(rows.scenario.scenarioId),
    database
      .prepare("DELETE FROM vm_scenario_vms WHERE scenario_id = ?")
      .bind(rows.scenario.scenarioId),
  ];
  for (const vm of rows.vms) statements.push(vmInsert(database, vm));
  for (const probe of rows.probes) statements.push(probeInsert(database, probe));
  return statements;
}

/**
 * Full artifact identity of one VM slot.
 *
 * It covers every field the VM needs in order to boot the same bytes, and
 * deliberately not the catalog metadata: republishing identical images with new
 * prose is not a new image state. Three shapes reach this: a manifest, the rows
 * a manifest produces, and a live catalog row.
 */
interface VmArtifactIdentity {
  vmName: string;
  arch: string;
  imageSha256: string;
  imageFormat: string;
  imageVirtualSizeBytes: number;
  chunkManifestSha256: string;
  guestBootstrapAbi: string;
  kernelSha256: string;
  initrdSha256: string;
  bootCmdline: string;
}

function vmArtifactIdentity(input: VmArtifactIdentity): string {
  return [
    input.vmName,
    input.arch,
    input.imageSha256,
    input.imageFormat,
    String(input.imageVirtualSizeBytes),
    input.chunkManifestSha256,
    input.guestBootstrapAbi,
    input.kernelSha256,
    input.initrdSha256,
    input.bootCmdline,
  ].join(":");
}

function fromManifestVm(vm: ScenarioManifestV4["vms"][number]): VmArtifactIdentity {
  return {
    vmName: vm.name.trim(),
    arch: vm.image_key.arch,
    imageSha256: vm.image_id,
    imageFormat: vm.image_format,
    imageVirtualSizeBytes: vm.image_virtual_size_bytes,
    chunkManifestSha256: vm.chunk_manifest_sha256 ?? "",
    guestBootstrapAbi: String(vm.guest_bootstrap_abi ?? ""),
    kernelSha256: vm.boot?.kernel_sha256 ?? "",
    initrdSha256: vm.boot?.initrd_sha256 ?? "",
    bootCmdline: vm.boot?.cmdline ?? "",
  };
}

function fromLiveRow(
  row: typeof vmScenarioVms.$inferSelect,
): VmArtifactIdentity {
  return {
    vmName: row.vmName,
    arch: row.imageKeyJson?.arch ?? "",
    imageSha256: row.imageSha256 ?? "",
    imageFormat: row.imageFormat,
    imageVirtualSizeBytes: row.imageVirtualSizeBytes,
    chunkManifestSha256: row.chunkManifestSha256 ?? "",
    guestBootstrapAbi: String(row.guestBootstrapAbi ?? ""),
    kernelSha256: row.kernelSha256,
    initrdSha256: row.initrdSha256,
    bootCmdline: row.bootCmdline,
  };
}

function catalogArtifactIdentity(entries: readonly string[]): string {
  return [...entries].sort().join("|");
}

/**
 * The created_at of the next rollback record of one family, shared by every
 * live replacement so the newest record is always the newest transition.
 *
 * Snapshot retention picks the newest record per scenario, so the ordering must
 * be decided by created_at and never by an id tiebreak: two records written in
 * the same millisecond, or written by a clock that stepped backwards, must
 * still order deterministically. The caller holds the per-family lock, so this
 * reads a state that cannot change underneath it and always advances past every
 * timestamp already written for the family.
 */
export async function nextCatalogRollbackTimestamp(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    previous: ScenarioCatalogRollbackV1;
    nowUnixMs: number;
  },
): Promise<number> {
  const scope = input.organizationId
    ? eq(scenarioCatalogSnapshots.organizationId, input.organizationId)
    : isNull(scenarioCatalogSnapshots.organizationId);
  const [latest] = await db
    .select({
      createdAt: sql<number | null>`max(${scenarioCatalogSnapshots.createdAt})`,
    })
    .from(scenarioCatalogSnapshots)
    .where(scope);
  let next = Math.trunc(input.nowUnixMs);
  if (latest?.createdAt !== null && latest?.createdAt !== undefined) {
    next = Math.max(next, Math.trunc(latest.createdAt) + 1);
  }
  for (const scenario of input.previous.scenarios) {
    next = Math.max(next, Math.trunc(scenario.updatedAt) + 1);
    next = Math.max(next, Math.trunc(scenario.createdAt) + 1);
  }
  return next;
}

/** True when this replacement changes the artifact identity of the catalog. */
export function catalogRollbackRotates(input: {
  previous: ScenarioCatalogRollbackV1;
  manifest: ScenarioManifestV4;
}): boolean {
  if (!input.previous.vms.length) return false;
  return (
    catalogArtifactIdentity(
      input.previous.vms.map((row) => vmArtifactIdentity(fromLiveRow(row))),
    ) !==
    catalogArtifactIdentity(
      input.manifest.vms.map((vm) => vmArtifactIdentity(fromManifestVm(vm))),
    )
  );
}

let liveTransitionCounter = 0;

/**
 * A fresh transition id for one live replacement.
 *
 * A transition is NOT identifiable by its content. A -> B -> C -> B returns to
 * an image state the registry already saw, and that second arrival at B is a
 * different transition from the first, with a different previous state. Keying
 * a rollback by the incoming identity would make the second arrival reuse the
 * first record, lose the immediate previous state, and hand the collector a
 * stale rollback. Every real transition therefore gets its own row, and the
 * rollback of record is the newest row rather than an old row whose key
 * happens to match.
 *
 * The id is time-ordered and unique within an isolate; the random suffix keeps
 * two isolates apart.
 */
export function liveCatalogTransitionId(nowUnixMs: number): string {
  liveTransitionCounter += 1;
  const time = Math.max(0, Math.trunc(nowUnixMs)).toString(36).padStart(9, "0");
  const seq = (liveTransitionCounter % 1_679_616).toString(36).padStart(4, "0");
  return time + "-" + seq + "-" + crypto.randomUUID().slice(0, 8);
}

export interface LiveCatalogReplacement {
  rows: ScenarioCatalogRows;
  previous: ScenarioCatalogRollbackV1;
  /** Image ids of the state this replacement replaces. */
  previousImageIds: string[];
  /** Previous image ids this replacement stops referencing. */
  outgoingImageIds: string[];
  /** Null when the replacement records no rollback. */
  transitionId: string | null;
  /** The created_at of that record; the caller's clock value is carried here. */
  transitionAtUnixMs: number;
  /**
   * Non-null when the outgoing-reference policy refused the replacement. A
   * refused replacement writes nothing at all.
   */
  blocked: { executionIds: string[]; hostIds: string[] } | null;
}

/**
 * Replaces one live scenario catalog and records the rollback of record.
 *
 * Every decision is made from the CURRENT live state, which is why the caller
 * must hold the per-family image-build coordination lock across this whole
 * call: two concurrent replacements that both read the same previous state
 * would otherwise both capture it and lose the state in between.
 *
 *   - a first publication has no previous state, so it records no rollback;
 *   - a replacement whose full artifact identity equals the live identity
 *     rotates nothing, so a metadata-only republish and an idempotent retry
 *     leave the recorded rollback alone;
 *   - any other replacement records a fresh transition capturing the state it
 *     replaces, and the snapshot plus the catalog rows commit in one batch;
 *   - a replacement the outgoing-reference policy refuses writes nothing.
 */
export async function replaceScenarioCatalogWithRollback(
  db: DrizzleD1Database,
  database: D1Database,
  input: {
    manifest: ScenarioManifestV4;
    organizationId: string | null;
    sourceRevision: string | null;
    nowUnixMs: number;
  },
): Promise<LiveCatalogReplacement> {
  const rows = catalogRowsFromScenarioManifest(input.manifest, {
    enabled: true,
    organizationId: input.organizationId,
    sourceRevision: input.sourceRevision,
    nowUnixMs: input.nowUnixMs,
  });
  const scenarioId = rows.scenario.scenarioId;
  await assertScenarioCatalogOwnership(
    db,
    scenarioId,
    rows.scenario.organizationId ?? null,
  );

  const previous = await loadScenarioCatalogRollback(db, [scenarioId]);
  const incomingImageIds = new Set(
    rows.vms
      .map((row) => row.imageSha256)
      .filter((imageId): imageId is string => Boolean(imageId)),
  );
  const previousImageIds = [
    ...new Set(
      previous.vms
        .map((row) => row.imageSha256)
        .filter((imageId): imageId is string => Boolean(imageId)),
    ),
  ].sort();
  const outgoingImageIds = previousImageIds.filter(
    (imageId) => !incomingImageIds.has(imageId),
  );

  const blockers = await loadOutgoingReferenceBlockers(db, {
    organizationId: input.organizationId,
    scenarioIds: [scenarioId],
    outgoingImageIds,
  });
  if (blockers.executionIds.length || blockers.hostIds.length) {
    return {
      rows,
      previous,
      previousImageIds,
      outgoingImageIds,
      transitionId: null,
      transitionAtUnixMs: Math.trunc(input.nowUnixMs),
      blocked: {
        executionIds: blockers.executionIds,
        hostIds: blockers.hostIds,
      },
    };
  }

  const rotates = catalogRollbackRotates({ previous, manifest: input.manifest });
  const transitionId = rotates
    ? liveCatalogTransitionId(input.nowUnixMs)
    : null;
  const statements: D1PreparedStatement[] = [];
  let transitionAtUnixMs = Math.trunc(input.nowUnixMs);
  if (transitionId) {
    transitionAtUnixMs = await nextCatalogRollbackTimestamp(db, {
      organizationId: input.organizationId,
      previous,
      nowUnixMs: input.nowUnixMs,
    });
    const snapshotKey = scenarioId + ":live:" + transitionId;
    statements.push(
      catalogRollbackSnapshotStatement(database, {
        id: catalogSnapshotRowId(input.organizationId, snapshotKey),
        revision: snapshotKey,
        organizationId: input.organizationId,
        rollback: previous,
        createdAt: transitionAtUnixMs,
      }),
    );
  }
  statements.push(...catalogReplacementStatements(database, rows));
  await database.batch(statements);

  return {
    rows,
    previous,
    previousImageIds,
    outgoingImageIds,
    transitionId,
    transitionAtUnixMs,
    blocked: null,
  };
}

export function catalogSnapshotRowId(
  organizationId: string | null,
  key: string,
): string {
  return (organizationId ?? "public") + ":" + key;
}

/**
 * Outgoing-reference policy, shared by every live catalog replacement:
 *  - an active runtime execution whose VM still boots an outgoing image,
 *  - a host with an active VM or an unfinished transfer for an outgoing image.
 * Ready local cache entries that desired state no longer requires are not
 * blockers; the replacement evicts them through the desired-state path.
 */
export async function loadOutgoingReferenceBlockers(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    scenarioIds: readonly string[];
    outgoingImageIds: readonly string[];
  },
): Promise<{
  executionIds: string[];
  hostIds: string[];
  leftoverCacheHostIds: string[];
}> {
  if (!input.outgoingImageIds.length) {
    return { executionIds: [], hostIds: [], leftoverCacheHostIds: [] };
  }
  const [executions, hosts] = await Promise.all([
    db
      .select({ executionId: runtimeExecutions.id })
      .from(runtimeVms)
      .innerJoin(
        runtimeExecutions,
        eq(runtimeExecutions.id, runtimeVms.executionId),
      )
      .innerJoin(
        scenarioRuns,
        eq(scenarioRuns.runtimeExecutionId, runtimeExecutions.id),
      )
      .where(
        and(
          inArray(runtimeVms.imageSha256, [...input.outgoingImageIds]),
          inArray(runtimeExecutions.state, [...ACTIVE_RUNTIME_EXECUTION_STATES]),
          inArray(scenarioRuns.scenarioId, [...input.scenarioIds]),
        ),
      ),
    db
      .select({
        hostId: agentHosts.id,
        desired: hostDesiredState.docJson,
        actual: hostActualState.reportJson,
      })
      .from(agentHosts)
      .leftJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
      .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(
        and(
          eq(agentHosts.role, "agent"),
          eq(agentHosts.disabled, false),
          input.organizationId
            ? eq(agentHosts.organizationId, input.organizationId)
            : undefined,
        ),
      ),
  ]);

  const hostIds: string[] = [];
  const leftoverCacheHostIds: string[] = [];
  for (const host of hosts) {
    const evaluation = evaluateHostImageReferences({
      outgoingImageIds: input.outgoingImageIds,
      desired: host.desired,
      actual: host.actual,
    });
    if (evaluation.blocking.length) {
      hostIds.push(host.hostId);
    } else if (evaluation.leftover.length) {
      leftoverCacheHostIds.push(host.hostId);
    }
  }
  return {
    executionIds: [...new Set(executions.map((row) => row.executionId))].sort(),
    hostIds: hostIds.sort(),
    leftoverCacheHostIds: leftoverCacheHostIds.sort(),
  };
}

/** A scenario id belongs to exactly one catalog. */
async function assertScenarioCatalogOwnership(
  db: DrizzleD1Database,
  scenarioId: string,
  organizationId: string | null,
): Promise<void> {
  const existing = await db
    .select({ organizationId: vmScenarios.organizationId })
    .from(vmScenarios)
    .where(eq(vmScenarios.scenarioId, scenarioId))
    .limit(1);
  if (existing[0] && existing[0].organizationId !== organizationId) {
    throw appError(
      409,
      "scenario_catalog_ownership_conflict",
      "scenario id belongs to another catalog",
    );
  }
}

export function scenarioUpsert(
  database: D1Database,
  row: ScenarioCatalogRows["scenario"],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO vm_scenarios (
         scenario_id, organization_id, source_revision, title, category,
         description, difficulty, estimated_minutes, tags_json,
         briefing_markdown, solution_markdown, hints_json, enabled, enabled_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scenario_id) DO UPDATE SET
         organization_id = excluded.organization_id,
         source_revision = excluded.source_revision,
         title = excluded.title,
         category = excluded.category,
         description = excluded.description,
         difficulty = excluded.difficulty,
         estimated_minutes = excluded.estimated_minutes,
         tags_json = excluded.tags_json,
         briefing_markdown = excluded.briefing_markdown,
         solution_markdown = excluded.solution_markdown,
         hints_json = excluded.hints_json,
         enabled = excluded.enabled,
         enabled_at = excluded.enabled_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      row.scenarioId,
      row.organizationId ?? null,
      row.sourceRevision ?? null,
      row.title,
      row.category,
      row.description,
      row.difficulty,
      row.estimatedMinutes,
      JSON.stringify(row.tagsJson),
      row.briefingMarkdown,
      row.solutionMarkdown,
      JSON.stringify(row.hintsJson),
      row.enabled ? 1 : 0,
      row.enabledAt ?? null,
      row.createdAt,
      row.updatedAt,
    );
}

export function vmInsert(
  database: D1Database,
  row: ScenarioCatalogRows["vms"][number],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO vm_scenario_vms (
         id, scenario_id, ordinal, vm_name, image, image_key_json,
         image_sha256, image_format, image_virtual_size_bytes,
         chunk_manifest_sha256, guest_bootstrap_abi, kernel_sha256,
         initrd_sha256, boot_cmdline, cpu_millis, vcpu_count, memory_mib,
         disk_mib
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.scenarioId,
      row.ordinal,
      row.vmName,
      row.image,
      JSON.stringify(row.imageKeyJson),
      row.imageSha256 ?? null,
      row.imageFormat,
      row.imageVirtualSizeBytes,
      row.chunkManifestSha256 ?? null,
      row.guestBootstrapAbi ?? null,
      row.kernelSha256,
      row.initrdSha256,
      row.bootCmdline,
      row.cpuMillis,
      row.vcpuCount,
      row.memoryMib,
      row.diskMib,
    );
}

export function probeInsert(
  database: D1Database,
  row: ScenarioCatalogRows["probes"][number],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO vm_scenario_probes (
         id, scenario_id, scenario_vm_id, ordinal, name, description, title,
         body_markdown, hints_json, phase, kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.scenarioId,
      row.scenarioVmId,
      row.ordinal,
      row.name,
      row.description,
      row.title ?? null,
      row.bodyMarkdown ?? null,
      JSON.stringify(row.hintsJson),
      row.phase,
      row.kind,
    );
}
