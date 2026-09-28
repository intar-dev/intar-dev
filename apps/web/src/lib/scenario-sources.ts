// Scenario source bindings: one GitHub repository per scope, connected
// through the Intar GitHub App. The binding is the only thing Intar trusts
// about where a repository may publish.
import { env } from "cloudflare:workers";
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  account,
  imageBuilds,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import type { ScenarioSourceCommitState } from "@/db/schema/scenarios";
import type { SourceCompileErrorV1 } from "@/generated/bridge";
import { activeAccountExistsSql, activeAdminSql } from "@/lib/account-access";
import type { UserContext } from "@/lib/agent-bridge";
import { appError, errorChainMatches } from "@/lib/app-error";
import type { FeatureToggleService } from "@/lib/feature-toggles";
import {
  findRepositoryInstallation,
  mintInstallationToken,
  readRepository,
  verifyRepositoryAdmin,
  type GitHubAppEnv,
  type RepositoryHead,
} from "@/lib/github-app";
import { featureToggleService } from "@/lib/organization-access";
import { administersOrganization } from "@/lib/organizations";
import { activeAdministrator } from "@/lib/platform-admin-authority";
import { enforceRateLimit } from "@/lib/request-security";

export const SCENARIO_GIT_SOURCES_FLAG = "scenario_git_sources";

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
  pausedAt: number | null;
  pauseReason: "admin" | "binder_lost_admin" | "suspended" | null;
  disconnectedAt: number | null;
  liveSha: string | null;
  liveAt: number | null;
  commit: {
    sha: string;
    state: ScenarioSourceCommitState;
    detail: string | null;
    diagnostics: Array<Pick<SourceCompileErrorV1, "path" | "line" | "message">>;
    updatedAt: number;
  } | null;
  builds: Array<{
    scenarioId: string;
    arch: string;
    status: string;
    phase: string;
    error: string | null;
  }>;
}

