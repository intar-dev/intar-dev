// Scenario source bindings: one GitHub repository per scope, connected
// through the Intar GitHub App. The binding is the only thing Intar trusts
// about where a repository may publish.
import { env } from "cloudflare:workers";
import { and, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { assertCutoverNotWiped, CUTOVER_WIPED_SQL } from "@/lib/run-admission-gate";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  normalizeCourseCatalogSnapshot,
} from "@/control-plane/image-registry/bundle";
import {
  isRecord,
  isSafeBundleRev,
  jsonResponse,
} from "@/control-plane/image-registry/shared";
import {
  account,
  bundles,
  pipelineUploadSessions,
  scenarioRevisions,
  scenarioSourceCommits,
  scenarioSources,
  scopeMachineImages,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import type { ImageProducer, ScenarioSourceCommitState, SourcePromotion } from "@/db/schema/scenarios";
import type { SourceCompileErrorV1 } from "@/generated/bridge";
import type { SourceRefusalCode } from "@/generated/catalog";
import {
  MAX_SOURCE_BUNDLE_GZIP_BYTES,
  SOURCE_BUNDLE_FIELD,
  SOURCE_META_FIELD,
} from "@/generated/constants";
import validateSourceBundleMeta from "@/generated/contracts/source-bundle-meta-v2.validate";
import { readSourceBundle, sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { activeAccountExistsSql, activeAdminSql } from "@/lib/account-access";
import type { UserContext } from "@/lib/agent-bridge";
import { type AppError, appError, errorChainMatches } from "@/lib/app-error";
import { courseCatalogScopeKey } from "@/lib/course-catalogs";
import { syncBuilderDesiredState } from "@/lib/machine-builds";
import {
  pipelinePlan,
  producerInForce,
  REVISION_SOURCE_DISCONNECTED,
  revisionBuildKeys,
  type PipelinePlan,
} from "@/lib/pipeline-revisions";
import { buildKeys } from "@/lib/scenario-contract/build-key";
import type { FeatureToggleService } from "@/lib/feature-toggles";
import {
  findRepositoryInstallation,
  mintInstallationToken,
  readRepository,
  verifyRepositoryAdmin,
  type GitHubAppEnv,
  type RepositoryHead,
} from "@/lib/github-app";
import { createAppId } from "@/lib/id";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import { featureToggleService } from "@/lib/organization-access";
import { administersOrganization } from "@/lib/organizations";
import { activeAdministrator } from "@/lib/platform-admin-authority";
import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/content-access";
import { purgeScenarioSource } from "@/lib/scenario-source-purge";
import {
  BodyLimitExceededError,
  enforceRateLimit,
  readBoundedBody,
} from "@/lib/request-security";

export const SCENARIO_GIT_SOURCES_FLAG = "scenario_git_sources";
/** Lets a platform administrator set a scope's source to pipeline-built images (#441). */
export const SCENARIO_PIPELINE_IMAGES_FLAG = "scenario_pipeline_images";
/** Lets a platform administrator switch a source to automatic promotion (#454). */
export const SCENARIO_AUTOMATIC_PROMOTION_FLAG = "scenario_automatic_promotion";
const REVISION_SOURCE_PULLS =
  "The scenario source was switched to pull mode before the images of this revision were pushed.";

// Until GitHub confirms the caller is a repository admin, every refusal reads
// the same and is sent no earlier than this after the request started, so
// neither the text nor the timing shows how far the checks got.
export const BIND_REFUSAL_MESSAGE =
  "Intar can't connect this repository. Check that the Intar App is installed on it and that your linked GitHub account is a repository admin.";
const BIND_REFUSAL_FLOOR_MS = 3_000;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type ScenarioSourceEnv = GitHubAppEnv & {
  PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID?: string;
};

export interface ScenarioSourceScope {
  key: string;
  organizationId: string | null;
}

export interface ScenarioSourceView {
  repository: string;
  defaultBranch: string;
  mode: "push" | "pull";
  /** Who builds the images of the commits ingested from now on. */
  imageProducer: ImageProducer;
  allowSelfHostedRunners: boolean;
  /** Who puts a commit's labs live: an administrator, or the source's job once each lab passed its check. */
  promotion: SourcePromotion;
  pausedAt: number | null;
  pauseReason: "admin" | "binder_lost_admin" | "suspended" | null;
  disconnectedAt: number | null;
  disconnectReason: string | null;
  liveSha: string | null;
  liveAt: number | null;
  commit: {
    sha: string;
    state: ScenarioSourceCommitState;
    /** Who builds this commit's images: it keeps the producer it was ingested with. Null before ingest. */
    imageProducer: ImageProducer | null;
    detail: string | null;
    diagnostics: Array<Pick<SourceCompileErrorV1, "path" | "line" | "message">>;
    updatedAt: number;
  } | null;
  /** Only in the answer to `forget_image`: what was forgotten, and the revisions whose document still names it. */
  forgotten?: { imageDigest: string; revisions: Array<{ scenarioId: string; rev: string; state: string }> };
}

export interface ScenarioSourceCard {
  /** Whether bind, resume and mode are available to this scope. */
  enabled: boolean;
  /** Whether a platform administrator may set this scope's source to pipeline-built images. */
  pipelineImages: boolean;
  /** For `public`: whether a repository id is pinned for it. */
  configured?: boolean;
  appSlug: string | null;
  /** The ref of the scenario-publish workflow a repository calls while the builder builds its images. */
  workflowRef: string;
  /** The ref to call once the repository's pipeline builds its images; null until that version is released. */
  pipelineWorkflowRef: string | null;
  /**
   * Only on the platform's own card, which platform administrators read:
   * they change the source's platform settings there, and a switch that
   * needs a flag says so before it is tried.
   */
  platformSettings?: { automaticPromotion: boolean };
  source: ScenarioSourceView | null;
}

export function scenarioSourceScope(
  organizationId: string | null,
): ScenarioSourceScope {
  return organizationId === null
    ? { key: "public", organizationId: null }
    : { key: `organization:${organizationId}`, organizationId };
}

/**
 * Holds while a `scenario_sources` row may write: it is connected and not
 * paused, and its binder still holds the scope.
 */
export function scenarioSourceBindingPredicate(): SQL {
  return sql`(${scenarioSources.disconnectedAt} IS NULL
    AND ${scenarioSources.pausedAt} IS NULL
    AND ${scenarioSourceBinderPredicate()})`;
}

/** The scope's source is disconnected. */
const sourceDisconnected = (scopeKey: string): SQL =>
  sql`EXISTS (SELECT 1 FROM scenario_sources source
    WHERE source.scope_key = ${scopeKey} AND source.disconnected_at IS NOT NULL)`;

/** The scope's source compiles on a builder: no pipeline can open a session for it. */
const sourcePulls = (scopeKey: string): SQL =>
  sql`EXISTS (SELECT 1 FROM scenario_sources source
    WHERE source.scope_key = ${scopeKey} AND source.mode = 'pull')`;

/**
 * Fails the building revisions of a scope's pipeline bundles (#441) while
 * `ended` holds for its source: disconnected, or switched to pull mode. It
 * goes in the batch that makes the change, after it, so it does nothing when
 * the change did not apply. Nothing later would end them sooner than the
 * deadline: no session can be opened for them any more.
 */
function failPipelineRevisions(db: DrizzleD1Database, scopeKey: string, reason: string, ended: SQL) {
  return db
    .update(scenarioRevisions)
    .set({ state: "failed", failureReason: reason })
    .where(
      and(
        eq(scenarioRevisions.state, "building"),
        sql`${scenarioRevisions.rev} IN (SELECT rev FROM bundles
          WHERE scope_key = ${scopeKey} AND image_producer = 'pipeline')`,
        ended,
      ),
    );
}

/**
 * With them, the `building` commit rows of those bundles fail: no revision
 * of theirs waits any more, and a failed row is what a new publish or a
 * re-run of the check takes up again. It goes after `failPipelineRevisions`
 * in the batch and follows it: a commit whose revisions all had their
 * images, and still reads `building`, is left as it is.
 */
function failPipelineCommits(db: DrizzleD1Database, scopeKey: string, now: number, reason: string, ended: SQL) {
  return db
    .update(scenarioSourceCommits)
    .set({ state: "failed", detail: reason, updatedAt: now })
    .where(
      and(
        eq(scenarioSourceCommits.scopeKey, scopeKey),
        eq(scenarioSourceCommits.purpose, "deploy"),
        eq(scenarioSourceCommits.state, "building"),
        sql`${scenarioSourceCommits.rev} IN (SELECT rev FROM bundles
          WHERE scope_key = ${scopeKey} AND image_producer = 'pipeline')`,
        sql`EXISTS (SELECT 1 FROM scenario_revisions ended
          WHERE ended.rev = ${scenarioSourceCommits.rev} AND ended.state = 'failed' AND ended.failure_reason = ${reason})`,
        sql`NOT EXISTS (SELECT 1 FROM scenario_revisions waiting
          WHERE waiting.rev = ${scenarioSourceCommits.rev} AND waiting.state = 'building')`,
        // An automatic source's job decides its row, unless the source is
        // gone: a disconnected one has no job any more.
        sql`NOT EXISTS (SELECT 1 FROM scenario_sources source
          WHERE source.scope_key = ${scopeKey} AND source.promotion = 'automatic' AND source.disconnected_at IS NULL)`,
        ended,
      ),
    );
}

export const failDisconnectedPipelineRevisions = (db: DrizzleD1Database, scopeKey: string) =>
  failPipelineRevisions(db, scopeKey, REVISION_SOURCE_DISCONNECTED, sourceDisconnected(scopeKey));
export const failDisconnectedPipelineCommits = (db: DrizzleD1Database, scopeKey: string, now: number) =>
  failPipelineCommits(db, scopeKey, now, REVISION_SOURCE_DISCONNECTED, sourceDisconnected(scopeKey));

/**
 * Closes the open pipeline upload sessions of a scope once its source is
 * disconnected; it goes in the batch that disconnects. A session already
 * stops working with the binding, but a reconnect must not bring it back.
 */
export function closeDisconnectedPipelineSessions(
  db: DrizzleD1Database,
  scopeKey: string,
  now: number,
) {
  return db
    .update(pipelineUploadSessions)
    .set({ closedAt: now })
    .where(
      and(
        eq(pipelineUploadSessions.scopeKey, scopeKey),
        isNull(pipelineUploadSessions.closedAt),
        sql`EXISTS (SELECT 1 FROM scenario_sources source
          WHERE source.scope_key = ${scopeKey}
            AND source.disconnected_at IS NOT NULL)`,
      ),
    );
}

/**
 * Holds while the binder is still an owner or admin of the organization with
 * an active account, or for `public` an active platform admin. Never NULL.
 */
export function scenarioSourceBinderPredicate(): SQL {
  const binder = sql`${scenarioSources.boundByUserId}`;
  return sql`((${scenarioSources.organizationId} IS NULL
      AND EXISTS (SELECT 1 FROM user AS binder
        WHERE binder.id = ${binder} AND ${sql.raw(activeAdminSql("binder"))}))
    OR (${administersOrganization(sql`${scenarioSources.organizationId}`, binder)}
      AND ${sql.raw(activeAccountExistsSql("scenario_sources.bound_by_user_id"))}))`;
}

/**
 * The unit guard: the scope's unfinished runs that have content access now
 * and would lose it once `snapshot` replaces the scope's catalog, or whose
 * scenario the commit disables. Runs without access never count. For
 * `public` (null) every organization's runs can hold public content.
 */
export async function countUnitGuardRuns(
  d1: D1Database,
  organizationId: string | null,
  snapshot: CourseCatalogSnapshotV2,
): Promise<number> {
  const row = await d1
    .prepare(`SELECT COUNT(*) AS runs ${unitGuardRunsSql(1, 2, 3)}`)
    .bind(organizationId, courseCatalogScopeKey(organizationId), JSON.stringify(snapshot))
    .first<{ runs: number }>();
  return row?.runs ?? 0;
}

/**
 * `FROM … WHERE` of the active runs that would lose access if the catalog
 * of scope ?{scopeKey} (organization ?{organization}) became the JSON
 * snapshot ?{snapshot}; see countUnitGuardRuns. A write can embed it as
 * `NOT EXISTS (SELECT 1 …)` to hold the guard in its own statement.
 */
export function unitGuardRunsSql(organization: number, scopeKey: number, snapshot: number): string {
  const access = currentScenarioRunContentAccessCondition();
  // The CTE shadows course_catalogs for the proposed check only; the other
  // scopes' catalogs are read from the table itself.
  return `FROM scenario_runs AS run
        WHERE (?${organization} IS NULL OR run.organization_id = ?${organization})
          AND run.state NOT IN ('completed', 'failed')
          AND (${access})
          AND NOT (WITH course_catalogs AS (
                SELECT scope_key, organization_id, catalog_json FROM main.course_catalogs
                  WHERE scope_key <> ?${scopeKey}
                UNION ALL SELECT ?${scopeKey}, ?${organization}, ?${snapshot})
              SELECT ${access})`;
}

/** Removes every absolute path; repository-relative paths stay readable. */
export function redactHostPaths(text: string): string {
  return text.replace(/(?<![\w.-])\/[^\s'"():,]+/g, "<path>");
}

export async function scenarioGitSourcesEnabled(
  scope: ScenarioSourceScope,
  toggles: FeatureToggleService = featureToggleService(),
): Promise<boolean> {
  return toggles.getBoolean(SCENARIO_GIT_SOURCES_FLAG, false, {
    targetingKey: scope.key,
  });
}

export async function scenarioPipelineImagesEnabled(
  scope: ScenarioSourceScope,
  toggles: FeatureToggleService = featureToggleService(),
): Promise<boolean> {
  return toggles.getBoolean(SCENARIO_PIPELINE_IMAGES_FLAG, false, {
    targetingKey: scope.key,
  });
}

export async function scenarioAutomaticPromotionEnabled(
  scope: ScenarioSourceScope,
  toggles: FeatureToggleService = featureToggleService(),
): Promise<boolean> {
  return toggles.getBoolean(SCENARIO_AUTOMATIC_PROMOTION_FLAG, false, {
    targetingKey: scope.key,
  });
}

export async function scenarioSourceCard(
  scope: ScenarioSourceScope,
  toggles?: FeatureToggleService,
  /** The reader is a platform administrator on the platform's card. */
  platformSettings = false,
): Promise<ScenarioSourceCard> {
  const [enabled, pipelineImages, automaticPromotion, source] = await Promise.all([
    scenarioGitSourcesEnabled(scope, toggles),
    scenarioPipelineImagesEnabled(scope, toggles),
    platformSettings ? scenarioAutomaticPromotionEnabled(scope, toggles) : false,
    loadScenarioSource(scope),
  ]);
  return {
    enabled,
    pipelineImages,
    ...(scope.organizationId === null
      ? { configured: Boolean(env.PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID) }
      : {}),
    appSlug: env.GITHUB_APP_SLUG || null,
    workflowRef: env.SCENARIO_PUBLISH_WORKFLOW_REF || "scenario-publish-v1",
    pipelineWorkflowRef: env.SCENARIO_PUBLISH_PIPELINE_WORKFLOW_REF || null,
    ...(platformSettings ? { platformSettings: { automaticPromotion } } : {}),
    source,
  };
}

/** The tenant projection: host paths are removed from every error text. */
export async function loadScenarioSource(
  scope: ScenarioSourceScope,
): Promise<ScenarioSourceView | null> {
  const db = drizzle(env.DB);
  const [binding] = await db
    .select()
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scope.key))
    .limit(1);
  if (!binding) return null;
  const [commit] = await db
    .select()
    .from(scenarioSourceCommits)
    .where(
      and(
        eq(scenarioSourceCommits.scopeKey, scope.key),
        eq(scenarioSourceCommits.purpose, "deploy"),
      ),
    )
    .orderBy(desc(scenarioSourceCommits.createdAt), desc(scenarioSourceCommits.id))
    .limit(1);
  const [stamp] = commit
    ? await db
        .select({ imageProducer: bundles.imageProducer })
        .from(bundles)
        .where(and(eq(bundles.rev, commit.rev), eq(bundles.scopeKey, scope.key)))
        .limit(1)
    : [];
  return {
    repository: binding.githubRepository,
    defaultBranch: binding.defaultBranch,
    mode: binding.mode,
    imageProducer: binding.imageProducer,
    allowSelfHostedRunners: binding.allowSelfHostedRunners,
    promotion: binding.promotion,
    pausedAt: binding.pausedAt,
    pauseReason: binding.pauseReason,
    disconnectedAt: binding.disconnectedAt,
    disconnectReason: binding.disconnectReason,
    liveSha: binding.liveSha,
    liveAt: binding.liveAt,
    commit: commit
      ? {
          sha: commit.sha,
          state: commit.state,
          imageProducer: stamp?.imageProducer ?? null,
          detail: commit.detail === null ? null : redactHostPaths(commit.detail),
          diagnostics: parseDiagnostics(commit.diagnosticsJson),
          updatedAt: commit.updatedAt,
        }
      : null,
  };
}

/** A commit row's compile diagnostics, with host paths removed. */
export function parseDiagnostics(
  json: string | null,
): NonNullable<ScenarioSourceView["commit"]>["diagnostics"] {
  let parsed: unknown = null;
  try {
    parsed = json === null ? null : JSON.parse(json);
  } catch {
    // An unreadable column shows no diagnostics.
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: Partial<SourceCompileErrorV1> | null) =>
    typeof entry?.message === "string"
      ? [
          {
            ...(typeof entry.path === "string" ? { path: entry.path } : {}),
            ...(typeof entry.line === "number" ? { line: entry.line } : {}),
            message: redactHostPaths(entry.message),
          },
        ]
      : [],
  );
}

type Change =
  | { action: "connect"; repository: string }
  | { action: "resume" | "pause" | "disconnect" | "purge" }
  | { action: "mode"; mode: "push" | "pull" }
  | { action: "image_producer"; producer: ImageProducer }
  | { action: "runner_policy"; allowSelfHosted: boolean }
  | { action: "promotion"; promotion: SourcePromotion }
  | { action: "forget_image"; buildKey: string; architecture: "amd64" | "arm64" };

/**
 * A source's settings: who builds its images, which runners may publish,
 * who puts its labs live, and forgetting an image. Its scope's
 * administrators change them (#472): an organization's owners and admins
 * for theirs, a platform administrator for the platform's.
 */
const SETTING_ACTIONS: ReadonlySet<Change["action"]> = new Set(["image_producer", "runner_policy", "promotion", "forget_image"]);

/**
 * Whether a platform administrator may make `change` on a scope that is
 * not theirs to run: what steps a source back or stops it, forgetting an
 * image, and the way to pull mode, which only the platform has.
 */
function platformMayStepBack(change: Change): boolean {
  switch (change.action) {
    case "pause":
    case "forget_image":
      return true;
    case "image_producer":
      return change.producer === "builder";
    case "runner_policy":
      return !change.allowSelfHosted;
    case "promotion":
      return change.promotion === "manual";
    case "mode":
      return change.mode === "pull";
    default:
      return false;
  }
}

function parseChange(body: unknown): Change {
  const input = (body ?? {}) as {
    action?: unknown;
    repository?: unknown;
    mode?: unknown;
    producer?: unknown;
    allow_self_hosted?: unknown;
    promotion?: unknown;
    build_key?: unknown;
    architecture?: unknown;
  };
  switch (input.action) {
    case "connect": {
      const repository =
        typeof input.repository === "string" ? input.repository.trim() : "";
      if (!REPOSITORY_PATTERN.test(repository)) {
        throw appError(
          400,
          "scenario_source_repository_invalid",
          "Enter the repository as owner/name.",
        );
      }
      return { action: "connect", repository };
    }
    case "resume":
    case "pause":
    case "disconnect":
    case "purge":
      return { action: input.action };
    case "mode":
      if (input.mode === "push" || input.mode === "pull") {
        return { action: "mode", mode: input.mode };
      }
      break;
    case "image_producer":
      if (input.producer === "builder" || input.producer === "pipeline") {
        return { action: "image_producer", producer: input.producer };
      }
      break;
    case "runner_policy":
      if (typeof input.allow_self_hosted === "boolean") {
        return { action: "runner_policy", allowSelfHosted: input.allow_self_hosted };
      }
      break;
    case "promotion":
      if (input.promotion === "manual" || input.promotion === "automatic") {
        return { action: "promotion", promotion: input.promotion };
      }
      break;
    case "forget_image":
      if (
        typeof input.build_key === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(input.build_key) &&
        (input.architecture === "amd64" || input.architecture === "arm64")
      ) {
        return { action: "forget_image", buildKey: input.build_key, architecture: input.architecture };
      }
      break;
  }
  throw appError(400, "scenario_source_change_invalid", "Unknown change.");
}

/**
 * Impersonated sessions never write, and each user shares one 20-per-minute
 * budget across every address they send from. Null when the write may go on.
 */
export async function refuseScenarioSourceWrite(
  request: Request,
  context: Pick<UserContext, "userId" | "impersonated">,
  workerEnv: Pick<Cloudflare.Env, "ACCESS_INVITE_RATE_LIMITER"> = env,
): Promise<Response | null> {
  if (context.impersonated) {
    throw appError(
      403,
      "impersonation_forbidden",
      "Stop impersonating to change the scenario source.",
    );
  }
  const limited = await enforceRateLimit(
    request,
    workerEnv,
    "scenario-source",
    `user:${context.userId}`,
  );
  return limited.ok ? null : limited.response;
}

/**
 * Applies one owner or admin change to the scope's binding and returns the
 * binding afterwards. Bind, resume and mode need the flag and answer 404
 * without it; pause, disconnect and purge never do, so a scope can always stop.
 */
export async function changeScenarioSource(input: {
  scope: ScenarioSourceScope;
  actorUserId: string;
  body: unknown;
  /** When the request started: the floor for a uniform bind refusal. */
  startedAt: number;
  toggles?: FeatureToggleService;
  appEnv?: ScenarioSourceEnv;
  /**
   * The actor is a platform administrator stepping a scope's source back,
   * not one of the scope's own administrators: only what
   * `platformMayStepBack` names, checked by the platform's rights.
   */
  asPlatform?: boolean;
}): Promise<ScenarioSourceView | null> {
  const { scope, actorUserId } = input;
  const change = parseChange(input.body);
  const db = drizzle(env.DB);
  const now = Date.now();
  if (input.asPlatform && !platformMayStepBack(change)) {
    throw appError(400, "scenario_source_change_invalid", "A platform administrator can only step a source back.");
  }
  // Pull mode needs the platform's builder: only the platform switches to it.
  const platformOnly = input.asPlatform === true || (change.action === "mode" && change.mode === "pull");
  const authority =
    platformOnly || scope.organizationId === null
      ? activeAdministrator(actorUserId)
      : administersOrganization(scope.organizationId, actorUserId);
  if (SETTING_ACTIONS.has(change.action) || platformOnly) {
    // Asked before any flag, so the answer does not tell a flag's state. Each
    // write below asks again in its own statement.
    if (!(await holdsAuthority(db, authority))) {
      throw appError(404, "not_found", "not found");
    }
  }
  // Stopping and stepping back never need a flag: a flag that is off, or
  // cannot be read, must not keep a source on its pipeline or on runners it
  // was allowed. Only what widens does.
  const flag =
    // A platform administrator's step back is one, whatever it is.
    input.asPlatform ||
    change.action === "pause" || change.action === "disconnect" || change.action === "purge" ||
    change.action === "forget_image" ||
    (change.action === "image_producer" && change.producer === "builder") ||
    (change.action === "runner_policy" && !change.allowSelfHosted) ||
    (change.action === "promotion" && change.promotion === "manual")
      ? null
      : change.action === "image_producer"
        ? scenarioPipelineImagesEnabled
        : change.action === "promotion"
          ? scenarioAutomaticPromotionEnabled
          : scenarioGitSourcesEnabled;
  if (flag && !(await flag(scope, input.toggles))) {
    throw appError(404, "not_found", "not found");
  }
  let forgotten: ScenarioSourceView["forgotten"];
  const connected = and(
    eq(scenarioSources.scopeKey, scope.key),
    isNull(scenarioSources.disconnectedAt),
    authority,
  );
  switch (change.action) {
    case "connect":
      await connect({
        ...input,
        fullName: change.repository,
        authority,
        now,
        // An organization that may use its own pipeline starts on it, so its
        // first publish queues nothing for the builder. The platform's own
        // source is switched by its operators.
        producer: scope.organizationId !== null && (await scenarioPipelineImagesEnabled(scope, input.toggles))
          ? "pipeline" : "builder",
      });
      break;
    case "resume": {
      const [binding] = await db
        .select()
        .from(scenarioSources)
        .where(eq(scenarioSources.scopeKey, scope.key))
        .limit(1);
      if (!binding || binding.disconnectedAt !== null) {
        throw appError(409, "scenario_source_not_connected", "No repository is connected.");
      }
      if (binding.pausedAt === null) break;
      const bound = await confirmRepositoryAdmin({
        ...input,
        fullName: binding.githubRepository,
        bound: {
          installationId: binding.githubInstallationId,
          repositoryId: binding.githubRepositoryId,
        },
      });
      if (bound.repository.id !== binding.githubRepositoryId) {
        throw appError(
          409,
          "scenario_source_repository_changed",
          "This name now belongs to a different repository. Disconnect and connect the repository again.",
        );
      }
      requirePinnedPublicRepository(scope, bound.repository, input.appEnv);
      await db
        .update(scenarioSources)
        .set({
          pausedAt: null,
          pauseReason: null,
          boundByUserId: actorUserId,
          githubInstallationId: bound.installationId,
          githubRepository: bound.repository.fullName,
          defaultBranch: bound.repository.defaultBranch,
          pokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            connected,
            eq(scenarioSources.githubRepositoryId, binding.githubRepositoryId),
          ),
        );
      break;
    }
    case "pause":
      // An admin pause replaces a suspension, so a later unsuspend leaves the
      // binding paused; a lost binder still needs a resume.
      await db
        .update(scenarioSources)
        .set({
          pausedAt: sql`COALESCE(${scenarioSources.pausedAt}, ${now})`,
          pauseReason: "admin",
          pokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            connected,
            or(
              isNull(scenarioSources.pausedAt),
              eq(scenarioSources.pauseReason, "suspended"),
            ),
          ),
        );
      break;
    case "disconnect":
      await db.batch([
        db
          .update(scenarioSources)
          .set({
            disconnectedAt: now,
            disconnectReason: "admin",
            pokedAt: now,
            updatedAt: now,
          })
          .where(connected),
        closeDisconnectedPipelineSessions(db, scope.key, now),
        failDisconnectedPipelineRevisions(db, scope.key),
        failDisconnectedPipelineCommits(db, scope.key, now),
      ]);
      break;
    case "purge":
      if (scope.organizationId === null) {
        throw appError(400, "scenario_source_change_invalid", "Unknown change.");
      }
      await purgeScenarioSource({
        scopeKey: scope.key,
        organizationId: scope.organizationId,
        actorUserId,
      });
      break;
    case "image_producer": {
      // In the statement: the actor still administers the scope, and a
      // pipeline builds only for a connected push source. Back to the builder
      // is always possible.
      const [set] = await db
        .update(scenarioSources)
        .set({ imageProducer: change.producer, updatedAt: now })
        .where(
          and(
            eq(scenarioSources.scopeKey, scope.key),
            authority,
            change.producer === "builder"
              ? undefined
              : and(isNull(scenarioSources.disconnectedAt), eq(scenarioSources.mode, "push")),
          ),
        )
        .returning({ scopeKey: scenarioSources.scopeKey });
      if (!set) throw await settingRefusal(db, scope, authority, change.producer === "pipeline");
      break;
    }
    case "runner_policy": {
      const [set, closed] = await db.batch([
        db
          .update(scenarioSources)
          .set({ allowSelfHostedRunners: change.allowSelfHosted, updatedAt: now })
          .where(and(eq(scenarioSources.scopeKey, scope.key), isNull(scenarioSources.disconnectedAt), authority))
          .returning({ scopeKey: scenarioSources.scopeKey }),
        // A session is not asked about its runner again, so one a runner that
        // is no longer allowed holds ends here.
        db
          .update(pipelineUploadSessions)
          .set({ closedAt: now })
          .where(
            and(
              eq(pipelineUploadSessions.scopeKey, scope.key),
              isNull(pipelineUploadSessions.closedAt),
              ne(pipelineUploadSessions.runnerEnvironment, "github-hosted"),
              sql`EXISTS (SELECT 1 FROM scenario_sources source
                WHERE source.scope_key = ${scope.key} AND source.allow_self_hosted_runners = 0)`,
              authority,
            ),
          )
          .returning({ id: pipelineUploadSessions.id }),
      ]);
      if (!set.length) throw await settingRefusal(db, scope, authority, false);
      console.info(JSON.stringify({
        event: "scenario_source_runner_policy_set", scope_key: scope.key, actor_user_id: actorUserId,
        allow_self_hosted: change.allowSelfHosted, closed_sessions: closed.length,
      }));
      break;
    }
    case "promotion": {
      // In the statement: the actor still administers the scope, only a
      // connected source is given a job, and an organization whose play
      // labs are open to everyone does not publish to them unreviewed (#472). Back to manual is always
      // possible. Switching changes nothing a learner sees: the job leaves
      // the commit that is the head now as the administrator left it, and
      // takes up the next one, or a re-run of this one. The poke runs the
      // source's pass at once, which lets a job go on a switch to manual.
      const digest = await sourceCompileDigest();
      const [set] = await db
        .update(scenarioSources)
        .set({
          promotion: change.promotion,
          promotionAfter: change.promotion === "manual" ? null : sql`(SELECT head.id || ':' || head.attempt
            FROM scenario_source_commits head WHERE head.scope_key = ${scenarioSources.scopeKey} AND head.purpose = 'deploy'
              AND head.rev = 'git-' || ${scenarioSources.githubRepositoryId} || '-' || ${scenarioSources.headSha} || '-' || ${digest})`,
          pokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(scenarioSources.scopeKey, scope.key),
            authority,
            change.promotion === "manual"
              ? undefined
              : and(isNull(scenarioSources.disconnectedAt), sql`NOT ${PUBLIC_PLAY_GRANTED}`),
          ),
        )
        .returning({ scopeKey: scenarioSources.scopeKey });
      if (!set) {
        if (change.promotion === "automatic" && (await db.get(sql`SELECT 1 AS granted FROM scenario_sources
            WHERE scope_key = ${scope.key} AND ${PUBLIC_PLAY_GRANTED}`))) {
          throw appError(409, "scenario_source_public_play",
            "This organization's play labs are open to everyone, so its labs are promoted by hand. Automatic promotion needs the public-play grant withdrawn first.");
        }
        throw await settingRefusal(db, scope, authority, false);
      }
      console.info(JSON.stringify({
        event: "scenario_source_promotion_set", scope_key: scope.key, actor_user_id: actorUserId, promotion: change.promotion,
      }));
      break;
    }
    case "forget_image": {
      const [row] = await db
        .delete(scopeMachineImages)
        .where(
          and(
            eq(scopeMachineImages.scopeKey, scope.key),
            eq(scopeMachineImages.buildKey, change.buildKey),
            eq(scopeMachineImages.architecture, change.architecture),
            authority,
          ),
        )
        .returning();
      if (!row) {
        if (!(await holdsAuthority(db, authority))) throw appError(404, "not_found", "not found");
        throw appError(404, "image_not_recorded", "This source has no image recorded for that key and architecture.");
      }
      // The row was the only record of who built the image.
      console.info(JSON.stringify({ event: "scenario_source_image_forgotten", actor_user_id: actorUserId, image: row }));
      // An amd64 image stays in the documents of the revisions that settled
      // on it; only a new commit replaces it there.
      const { results } = await env.DB.prepare(
        `SELECT revision.scenario_id, revision.rev, revision.state FROM scenario_revisions revision
           JOIN scenarios scenario ON scenario.id = revision.scenario_id AND scenario.scope_key = ?1
          WHERE EXISTS (SELECT 1 FROM json_each(revision.doc_json, '$.machines') machine
            WHERE json_extract(machine.value, '$.image_digest') = ?2)
          ORDER BY revision.created_at DESC LIMIT 50`,
      ).bind(scope.key, row.imageDigest).all<{ scenario_id: string; rev: string; state: string }>();
      forgotten = {
        imageDigest: row.imageDigest,
        revisions: results.map((revision) => ({ scenarioId: revision.scenario_id, rev: revision.rev, state: revision.state })),
      };
      break;
    }
    case "mode": {
      // A pipeline builds only for a push source, so the producer goes back
      // to the builder first; in the statement, so this and a producer
      // change at the same moment cannot end as pull with a pipeline.
      const switching = and(
        connected,
        ne(scenarioSources.mode, change.mode),
        change.mode === "pull" ? eq(scenarioSources.imageProducer, "builder") : undefined,
      );
      // A fetch or compile under the old mode is dropped; the new mode
      // delivers the head again.
      const [dropped] = await db.batch([
        db
          .update(scenarioSourceCommits)
          .set({ state: "superseded", updatedAt: now })
          .where(
            and(
              eq(scenarioSourceCommits.scopeKey, scope.key),
              inArray(scenarioSourceCommits.state, ["fetching", "compiling"]),
              exists(
                db
                  .select({ scopeKey: scenarioSources.scopeKey })
                  .from(scenarioSources)
                  .where(switching),
              ),
            ),
          )
          .returning({ hostId: scenarioSourceCommits.compileHostId }),
        db
          .update(scenarioSources)
          .set({ mode: change.mode, pokedAt: now, updatedAt: now })
          .where(switching),
        // After the switch, so they do nothing unless the source pulls now.
        failPipelineRevisions(db, scope.key, REVISION_SOURCE_PULLS, sourcePulls(scope.key)),
        failPipelineCommits(db, scope.key, now, REVISION_SOURCE_PULLS, sourcePulls(scope.key)),
      ]);
      await endSourceCompiles(env, dropped.map((row) => row.hostId));
      if (change.mode === "pull") {
        const [left] = await db
          .select({ mode: scenarioSources.mode, imageProducer: scenarioSources.imageProducer })
          .from(scenarioSources)
          .where(connected)
          .limit(1);
        if (left?.mode === "push" && left.imageProducer === "pipeline") {
          throw appError(
            409,
            "scenario_source_pipeline_images",
            "This source's images are built by its pipeline. Set the image producer to builder first.",
          );
        }
      }
      break;
    }
  }
  const view = await loadScenarioSource(scope);
  return view && forgotten ? { ...view, forgotten } : view;
}

/** Holds while the source of a scope is an organization's that has the public-play grant. */
const PUBLIC_PLAY_GRANTED = sql`EXISTS (SELECT 1 FROM organization_entitlements entitlement
  WHERE entitlement.organization_id = ${scenarioSources.organizationId}
    AND entitlement.public_play_granted_at IS NOT NULL)`;

/** Whether the actor an authority predicate names holds it now. */
async function holdsAuthority(db: DrizzleD1Database, authority: SQL): Promise<boolean> {
  const row = await db.get<{ ok: number }>(sql`SELECT 1 AS ok WHERE ${authority}`);
  return row !== undefined && row !== null;
}

/** Why a change of a setting changed nothing. */
async function settingRefusal(
  db: DrizzleD1Database,
  scope: ScenarioSourceScope,
  authority: SQL,
  needsPush: boolean,
): Promise<AppError> {
  if (!(await holdsAuthority(db, authority))) return appError(404, "not_found", "not found");
  const [binding] = await db
    .select({ mode: scenarioSources.mode, disconnectedAt: scenarioSources.disconnectedAt })
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scope.key))
    .limit(1);
  if (!binding || binding.disconnectedAt !== null) {
    return appError(409, "scenario_source_not_connected", "No repository is connected.");
  }
  if (needsPush && binding.mode !== "push") {
    return appError(409, "scenario_source_mode_pull", "A pipeline builds images only for a push-mode source. Switch it to push mode first.");
  }
  return appError(409, "scenario_source_change_conflict", "The source changed. Reload and try again.");
}

