// One Durable Object per scenario source binding, named by its scope key.
// Its alarm observes the repository, pauses a binding whose binder lost the
// scope, delivers a pull binding's head to a platform builder, ingests the
// head commit's staged bundle, fails or heals the target's builds, and
// promotes the target as a whole: images, then catalog, then `live`. A public
// commit that replaces a live image applies its catalog and leaves its images
// to the drained lane. The head commit's state shows as a GitHub check run.
// Every head comparison runs in SQL against the stored head, so a push claim
// that moves the head mid-alarm is never overwritten.
import { DurableObject } from "cloudflare:workers";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, lt, not, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  imageBuildBundles,
  imageBuilds,
  organization,
  scenarioCatalogCandidates,
  scenarioSources,
} from "@/db/schema";
import type { ScenarioSourceCommitState } from "@/db/schema/scenarios";
import { AppError } from "@/lib/app-error";
import { linkedScenarioIds, syncCourseCatalogSnapshot } from "@/lib/course-catalogs";
import {
  freeSourceCompileBuilders,
  reconcileHostSourceCompiles,
} from "@/lib/build-scheduler";
import {
  BUILDER_REASSIGN_AFTER_MS,
  SUPERSEDED_BUILD_ERROR_PREFIX,
  type BuilderCandidate,
} from "@/lib/build-scheduler-core";
import {
  createCheckRun,
  fetchTarball,
  mintInstallationToken,
  readRepository,
  updateCheckRun,
  type CheckRunState,
  type MintOutcome,
} from "@/lib/github-app";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import { createAppId } from "@/lib/id";
import { platformCompileDigest } from "@/lib/image-build-format";
import {
  admitInternalRegistryOperation,
  createRegistryWriterGuard,
} from "@/lib/image-registry-admission";
import { runsHeldCondition } from "@/lib/run-admission-gate";
import { promotionHolding } from "./image-promotion";
import { isCandidateSourceLocked } from "@/lib/scenario-catalog-candidates";
import {
  countUnitGuardRuns,
  endSourceCompiles,
  MAX_COMPILE_ATTEMPTS,
  parseDiagnostics,
  redactHostPaths,
  scenarioSourceBinderPredicate,
  scenarioSourceBindingPredicate,
  stagedSourceObjectPrefix,
} from "@/lib/scenario-sources";
import {
  controlPlaneMaintenanceEnabled,
  maintenanceJsonResponse,
} from "@/maintenance";
import {
  ingestScenarioBundle,
  readBundleMeta,
  readGzipBundleArchive,
  readTarFile,
  ScenarioBundleIngestError,
  validateBundleArchivePayload,
  type ParsedBundleMeta,
} from "./image-registry/bundle";
import {
  incomingFamilyImages,
  loadFamilyImageIdsMap,
  outgoingFamilyImageIds,
  promoteCandidateRevision,
  type CandidatePromotionRefusal,
  type CandidatePromotionResult,
} from "./image-registry/catalog-promotion";
import { isRecord } from "./image-registry/shared";

