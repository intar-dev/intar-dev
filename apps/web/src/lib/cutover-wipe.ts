// The cutover's one admin action (#306, §10.4 in #306): delete every row of
// scenario data on the current Worker, keep accounts, organizations, hosts,
// enrollment and credentials. R2 objects stay for the +14 d job.
import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";
import { IMAGE_CUTOVER_GATE, IMAGE_CUTOVER_WIPED } from "@/lib/run-admission-gate";
import { stopRunShare } from "@/lib/run-share/service";
import { revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { parseRunState } from "@/lib/scenario-runs/storage";

const KEPT_TABLES = ["agent_hosts", "organization", "member", "user"] as const;

/** Deleted in this order once no run or execution is left. */
const PLAIN_TABLES = [
  "host_cpu_reservations",
  "course_unit_completions",
  "scenario_assignments",
  "personal_image_preparations",
  "scenario_source_commits",
] as const;

const WIPED_TABLES = ["scenario_runs", "runtime_executions", ...PLAIN_TABLES] as const;

/** Rows per run or execution batch; D1 binds at most 100 parameters. */
const BATCH = 25;
// ponytail: a per-call budget keeps one request under the Worker's
// subrequest limit; the runbook repeats the call until `complete`.
const PARENTS_PER_CALL = 200;
const ROWS_PER_DELETE = 500;

type Counts = Record<string, number>;

export interface CutoverWipeReport {
  /** False while rows remain; call again. */
  complete: boolean;
  kept: { before: Counts; after: Counts };
  remaining: Counts;
  sharesStopped: number;
  runRoutesRevoked: number;
  uploadsAborted: number;
  uploadAbortFailures: number;
  /** Rows deleted directly; cascaded children are not counted. */
  deleted: Counts;
}

/**
 * Refused unless the operators' gate is `drained` (or already `wiped`, for a
 * retry). The gate turns `wiped` before the first delete, so no admission,
 * admin proof start or assignment can land behind the wipe.
 */
export async function wipeScenarioData(): Promise<CutoverWipeReport> {
  const gate = await env.DB.prepare(
    `UPDATE runtime_operation_gates SET state = ?1, updated_at = ?2
      WHERE key = ?3 AND state IN ('drained', ?1)`,
  )
    .bind(IMAGE_CUTOVER_WIPED, Date.now(), IMAGE_CUTOVER_GATE)
    .run();
  if (!gate.meta.changes) {
    throw appError(
      409,
      "runtime_cutover_not_drained",
      "Drain the runtime cutover gate before wiping scenario data.",
    );
  }

  const report: CutoverWipeReport = {
    complete: false,
    kept: { before: await countRows(KEPT_TABLES), after: {} },
    remaining: {},
    sharesStopped: 0,
    runRoutesRevoked: 0,
    uploadsAborted: 0,
    uploadAbortFailures: 0,
    deleted: Object.fromEntries(WIPED_TABLES.map((table) => [table, 0])),
  };
  let budget = PARENTS_PER_CALL;

  // Each batch is finished before its rows go, so a failed share wipe or
  // route revoke throws with the run still there for the retry.
  while (budget > 0) {
    const { results: runs } = await env.DB.prepare(
      `SELECT run_id, share_id, state, state_json FROM scenario_runs ORDER BY run_id LIMIT ?`,
    )
      .bind(Math.min(BATCH, budget))
      .all<{ run_id: string; share_id: string | null; state: string; state_json: string }>();
    if (!runs.length) break;
    budget -= runs.length;
    for (const run of runs) {
      if (!run.share_id) continue;
      await stopRunShare(run.run_id, run.share_id);
      report.sharesStopped += 1;
    }
    const ids = runs.map((run) => run.run_id);
    await abortUploads(
      report,
      `SELECT artifact.r2_key, upload.r2_upload_id
         FROM scenario_run_artifact_uploads upload
         JOIN scenario_run_artifacts artifact ON artifact.id = upload.artifact_id
        WHERE upload.r2_upload_id IS NOT NULL AND artifact.run_id IN (${marks(ids)})`,
      ids,
    );
    for (const run of runs) {
      if (run.state === "completed" || run.state === "failed") continue;
      await revokeScenarioRunRoutes({ runId: run.run_id, state: parseRunState(run.state_json) });
      report.runRoutesRevoked += 1;
    }
    await deleteWhereIn("scenario_runs", "run_id", ids);
    report.deleted.scenario_runs! += ids.length;
  }

  while (budget > 0) {
    const { results: executions } = await env.DB.prepare(
      `SELECT id FROM runtime_executions ORDER BY id LIMIT ?`,
    )
      .bind(Math.min(BATCH, budget))
      .all<{ id: string }>();
    if (!executions.length) break;
    budget -= executions.length;
    const ids = executions.map((execution) => execution.id);
    await abortUploads(
      report,
      `SELECT artifact.r2_key, upload.r2_upload_id
         FROM runtime_artifact_uploads upload
         JOIN runtime_artifacts artifact ON artifact.id = upload.artifact_id
        WHERE upload.r2_upload_id IS NOT NULL AND artifact.execution_id IN (${marks(ids)})`,
      ids,
    );
    await deleteWhereIn("runtime_executions", "id", ids);
    report.deleted.runtime_executions! += ids.length;
  }

  if (budget > 0) {
    for (const table of PLAIN_TABLES) {
      for (;;) {
        const result = await env.DB.prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`,
        )
          .bind(ROWS_PER_DELETE)
          .run();
        if (!result.meta.changes) break;
        report.deleted[table]! += result.meta.changes;
      }
    }
  }

  report.remaining = await countRows(WIPED_TABLES);
  report.complete = Object.values(report.remaining).every((count) => count === 0);
  report.kept.after = await countRows(KEPT_TABLES);
  console.log(JSON.stringify({ event: "cutover_wipe", ...report }));
  return report;
}

/** Aborts pending multipart uploads; never deletes an object. */
async function abortUploads(
  report: CutoverWipeReport,
  query: string,
  ids: string[],
): Promise<void> {
  const { results } = await env.DB.prepare(query)
    .bind(...ids)
    .all<{ r2_key: string; r2_upload_id: string }>();
  for (const upload of results) {
    try {
      await env.VM_RUN_ARTIFACTS_BUCKET.resumeMultipartUpload(
        upload.r2_key,
        upload.r2_upload_id,
      ).abort();
      report.uploadsAborted += 1;
    } catch {
      // Already completed, aborted or expired: nothing is left to stop.
      report.uploadAbortFailures += 1;
    }
  }
}

/** Children go by `ON DELETE CASCADE`. */
async function deleteWhereIn(table: string, column: string, ids: string[]): Promise<void> {
  await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} IN (${marks(ids)})`)
    .bind(...ids)
    .run();
}

async function countRows(tables: readonly string[]): Promise<Counts> {
  const row = await env.DB.prepare(
    `SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM "${table}") AS "${table}"`).join(", ")}`,
  ).first<Counts>();
  return row ?? {};
}

function marks(ids: string[]): string {
  return ids.map(() => "?").join(", ");
}
