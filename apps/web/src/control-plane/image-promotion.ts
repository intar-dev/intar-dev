// Intar's own image catalog promotion. A public scenario source commit that
// replaces live images waits in `awaiting_promote`; this machine promotes it at
// the next idle moment, and an admin can start one for any candidate revision.
// It holds new runs through its own gate key, `image_promotion`, and never
// touches the operators' `image_cutover`, so it cannot reopen a drain it did
// not make. The key's evidence_json is the one attempt, and every transition
// is one compare-and-set on its exact text. The every-minute cron advances it.
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { imageBuildBundles, imageBuilds } from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  admitInternalRegistryOperation,
  readRegistryAdmissionState,
} from "@/lib/image-registry-admission";
import { activeAdministrator } from "@/lib/platform-admin-authority";
import {
  REGISTRY_CLEANUP_WAIT_BUDGET_MS,
  registryCleanupService,
  runRegistryCleanup,
} from "@/lib/registry-cleanup-client";
import { IMAGE_CUTOVER_GATE, PROMOTION_HOLD_GATE } from "@/lib/run-admission-gate";
import { loadOutgoingReferenceBlockers } from "@/lib/scenario-catalog-rollback";
import {
  publicSourceRevPromotable,
  recordPublicSourceLive,
  scenarioSourceBindingPredicate,
} from "@/lib/scenario-sources";
import {
  loadRevisionStatus,
  revisionReady,
  type RevisionStatus,
} from "./image-registry/build-status";
import {
  incomingFamilyImages,
  loadFamilyImageIdsMap,
  outgoingFamilyImageIds,
  promoteDrainedRevision,
  readCleanupReadiness,
  type PromotionAdmission,
  type PromotionFence,
} from "./image-registry/catalog-promotion";
import { isSafeBundleRev } from "./image-registry/shared";

/** An automatic attempt's whole drain: idle VMs, free images and readiness. */
const AUTO_DRAIN_BOUND_MS = 10 * 60_000;
/** A forced or admin attempt waits for active runs to end. */
const FORCED_DRAIN_BOUND_MS = 6 * 60 * 60_000;
/** An admin attempt waits this long for its revision to become ready. */
const ADMIN_WAIT_BOUND_MS = 2 * 60 * 60_000;
/** After these, an automatic attempt reopens runs and leaves the rest. */
const AUTO_CLEANUP_BOUND_MS = 30 * 60_000;
const AUTO_VERIFY_BOUND_MS = 10 * 60_000;
/** An automatic attempt that failed is not retried for its revision before this. */
const AUTO_RETRY_COOLDOWN_MS = 60 * 60_000;

export type PromotionPhase =
  | "waiting"
  | "drained"
  | "promoting"
  | "cleaning"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled"
  | "released"
  | "yielded";

/** Phases in which Intar holds new runs. */
const HOLDING = new Set<PromotionPhase>(["drained", "promoting", "cleaning", "verifying"]);
const ENDED = new Set<PromotionPhase>(["done", "failed", "cancelled", "released", "yielded"]);

export interface PromotionAttempt {
  v: 1;
  id: string;
  revision: string;
  origin: "auto" | "admin";
  requestedBy: string | null;
  phase: PromotionPhase;
  detail: string | null;
  createdAt: number;
  drainedAt: number | null;
  committedAt: number | null;
  cleanedAt: number | null;
  finishedAt: number | null;
}

interface PromotionGate {
  /** The exact stored text, the compare-and-set key; null before the first attempt. */
  text: string | null;
  attempt: PromotionAttempt | null;
}

const FENCE_ABORT = /NOT NULL constraint failed: runtime_operation_gates\.state/;
const RUNNING_VMS = sql`(SELECT COUNT(*) FROM host_desired_state,
  json_each(host_desired_state.doc_json, '$.vms') AS vm
  WHERE json_extract(vm.value, '$.desired_phase') = 'running')`;
const OPERATOR_DRAINED = sql`EXISTS (SELECT 1 FROM runtime_operation_gates
  WHERE key = ${IMAGE_CUTOVER_GATE} AND state = 'drained')`;

async function readGate(db: DrizzleD1Database): Promise<PromotionGate> {
  const row = await db.get<{ evidence_json: string | null } | undefined>(
    sql`SELECT evidence_json FROM runtime_operation_gates WHERE key = ${PROMOTION_HOLD_GATE}`,
  );
  const text = row?.evidence_json ?? null;
  return { text, attempt: parseAttempt(text) };
}