const SCOPE_PATTERN = /^(?:public|organization:[^/?#]+)$/;
const SCOPE_STORAGE_KEY = "scope";
const RETRIES_STORAGE_KEY = "retries";
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** The fourth fetch, ingest or heal try of one row attempt ends it. */
const MAX_TRIES = 3;
const POLL_INTERVAL_MS = 10 * 60_000;
const MAX_POLLS_PER_TICK = 5;
const PRUNE_AFTER_MS = 10 * 60_000;
// The same caps compile_bundle applies, so `validate` reports them first.
const MAX_META_BYTES = 1_500_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_SCENARIOS = 100;
const MAX_DETAIL_CHARS = 4096;
const STAGED_FILES = ["bundle.tar.gz", "meta.json", "source.tar.gz"];
const REV_SCOPE_CONFLICT = "rev_scope_conflict: this commit is owned by another scope";
/** A pull binding fetches or starts a compile at most once a minute. */
const DELIVERY_FLOOR_MS = 60_000;
const DELIVERED_AT_STORAGE_KEY = "delivered_at";
/** GitHub's tarball holds the whole repository; the DO never unpacks it. */
const MAX_SOURCE_ARCHIVE_BYTES = 8 * 1024 * 1024;
const CHECK_STORAGE_KEY = "deploy_check";
/** GitHub's cap on a check run's summary. */
const MAX_CHECK_SUMMARY_CHARS = 65_535;

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "getAlarm" | "setAlarm">;

interface Step {
  env: Cloudflare.Env;
  storage: Storage;
  scopeKey: string;
  organizationId: string | null;
  digest: string;
}

type ActiveBinding = Pick<
  typeof scenarioSources.$inferSelect,
  "mode" | "githubInstallationId" | "githubRepository" | "githubRepositoryId"
>;

interface CommitRow {
  id: string;
  rev: string;
  attempt: number;
  state: string;
}

type Settled = { state: "invalid" | "superseded"; detail: string };
/** `retry` is a settled refusal: the row keeps its state and the try is not counted. */
type WriteOutcome = "done" | "retry" | Settled;

const invalid = (detail: string): Settled => ({ state: "invalid", detail });

/** D1 allows 100 bound parameters, so a commit's hashes travel as one JSON array. */
const hashIn = (hashes: string[]) =>
  sql`${imageBuilds.contentHash} IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`;

/** The head rev, as SQL over the stored head sha. */
const headRev = (scope: string, digest: string) =>
  `(SELECT 'git-' || github_repository_id || '-' || head_sha || '-' || ${digest}
    FROM scenario_sources WHERE scope_key = ${scope})`;

export class ScenarioSourceDO extends DurableObject<Cloudflare.Env> {
  override async fetch(request: Request): Promise<Response> {
    if (controlPlaneMaintenanceEnabled(this.env)) return maintenanceJsonResponse();
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") ?? "";
    if (
      request.method !== "POST" ||
      url.pathname !== "/poke" ||
      !SCOPE_PATTERN.test(scope) ||
      !this.ctx.id.equals(this.env.SCENARIO_SOURCE.idFromName(scope))
    ) {
      return new Response(null, { status: 404 });
    }
    await this.ctx.storage.put(SCOPE_STORAGE_KEY, scope);
    await this.ctx.storage.setAlarm(Date.now());
    return new Response(null, { status: 204 });
  }

  override async alarm(): Promise<void> {
    if (controlPlaneMaintenanceEnabled(this.env)) {
      // The cron's 10-minute poll restarts every binding after maintenance.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const scopeKey = await this.ctx.storage.get<string>(SCOPE_STORAGE_KEY);
    if (!scopeKey) return;
    let again = true;
    try {
      again = await tickScenarioSource(this.env, this.ctx.storage, scopeKey);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scenario_source_tick_failed",
          scopeKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (!again) {
      await this.ctx.storage.delete(RETRIES_STORAGE_KEY);
      return;
    }
    const retries = (await this.ctx.storage.get<number>(RETRIES_STORAGE_KEY)) ?? 0;
    await this.ctx.storage.put(RETRIES_STORAGE_KEY, retries + 1);
    await armAt(
      this.ctx.storage,
      Date.now() + Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_MAX_MS),
    );
  }
}

/** A poke, or an earlier step, that armed a sooner alarm keeps its time. */
async function armAt(storage: Storage, at: number): Promise<void> {
  const pending = await storage.getAlarm();
  if (pending === null || pending > at) await storage.setAlarm(at);
}

/**
 * One alarm pass over a binding. True when a step wants to run again soon.
 * The DO never reads the feature flag: a failed evaluation answers `false`,
 * which would drop accepted commits.
 */
async function tickScenarioSource(
  env: Cloudflare.Env,
  storage: Storage,
  scopeKey: string,
): Promise<boolean> {
  const db = drizzle(env.DB);
  const [binding] = await db
    .select()
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scopeKey))
    .limit(1);
  if (!binding) return false;
  const again = await observe(env, binding);
  const organizationId = binding.organizationId;

  const now = Date.now();
  await db
    .update(scenarioSources)
    .set({ pausedAt: now, pauseReason: "binder_lost_admin", updatedAt: now })
    .where(
      and(
        eq(scenarioSources.scopeKey, scopeKey),
        isNull(scenarioSources.disconnectedAt),
        isNull(scenarioSources.pausedAt),
        not(scenarioSourceBinderPredicate()),
      ),
    );

  await dropInactive(env, scopeKey);

  // A started promotion finishes even while the binding is paused, the digest
  // is unset or the fleet is drained, and it is the alarm's only promotion.
  const promoting = await finishPromotion(env, scopeKey, organizationId);

  // Without a digest there is no head rev, so rows stay as they are rather
  // than be compared against NULL.
  const digest = await platformCompileDigest(env.PLATFORM_BASE_IMAGES_SHA256);
  if (digest === null) return again || promoting === true;
  await supersede(env, scopeKey, digest);

  const [active] = await db
    .select({
      mode: scenarioSources.mode,
      githubInstallationId: scenarioSources.githubInstallationId,
      githubRepository: scenarioSources.githubRepository,
      githubRepositoryId: scenarioSources.githubRepositoryId,
    })
    .from(scenarioSources)
    .where(and(eq(scenarioSources.scopeKey, scopeKey), scenarioSourceBindingPredicate()))
    .limit(1);
  if (!active) return again || promoting === true;
  const step = { env, storage, scopeKey, organizationId, digest };
  const ingestAgain = await ingest(step);
  // After ingest, so a re-run failed row that ingest finds without its
  // staged objects is delivered again in the same pass.
  if (active.mode === "pull") await deliver(step, active);
  await retargetLiveRev(step);
  const heal = await failOrHeal(step);
  let applyAgain = promoting === true;
  if (heal === "ready") {
    // One promotion per alarm: a finished one leaves the target to the next.
    applyAgain = promoting === null ? await promoteTarget(step) : true;
  }
  const checkAgain = await syncDeployCheckRun(step, active);
  return again || ingestAgain || heal === "again" || applyAgain || checkAgain;
}

// Reads the repository through a token minted for the bound id. The mint is
// the only signal of the installation's state: gone disconnects, suspended
// pauses unless already paused, and ok lifts only a suspension. A repository
// with no commits yet has no head, which is not an error.
async function observe(
  env: Cloudflare.Env,
  binding: typeof scenarioSources.$inferSelect,
): Promise<boolean> {
  if (binding.disconnectedAt !== null) return false;
  const observedAt = Date.now();
  let mint: MintOutcome;
  try {
    mint = await mintInstallationToken(env, {
      installationId: binding.githubInstallationId,
      fullName: binding.githubRepository,
      repositoryId: binding.githubRepositoryId,
    });
  } catch {
    // The App is not configured or its key is unreadable.
    mint = { status: "transient" };
  }
  const db = drizzle(env.DB);
  const bound = and(
    eq(scenarioSources.scopeKey, binding.scopeKey),
    eq(scenarioSources.githubInstallationId, binding.githubInstallationId),
    eq(scenarioSources.githubRepositoryId, binding.githubRepositoryId),
    isNull(scenarioSources.disconnectedAt),
  );
  const now = Date.now();
  if (mint.status !== "ok") {
    if (mint.status === "gone") {
      await db
        .update(scenarioSources)
        .set({ disconnectedAt: now, disconnectReason: "github_gone", updatedAt: now })
        .where(bound);
    } else if (mint.status === "suspended") {
      await db
        .update(scenarioSources)
        .set({ pausedAt: now, pauseReason: "suspended", updatedAt: now })
        .where(and(bound, isNull(scenarioSources.pausedAt)));
    }
    return mint.status === "transient";
  }
  await db
    .update(scenarioSources)
    .set({ pausedAt: null, pauseReason: null, updatedAt: now })
    .where(and(bound, eq(scenarioSources.pauseReason, "suspended")));
  const repository = await readRepository(mint.token);
  if (repository?.id === binding.githubRepositoryId) {
    await db
      .update(scenarioSources)
      .set({
        headSha: repository.headSha,
        headObservedAt: observedAt,
        githubRepository: repository.fullName,
        defaultBranch: repository.defaultBranch,
        updatedAt: now,
      })
      .where(and(bound, lt(scenarioSources.headObservedAt, observedAt)));
  }
  return false;
}

// Supersedes every fetch, compile and ingest of a paused or disconnected
// binding. It compares no head rev, so it also runs while the digest is unset.
async function dropInactive(env: Cloudflare.Env, scopeKey: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `UPDATE scenario_source_commits SET state = 'superseded', updated_at = ?1
      WHERE scope_key = ?2 AND state IN ('fetching', 'compiling', 'ingesting')
        AND EXISTS (SELECT 1 FROM scenario_sources WHERE scope_key = ?2
          AND (paused_at IS NOT NULL OR disconnected_at IS NOT NULL))
      RETURNING rev, purpose, compile_host_id`,
  )
    .bind(Date.now(), scopeKey)
    .all<DroppedRow>();
  await dropped(env, scopeKey, results);
}

interface DroppedRow {
  rev: string;
  purpose: "deploy" | "validate";
  compile_host_id: string | null;
}

// A dropped row's objects go, and so does the compile of one that was
// compiling: its builder kills the child once the entry leaves.
async function dropped(env: Cloudflare.Env, scopeKey: string, rows: DroppedRow[]) {
  await deleteStagedObjects(env, scopeKey, rows);
  await endSourceCompiles(env, rows.map((row) => row.compile_host_id));
}

// Supersedes rows that are neither head nor live, except a promotion that
// must finish.
async function supersede(
  env: Cloudflare.Env,
  scopeKey: string,
  digest: string,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `UPDATE scenario_source_commits SET state = 'superseded', updated_at = ?1
      WHERE scope_key = ?2 AND purpose = 'deploy'
        AND state IN ('fetching', 'compiling', 'ingesting', 'building', 'waiting',
          'awaiting_promote', 'failed')
        AND rev IS NOT ${headRev("?2", "?3")}
        AND rev IS NOT (SELECT live_rev FROM scenario_sources WHERE scope_key = ?2)
      RETURNING rev, purpose, compile_host_id`,
  )
    .bind(Date.now(), scopeKey, digest)
    .all<DroppedRow>();
  await dropped(env, scopeKey, results);
}

interface HeadRow {
  sha: string;
  rev: string;
  id: string | null;
  attempt: number | null;
  state: string | null;
}

/** The head rev while the binding is a pull binding that may write, else NULL. */
const pullHeadRev = (scopeKey: string, digest: string) =>
  sql`(SELECT 'git-' || github_repository_id || '-' || head_sha || '-' || ${digest}
    FROM scenario_sources WHERE scope_key = ${scopeKey} AND mode = 'pull'
      AND ${scenarioSourceBindingPredicate()})`;

