import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  ACTIVE_RUNTIME_EXECUTION_STATES,
  agentHosts,
  hostActualState,
  imageBuilds,
} from "@/db/schema";
import type { ImageBuildBundleMeta } from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { AppError, appError } from "@/lib/app-error";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { loadRetiredBuildIds } from "@/lib/image-artifact-retention";
import { upsertDesiredCachedImage } from "@/lib/desired-state";
import {
  applyLecturePresentation,
  findCourseLecturePresentation,
} from "@/lib/course-catalogs";

/**
 * Stages one candidate scenario row.
 *
 * The row is not only the publish intent: it is the manifest reader of a
 * candidate start and the retention root of the build objects that start
 * launches. A rewrite of the row for the same id therefore changes what a run
 * in flight reads and what the artifact collector keeps for it.
 *
 * The refusal is part of the write, not a read before it: a start commits its
 * runtime execution and its run row in one batch, so a row that looks free
 * before this statement can be read by a run again after it. The statement
 * inserts only while no run in an active execution state reads the row, and it
 * updates only a row whose payload really differs. An identical replay writes
 * nothing, so it neither changes the reader nor moves the staged timestamp.
 */
export async function stageCandidateScenarioManifest(
  db: DrizzleD1Database,
  input: {
    revision: string;
    organizationId: string | null;
    buildId: string;
    manifest: ScenarioManifestV4;
    nowUnixMs: number;
  },
): Promise<void> {
  const id = candidateScenarioId(
    input.organizationId,
    input.revision,
    input.manifest.scenario_id,
  );
  const scenarioId = input.manifest.scenario_id;
  const manifestJson = JSON.stringify(input.manifest);
  // The same authority the retention policy and the outgoing-reference check
  // read, rendered as bound values so the guard and the policy cannot drift.
  const activeExecutionStates = sql.join(
    ACTIVE_RUNTIME_EXECUTION_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  const written = await db.all<{ id: string }>(sql`
    INSERT INTO scenario_catalog_candidates (
      id, revision, organization_id, scenario_id, build_id, manifest_json,
      created_at, updated_at
    )
    SELECT ${id}, ${input.revision}, ${input.organizationId}, ${scenarioId},
           ${input.buildId}, ${manifestJson}, ${input.nowUnixMs}, ${input.nowUnixMs}
    WHERE NOT EXISTS (
      SELECT 1
      FROM scenario_runs run
      JOIN runtime_executions execution
        ON execution.id = run.runtime_execution_id
      WHERE run.scenario_id = ${scenarioId}
        AND run.organization_id IS ${input.organizationId}
        AND json_extract(run.request_scope_json, '$.candidateRevision') = ${input.revision}
        AND execution.state IN (${activeExecutionStates})
        AND NOT EXISTS (
          SELECT 1
          FROM scenario_catalog_candidates staged
          WHERE staged.id = ${id}
            AND staged.build_id IS ${input.buildId}
            AND staged.manifest_json IS ${manifestJson}
        )
    )
    ON CONFLICT(id) DO UPDATE SET
      build_id = excluded.build_id,
      manifest_json = excluded.manifest_json,
      updated_at = excluded.updated_at
    WHERE scenario_catalog_candidates.build_id IS NOT excluded.build_id
       OR scenario_catalog_candidates.manifest_json IS NOT excluded.manifest_json
    RETURNING id
  `);
  if (written.length > 0) return;
  // Nothing was written: the row either already holds this exact payload, which
  // is an identical replay, or the guard refused a change while a run still
  // reads the row.
  const staged = await db.get<{ buildId: string; manifestJson: string }>(sql`
    SELECT build_id AS buildId, manifest_json AS manifestJson
    FROM scenario_catalog_candidates
    WHERE id = ${id}
  `);
  if (
    staged?.buildId !== input.buildId ||
    staged.manifestJson !== manifestJson
  ) {
    // The refused publish fails instead of reporting a success that did not
    // land: the row keeps the manifest the active run reads, and the caller can
    // stage the same revision again once that run has finished.
    throw appError(
      409,
      "candidate_source_locked",
      "an active run still reads this candidate scenario; the staged manifest was not changed",
    );
  }
}

/**
 * True when the error is the refusal of a candidate source rewrite.
 *
 * It is a settled refusal and never an unknown write: one conditional
 * statement proved that no row changed, so the caller answers this exact 409
 * and settles its registry writer. Left as a hold instead, the row would block
 * every destructive sweep until an operator reap, for a refusal that no retry
 * can change.
 */
export function isCandidateSourceLocked(error: unknown): boolean {
  return error instanceof AppError && error.code === "candidate_source_locked";
}

export async function warmCandidateScenarioManifest(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    manifest: ScenarioManifestV4;
    nowUnixMs: number;
    wakeHost: (hostId: string) => Promise<void>;
  },
): Promise<string[]> {
  const hosts = await loadCandidateAgentHosts(db, input.organizationId);
  const warmed: string[] = [];
  for (const host of hosts) {
    const images = input.manifest.vms.filter(
      (vm) => vm.image_key.arch === host.arch,
    );
    if (images.length === 0) continue;
    await mutateStoredHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
      (draft) => {
        for (const vm of images) {
          upsertDesiredCachedImage(draft, {
            image_key: vm.image_key,
            image_id: vm.image_id,
          });
        }
      },
    );
    await input.wakeHost(host.id);
    warmed.push(host.id);
  }
  return warmed.sort();
}