// One statement connects a new scope or re-binds a disconnected one. A
// re-bind keeps the live commit until the new repository's first deploy goes
// live, and forgets the old repository's head and target.
// Either starts in push mode (#465): the repository's own workflow
// publishes, and nothing is published until its first run. Pull mode, where
// Intar fetches the repository and a builder compiles it, is a platform
// administrator's fallback.
async function connect(input: {
  scope: ScenarioSourceScope;
  actorUserId: string;
  fullName: string;
  startedAt: number;
  appEnv?: ScenarioSourceEnv;
  authority: SQL;
  now: number;
  /** Who builds the new source's images; it is in push mode, which a pipeline needs. */
  producer: ImageProducer;
}): Promise<void> {
  const { scope, now } = input;
  const bound = await confirmRepositoryAdmin(input);
  requirePinnedPublicRepository(scope, bound.repository, input.appEnv);
  const db = drizzle(env.DB);
  let changes: number;
  try {
    const result = await db.run(sql`INSERT INTO scenario_sources (scope_key,
        organization_id, github_installation_id, github_repository_id,
        github_repository, default_branch, mode, image_producer, bound_by_user_id, poked_at,
        created_at, updated_at)
      SELECT ${scope.key}, ${scope.organizationId}, ${bound.installationId},
        ${bound.repository.id}, ${bound.repository.fullName},
        ${bound.repository.defaultBranch}, 'push', ${input.producer}, ${input.actorUserId}, ${now},
        ${now}, ${now}
      WHERE ${input.authority}
      ON CONFLICT (scope_key) DO UPDATE SET
        github_installation_id = excluded.github_installation_id,
        github_repository_id = excluded.github_repository_id,
        github_repository = excluded.github_repository,
        default_branch = excluded.default_branch,
        mode = excluded.mode,
        image_producer = excluded.image_producer,
        allow_self_hosted_runners = 0,
        promotion = 'manual',
        promotion_after = NULL,
        bound_by_user_id = excluded.bound_by_user_id,
        head_sha = NULL,
        head_observed_at = 0,
        target_rev = scenario_sources.live_rev,
        paused_at = NULL,
        pause_reason = NULL,
        disconnected_at = NULL,
        disconnect_reason = NULL,
        poked_at = excluded.poked_at,
        updated_at = excluded.updated_at
      WHERE scenario_sources.disconnected_at IS NOT NULL
        AND scenario_sources.disconnect_reason IS NOT 'purging'`);
    changes = result.meta.changes ?? 0;
  } catch (error) {
    if (errorChainMatches(error, /scenario_sources\.github_repository_id/i)) {
      throw appError(
        409,
        "scenario_source_repository_taken",
        "This repository is already connected to another Intar scope.",
      );
    }
    throw error;
  }
  if (changes === 1) {
    // A fetch or compile that a pull source left in flight is dropped, as a
    // change of mode drops it: a push source delivers nothing itself, and a
    // row left on the head would refuse the workflow's first upload.
    const dropped = await db
      .update(scenarioSourceCommits)
      .set({ state: "superseded", updatedAt: now })
      .where(and(
        eq(scenarioSourceCommits.scopeKey, scope.key),
        inArray(scenarioSourceCommits.state, ["fetching", "compiling"]),
      ))
      .returning({ hostId: scenarioSourceCommits.compileHostId });
    await endSourceCompiles(env, dropped.map((row) => row.hostId));
    return;
  }
  const [existing] = await db
    .select({
      disconnectedAt: scenarioSources.disconnectedAt,
      disconnectReason: scenarioSources.disconnectReason,
    })
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scope.key))
    .limit(1);
  if (existing?.disconnectReason === "purging") {
    throw appError(
      409,
      "scenario_source_purging",
      "The courses of the last repository are still being deleted. Finish that first.",
    );
  }
  if (existing && existing.disconnectedAt === null) {
    throw appError(
      409,
      "scenario_source_connected",
      "A repository is already connected. Disconnect it first.",
    );
  }
  throw appError(
    409,
    "scenario_source_authority_changed",
    "Your role changed while connecting. Reload and try again.",
  );
}