export interface ScenarioSourceCard {
  /** Whether bind, resume and mode are available to this scope. */
  enabled: boolean;
  /** For `public`: whether a repository id is pinned for it. */
  configured?: boolean;
  appSlug: string | null;
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
 * paused, and its binder is still an owner or admin of the organization with
 * an active account, or for `public` an active platform admin.
 */
export function scenarioSourceBindingPredicate(): SQL {
  const binder = sql`${scenarioSources.boundByUserId}`;
  return sql`(${scenarioSources.disconnectedAt} IS NULL
    AND ${scenarioSources.pausedAt} IS NULL
    AND ((${scenarioSources.organizationId} IS NULL
        AND EXISTS (SELECT 1 FROM user AS binder
          WHERE binder.id = ${binder} AND ${sql.raw(activeAdminSql("binder"))}))
      OR (${administersOrganization(sql`${scenarioSources.organizationId}`, binder)}
        AND ${sql.raw(activeAccountExistsSql("scenario_sources.bound_by_user_id"))})))`;
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

export async function scenarioSourceCard(
  scope: ScenarioSourceScope,
  toggles?: FeatureToggleService,
): Promise<ScenarioSourceCard> {
  const [enabled, source] = await Promise.all([
    scenarioGitSourcesEnabled(scope, toggles),
    loadScenarioSource(scope),
  ]);
  return {
    enabled,
    ...(scope.organizationId === null
      ? { configured: Boolean(env.PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID) }
      : {}),
    appSlug: env.GITHUB_APP_SLUG || null,
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
  const builds = commit
    ? await db
        .select({
          scenarioId: imageBuilds.scenarioId,
          arch: imageBuilds.arch,
          status: imageBuilds.status,
          phase: imageBuilds.phase,
          error: imageBuilds.error,
        })
        .from(imageBuilds)
        .where(
          and(
            eq(imageBuilds.rev, commit.rev),
            scope.organizationId === null
              ? isNull(imageBuilds.organizationId)
              : eq(imageBuilds.organizationId, scope.organizationId),
          ),
        )
        .orderBy(asc(imageBuilds.scenarioId), asc(imageBuilds.arch))
    : [];
  return {
    repository: binding.githubRepository,
    defaultBranch: binding.defaultBranch,
    mode: binding.mode,
    pausedAt: binding.pausedAt,
    pauseReason: binding.pauseReason,
    disconnectedAt: binding.disconnectedAt,
    liveSha: binding.liveSha,
    liveAt: binding.liveAt,
    commit: commit
      ? {
          sha: commit.sha,
          state: commit.state,
          detail: commit.detail === null ? null : redactHostPaths(commit.detail),
          diagnostics: parseDiagnostics(commit.diagnosticsJson),
          updatedAt: commit.updatedAt,
        }
      : null,
    builds: builds.map((build) => ({
      ...build,
      error: build.error === null ? null : redactHostPaths(build.error),
    })),
  };
}

function parseDiagnostics(
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
  | { action: "resume" | "pause" | "disconnect" }
  | { action: "mode"; mode: "push" | "pull" };

function parseChange(body: unknown): Change {
  const input = (body ?? {}) as {
    action?: unknown;
    repository?: unknown;
    mode?: unknown;
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
      return { action: input.action };
    case "mode":
      if (input.mode === "push" || input.mode === "pull") {
        return { action: "mode", mode: input.mode };
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
 * without it; pause and disconnect never do, so a scope can always stop.
 */
export async function changeScenarioSource(input: {
  scope: ScenarioSourceScope;
  actorUserId: string;
  body: unknown;
  /** When the request started: the floor for a uniform bind refusal. */
  startedAt: number;
  toggles?: FeatureToggleService;
  appEnv?: ScenarioSourceEnv;
}): Promise<ScenarioSourceView | null> {
  const { scope, actorUserId } = input;
  const change = parseChange(input.body);
  if (
    change.action !== "pause" &&
    change.action !== "disconnect" &&
    !(await scenarioGitSourcesEnabled(scope, input.toggles))
  ) {
    throw appError(404, "not_found", "not found");
  }
  const db = drizzle(env.DB);
  const now = Date.now();
  const authority =
    scope.organizationId === null
      ? activeAdministrator(actorUserId)
      : administersOrganization(scope.organizationId, actorUserId);
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
      await db
        .update(scenarioSources)
        .set({
          disconnectedAt: now,
          disconnectReason: "admin",
          pokedAt: now,
          updatedAt: now,
        })
        .where(connected);
      break;
    case "mode": {
      const switching = and(connected, ne(scenarioSources.mode, change.mode));
      // A fetch or compile under the old mode is dropped; the new mode
      // delivers the head again.
      await db.batch([
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
          ),
        db
          .update(scenarioSources)
          .set({ mode: change.mode, pokedAt: now, updatedAt: now })
          .where(switching),
      ]);
      break;
    }
  }
  return loadScenarioSource(scope);
}

// One statement connects a new scope or re-binds a disconnected one. A
// re-bind keeps the live commit until the new repository's first deploy goes
// live, and forgets the old repository's head and target.
async function connect(input: {
  scope: ScenarioSourceScope;
  actorUserId: string;
  fullName: string;
  startedAt: number;
  appEnv?: ScenarioSourceEnv;
  authority: SQL;
  now: number;
}): Promise<void> {
  const { scope, now } = input;
  const bound = await confirmRepositoryAdmin(input);
  requirePinnedPublicRepository(scope, bound.repository, input.appEnv);
  const db = drizzle(env.DB);
  let changes: number;
  try {
    const result = await db.run(sql`INSERT INTO scenario_sources (scope_key,
        organization_id, github_installation_id, github_repository_id,
        github_repository, default_branch, mode, bound_by_user_id, poked_at,
        created_at, updated_at)
      SELECT ${scope.key}, ${scope.organizationId}, ${bound.installationId},
        ${bound.repository.id}, ${bound.repository.fullName},
        ${bound.repository.defaultBranch}, 'pull', ${input.actorUserId}, ${now},
        ${now}, ${now}
      WHERE ${input.authority}
      ON CONFLICT (scope_key) DO UPDATE SET
        github_installation_id = excluded.github_installation_id,
        github_repository_id = excluded.github_repository_id,
        github_repository = excluded.github_repository,
        default_branch = excluded.default_branch,
        mode = excluded.mode,
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
      WHERE scenario_sources.disconnected_at IS NOT NULL`);
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
  if (changes === 1) return;
  const [existing] = await db
    .select({ disconnectedAt: scenarioSources.disconnectedAt })
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scope.key))
    .limit(1);
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
 * identified by its numeric id.
 */
async function confirmRepositoryAdmin(input: {
  actorUserId: string;
  fullName: string;
  startedAt: number;
  appEnv?: ScenarioSourceEnv;
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
    const installation = await findRepositoryInstallation(appEnv, owner, repo);
    const mint = installation
      ? await mintInstallationToken(appEnv, {
          installationId: installation.id,
          fullName: input.fullName,
        })
      : null;
    const repository =
      mint?.status === "ok" ? await readRepository(mint.token) : null;
    if (
      installation &&
      mint?.status === "ok" &&
      repository &&
      (await verifyRepositoryAdmin(mint.token, repository.fullName, github.accountId))
    ) {
      return { installationId: installation.id, repository };
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