function parseAttempt(text: string | null): PromotionAttempt | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as PromotionAttempt;
    return value?.v === 1 && typeof value.revision === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Moves the attempt from the text read to `next`, in one statement that also
 * sets the hold. `guard` must hold at write time. False when anything changed.
 */
async function transition(
  db: DrizzleD1Database,
  gate: PromotionGate,
  next: PromotionAttempt,
  guard: SQL = sql`1`,
): Promise<PromotionGate | null> {
  const text = JSON.stringify(next);
  const state = HOLDING.has(next.phase) ? "drained" : "open";
  const result = await db.run(sql`INSERT INTO runtime_operation_gates
      (key, state, evidence_json, updated_at)
    SELECT ${PROMOTION_HOLD_GATE}, ${state}, ${text}, ${Date.now()} WHERE ${guard}
    ON CONFLICT (key) DO UPDATE SET state = excluded.state,
      evidence_json = excluded.evidence_json, updated_at = excluded.updated_at
    WHERE runtime_operation_gates.evidence_json IS ${gate.text}`);
  if (result.meta.changes !== 1) return null;
  if (next.phase !== gate.attempt?.phase) {
    console.info(
      JSON.stringify({
        event: "image_promotion",
        id: next.id,
        revision: next.revision,
        origin: next.origin,
        from: gate.attempt?.phase ?? null,
        to: next.phase,
        detail: next.detail,
      }),
    );
    // The public check run names Intar's hold, so its binding looks again.
    if (HOLDING.has(next.phase) !== HOLDING.has(gate.attempt?.phase ?? "waiting")) {
      await db.run(sql`UPDATE scenario_sources SET poked_at = ${Date.now()}
        WHERE scope_key = 'public'`);
    }
  }
  return { text, attempt: next };
}

async function setDetail(db: DrizzleD1Database, gate: PromotionGate, detail: string) {
  if (!gate.attempt || gate.attempt.detail === detail) return;
  await transition(db, gate, { ...gate.attempt, detail });
}

function end(
  db: DrizzleD1Database,
  gate: PromotionGate,
  phase: "done" | "failed" | "cancelled" | "released" | "yielded",
  detail: string | null,
) {
  const attempt = gate.attempt as PromotionAttempt;
  return transition(db, gate, { ...attempt, phase, detail, finishedAt: Date.now() });
}

/** The public commit waiting for its images, while its binding may write. */
async function pendingPublicRevision(db: DrizzleD1Database): Promise<string | null> {
  const row = await db.get<{ rev: string } | undefined>(sql`SELECT c.rev
    FROM scenario_source_commits AS c
    JOIN scenario_sources ON scenario_sources.scope_key = c.scope_key
    WHERE c.scope_key = 'public' AND c.purpose = 'deploy' AND c.state = 'awaiting_promote'
      AND c.rev = scenario_sources.target_rev AND ${scenarioSourceBindingPredicate()}
    LIMIT 1`);
  return row?.rev ?? null;
}

/** Runs and hosts that still reference an image this revision replaces. */
async function outgoingImageUse(
  db: DrizzleD1Database,
  revision: string,
): Promise<{ executionIds: string[]; hostIds: string[] }> {
  const [bundle] = await db
    .select({ organizationId: imageBuildBundles.organizationId, meta: imageBuildBundles.metaJson })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, revision))
    .limit(1);
  const scenarios = bundle?.meta.scenarios ?? [];
  if (!bundle || !scenarios.length) return { executionIds: [], hostIds: [] };
  const builds = await db
    .select({
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      contentHash: imageBuilds.contentHash,
      manifest: imageBuilds.publishedManifestJson,
    })
    .from(imageBuilds)
    .where(inArray(imageBuilds.contentHash, [...new Set(scenarios.map((item) => item.contentHash))]));
  const incoming = incomingFamilyImages(
    scenarios,
    scenarios.map((item) =>
      builds.find(
        (build) =>
          build.scenarioId === item.scenarioId &&
          build.arch === item.arch &&
          build.contentHash === item.contentHash,
      ),
    ),
  );
  const outgoingImageIds = outgoingFamilyImageIds(incoming, await loadFamilyImageIdsMap(db, incoming));
  if (!outgoingImageIds.length) return { executionIds: [], hostIds: [] };
  const blockers = await loadOutgoingReferenceBlockers(db, {
    organizationId: bundle.organizationId,
    scenarioIds: [...new Set(scenarios.map((item) => item.scenarioId))],
    outgoingImageIds,
  });
  return { executionIds: blockers.executionIds, hostIds: blockers.hostIds };
}