// Pull delivery: the head is fetched once into R2 and compiled on a free
// builder on this digest. Only a head with no row or a superseded one is
// claimed, so a poll never delivers an invalid or failed head again; a re-run
// flips it first. Every wait re-arms the alarm itself; a wait for a builder
// ends when a compile does, which wakes the binding that waited longest.
async function deliver(step: Step, binding: ActiveBinding): Promise<void> {
  const { env, storage, scopeKey, digest } = step;
  const db = drizzle(env.DB);
  const now = Date.now();
  await expireCompiles(step, now);
  const head = await db.get<HeadRow>(sql`SELECT s.head_sha AS sha, c.id, c.attempt, c.state,
      'git-' || s.github_repository_id || '-' || s.head_sha || '-' || ${digest} AS rev
    FROM scenario_sources AS s
    LEFT JOIN scenario_source_commits AS c ON c.scope_key = s.scope_key
      AND c.purpose = 'deploy'
      AND c.rev = 'git-' || s.github_repository_id || '-' || s.head_sha || '-' || ${digest}
    WHERE s.scope_key = ${scopeKey} AND s.head_sha IS NOT NULL`);
  if (!head || (head.state !== null && head.state !== "superseded" && head.state !== "fetching")) {
    return;
  }
  const deliveredAt = (await storage.get<number>(DELIVERED_AT_STORAGE_KEY)) ?? 0;
  if (now < deliveredAt + DELIVERY_FLOOR_MS) {
    await armAt(storage, deliveredAt + DELIVERY_FLOOR_MS);
    return;
  }
  // Waiting for a compiler: nothing is fetched or claimed.
  let builders = await freeSourceCompileBuilders(db, now, digest);
  if (!builders.length) return;
  await storage.put(DELIVERED_AT_STORAGE_KEY, now);
  const row =
    head.state === "fetching" && head.id !== null && head.attempt !== null
      ? { id: head.id, rev: head.rev, attempt: head.attempt, state: head.state }
      : await claim(step, head, now);
  if (!row) return;
  const archive = `${stagedSourceObjectPrefix(scopeKey, row.rev, "deploy")}source.tar.gz`;
  if (!(await env.VM_IMAGE_REGISTRY_BUCKET.head(archive))) {
    const fetched = await fetchSource(step, binding, row, head.sha, archive);
    if (fetched === "retry") await armAt(storage, now + DELIVERY_FLOOR_MS);
    if (fetched !== "stored") return;
    // A builder can drop off, be disabled or roll during the download.
    builders = await freeSourceCompileBuilders(db, Date.now(), digest);
  }
  for (const builder of builders) {
    if (await assign(step, row, builder, now)) return;
  }
  // Another binding took the builder first, or it left; the stored archive waits.
  await armAt(storage, now + DELIVERY_FLOOR_MS);
}

// A compile past the builder lease comes back to fetching with its archive,
// and one that expires on the third delivery since its claim fails the row.
async function expireCompiles(step: Step, now: number): Promise<void> {
  const capped = "attempt - COALESCE(claimed_attempt, 0) >= ?4";
  const { results } = await step.env.DB.prepare(
    `UPDATE scenario_source_commits
      SET state = CASE WHEN ${capped} THEN 'failed' ELSE 'fetching' END,
        detail = CASE WHEN ${capped} THEN 'compiler did not finish' ELSE detail END,
        updated_at = ?1
      WHERE scope_key = ?2 AND state = 'compiling' AND compile_assigned_at <= ?3
      RETURNING rev, purpose, state, compile_host_id`,
  )
    .bind(now, step.scopeKey, now - BUILDER_REASSIGN_AFTER_MS, MAX_COMPILE_ATTEMPTS)
    .all<DroppedRow & { state: string }>();
  await deleteStagedObjects(
    step.env,
    step.scopeKey,
    results.filter((row) => row.state === "failed"),
  );
  await endSourceCompiles(step.env, results.map((row) => row.compile_host_id));
}

async function claim(step: Step, head: HeadRow, now: number): Promise<CommitRow | null> {
  const row = await drizzle(step.env.DB).get<CommitRow>(sql`INSERT INTO scenario_source_commits
      (id, scope_key, purpose, sha, rev, via, state, created_at, updated_at)
    SELECT ${createAppId()}, scope_key, 'deploy', head_sha, ${head.rev}, 'pull', 'fetching',
      ${now}, ${now}
    FROM scenario_sources WHERE scope_key = ${step.scopeKey} AND mode = 'pull'
      AND head_sha = ${head.sha} AND ${scenarioSourceBindingPredicate()}
    ON CONFLICT (scope_key, rev, purpose) DO UPDATE SET state = 'fetching', via = 'pull',
      claimed_attempt = attempt, detail = NULL, diagnostics_json = NULL,
      updated_at = excluded.updated_at
      WHERE scenario_source_commits.state = 'superseded'
    RETURNING id, rev, attempt, state`);
  if (row) await step.storage.delete(tryKey(row, "fetch"));
  return row ?? null;
}

// Stores the head's repository tarball as the row's archive. GitHub not
// answering is not counted, and neither is a mint that says gone or
// suspended: the next observe applies it.
async function fetchSource(
  step: Step,
  binding: ActiveBinding,
  row: CommitRow,
  sha: string,
  archive: string,
): Promise<"stored" | "retry" | "settled"> {
  const key = tryKey(row, "fetch");
  const tries = ((await step.storage.get<number>(key)) ?? 0) + 1;
  await step.storage.put(key, tries);
  if (tries > MAX_TRIES) {
    await settle(step, row, { state: "failed", detail: "fetch did not finish" });
    await step.storage.delete(key);
    return "settled";
  }
  let mint: MintOutcome;
  try {
    mint = await mintInstallationToken(step.env, {
      installationId: binding.githubInstallationId,
      fullName: binding.githubRepository,
      repositoryId: binding.githubRepositoryId,
    });
  } catch {
    mint = { status: "transient" };
  }
  // Right after the mint: a private repository's tarball URL lives minutes.
  const tarball =
    mint.status === "ok"
      ? await fetchTarball(mint.token, binding.githubRepository, sha, MAX_SOURCE_ARCHIVE_BYTES)
      : ({ status: "transient" } as const);
  if (tarball.status === "transient") {
    await step.storage.put(key, tries - 1);
    await step.env.DB.prepare(
      `UPDATE scenario_source_commits SET detail = ?1, updated_at = ?2
        WHERE id = ?3 AND attempt = ?4 AND state = 'fetching'`,
    )
      .bind("GitHub could not be read; retrying", Date.now(), row.id, row.attempt)
      .run();
    return "retry";
  }
  if (tarball.status !== "ok") {
    await step.storage.delete(key);
    await settle(
      step,
      row,
      invalid(
        tarball.status === "too_large"
          ? "The repository is over the 8 MiB pull limit. Use push mode or slim the repository."
          : "GitHub has no archive for this commit.",
      ),
    );
    return "settled";
  }
  await step.env.VM_IMAGE_REGISTRY_BUCKET.put(archive, tarball.archive, {
    httpMetadata: { contentType: "application/gzip" },
  });
  await step.storage.delete(key);
  return "stored";
}

// One conditional statement picks the builder, so two bindings never share
// one: the row must still be the fetching head, and the builder must have no
// compile in flight.
async function assign(
  step: Step,
  row: CommitRow,
  builder: BuilderCandidate,
  now: number,
): Promise<boolean> {
  const db = drizzle(step.env.DB);
  const assigned = await db.get<{ attempt: number }>(sql`UPDATE scenario_source_commits
    SET state = 'compiling', attempt = attempt + 1, compile_host_id = ${builder.hostId},
      compile_assigned_at = ${now}, detail = NULL, updated_at = ${now}
    WHERE id = ${row.id} AND attempt = ${row.attempt} AND state = 'fetching'
      AND rev = ${pullHeadRev(step.scopeKey, step.digest)}
      AND NOT EXISTS (SELECT 1 FROM scenario_source_commits AS busy
        WHERE busy.compile_host_id = ${builder.hostId} AND busy.state = 'compiling')
    RETURNING attempt`);
  if (!assigned) return false;
  if (await reconcileHostSourceCompiles(db, builder.hostId, now)) {
    await tryWakeHostRuntimeViaNamespace(step.env.HOST_RUNTIME, builder.hostId);
  }
  return true;
}

