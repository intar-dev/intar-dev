import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  vmScenarioProbes,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import { catalogRowsFromScenarioManifest } from "@/lib/catalog-manifest";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import { reconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import {
  hasRegistryPublishToken,
  isSafeBundleRev,
  jsonResponse,
} from "./shared";

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
    "SELECT state FROM runtime_operation_gates WHERE key = 'image_v10_cutover'",
  ).first<{ state: string }>();
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
  const expected = bundle.meta.scenarios;
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

  const candidates = await db
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
  const expectedScenarioIds = [...new Set(expected.map((item) => item.scenarioId))].sort();
  const candidateScenarioIds = candidates.map((item) => item.scenarioId).sort();
  if (JSON.stringify(candidateScenarioIds) !== JSON.stringify(expectedScenarioIds)) {
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

  const now = Date.now();
  const [previousScenarios, previousVms, previousProbes] = await Promise.all([
    db
      .select()
      .from(vmScenarios)
      .where(inArray(vmScenarios.scenarioId, expectedScenarioIds)),
    db
      .select()
      .from(vmScenarioVms)
      .where(inArray(vmScenarioVms.scenarioId, expectedScenarioIds)),
    db
      .select()
      .from(vmScenarioProbes)
      .where(inArray(vmScenarioProbes.scenarioId, expectedScenarioIds)),
  ]);
  const rollbackSnapshot: ScenarioCatalogRollbackV1 = {
    schemaVersion: 1,
    targetScenarioIds: expectedScenarioIds,
    scenarios: previousScenarios,
    vms: previousVms,
    probes: previousProbes,
  };
  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO scenario_catalog_snapshots
           (id, revision, organization_id, snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        catalogSnapshotId(bundle.organizationId, revision),
        revision,
        bundle.organizationId,
        JSON.stringify(rollbackSnapshot),
        now,
      ),
  );
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
    if (bundle.organizationId) {
      statements.push(
        env.DB
          .prepare(
            "UPDATE scenario_sources SET status = 'published', updated_at = ? WHERE organization_id = ? AND scenario_id = ?",
          )
          .bind(now, bundle.organizationId, rows.scenario.scenarioId),
      );
    }
  }
  await env.DB.batch(statements);

  const cache = await reconcileScenarioImagesForPublicationScope(db, {
    publicationOrganizationId: bundle.organizationId,
    nowUnixMs: now,
    wakeHostRuntime: (hostId) =>
      tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
  });
  if (cache.failedHostIds.length > 0) {
    return jsonResponse(
      {
        error: "catalog promoted but host desired-state reconciliation failed",
        failed_host_ids: cache.failedHostIds,
      },
      503,
    );
  }

  return jsonResponse({
    ok: true,
    revision,
    scenario_ids: expectedScenarioIds,
    changed_host_ids: cache.changedHostIds,
    rollback_snapshot_retained: true,
  });
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
    "SELECT state FROM runtime_operation_gates WHERE key = 'image_v10_cutover'",
  ).first<{ state: string }>();
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

  const placeholders = snapshot.targetScenarioIds.map(() => "?").join(",");
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
  await env.DB.batch(statements);

  const cache = await reconcileScenarioImagesForPublicationScope(db, {
    publicationOrganizationId: stored.organizationId,
    nowUnixMs: Date.now(),
    wakeHostRuntime: (hostId) =>
      tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
  });
  if (cache.failedHostIds.length > 0) {
    return jsonResponse(
      {
        error: "catalog rolled back but host desired-state reconciliation failed",
        failed_host_ids: cache.failedHostIds,
      },
      503,
    );
  }
  return jsonResponse({
    ok: true,
    revision,
    restored_scenario_ids: snapshot.targetScenarioIds,
    changed_host_ids: cache.changedHostIds,
  });
}

interface ScenarioCatalogRollbackV1 {
  schemaVersion: 1;
  targetScenarioIds: string[];
  scenarios: Array<typeof vmScenarios.$inferSelect>;
  vms: Array<typeof vmScenarioVms.$inferSelect>;
  probes: Array<typeof vmScenarioProbes.$inferSelect>;
}

function catalogSnapshotId(
  organizationId: string | null,
  revision: string,
): string {
  return `${organizationId ?? "public"}:${revision}:pre-promotion`;
}

function scenarioUpsert(
  database: D1Database,
  row: ReturnType<typeof catalogRowsFromScenarioManifest>["scenario"],
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

function vmInsert(
  database: D1Database,
  row: ReturnType<typeof catalogRowsFromScenarioManifest>["vms"][number],
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

function probeInsert(
  database: D1Database,
  row: ReturnType<typeof catalogRowsFromScenarioManifest>["probes"][number],
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