/** "1 VM", "2 VMs". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function readinessDetail(status: RevisionStatus): string {
  const builds = status.builds.filter((build) => build.status !== "succeeded").length;
  if (builds) return `${counted(builds, "image build")} not finished`;
  const hosts = status.hosts.filter((host) => !host.ready).length;
  if (hosts) return `new images still warming on ${counted(hosts, "host")}`;
  if (!status.hosts.length) return "no connected platform host holds the new images";
  return `the revision is ${status.state}`;
}

/** Why an attempt waits; a permanent refusal never clears by waiting. */
interface Refusal {
  reason: string;
  permanent: boolean;
}

const waitFor = (reason: string): Refusal => ({ reason, permanent: false });
const never = (reason: string): Refusal => ({ reason, permanent: true });

/**
 * Why `revision` may not take or use a drain yet, or null when it may: warm
 * images and stable tools, a collector that deletes, no unresolved registry
 * writer, a promotable `git-` revision and, with `imageUse`, no run or host
 * that still uses an outgoing image. A forced drain skips that last check
 * before it drains and waits for it after. A missing bundle, a failed build
 * and an unpromotable revision are permanent.
 */
async function drainRefusal(
  env: Cloudflare.Env,
  revision: string,
  imageUse: boolean,
): Promise<Refusal | null> {
  const db = drizzle(env.DB);
  const loaded = await loadRevisionStatus(env, revision, "stable");
  if (!loaded.ok) return loaded.status === 404 ? never(loaded.error) : waitFor(loaded.error);
  // A retired or superseded build reads as stale and heals in the scenario
  // source; only a build that failed never becomes ready.
  if (loaded.body.builds.some((build) => build.status === "failed")) {
    return never("an image build of the revision failed");
  }
  if (!revisionReady(loaded.body)) return waitFor(readinessDetail(loaded.body));
  if (revision.startsWith("git-") && !(await publicSourceRevPromotable(env.DB, revision))) {
    return never("the scenario source revision is no longer promotable");
  }
  const service = registryCleanupService(env);
  if (!service) return waitFor("the registry cleanup service is not configured");
  if (!(await readCleanupReadiness(service)).deletes) {
    return waitFor("the registry cleanup is not in delete mode");
  }
  // The cleanup deletes only under enforced admission; without it a drain
  // would hold runs for a cleanup that cannot apply.
  const admission = await readRegistryAdmissionState(env);
  if (admission.enforcement !== "enforce") {
    return waitFor(`registry admission is ${admission.enforcement}, so the cleanup cannot delete`);
  }
  const unknown = await db.get<{ count: number }>(sql`SELECT COUNT(*) AS count
    FROM image_registry_operation_writers
    WHERE released_at IS NOT NULL AND outcome = 'unknown'`);
  if (unknown?.count) {
    return waitFor("a registry writer awaits the image-ops cleanup-resolve operation");
  }
  const use = imageUse ? await outgoingImageUse(db, revision) : { executionIds: [], hostIds: [] };
  if (use.executionIds.length || use.hostIds.length) {
    return waitFor(
      `the old images are still in use by ${counted(use.executionIds.length, "run")} and ${counted(use.hostIds.length, "host")}`,
    );
  }
  return null;
}

async function runningVms(db: DrizzleD1Database): Promise<number> {
  return (await db.get<{ count: number }>(sql`SELECT ${RUNNING_VMS} AS count`))?.count ?? 0;
}

async function operatorDrained(db: DrizzleD1Database): Promise<boolean> {
  return Boolean((await db.get<{ drained: number }>(sql`SELECT ${OPERATOR_DRAINED} AS drained`))?.drained);
}