async function ingest(step: Step): Promise<boolean> {
  const row = await step.env.DB.prepare(
    `SELECT id, rev, attempt, state FROM scenario_source_commits
      WHERE scope_key = ?1 AND purpose = 'deploy' AND state = 'ingesting'
        AND rev = ${headRev("?1", "?2")}`,
  )
    .bind(step.scopeKey, step.digest)
    .first<CommitRow>();
  if (!row) return false;
  const key = tryKey(row, "ingest");
  const tries = ((await step.storage.get<number>(key)) ?? 0) + 1;
  await step.storage.put(key, tries);
  if (tries > MAX_TRIES) {
    await settle(step, row, { state: "failed", detail: "ingest did not finish" });
    await step.storage.delete(key);
    return false;
  }
  const outcome = await ingestRow(step, row.rev);
  if (outcome === "retry") {
    await step.storage.put(key, tries - 1);
    return true;
  }
  await step.storage.delete(key);
  if (outcome !== "done") {
    await settle(step, row, outcome);
    return false;
  }
  const now = Date.now();
  // One transaction: the target moves only with its row, and both only while
  // the row's rev is still the head rev.
  const [, finished] = await step.env.DB.batch([
    step.env.DB.prepare(
      `UPDATE scenario_sources SET target_rev = ?3, updated_at = ?4
        WHERE scope_key = ?1 AND ?3 = ${headRev("?1", "?2")}
          AND EXISTS (SELECT 1 FROM scenario_source_commits
            WHERE id = ?5 AND attempt = ?6 AND state = 'ingesting')`,
    ).bind(step.scopeKey, step.digest, row.rev, now, row.id, row.attempt),
    step.env.DB.prepare(
      `UPDATE scenario_source_commits SET state = 'building', detail = NULL, updated_at = ?4
        WHERE id = ?5 AND attempt = ?6 AND state = 'ingesting'
          AND rev = ?3 AND ?3 = ${headRev("?1", "?2")}`,
    ).bind(step.scopeKey, step.digest, row.rev, now, row.id, row.attempt),
  ]);
  if (finished?.meta.changes) {
    await deleteStagedObjects(step.env, step.scopeKey, [{ rev: row.rev, purpose: "deploy" }]);
  }
  return false;
}

async function ingestRow(step: Step, rev: string): Promise<WriteOutcome> {
  const [bundle] = await drizzle(step.env.DB)
    .select({
      organizationId: imageBuildBundles.organizationId,
      metaJson: imageBuildBundles.metaJson,
    })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, rev))
    .limit(1);
  if (bundle) {
    if (bundle.organizationId !== step.organizationId) return invalid(REV_SCOPE_CONFLICT);
    // A re-run, or a retry after a try that wrote the bundle row: requeue
    // from the stored meta, with no archive check.
    return writeBundle(step, rev, bundle.metaJson as ParsedBundleMeta);
  }
  const staged = await readStagedCommit(step, rev);
  return "state" in staged ? staged : writeBundle(step, rev, staged.meta, staged.payload);
}

// The content checks on the staged objects. They fail closed.
async function readStagedCommit(
  step: Step,
  rev: string,
): Promise<Settled | { meta: ParsedBundleMeta; payload: ArrayBuffer }> {
  const bucket = step.env.VM_IMAGE_REGISTRY_BUCKET;
  const prefix = stagedSourceObjectPrefix(step.scopeKey, rev, "deploy");
  const [metaObject, bundleObject] = await Promise.all([
    bucket.get(`${prefix}meta.json`),
    bucket.get(`${prefix}bundle.tar.gz`),
  ]);
  // The producer delivers the commit again.
  if (!metaObject || !bundleObject) {
    return { state: "superseded", detail: "the staged bundle is gone" };
  }
  if (metaObject.size > MAX_META_BYTES) return invalid("bundle meta is over 1.5 MB");
  if (bundleObject.size > MAX_BUNDLE_BYTES) {
    return invalid("bundle archive is over 2 MiB compressed");
  }
  const metaText = await metaObject.text();
  const parsed = await readBundleMeta(metaText);
  if (!parsed.ok) return invalid(await refusalText(parsed.response));
  const meta = parsed.value.bundleMeta;
  if (parsed.value.rev !== rev) return invalid("meta.rev is not this commit's rev");
  const label = await scopeLabel(step);
  if (!isRecord(meta.source) || meta.source.scope !== label) {
    return invalid("the intar.yaml scope does not match this binding");
  }
  // Entries, not ids: every later step reads one build per entry.
  if (meta.scenarios.length > MAX_SCENARIOS) {
    return invalid(`${meta.scenarios.length} scenario builds exceed the limit of ${MAX_SCENARIOS}`);
  }
  const ids = [...new Set(meta.scenarios.map((scenario) => scenario.scenarioId))];
  const namespace = await namespaceRefusal(step, ids, step.organizationId === null ? null : label);
  if (namespace) return invalid(namespace);

  const payload = await bundleObject.arrayBuffer();
  const archiveError = await validateBundleArchivePayload(
    payload,
    meta,
    MAX_EXPANDED_BUNDLE_BYTES,
  );
  if (archiveError) return invalid(await refusalText(archiveError));
  const archive = await readGzipBundleArchive(payload, MAX_EXPANDED_BUNDLE_BYTES);
  const catalog = archive.ok ? readTarFile(archive.bytes, "curriculum/catalog.json") : null;
  const wire = parseJson(metaText) as { course_catalog?: unknown } | undefined;
  if (!catalog || !isDeepStrictEqual(parseJson(catalog), wire?.course_catalog)) {
    return invalid("meta.course_catalog differs from curriculum/catalog.json");
  }
  return { meta, payload };
}

// The longest organization slug that prefixes an id must be this scope's,
// and for `public` none may. Ids the scope already owns are grandfathered.
async function namespaceRefusal(
  step: Step,
  ids: string[],
  slug: string | null | undefined,
): Promise<string | null> {
  const { results } = await step.env.DB.prepare(
    `SELECT ids.value AS id,
        (SELECT o.slug FROM organization AS o
          WHERE lower(substr(ids.value, 1, length(o.slug) + 1)) = lower(o.slug) || '-'
          ORDER BY length(o.slug) DESC LIMIT 1) AS slug,
        EXISTS (SELECT 1 FROM vm_scenarios AS v
          WHERE v.scenario_id = ids.value AND v.organization_id IS ?2) AS owned
      FROM json_each(?1) AS ids`,
  )
    .bind(JSON.stringify(ids), step.organizationId)
    .all<{ id: string; slug: string | null; owned: number }>();
  for (const row of results) {
    if (row.id.toLowerCase().startsWith("workshop-")) {
      return `${row.id}: the workshop- prefix is reserved`;
    }
    if (!row.owned && row.slug !== slug) return `${row.id} is outside your namespace`;
  }
  return null;
}