function requirePinnedPublicRepository(
  scope: ScenarioSourceScope,
  repository: RepositoryHead,
  appEnv: ScenarioSourceEnv = env,
): void {
  if (
    scope.organizationId === null &&
    String(repository.id) !== appEnv.PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID?.trim()
  ) {
    throw appError(
      409,
      "scenario_source_repository_not_pinned",
      "This repository is not the pinned public scenario source.",
    );
  }
}

/**
 * Runs the GitHub bind checks in order: the installation Intar looks up
 * itself, a token minted for the repository by name, the repository read
 * through that token, then admin for the caller's linked GitHub account,
 * identified by its numeric id. A bound repository is first minted by id
 * under its stored installation, so a renamed or transferred repository still
 * resolves; the name lookup runs only when that mint fails.
 */
async function confirmRepositoryAdmin(input: {
  actorUserId: string;
  fullName: string;
  startedAt: number;
  appEnv?: ScenarioSourceEnv;
  bound?: { installationId: number; repositoryId: number };
}): Promise<{ installationId: number; repository: RepositoryHead }> {
  const appEnv = input.appEnv ?? env;
  const [github] = await drizzle(env.DB)
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(eq(account.userId, input.actorUserId), eq(account.providerId, "github")),
    )
    .limit(1);
  if (!github) {
    throw appError(
      409,
      "github_account_required",
      "Connect your GitHub account in your profile first.",
    );
  }
  if (!appEnv.GITHUB_APP_CLIENT_ID || !appEnv.GITHUB_APP_PRIVATE_KEY) {
    throw appError(
      503,
      "github_app_unavailable",
      "The Intar GitHub App is not configured.",
    );
  }
  const [owner = "", repo = ""] = input.fullName.split("/");
  try {
    let installationId = input.bound?.installationId ?? null;
    let mint = input.bound
      ? await mintInstallationToken(appEnv, { ...input.bound, fullName: input.fullName })
      : null;
    if (mint?.status !== "ok") {
      installationId =
        (await findRepositoryInstallation(appEnv, owner, repo))?.id ?? null;
      mint =
        installationId === null
          ? null
          : await mintInstallationToken(appEnv, {
              installationId,
              fullName: input.fullName,
            });
    }
    const repository =
      mint?.status === "ok" ? await readRepository(mint.token) : null;
    if (
      installationId !== null &&
      mint?.status === "ok" &&
      repository &&
      (await verifyRepositoryAdmin(mint.token, repository.fullName, github.accountId))
    ) {
      return { installationId, repository };
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "scenario_source_bind_check_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  const wait = input.startedAt + BIND_REFUSAL_FLOOR_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  throw appError(422, "scenario_source_bind_refused", BIND_REFUSAL_MESSAGE);
}

/** A refusal whose body is a `SourceRefusalV1`. */
export function sourceRefusal(
  status: number,
  code: SourceRefusalCode,
  message: string,
): AppError {
  return appError(status, code, message);
}

/** The connected push-mode binding of a repository, while it may write. */
export async function loadPushScenarioSource(
  db: DrizzleD1Database,
  repositoryId: number,
) {
  const [binding] = await db
    .select()
    .from(scenarioSources)
    .where(
      and(
        eq(scenarioSources.githubRepositoryId, repositoryId),
        eq(scenarioSources.mode, "push"),
        scenarioSourceBindingPredicate(),
      ),
    )
    .limit(1);
  return binding ?? null;
}

/** 2 MiB of compressed bundle, plus 2 MiB for the meta part and framing. */
export const MAX_SOURCE_UPLOAD_BYTES = 4 * 1024 * 1024;
/**
 * A pull compile that expires, or is refused as outdated, this many attempts
 * after the row's claim fails its row.
 */
export const MAX_COMPILE_ATTEMPTS = 3;

// A row in one of these states already holds the rev; a re-upload is a no-op.
const SETTLED_STATES: readonly ScenarioSourceCommitState[] = [
  "ingesting",
  "building",
  "waiting",
  "promoting",
  "awaiting_promote",
  "live",
  "validated",
];

/**
 * How an upload claims its row. A push inserts the head rev as `ingesting`,
 * or takes over a failed, invalid or superseded row for it. A pull compile
 * result moves its own `compiling` row, fenced on (row, attempt, host).
 */
export type SourceUploadClaim =
  | { via: "push"; headSha: string; observedAt: number }
  | { via: "pull"; commitId: string; attempt: number; hostId: string };

/** Where a row's staged objects live. */
export function stagedSourceObjectPrefix(
  scopeKey: string,
  rev: string,
  purpose: "deploy" | "validate",
): string {
  return `builds/sources/${scopeKey}/${rev}/${purpose}/`;
}

/**
 * The request half of ingest, shared by the push route and the pull result
 * route: the size and producer checks, the base-catalog check, the stage and
 * the claim. It holds no registry writer, so a cancelled request leaves only
 * staged objects, which the prune removes. Refusals throw an AppError; the
 * named ones are `SourceRefusalV1`.
 */
export async function acceptScenarioSourceUpload(
  request: Request,
  workerEnv: Cloudflare.Env,
  input: {
    scope: ScenarioSourceScope;
    repositoryId: number;
    sha: string;
    purpose: "deploy" | "validate";
    claim: SourceUploadClaim;
    /** Who builds the source's images now; absent, a builder. */
    imageProducer?: ImageProducer;
  },
): Promise<Response> {
  const { scope, purpose, claim } = input;
  // Checked before anything is buffered; the CLI and the builder send it.
  const declared = request.headers.get("content-length");
  if (
    !declared ||
    !/^\d+$/.test(declared) ||
    Number(declared) > MAX_SOURCE_UPLOAD_BYTES
  ) {
    throw appError(
      413,
      "payload_too_large",
      "The upload needs a Content-Length of at most 4 MiB.",
    );
  }
  let form: FormData;
  try {
    const body = request.body
      ? await readBoundedBody(request.body, MAX_SOURCE_UPLOAD_BYTES)
      : new Uint8Array();
    form = await new Response(body, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw appError(413, "payload_too_large", "The upload is too large.");
    }
    throw appError(400, "multipart_required", "multipart form data is required");
  }

  const metaField = form.get(SOURCE_META_FIELD);
  const rawMeta =
    typeof metaField === "string" ? metaField : await metaField?.text();
  const revPrefix = `git-${input.repositoryId}-${input.sha}-`;
  const lenient = parseRecord(rawMeta);
  // An older CLI or builder, whose meta names its source, is told to re-read
  // the compiler descriptor before any other check calls its output malformed.
  if (Object.hasOwn(lenient, "source")) {
    throw sourceRefusal(
      409,
      "compiler_outdated",
      "Intar now compiles with another compiler. Re-read the compiler descriptor and publish again.",
    );
  }
  if (!validateSourceBundleMeta(lenient)) {
    throw appError(400, "source_meta_invalid", "meta must be exactly {\"rev\": ...}");
  }
  if (!isSafeBundleRev(lenient.rev) || !lenient.rev.startsWith(revPrefix)) {
    throw appError(400, "source_rev_invalid", "meta.rev does not name this commit");
  }
  const digest = await sourceCompileDigest();
  const rev = `${revPrefix}${digest}`;
  if (lenient.rev !== rev) {
    throw sourceRefusal(
      409,
      "compiler_outdated",
      "Intar now compiles with another compiler. Re-read the compiler descriptor and publish again.",
    );
  }
  const bundle = form.get(SOURCE_BUNDLE_FIELD);
  // A validate-only compile result carries no bundle.
  if (purpose === "deploy" && !(bundle instanceof File)) {
    throw appError(400, "bundle_required", "bundle form field is required");
  }

  const db = drizzle(workerEnv.DB);
  // Before any decompression, so a repeated upload costs only the form read.
  const [existing] = await db
    .select({ state: scenarioSourceCommits.state })
    .from(scenarioSourceCommits)
    .where(
      and(
        eq(scenarioSourceCommits.scopeKey, scope.key),
        eq(scenarioSourceCommits.rev, rev),
        eq(scenarioSourceCommits.purpose, purpose),
      ),
    )
    .limit(1);
  const settled = existing !== undefined && SETTLED_STATES.includes(existing.state);
  // A pipeline's receipt also says which images its scope lacks (#441). The
  // keys are the ingested revisions' once the rev has a bundle, since those
  // are what a push is checked against; before that, the uploaded bundle's.
  const pipeline =
    claim.via === "push" && purpose === "deploy"
      ? await producerInForce(workerEnv, scope.key, rev, input.imageProducer ?? "builder")
      : null;
  const planned = pipeline?.producer === "pipeline";
  const receiptOf = async (uploaded: string[]) =>
    receipt(
      rev,
      planned
        ? await pipelinePlan(
            workerEnv,
            scope.key,
            pipeline.stamped ? await revisionBuildKeys(workerEnv, scope.key, rev) : uploaded,
          )
        : undefined,
    );
  if (settled && !(planned && !pipeline.stamped)) return receiptOf([]);

  let uploadedKeys: string[] = [];
  const files: Array<[name: string, body: Uint8Array<ArrayBuffer>, type: string]> = [];
  if (bundle instanceof File) {
    if (bundle.size > MAX_SOURCE_BUNDLE_GZIP_BYTES) {
      throw appError(413, "payload_too_large", `The bundle is over ${MAX_SOURCE_BUNDLE_GZIP_BYTES} bytes gzipped.`);
    }
    const gzip = new Uint8Array(await bundle.arrayBuffer());
    const read = await readSourceBundle(gzip);
    if (!normalizeCourseCatalogSnapshot(read.course_catalog)) {
      throw appError(400, "bundle_invalid", "The course catalog is invalid.");
    }
    if (planned) {
      for (const scenario of read.scenarios) {
        uploadedKeys.push(...Object.values((await buildKeys(scenario, read.images)).machines));
      }
    }
    if (purpose === "deploy") files.push(["bundle.json.gz", gzip, "application/gzip"]);
  }
  // The row already holds the rev; only its bundle is not ingested yet.
  if (settled) return receiptOf(uploadedKeys);
  // A validate-only result has nothing left to do once it is claimed.
  const claimState = purpose === "validate" ? "validated" : "ingesting";

  // Before staging: nothing lands in the wiped tables or the bucket. The
  // claim's own predicate covers a wipe that starts after this read.
  await assertCutoverNotWiped(workerEnv.DB);
  const staged = stagedSourceObjectPrefix(scope.key, rev, purpose);
  await Promise.all(
    files.map(([name, body, contentType]) =>
      workerEnv.VM_IMAGE_REGISTRY_BUCKET.put(`${staged}${name}`, body, {
        httpMetadata: { contentType },
      }),
    ),
  );

  const now = Date.now();
  const headIsRev = sql`EXISTS (SELECT 1 FROM scenario_sources
    WHERE scope_key = ${scope.key} AND mode = ${claim.via}
      AND ${scenarioSourceBindingPredicate()}
      AND 'git-' || github_repository_id || '-' || head_sha || '-' || ${digest} = ${rev})`;
  const queries =
    claim.via === "push"
      ? [
          // Monotonic: an older read never replaces a newer head, and the
          // first push after a bind needs no observe first.
          sql`UPDATE scenario_sources
            SET head_sha = ${claim.headSha},
              head_observed_at = ${claim.observedAt}, updated_at = ${now}
            WHERE scope_key = ${scope.key} AND mode = 'push'
              AND head_observed_at < ${claim.observedAt}
              AND ${scenarioSourceBindingPredicate()}`,
          sql`INSERT INTO scenario_source_commits (id, scope_key, purpose, sha,
              rev, via, state, created_at, updated_at)
            SELECT ${createAppId()}, ${scope.key}, ${purpose}, ${input.sha},
              ${rev}, 'push', ${claimState}, ${now}, ${now}
            WHERE ${headIsRev} AND NOT ${sql.raw(CUTOVER_WIPED_SQL)}
            ON CONFLICT (scope_key, rev, purpose) DO UPDATE SET
              state = ${claimState}, via = 'push', attempt = attempt + 1,
              detail = NULL, diagnostics_json = NULL,
              updated_at = excluded.updated_at
            WHERE scenario_source_commits.state IN
              ('failed', 'invalid', 'superseded')`,
        ]
      : [
          sql`UPDATE scenario_source_commits
            SET state = ${claimState}, updated_at = ${now}
            WHERE id = ${claim.commitId} AND attempt = ${claim.attempt}
              AND compile_host_id = ${claim.hostId} AND state = 'compiling'
              AND scope_key = ${scope.key} AND rev = ${rev}
              AND purpose = ${purpose} AND ${headIsRev}`,
        ];
  // One D1 batch, so the head write and the claim commit together.
  const dialect = new SQLiteSyncDialect();
  const claimed = await workerEnv.DB.batch(
    queries.map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return workerEnv.DB.prepare(compiled.sql).bind(...compiled.params);
    }),
  );
  if (!claimed.at(-1)?.meta.changes) {
    throw claim.via === "push"
      ? sourceRefusal(
          409,
          "superseded",
          "This commit is no longer the head of the default branch.",
        )
      : sourceRefusal(
          409,
          "fenced",
          "This compile is no longer assigned to this builder.",
        );
  }
  await db
    .update(scenarioSources)
    .set({ pokedAt: now })
    .where(eq(scenarioSources.scopeKey, scope.key));
  return receiptOf(uploadedKeys);
}