/** Starts an automatic attempt for the waiting public commit, if any. */
async function startAutomatic(
  db: DrizzleD1Database,
  gate: PromotionGate,
  now: number,
): Promise<PromotionGate | null> {
  const revision = await pendingPublicRevision(db);
  if (!revision) return null;
  const last = gate.attempt;
  if (
    last?.revision === revision &&
    (last.phase === "cancelled" ||
      last.phase === "released" ||
      (last.phase === "failed" && now - (last.finishedAt ?? now) < AUTO_RETRY_COOLDOWN_MS))
  ) {
    return null;
  }
  return transition(db, gate, newAttempt(revision, "auto", null, now));
}

function newAttempt(
  revision: string,
  origin: "auto" | "admin",
  requestedBy: string | null,
  now: number,
): PromotionAttempt {
  return {
    v: 1,
    id: crypto.randomUUID(),
    revision,
    origin,
    requestedBy,
    phase: "waiting",
    detail: null,
    createdAt: now,
    drainedAt: null,
    committedAt: null,
    cleanedAt: null,
    finishedAt: null,
  };
}

/**
 * One cron step: starts an automatic attempt when a public commit waits, then
 * advances the attempt as far as it can go in this tick.
 */
export async function advanceImagePromotion(env: Cloudflare.Env): Promise<void> {
  const db = drizzle(env.DB);
  let gate: PromotionGate | null = await readGate(db);
  if (!gate.attempt || ENDED.has(gate.attempt.phase)) {
    gate = await startAutomatic(db, gate, Date.now());
  }
  // Each pass moves at most one phase; a few passes finish a quick attempt.
  for (let pass = 0; gate?.attempt && !ENDED.has(gate.attempt.phase) && pass < 5; pass += 1) {
    gate = await step(env, db, gate);
  }
}

/** Advances one phase. Null when the attempt waits or changed under it. */
async function step(
  env: Cloudflare.Env,
  db: DrizzleD1Database,
  gate: PromotionGate,
): Promise<PromotionGate | null> {
  const attempt = gate.attempt as PromotionAttempt;
  const now = Date.now();
  const automatic = attempt.origin === "auto";
  switch (attempt.phase) {
    case "waiting": {
      // A pause, a suspension or a head that moved on: the attempt steps
      // aside, and the revision starts again once it waits again.
      if (automatic && (await pendingPublicRevision(db)) !== attempt.revision) {
        return end(db, gate, "yielded", "the public commit is no longer waiting");
      }
      if (!automatic && now - attempt.createdAt > ADMIN_WAIT_BOUND_MS) {
        return end(db, gate, "failed", attempt.detail ?? "the revision did not become ready");
      }
      const refusal =
        (await drainRefusal(env, attempt.revision, automatic)) ??
        (automatic && (await operatorDrained(db)) ? waitFor("an operator drain is active") : null);
      if (refusal?.permanent) return end(db, gate, "failed", refusal.reason);
      if (refusal) {
        await setDetail(db, gate, refusal.reason);
        return null;
      }
      // The idle moment is one statement: no operator drain and no running VM
      // at the instant the hold lands. A run insert carries the hold in its
      // own batch, so a start and the drain cannot both win.
      const drained = await transition(
        db,
        gate,
        { ...attempt, phase: "drained", detail: null, drainedAt: now },
        automatic ? sql`NOT ${OPERATOR_DRAINED} AND ${RUNNING_VMS} = 0` : sql`1`,
      );
      if (!drained) {
        const running = await runningVms(db);
        await setDetail(db, gate, `waiting for an idle moment: ${counted(running, "VM")} running`);
      }
      return drained;
    }
    case "drained":
    case "promoting": {
      if (automatic && (await operatorDrained(db))) {
        return end(db, gate, "yielded", "an operator drain took over");
      }
      const bound = automatic ? AUTO_DRAIN_BOUND_MS : FORCED_DRAIN_BOUND_MS;
      if (now - (attempt.drainedAt ?? now) > bound) {
        return end(db, gate, "failed", attempt.detail ?? "the drain did not become ready in time");
      }
      // A refusal that never clears ends the hold now, not at the bound.
      const refusal = await drainRefusal(env, attempt.revision, true);
      if (refusal?.permanent) return end(db, gate, "failed", refusal.reason);
      const running = await runningVms(db);
      const pending = running ? `${counted(running, "VM")} still running` : refusal?.reason;
      if (pending) {
        await setDetail(db, gate, pending);
        return null;
      }
      if (attempt.phase === "drained") {
        return transition(db, gate, { ...attempt, phase: "promoting", detail: null });
      }
      return promote(env, db, gate);
    }
    case "cleaning": {
      // live_rev follows the committed catalog even if the tick that committed
      // it died before it could say so.
      if (attempt.revision.startsWith("git-")) {
        await recordPublicSourceLive(env.DB, attempt.revision);
      }
      if (automatic && now - (attempt.committedAt ?? now) > AUTO_CLEANUP_BOUND_MS) {
        return end(db, gate, "done", "the registry cleanup is still pending");
      }
      const service = registryCleanupService(env);
      if (!service) {
        await setDetail(db, gate, "the registry cleanup service is not configured");
        return null;
      }
      const cleanup = await runRegistryCleanup(service, {
        nowUnixMs: now,
        waitBudgetMs: REGISTRY_CLEANUP_WAIT_BUDGET_MS,
      });
      if (!cleanup.applied || cleanup.partial) {
        await setDetail(db, gate, cleanup.error ?? "the registry cleanup has not finished");
        return null;
      }
      return transition(db, gate, { ...attempt, phase: "verifying", detail: null, cleanedAt: now });
    }
    case "verifying": {
      const loaded = await loadRevisionStatus(env, attempt.revision, "stable");
      if (loaded.ok && revisionReady(loaded.body)) return end(db, gate, "done", null);
      if (automatic && now - (attempt.cleanedAt ?? now) > AUTO_VERIFY_BOUND_MS) {
        return end(db, gate, "done", "the hosts had not reported the new images yet");
      }
      await setDetail(db, gate, loaded.ok ? readinessDetail(loaded.body) : loaded.error);
      return null;
    }
    default:
      return null;
  }
}