// Writes under an internal registry writer. A refused writer and a locked
// candidate source are settled and retried. A throw before the first write
// settles the writer; any other stays an `unknown` hold for the operator reap.
// Every throw counts as a try.
async function writeBundle(
  step: Step,
  rev: string,
  meta: ParsedBundleMeta,
  payload?: ArrayBuffer,
): Promise<WriteOutcome> {
  const admitted = await admitInternalRegistryOperation(step.env, {
    operation: "bundle_put",
    owner: { kind: "system", id: `source:${step.scopeKey}` },
  });
  if (!admitted.ok) return "retry";
  let outcome: "ok" | "error" | "unknown" = "unknown";
  try {
    const ingested = await ingestScenarioBundle(step.env, drizzle(step.env.DB), {
      rev,
      payload,
      meta,
      organizationId: step.organizationId,
      applyCatalog: false,
    });
    if (!ingested.ok) {
      outcome = "error";
      return invalid(
        "course catalog references unavailable scenarios: " +
          ingested.invalidScenarioIds.join(", "),
      );
    }
    outcome = "ok";
    return "done";
  } catch (error) {
    if (isCandidateSourceLocked(error)) {
      outcome = "error";
      return "retry";
    }
    if (error instanceof AppError && error.code === "rev_scope_conflict") {
      outcome = "error";
      return invalid(REV_SCOPE_CONFLICT);
    }
    if (
      error instanceof ScenarioBundleIngestError &&
      ["validate_catalog_references", "check_rev_scope"].includes(error.stage)
    ) {
      outcome = "error";
    }
    throw error;
  } finally {
    await admitted.lease.complete(outcome);
  }
}

// A public head back at live_rev while another rev's catalog is applied: that
// rev took the catalog-first route and was abandoned by a force-push or a
// reset, and nothing else would restore live_rev. live_rev becomes the target
// again, so heal restages it and apply promotes it once more, which restores
// its catalog and re-enables what the other catalog disabled. The drain hold
// and the unit guard hold it like any target. Supersede skips live_rev's row,
// so a restore the head moved on from returns that row to `live`.
async function retargetLiveRev(step: Step): Promise<void> {
  if (step.organizationId !== null) return;
  const abandoned = `SELECT live_rev FROM scenario_sources WHERE scope_key = ?1
      AND live_rev = ${headRev("?1", "?2")}
      AND live_rev IS NOT (SELECT source_revision FROM course_catalogs WHERE scope_key = 'public')
      AND NOT EXISTS (SELECT 1 FROM scenario_source_commits
        WHERE scope_key = ?1 AND purpose = 'deploy' AND state = 'promoting')`;
  const now = Date.now();
  await step.env.DB.batch([
    step.env.DB.prepare(
      `UPDATE scenario_sources SET target_rev = live_rev, updated_at = ?3
        WHERE scope_key = ?1 AND target_rev IS NOT live_rev AND live_rev IN (${abandoned})`,
    ).bind(step.scopeKey, step.digest, now),
    step.env.DB.prepare(
      `UPDATE scenario_source_commits SET state = 'building', detail = NULL, updated_at = ?3
        WHERE scope_key = ?1 AND purpose = 'deploy' AND state = 'live' AND rev IN (${abandoned})`,
    ).bind(step.scopeKey, step.digest, now),
    step.env.DB.prepare(
      `UPDATE scenario_source_commits SET state = 'live', detail = NULL, updated_at = ?3
        WHERE scope_key = ?1 AND purpose = 'deploy' AND state IN ('building', 'waiting', 'failed')
          AND rev = (SELECT live_rev FROM scenario_sources WHERE scope_key = ?1)
          AND rev IS NOT ${headRev("?1", "?2")}`,
    ).bind(step.scopeKey, step.digest, now),
  ]);
}

// While the target is not live: an exact build that failed or went silent
// fails the row, and nothing retries it, so a build that hangs every time
// cannot loop. One superseded or retired is requeued, and reusable candidates
// the target lacks are restaged, under the same try cap. That covers a build
// deduplicated onto an older rev's and a candidate row the collector retired.
// `ready` means every exact build succeeded and its candidate is staged. A
// finished heal answers `again`: nothing else pokes a target it made ready.
async function failOrHeal(step: Step): Promise<"again" | "ready" | "idle"> {
  const target = await step.env.DB.prepare(
    `SELECT c.id, c.rev, c.attempt, c.state FROM scenario_source_commits AS c
      JOIN scenario_sources AS s ON s.scope_key = c.scope_key
      WHERE c.scope_key = ?1 AND c.purpose = 'deploy' AND c.rev = s.target_rev
        AND c.state IN ('building', 'waiting', 'awaiting_promote')`,
  )
    .bind(step.scopeKey)
    .first<CommitRow>();
  if (!target) return "idle";
  const db = drizzle(step.env.DB);
  const [bundle] = await db
    .select({ metaJson: imageBuildBundles.metaJson })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, target.rev))
    .limit(1);
  if (!bundle) return "idle";
  const meta = bundle.metaJson as ParsedBundleMeta;
  const hashes = [...new Set(meta.scenarios.map((scenario) => scenario.contentHash))];
  const builds = hashes.length
    ? await db
        .select({
          scenarioId: imageBuilds.scenarioId,
          arch: imageBuilds.arch,
          contentHash: imageBuilds.contentHash,
          status: imageBuilds.status,
          error: imageBuilds.error,
          artifactsRetiredAt: imageBuilds.artifactsRetiredAt,
          published: sql<number>`${imageBuilds.publishedManifestJson} IS NOT NULL`,
        })
        .from(imageBuilds)
        .where(hashIn(hashes))
    : [];
  const staged = new Set(
    (
      await db
        .select({ scenarioId: scenarioCatalogCandidates.scenarioId })
        .from(scenarioCatalogCandidates)
        .where(
          and(
            eq(scenarioCatalogCandidates.revision, target.rev),
            sql`${scenarioCatalogCandidates.organizationId} IS ${step.organizationId}`,
          ),
        )
    ).map((row) => row.scenarioId),
  );
  let heal = false;
  let ready = true;
  for (const scenario of meta.scenarios) {
    const build = builds.find(
      (candidate) =>
        candidate.scenarioId === scenario.scenarioId &&
        candidate.arch === scenario.arch &&
        candidate.contentHash === scenario.contentHash,
    );
    const superseded =
      build?.status === "stale" &&
      Boolean(build.error?.startsWith(SUPERSEDED_BUILD_ERROR_PREFIX));
    if (build?.status === "failed" || (build?.status === "stale" && !superseded)) {
      await settle(step, target, {
        state: "failed",
        detail:
          `image build ${scenario.scenarioId} (${scenario.arch}) ${build.status}: ` +
          (build.error ?? "no error"),
      });
      return "idle";
    }
    const unstaged =
      build?.status === "succeeded" &&
      Boolean(build.published) &&
      !staged.has(scenario.scenarioId);
    heal ||= !build || superseded || build.artifactsRetiredAt !== null || unstaged;
    ready &&= build?.status === "succeeded" && staged.has(scenario.scenarioId);
  }
  if (!heal) return ready ? "ready" : "idle";

  const key = tryKey(target, "heal");
  const tries = ((await step.storage.get<number>(key)) ?? 0) + 1;
  await step.storage.put(key, tries);
  if (tries > MAX_TRIES) {
    await settle(step, target, { state: "failed", detail: "heal did not finish" });
    await step.storage.delete(key);
    return "idle";
  }
  const outcome = await writeBundle(step, target.rev, meta);
  if (outcome === "retry") {
    await step.storage.put(key, tries - 1);
    return "again";
  }
  await step.storage.delete(key);
  if (outcome === "done") return "again";
  await settle(step, target, outcome);
  return "idle";
}

interface Promotion {
  env: Cloudflare.Env;
  scopeKey: string;
  organizationId: string | null;
}

const REFUSAL_STATES = {
  incomplete_builds: "building",
  incomplete_catalog: "building",
  image_in_use: "waiting",
  ownership_conflict: "invalid",
  // Only the drained lane asks; the DO never does.
  not_promotable: "waiting",
  // Only Intar's image promotion passes a fence; the DO never does.
  fenced: "waiting",
} as const satisfies Record<CandidatePromotionRefusal["kind"], ScenarioSourceCommitState>;