async function warmReusableCandidateManifests(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    manifests: ScenarioManifestV4[];
    nowUnixMs: number;
    wakeHost: (hostId: string) => Promise<void>;
  },
): Promise<void> {
  if (!input.manifests.length) return;

  const hosts = await loadCandidateAgentHosts(db, input.organizationId);
  for (const host of hosts) {
    const images = input.manifests.flatMap((manifest) =>
      manifest.vms.filter((vm) => vm.image_key.arch === host.arch),
    );
    if (!images.length) continue;

    const current = await loadOrCreateHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
    );
    let changed = false;
    await mutateStoredHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
      (draft) => {
        changed = false;
        for (const vm of images) {
          if (
            !draft.cached_images.some(
              (candidate) =>
                candidate.image_id === vm.image_id &&
                candidate.image_key.scenario === vm.image_key.scenario &&
                candidate.image_key.vm === vm.image_key.vm &&
                candidate.image_key.arch === vm.image_key.arch,
            )
          ) {
            changed = true;
          }
          upsertDesiredCachedImage(draft, {
            image_key: vm.image_key,
            image_id: vm.image_id,
          });
        }
      },
      current,
    );
    if (!changed) continue;
    await input.wakeHost(host.id);
  }
}

async function loadCandidateAgentHosts(
  db: DrizzleD1Database,
  organizationId: string | null,
) {
  return db
    .select({
      id: agentHosts.id,
      arch: sql<unknown>`json_extract(${hostActualState.reportJson}, '$.capabilities.arch')`,
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        organizationId
          ? eq(agentHosts.organizationId, organizationId)
          : undefined,
      ),
    );
}

export function candidateScenarioId(
  organizationId: string | null,
  revision: string,
  scenarioId: string,
): string {
  return `${organizationId ?? "public"}:${revision}:${scenarioId}`;
}

export async function stageReusableCandidateManifests(
  db: DrizzleD1Database,
  input: {
    revision: string;
    organizationId: string | null;
    meta: ImageBuildBundleMeta;
    nowUnixMs: number;
    wakeHost: (hostId: string) => Promise<void>;
  },
): Promise<string[]> {
  if (input.meta.catalogChannel !== "candidate") return [];
  const hashes = [...new Set(input.meta.scenarios.map((item) => item.contentHash))];
  if (hashes.length === 0) return [];
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
    .where(inArray(imageBuilds.contentHash, hashes));
  // A retired build keeps its audit row but has no artifacts left, so it must
  // never be staged as a reusable candidate. The next bundle queues a rebuild.
  const retiredBuildIds = await loadRetiredBuildIds(
    db,
    builds.map((build) => build.id),
  );
  const staged: string[] = [];
  const manifests: ScenarioManifestV4[] = [];
  for (const expected of input.meta.scenarios) {
    const build = builds.find(
      (candidate) =>
        candidate.scenarioId === expected.scenarioId &&
        candidate.arch === expected.arch &&
        candidate.contentHash === expected.contentHash &&
        candidate.status === "succeeded" &&
        !retiredBuildIds.has(candidate.id) &&
        candidate.manifest,
    );
    if (!build?.manifest) continue;
    const presentation = input.meta.courseCatalog
      ? findCourseLecturePresentation(
          input.meta.courseCatalog,
          expected.scenarioId,
        )
      : null;
    const manifest = presentation
      ? applyLecturePresentation(build.manifest, presentation)
      : build.manifest;
    await stageCandidateScenarioManifest(db, {
      revision: input.revision,
      organizationId: input.organizationId,
      buildId: build.id,
      manifest,
      nowUnixMs: input.nowUnixMs,
    });
    manifests.push(manifest);
    staged.push(expected.scenarioId);
  }
  await warmReusableCandidateManifests(db, {
    organizationId: input.organizationId,
    manifests,
    nowUnixMs: input.nowUnixMs,
    wakeHost: input.wakeHost,
  });
  return staged.sort();
}