/**
 * Runs the promotion core with its commit fenced on this exact attempt, so a
 * release or a second tick can never commit a swap the record does not hold.
 */
async function promote(
  env: Cloudflare.Env,
  db: DrizzleD1Database,
  gate: PromotionGate,
): Promise<PromotionGate | null> {
  const attempt = gate.attempt as PromotionAttempt;
  const committed: PromotionAttempt = {
    ...attempt,
    phase: "cleaning",
    detail: null,
    committedAt: Date.now(),
  };
  const committedText = JSON.stringify(committed);
  const fence: PromotionFence = {
    statements: [
      env.DB.prepare(
        `UPDATE runtime_operation_gates SET evidence_json = ?2, updated_at = ?3
          WHERE key = ?1 AND evidence_json = ?4`,
      ).bind(PROMOTION_HOLD_GATE, committedText, committed.committedAt, gate.text),
      // Selected only when the update above missed; a NULL state aborts the
      // whole batch, so the catalog cannot commit without the record.
      env.DB.prepare(
        `INSERT INTO runtime_operation_gates (key, state, updated_at)
          SELECT '__image_promotion_fence__', NULL, 0 WHERE NOT EXISTS (SELECT 1
            FROM runtime_operation_gates WHERE key = ?1 AND evidence_json = ?2)`,
      ).bind(PROMOTION_HOLD_GATE, committedText),
    ],
    aborted: (error) => errorChainMatches(error, FENCE_ABORT),
  };
  const admit = async (): Promise<PromotionAdmission> => {
    const admitted = await admitInternalRegistryOperation(env, {
      operation: "pointer_mutation",
      owner: { kind: "system", id: "image-promotion" },
    });
    return admitted.ok
      ? admitted
      : {
          ok: false,
          response: Response.json({ error: `the registry refused a writer: ${admitted.reason}` }, { status: 503 }),
        };
  };
  let result: Awaited<ReturnType<typeof promoteDrainedRevision>>;
  try {
    result = await promoteDrainedRevision(env, attempt.revision, { admit, fence });
  } catch (error) {
    // Nothing tells whether the batch landed: the next tick reads the record,
    // which the fence moved only if the catalog committed.
    console.error(
      JSON.stringify({
        event: "image_promotion_core_failed",
        id: attempt.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
  if (result.ok) {
    if (result.outcome.failedHostIds.length) {
      console.warn(
        JSON.stringify({
          event: "image_promotion_host_reconcile_failed",
          id: attempt.id,
          hostIds: result.outcome.failedHostIds,
        }),
      );
    }
    // A retry of a committed revision runs no batch, so no fence moved the
    // record; the committed state is written here instead.
    if (result.outcome.alreadyPromoted) {
      return transition(db, gate, committed);
    }
    return readGate(db);
  }
  const error = typeof result.body.error === "string" ? result.body.error : `refused with ${result.status}`;
  if (error === "the promotion attempt changed") return null;
  if (result.retry) {
    await setDetail(db, gate, error);
    return null;
  }
  return end(db, gate, "failed", error);
}

/** What the admin panel shows. */
export interface ImagePromotionView {
  attempt: PromotionAttempt | null;
  holdingRuns: boolean;
  operatorDrained: boolean;
  pendingRevision: string | null;
  runningVms: number;
}

export async function readImagePromotion(env: Cloudflare.Env): Promise<ImagePromotionView> {
  const db = drizzle(env.DB);
  const { attempt } = await readGate(db);
  return {
    attempt,
    holdingRuns: Boolean(attempt && HOLDING.has(attempt.phase)),
    operatorDrained: await operatorDrained(db),
    pendingRevision: await pendingPublicRevision(db),
    runningVms: await runningVms(db),
  };
}

/**
 * An admin starts a promotion of any candidate revision. It drains without
 * waiting for an idle moment once the revision is ready, and it may run inside
 * an operator drain, which it leaves in place.
 */
export async function startImagePromotion(
  env: Cloudflare.Env,
  input: { revision: string; actorUserId: string },
): Promise<ImagePromotionView> {
  const revision = input.revision.trim();
  if (!isSafeBundleRev(revision)) throw appError(400, "invalid_revision", "Enter a candidate revision.");
  const db = drizzle(env.DB);
  const [bundle] = await db
    .select({ meta: imageBuildBundles.metaJson })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, revision))
    .limit(1);
  if (!bundle || bundle.meta.catalogChannel !== "candidate") {
    throw appError(404, "revision_not_found", "No candidate revision has that name.");
  }
  if (bundle.meta.buildFormatVersion !== IMAGE_BUILD_FORMAT_VERSION) {
    throw appError(409, "revision_format", "That revision uses an older image build format.");
  }
  if (revision.startsWith("git-") && !(await publicSourceRevPromotable(env.DB, revision))) {
    throw appError(409, "revision_not_promotable", "That scenario source revision cannot be promoted now.");
  }
  const gate = await readGate(db);
  if (gate.attempt && HOLDING.has(gate.attempt.phase)) {
    throw appError(409, "promotion_in_progress", "A promotion is holding runs. Wait for it or reopen runs first.");
  }
  const next = newAttempt(revision, "admin", input.actorUserId, Date.now());
  if (!(await transition(db, gate, next, activeAdministrator(input.actorUserId)))) {
    throw appError(409, "promotion_changed", "The promotion changed. Reload and try again.");
  }
  return readImagePromotion(env);
}

/**
 * An admin ends the attempt. Before the commit it is cancelled, and a core
 * call in flight is fenced out; after it, runs reopen and the rest is left.
 */
export async function releaseImagePromotion(
  env: Cloudflare.Env,
  input: { actorUserId: string },
): Promise<ImagePromotionView> {
  const db = drizzle(env.DB);
  const gate = await readGate(db);
  const attempt = gate.attempt;
  if (!attempt || ENDED.has(attempt.phase)) {
    throw appError(409, "no_promotion", "No promotion is running.");
  }
  const phase = attempt.committedAt === null ? "cancelled" : "released";
  // A tick that died between the commit and live_rev leaves only this call
  // to record the committed catalog; it is idempotent.
  if (phase === "released" && attempt.revision.startsWith("git-")) {
    await recordPublicSourceLive(env.DB, attempt.revision);
  }
  const next: PromotionAttempt = {
    ...attempt,
    phase,
    detail: phase === "cancelled" ? "cancelled by an admin" : "runs reopened by an admin",
    finishedAt: Date.now(),
  };
  if (!(await transition(db, gate, next, activeAdministrator(input.actorUserId)))) {
    throw appError(409, "promotion_changed", "The promotion changed. Reload and try again.");
  }
  return readImagePromotion(env);
}

/** Whether Intar's hold is promoting `revision` right now. */
export async function promotionHolding(db: DrizzleD1Database, revision: string): Promise<boolean> {
  const { attempt } = await readGate(db);
  return Boolean(attempt && attempt.revision === revision && HOLDING.has(attempt.phase));
}