// An operator's image release or Intar's own promotion hold.
const fleetDrained = sql.raw(runsHeldCondition());

/**
 * The target may start to apply: it is still the head, the binding may write,
 * and for `public` no drain holds the fleet.
 */
const mayApply = (step: Step, rev: string) => sql`EXISTS (SELECT 1 FROM scenario_sources
  WHERE scope_key = ${step.scopeKey} AND target_rev = ${rev}
    AND target_rev = 'git-' || github_repository_id || '-' || head_sha || '-' || ${step.digest}
    AND ${scenarioSourceBindingPredicate()}
    AND (organization_id IS NOT NULL OR NOT ${fleetDrained}))`;

// Promotes a ready target that is still the head. The unit guard holds it in
// `waiting` while a run with access would lose it, and for `public` so does a
// fleet drain. `promoting` is written only while the target may
// apply, so a pause or a drain during this alarm stops it here. A public
// commit that replaces a live image takes the catalog-first route instead.
async function promoteTarget(step: Step): Promise<boolean> {
  const target = await step.env.DB.prepare(
    `SELECT c.id, c.rev, c.attempt, c.state FROM scenario_source_commits AS c
      JOIN scenario_sources AS s ON s.scope_key = c.scope_key
      WHERE c.scope_key = ?1 AND c.purpose = 'deploy' AND c.rev = s.target_rev
        AND c.state IN ('building', 'waiting')`,
  )
    .bind(step.scopeKey)
    .first<CommitRow>();
  if (!target) return false;
  const bundle = await loadBundle(step.env, target.rev);
  if (
    !bundle ||
    bundle.organizationId !== step.organizationId ||
    !isRecord(bundle.meta.source) ||
    bundle.meta.source.scope !== (await scopeLabel(step))
  ) {
    await settle(step, target, invalid("the bundle does not belong to this binding"));
    return false;
  }
  const db = drizzle(step.env.DB);
  if (
    step.organizationId === null &&
    (await db.get<{ drained: number }>(sql`SELECT ${fleetDrained} AS drained`))?.drained
  ) {
    await settle(step, target, { state: "waiting", detail: "the fleet is drained for an image swap" });
    return false;
  }
  if (await countUnitGuardRuns(step.env.DB, step.organizationId, bundle.meta.courseCatalog)) {
    await settle(step, target, { state: "waiting", detail: "active runs would lose access" });
    return false;
  }
  if (step.organizationId === null && (await replacesLiveImages(db, bundle.meta))) {
    return applyCatalogFirst(step, target, bundle.meta);
  }
  const written = await db.run(sql`UPDATE scenario_source_commits
    SET state = 'promoting', detail = NULL, updated_at = ${Date.now()}
    WHERE id = ${target.id} AND attempt = ${target.attempt} AND state = ${target.state}
      AND ${mayApply(step, target.rev)}`);
  if (!written.meta.changes) return false;
  return promote(step, { ...target, state: "promoting" });
}

/** Whether promoting `meta` replaces a live image, by the core's own measure. */
async function replacesLiveImages(
  db: DrizzleD1Database,
  meta: ParsedBundleMeta,
): Promise<boolean> {
  const hashes = [...new Set(meta.scenarios.map((scenario) => scenario.contentHash))];
  if (!hashes.length) return false;
  const builds = await db
    .select({
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      contentHash: imageBuilds.contentHash,
      manifest: imageBuilds.publishedManifestJson,
    })
    .from(imageBuilds)
    .where(hashIn(hashes));
  const incoming = incomingFamilyImages(
    meta.scenarios,
    meta.scenarios.map((item) =>
      builds.find(
        (build) =>
          build.scenarioId === item.scenarioId &&
          build.arch === item.arch &&
          build.contentHash === item.contentHash,
      ),
    ),
  );
  const live = await loadFamilyImageIdsMap(db, incoming);
  return outgoingFamilyImageIds(incoming, live).length > 0;
}

// A public commit that replaces a live image: its catalog applies here, and
// its images go live only through the drained lane. The re-read right before
// the sync stops an alarm whose binding was paused, or whose fleet was
// drained, since it began. `awaiting_promote` needs the complete candidate
// set; a candidate the collector retired meanwhile is heal's to restage.
async function applyCatalogFirst(
  step: Step,
  target: CommitRow,
  meta: ParsedBundleMeta,
): Promise<boolean> {
  const db = drizzle(step.env.DB);
  if (!(await db.get(sql`SELECT 1 AS open WHERE ${mayApply(step, target.rev)}`))) {
    return false;
  }
  await syncCourseCatalogSnapshot(db, {
    snapshot: meta.courseCatalog,
    sourceRevision: target.rev,
    organizationId: null,
    nowUnixMs: Date.now(),
  });
  const ids = [...new Set(meta.scenarios.map((scenario) => scenario.scenarioId))];
  const entered = await db.run(sql`UPDATE scenario_source_commits
    SET state = 'awaiting_promote', detail = NULL, updated_at = ${Date.now()}
    WHERE id = ${target.id} AND attempt = ${target.attempt} AND state = ${target.state}
      AND NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(ids)}) AS expected
        WHERE expected.value NOT IN (SELECT scenario_id FROM scenario_catalog_candidates
          WHERE revision = ${target.rev} AND organization_id IS NULL))`);
  return !entered.meta.changes;
}

/** Finishes a `promoting` row. Null when there is none, else whether to re-arm. */
async function finishPromotion(
  env: Cloudflare.Env,
  scopeKey: string,
  organizationId: string | null,
): Promise<boolean | null> {
  const row = await env.DB.prepare(
    `SELECT id, rev, attempt, state FROM scenario_source_commits
      WHERE scope_key = ?1 AND purpose = 'deploy' AND state = 'promoting'`,
  )
    .bind(scopeKey)
    .first<CommitRow>();
  return row ? promote({ env, scopeKey, organizationId }, row) : null;
}