/**
 * Every exit from `compiling`: each builder's desired compiles follow its
 * rows, and a freed builder wakes the pull binding that waited longest for
 * one. `hostIds` may over-approximate; a host already in step costs two reads.
 */
export async function endSourceCompiles(
  workerEnv: Cloudflare.Env,
  hostIds: Array<string | null>,
): Promise<void> {
  const hosts = [...new Set(hostIds)].filter((id): id is string => id !== null);
  if (!hosts.length) return;
  const now = Date.now();
  for (const hostId of hosts) {
    if (await syncBuilderDesiredState(workerEnv, hostId, now)) {
      await tryWakeHostRuntimeViaNamespace(workerEnv.HOST_RUNTIME, hostId);
    }
  }
  const digest = await sourceCompileDigest();
  // The oldest head with nothing in flight; the every-minute cron delivers it.
  await workerEnv.DB.prepare(
    `UPDATE scenario_sources SET poked_at = ?1
      WHERE scope_key = (SELECT s.scope_key FROM scenario_sources AS s
        WHERE s.mode = 'pull' AND s.disconnected_at IS NULL
          AND s.paused_at IS NULL AND s.head_sha IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM scenario_source_commits AS c
            WHERE c.scope_key = s.scope_key AND c.purpose = 'deploy'
              AND c.rev = 'git-' || s.github_repository_id || '-' || s.head_sha || '-' || ?2
              AND c.state NOT IN ('fetching', 'superseded'))
        ORDER BY s.head_observed_at LIMIT 1)`,
  )
    .bind(now, digest)
    .run();
}

// The CLI and builder receipt check accepts this; nothing is queued yet.
function receipt(rev: string, pipeline?: PipelinePlan): Response {
  return jsonResponse({ ok: true, rev, queued: 0, assigned: [], ...(pipeline ? { pipeline } : {}) }, 202);
}

function parseRecord(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "");
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
