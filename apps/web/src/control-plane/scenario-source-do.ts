// One Durable Object per scenario source binding, named by its scope key.
// Its alarm observes the repository, pauses a binding whose binder lost the
// scope, ingests the head commit's staged bundle, fails or heals the target's
// builds, and promotes an organization's target as a whole: images, then
// catalog, then `live`. Every head comparison runs in SQL against the stored
// head, so a push claim that moves the head mid-alarm is never overwritten.
import { DurableObject } from "cloudflare:workers";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, lt, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  imageBuildBundles,
  imageBuilds,
  organization,
  scenarioCatalogCandidates,
  scenarioSources,
} from "@/db/schema";
import type { ScenarioSourceCommitState } from "@/db/schema/scenarios";
import { AppError } from "@/lib/app-error";
import { SUPERSEDED_BUILD_ERROR_PREFIX } from "@/lib/build-scheduler-core";
import { syncCourseCatalogSnapshot } from "@/lib/course-catalogs";
import {
  mintInstallationToken,
  readRepository,
  type MintOutcome,
} from "@/lib/github-app";
import { platformCompileDigest } from "@/lib/image-build-format";
import {
  admitInternalRegistryOperation,
  createRegistryWriterGuard,
} from "@/lib/image-registry-admission";
import { isCandidateSourceLocked } from "@/lib/scenario-catalog-candidates";
import {
  countUnitGuardRuns,
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

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

interface Step {
  env: Cloudflare.Env;
  storage: Storage;
  scopeKey: string;
  organizationId: string | null;
  digest: string;
}

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
    const at = Date.now() + Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_MAX_MS);
    // A poke that arrived during this alarm keeps its earlier time.
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending > at) await this.ctx.storage.setAlarm(at);
  }
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

  // A started promotion finishes even while the binding is paused or the
  // digest is unset, and it is the alarm's only promotion.
  const promoting =
    organizationId === null ? null : await finishPromotion(env, scopeKey, organizationId);

  // Without a digest there is no head rev, so rows stay as they are rather
  // than be compared against NULL.
  const digest = await platformCompileDigest(env.PLATFORM_BASE_IMAGES_SHA256);
  if (digest === null) return again || promoting === true;
  await supersede(env, scopeKey, digest);

  const [active] = await db
    .select({ scopeKey: scenarioSources.scopeKey })
    .from(scenarioSources)
    .where(and(eq(scenarioSources.scopeKey, scopeKey), scenarioSourceBindingPredicate()))
    .limit(1);
  if (!active) return again || promoting === true;
  const step = { env, storage, scopeKey, organizationId, digest };
  const ingestAgain = await ingest(step);
  const heal = await failOrHeal(step);
  let applyAgain = promoting === true;
  // Only an organization commit applies here; `public` needs the drain hold.
  if (heal === "ready" && organizationId !== null) {
    // One promotion per alarm: a finished one leaves the target to the next.
    applyAgain = promoting === null ? await promoteTarget({ ...step, organizationId }) : true;
  }
  return again || ingestAgain || heal === "again" || applyAgain;
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
      RETURNING rev, purpose`,
  )
    .bind(Date.now(), scopeKey)
    .all<{ rev: string; purpose: "deploy" | "validate" }>();
  await deleteStagedObjects(env, scopeKey, results);
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
      RETURNING rev, purpose`,
  )
    .bind(Date.now(), scopeKey, digest)
    .all<{ rev: string; purpose: "deploy" | "validate" }>();
  await deleteStagedObjects(env, scopeKey, results);
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
  const ids = [...new Set(meta.scenarios.map((scenario) => scenario.scenarioId))];
  if (ids.length > MAX_SCENARIOS) {
    return invalid(`${ids.length} scenarios exceed the limit of ${MAX_SCENARIOS}`);
  }
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

// While the target is not live: an exact build that failed or went silent
// fails the row, and nothing retries it, so a build that hangs every time
// cannot loop. One superseded or retired is requeued, and reusable candidates
// the target lacks are restaged, under the same try cap. That covers a build
// deduplicated onto an older rev's and a candidate row the collector retired.
// `ready` means every exact build succeeded and its candidate is staged.
async function failOrHeal(step: Step): Promise<"again" | "ready" | "idle"> {
  const target = await step.env.DB.prepare(
    `SELECT c.id, c.rev, c.attempt, c.state FROM scenario_source_commits AS c
      JOIN scenario_sources AS s ON s.scope_key = c.scope_key
      WHERE c.scope_key = ?1 AND c.purpose = 'deploy' AND c.rev = s.target_rev
        AND s.target_rev IS NOT s.live_rev
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
        .where(inArray(imageBuilds.contentHash, hashes))
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
  if (outcome !== "done") await settle(step, target, outcome);
  return "idle";
}

interface Promotion {
  env: Cloudflare.Env;
  scopeKey: string;
  organizationId: string;
}

const REFUSAL_STATES = {
  incomplete_builds: "building",
  incomplete_catalog: "building",
  image_in_use: "waiting",
  ownership_conflict: "invalid",
} as const satisfies Record<CandidatePromotionRefusal["kind"], ScenarioSourceCommitState>;

// Promotes a ready target that is still the head. The unit guard holds it in
// `waiting` while a run with access would lose it. `promoting` is written only
// while the binding may write, so a pause during this alarm stops it here.
async function promoteTarget(step: Step & Promotion): Promise<boolean> {
  const target = await step.env.DB.prepare(
    `SELECT c.id, c.rev, c.attempt, c.state FROM scenario_source_commits AS c
      JOIN scenario_sources AS s ON s.scope_key = c.scope_key
      WHERE c.scope_key = ?1 AND c.purpose = 'deploy' AND c.rev = s.target_rev
        AND s.target_rev IS NOT s.live_rev AND c.state IN ('building', 'waiting')`,
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
  if (await countUnitGuardRuns(step.env.DB, step.organizationId, bundle.meta.courseCatalog)) {
    await settle(step, target, { state: "waiting", detail: "active runs would lose access" });
    return false;
  }
  const written = await drizzle(step.env.DB).run(sql`UPDATE scenario_source_commits
    SET state = 'promoting', detail = NULL, updated_at = ${Date.now()}
    WHERE id = ${target.id} AND attempt = ${target.attempt} AND state = ${target.state}
      AND EXISTS (SELECT 1 FROM scenario_sources WHERE scope_key = ${step.scopeKey}
        AND target_rev = scenario_source_commits.rev
        AND scenario_source_commits.rev =
          'git-' || github_repository_id || '-' || head_sha || '-' || ${step.digest}
        AND ${scenarioSourceBindingPredicate()})`);
  if (!written.meta.changes) return false;
  return promote(step, { ...target, state: "promoting" });
}

/** Finishes a `promoting` row. Null when there is none, else whether to re-arm. */
async function finishPromotion(
  env: Cloudflare.Env,
  scopeKey: string,
  organizationId: string,
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
  const now = Date.now();
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
function tryKey(row: CommitRow, step: "ingest" | "heal"): string {
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
  if (row.state === "ingesting") {
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