// Runs the promotion core under a pointer_mutation writer, then the catalog,
// then one batch that makes the row live. The core is idempotent through
// `alreadyPromoted`, so a refused writer or a throw keeps `promoting` and a
// later alarm finishes it. A refusal from the core has written nothing.
async function promote(step: Promotion, row: CommitRow): Promise<boolean> {
  const bundle = await loadBundle(step.env, row.rev);
  if (!bundle) throw new Error(`promoting rev ${row.rev} has no bundle`);
  const admitted = await admitInternalRegistryOperation(step.env, {
    operation: "pointer_mutation",
    owner: { kind: "system", id: `source:${step.scopeKey}` },
  });
  if (!admitted.ok) return true;
  const db = drizzle(step.env.DB);
  const writer = createRegistryWriterGuard(admitted.lease);
  let result: CandidatePromotionResult;
  try {
    result = await promoteCandidateRevision(step.env, db, writer, {
      revision: row.rev,
      bundle,
      nowUnixMs: Date.now(),
    });
    if (result.ok) await writer.release("ok");
  } finally {
    await writer.finish();
  }
  if (!result.ok) {
    await settle(step, row, { state: REFUSAL_STATES[result.kind], detail: result.error });
    return false;
  }
  // Committed, including a host reconcile that failed: the host alarms finish
  // it. There is no second unit guard.
  await syncCourseCatalogSnapshot(db, {
    snapshot: bundle.meta.courseCatalog,
    sourceRevision: row.rev,
    organizationId: step.organizationId,
    nowUnixMs: Date.now(),
  });
  const now = Date.now();
  // Only a retarget promotes live_rev again. Its catalog went live with every
  // linked scenario enabled; the core re-enables the bundled ones, and this
  // the others that the abandoned catalog disabled.
  const linked = JSON.stringify(linkedScenarioIds(bundle.meta.courseCatalog));
  await db.run(sql`UPDATE vm_scenarios SET enabled = 1, enabled_at = ${now}, updated_at = ${now}
    WHERE organization_id IS ${step.organizationId} AND enabled = 0
      AND scenario_id IN (SELECT value FROM json_each(${linked}))
      AND EXISTS (SELECT 1 FROM scenario_sources WHERE scope_key = ${step.scopeKey} AND live_rev = ${row.rev})`);
  // One transaction: the live commit moves with its row, and the previous
  // live row is superseded, so its rev can be delivered again.
  const promoting = `EXISTS (SELECT 1 FROM scenario_source_commits
    WHERE id = ?1 AND attempt = ?2 AND state = 'promoting')`;
  const statements = [
    `UPDATE scenario_sources SET live_rev = ?3, live_at = ?5, updated_at = ?5,
        live_sha = (SELECT sha FROM scenario_source_commits WHERE id = ?1)
      WHERE scope_key = ?4 AND ${promoting}`,
    `UPDATE scenario_source_commits SET state = 'superseded', updated_at = ?5
      WHERE scope_key = ?4 AND purpose = 'deploy' AND state = 'live' AND ${promoting}`,
    `UPDATE scenario_source_commits SET state = 'live', detail = NULL, updated_at = ?5
      WHERE id = ?1 AND attempt = ?2 AND state = 'promoting'`,
  ];
  await step.env.DB.batch(
    statements.map((statement) =>
      step.env.DB.prepare(statement).bind(row.id, row.attempt, row.rev, step.scopeKey, now),
    ),
  );
  return false;
}

async function loadBundle(env: Cloudflare.Env, rev: string) {
  const [bundle] = await drizzle(env.DB)
    .select({ organizationId: imageBuildBundles.organizationId, meta: imageBuildBundles.metaJson })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, rev))
    .limit(1);
  return bundle && { organizationId: bundle.organizationId, meta: bundle.meta as ParsedBundleMeta };
}

/** The last check state sent, and the row and check run it was sent for. */
interface SentCheck {
  rowId: string;
  checkRunId: number;
  check: CheckRunState;
}

interface CheckRow {
  id: string;
  sha: string;
  rev: string;
  state: ScenarioSourceCommitState;
  detail: string | null;
  diagnostics_json: string | null;
  check_run_id: number | null;
  is_live_rev: number;
}

const CHECK_ROW = `SELECT id, sha, rev, state, detail, diagnostics_json, check_run_id,
    rev IS (SELECT live_rev FROM scenario_sources WHERE scope_key = ?1) AS is_live_rev
  FROM scenario_source_commits WHERE scope_key = ?1 AND purpose = 'deploy'`;

// A superseded head row waits to be delivered again, so it shows as queued.
// The summary says what a row waits for. A catalog-first row waits for Intar's
// image promotion, which runs at the next idle moment.
const DEPLOY_CHECKS = {
  fetching: { status: "queued", title: "Queued" },
  ingesting: { status: "queued", title: "Queued" },
  compiling: { status: "in_progress", title: "Compiling" },
  building: { status: "in_progress", title: "Building" },
  waiting: { status: "in_progress", title: "Waiting" },
  promoting: { status: "in_progress", title: "Promoting" },
  awaiting_promote: { status: "in_progress", title: "Waiting for an idle moment" },
  live: { status: "completed", conclusion: "success", title: "Live" },
  failed: { status: "completed", conclusion: "failure", title: "Failed" },
  invalid: { status: "completed", conclusion: "failure", title: "Invalid" },
  superseded: { status: "completed", conclusion: "neutral", title: "Superseded by a newer commit" },
  validated: { status: "completed", conclusion: "success", title: "Validated" },
} as const satisfies Record<ScenarioSourceCommitState, Omit<CheckRunState, "summary">>;

// Shows the head row as the Intar / deploy check run on its commit. Only a
// change is sent, and the last state sent is all the DO keeps; the check run
// id goes to D1, where the webhook finds a re-run. A check the head moved
// away from is closed first, so no replaced commit keeps a running check: a
// promotion is followed to its end, and any other row shows as superseded.
// A check on a repository the scope was bound to before is out of the
// token's reach, and a paused or disconnected binding sends nothing: its
// alarm only observes and finishes a promotion, so its check keeps the last
// state until the binding is active again. True when a send failed, so the
// alarm tries again.
async function syncDeployCheckRun(step: Step, binding: ActiveBinding): Promise<boolean> {
  const head = await step.env.DB.prepare(`${CHECK_ROW} AND rev = ${headRev("?1", "?2")}`)
    .bind(step.scopeKey, step.digest)
    .first<CheckRow>();
  let last = await step.storage.get<SentCheck>(CHECK_STORAGE_KEY);
  if (last && last.rowId !== head?.id && last.check.status !== "completed") {
    const row = await step.env.DB.prepare(`${CHECK_ROW} AND id = ?2`)
      .bind(step.scopeKey, last.rowId)
      .first<CheckRow>();
    if (row?.rev.startsWith(`git-${binding.githubRepositoryId}-`)) {
      const check = await deployCheck(step, row, false);
      if (check.status !== "completed") return false;
      last = await sendCheck(step, binding, row, check, last);
      if (!last) return true;
    }
  }
  if (!head) return false;
  return !(await sendCheck(step, binding, head, await deployCheck(step, head, true), last));
}

// The tenant projection: the row's own builds by phase, with every error,
// detail and diagnostic redacted, and no host, fleet or run data.
async function deployCheck(step: Step, row: CheckRow, isHead: boolean): Promise<CheckRunState> {
  const bundle = await loadBundle(step.env, row.rev);
  // A rev another scope owns never shows that scope's bundle.
  const scenarios = bundle?.organizationId === step.organizationId ? bundle.meta.scenarios : [];
  const hashes = [...new Set(scenarios.map((scenario) => scenario.contentHash))];
  const builds = hashes.length
    ? await drizzle(step.env.DB)
        .select({
          scenarioId: imageBuilds.scenarioId,
          arch: imageBuilds.arch,
          contentHash: imageBuilds.contentHash,
          status: imageBuilds.status,
          phase: imageBuilds.phase,
          error: imageBuilds.error,
        })
        .from(imageBuilds)
        .where(
          and(hashIn(hashes), sql`${imageBuilds.organizationId} IS ${step.organizationId}`),
        )
    : [];
  let built = 0;
  const lines = scenarios.map(({ scenarioId, arch, contentHash }) => {
    const build = builds.find(
      (candidate) =>
        candidate.scenarioId === scenarioId &&
        candidate.arch === arch &&
        candidate.contentHash === contentHash,
    );
    if (build?.status === "succeeded") built += 1;
    const error = build?.error ? `: ${redactHostPaths(build.error)}` : "";
    return `- ${scenarioId} (${arch}): ${build ? `${build.status}, ${build.phase}${error}` : "queued"}`;
  });
  const diagnostics = parseDiagnostics(row.diagnostics_json).map(({ path, line, message }) => {
    const at = path === undefined ? "" : line === undefined ? `${path}: ` : `${path}:${line}: `;
    return `- ${at}${message}`;
  });
  // A row the head left, except a promotion, is done with.
  const left =
    !isHead && row.state !== "promoting" && DEPLOY_CHECKS[row.state].status !== "completed";
  const state = left ? "superseded" : row.state === "superseded" && isHead ? "fetching" : row.state;
  const check = DEPLOY_CHECKS[state];
  // live_rev in progress is a retarget restoring its catalog, not a new deploy.
  const title =
    row.is_live_rev && check.status !== "completed"
      ? "Restoring"
      : state === "building"
        ? `Building ${built}/${scenarios.length}`
        : state === "awaiting_promote" && (await promotionHolding(drizzle(step.env.DB), row.rev))
          ? "Promoting images"
          : check.title;
  // GitHub renders the summary as Markdown and drops tags such as `<path>`.
  const summary = [
    ...(row.detail === null ? [] : [redactHostPaths(row.detail)]),
    ...diagnostics,
    ...lines,
  ]
    .join("\n")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return { ...check, title, summary: (summary || title).slice(0, MAX_CHECK_SUMMARY_CHARS) };
}

// Sends a changed check. A row's first check, and one that reopens after it
// completed, as a re-run does, get a new check run: GitHub shows the newest.
// A mint or a call that fails leaves the last state as it was, so the next
// alarm sends again.
async function sendCheck(
  step: Step,
  binding: ActiveBinding,
  row: CheckRow,
  check: CheckRunState,
  last: SentCheck | undefined,
): Promise<SentCheck | undefined> {
  const prior = last?.rowId === row.id && last.checkRunId === row.check_run_id ? last : undefined;
  if (prior && isDeepStrictEqual(prior.check, check)) return prior;
  let mint: MintOutcome;
  try {
    mint = await mintInstallationToken(step.env, {
      installationId: binding.githubInstallationId,
      fullName: binding.githubRepository,
      repositoryId: binding.githubRepositoryId,
    });
  } catch {
    return undefined;
  }
  if (mint.status !== "ok") return undefined;
  const reopened = prior?.check.status === "completed" && check.status !== "completed";
  let checkRunId = prior && !reopened ? prior.checkRunId : null;
  if (checkRunId !== null) {
    if (!(await updateCheckRun(mint.token, binding.githubRepository, checkRunId, check))) {
      return undefined;
    }
  } else {
    checkRunId = await createCheckRun(mint.token, binding.githubRepository, row.sha, check);
    if (checkRunId === null) return undefined;
    await step.env.DB.prepare(`UPDATE scenario_source_commits SET check_run_id = ?1 WHERE id = ?2`)
      .bind(checkRunId, row.id)
      .run();
  }
  const sent = { rowId: row.id, checkRunId, check };
  await step.storage.put(CHECK_STORAGE_KEY, sent);
  return sent;
}

/** The scope `intar.yaml` must name: `public` or the organization's slug. */
async function scopeLabel(step: Pick<Step, "env" | "organizationId">) {
  if (step.organizationId === null) return "public";
  const [owner] = await drizzle(step.env.DB)
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, step.organizationId))
    .limit(1);
  return owner?.slug;
}

// ponytail: a counter of a row that observe supersedes mid-try stays in DO
// storage; clear them by prefix if a binding ever holds many.
function tryKey(row: CommitRow, step: "fetch" | "ingest" | "heal"): string {
  return `try:${row.id}:${row.attempt}:${step}`;
}

/** Moves a row out of the state it was read in, unless it changed since. */
async function settle(
  step: Pick<Step, "env" | "scopeKey">,
  row: CommitRow,
  to: { state: ScenarioSourceCommitState; detail: string },
): Promise<void> {
  await step.env.DB.prepare(
    `UPDATE scenario_source_commits SET state = ?1, detail = ?2, updated_at = ?3
      WHERE id = ?4 AND attempt = ?5 AND state = ?6`,
  )
    .bind(
      to.state,
      to.detail.slice(0, MAX_DETAIL_CHARS),
      Date.now(),
      row.id,
      row.attempt,
      row.state,
    )
    .run();
  if (row.state === "fetching" || row.state === "ingesting") {
    await deleteStagedObjects(step.env, step.scopeKey, [{ rev: row.rev, purpose: "deploy" }]);
  }
}

async function deleteStagedObjects(
  env: Cloudflare.Env,
  scopeKey: string,
  rows: Array<{ rev: string; purpose: "deploy" | "validate" }>,
): Promise<void> {
  const keys = rows.flatMap(({ rev, purpose }) =>
    STAGED_FILES.map((file) => `${stagedSourceObjectPrefix(scopeKey, rev, purpose)}${file}`),
  );
  if (keys.length) await env.VM_IMAGE_REGISTRY_BUCKET.delete(keys);
}

async function refusalText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `refused with ${response.status}`;
}

function parseJson(value: string | Uint8Array): unknown {
  try {
    return JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value));
  } catch {
    return undefined;
  }
}

/**
 * The every-minute cron. Poked bindings run at once and connected ones every
 * 10 minutes, at most 5 re-syncs per tick. A disconnected binding runs only
 * while it owns an in-flight row, so a lost alarm still settles that row; its
 * DO makes no GitHub call. Staged objects that nothing holds are pruned.
 */
export async function sweepScenarioSources(
  env: Cloudflare.Env,
  now = Date.now(),
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT scope_key, poked_at FROM scenario_sources AS source
      WHERE (source.disconnected_at IS NULL OR EXISTS (
          SELECT 1 FROM scenario_source_commits AS c WHERE c.scope_key = source.scope_key
            AND c.state IN ('fetching', 'compiling', 'ingesting', 'promoting')))
        AND (source.poked_at IS NOT NULL OR COALESCE(source.polled_at, 0) <= ?1)
      ORDER BY source.poked_at IS NULL, COALESCE(source.polled_at, 0)
      LIMIT 100`,
  )
    .bind(now - POLL_INTERVAL_MS)
    .all<{ scope_key: string; poked_at: number | null }>();
  let polls = 0;
  for (const source of results) {
    if (source.poked_at === null && ++polls > MAX_POLLS_PER_TICK) break;
    try {
      const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(source.scope_key));
      const response = await stub.fetch(
        `https://scenario-source/poke?scope=${encodeURIComponent(source.scope_key)}`,
        { method: "POST" },
      );
      if (!response.ok) continue;
      // A poke that lands after the read above stays set for the next tick.
      await env.DB.prepare(
        `UPDATE scenario_sources SET poked_at = NULL, polled_at = ?1
          WHERE scope_key = ?2 AND COALESCE(poked_at, 0) <= ?3`,
      )
        .bind(now, source.scope_key, source.poked_at ?? 0)
        .run();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "scenario_source_poke_failed",
          scopeKey: source.scope_key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  await pruneStagedObjects(env, now);
}

// Deletes staged objects older than 10 minutes that no fetching, compiling or
// ingesting row holds. The age covers the push route's stage-to-claim gap.
// ponytail: one listing page per tick; a larger backlog drains over ticks.
async function pruneStagedObjects(env: Cloudflare.Env, now: number): Promise<void> {
  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  const listed = await bucket.list({ prefix: "builds/sources/", limit: 1000 });
  const expired = listed.objects.filter(
    (object) => object.uploaded.getTime() < now - PRUNE_AFTER_MS,
  );
  if (!expired.length) return;
  const { results } = await env.DB.prepare(
    `SELECT scope_key, rev, purpose FROM scenario_source_commits
      WHERE state IN ('fetching', 'compiling', 'ingesting')`,
  ).all<{ scope_key: string; rev: string; purpose: "deploy" | "validate" }>();
  const held = new Set(
    results.map((row) => stagedSourceObjectPrefix(row.scope_key, row.rev, row.purpose)),
  );
  const keys = expired
    .map((object) => object.key)
    .filter((key) => !held.has(key.slice(0, key.lastIndexOf("/") + 1)));
  if (keys.length) await bucket.delete(keys);
}
