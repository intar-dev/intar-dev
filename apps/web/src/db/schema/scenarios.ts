import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import { organization, user } from "./core";
import { agentHosts } from "./platform";
import {
  type CourseCatalogSnapshotV2,
  jsonText,
  nowMsDefault,
} from "./shared";

export const courseCatalogs = sqliteTable(
  "course_catalogs",
  {
    scopeKey: text("scope_key").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    catalogJson: jsonText<CourseCatalogSnapshotV2>("catalog_json")
      .notNull(),
    sourceRevision: text("source_revision").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("course_catalogs_organization_uidx").on(
      table.organizationId,
    ),
    check(
      "course_catalogs_scope_check",
      sql`(${table.scopeKey} = 'public' AND ${table.organizationId} IS NULL) OR (${table.scopeKey} = 'organization:' || ${table.organizationId} AND ${table.organizationId} IS NOT NULL)`,
    ),
    check(
      "course_catalogs_catalog_json_check",
      sql`json_valid(${table.catalogJson})`,
    ),
  ],
);

export type ScenarioSourceCommitState =
  | "fetching"
  | "compiling"
  | "ingesting"
  | "building"
  | "waiting"
  | "promoting"
  | "awaiting_promote"
  | "live"
  | "failed"
  | "invalid"
  | "superseded"
  | "validated";

export const scenarioSources = sqliteTable(
  "scenario_sources",
  {
    scopeKey: text("scope_key").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    githubInstallationId: integer("github_installation_id").notNull(),
    githubRepositoryId: integer("github_repository_id").notNull(),
    githubRepository: text("github_repository").notNull(),
    defaultBranch: text("default_branch").notNull(),
    mode: text("mode").$type<"push" | "pull">().default("pull").notNull(),
    headSha: text("head_sha"),
    headObservedAt: integer("head_observed_at").default(0).notNull(),
    pokedAt: integer("poked_at"),
    polledAt: integer("polled_at"),
    targetRev: text("target_rev"),
    liveRev: text("live_rev"),
    liveSha: text("live_sha"),
    liveAt: integer("live_at"),
    pausedAt: integer("paused_at"),
    pauseReason: text("pause_reason").$type<
      "admin" | "binder_lost_admin" | "suspended"
    >(),
    disconnectedAt: integer("disconnected_at"),
    disconnectReason: text("disconnect_reason"),
    boundByUserId: text("bound_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_sources_organization_uidx").on(
      table.organizationId,
    ),
    uniqueIndex("scenario_sources_connected_repository_uidx")
      .on(table.githubRepositoryId)
      .where(sql`${table.disconnectedAt} IS NULL`),
    check(
      "scenario_sources_scope_check",
      sql`(${table.scopeKey} = 'public' AND ${table.organizationId} IS NULL) OR (${table.scopeKey} = 'organization:' || ${table.organizationId} AND ${table.organizationId} IS NOT NULL)`,
    ),
    check("scenario_sources_mode_check", sql`${table.mode} IN ('push', 'pull')`),
    check(
      "scenario_sources_pause_reason_check",
      sql`${table.pauseReason} IN ('admin', 'binder_lost_admin', 'suspended')`,
    ),
  ],
);

export const scenarioSourceCommits = sqliteTable(
  "scenario_source_commits",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key")
      .notNull()
      .references(() => scenarioSources.scopeKey, { onDelete: "cascade" }),
    purpose: text("purpose").$type<"deploy" | "validate">().notNull(),
    sha: text("sha").notNull(),
    rev: text("rev").notNull(),
    via: text("via").$type<"push" | "pull">().notNull(),
    attempt: integer("attempt").default(0).notNull(),
    // `attempt` when a pull delivery last claimed the row; the compile cap
    // counts from it. NULL counts from 0.
    claimedAttempt: integer("claimed_attempt"),
    state: text("state").$type<ScenarioSourceCommitState>().notNull(),
    detail: text("detail"),
    diagnosticsJson: text("diagnostics_json"),
    compileHostId: text("compile_host_id").references(() => agentHosts.id, {
      onDelete: "set null",
    }),
    compileAssignedAt: integer("compile_assigned_at"),
    checkRunId: integer("check_run_id"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_source_commits_scope_rev_purpose_uidx").on(
      table.scopeKey,
      table.rev,
      table.purpose,
    ),
    index("scenario_source_commits_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "scenario_source_commits_purpose_check",
      sql`${table.purpose} IN ('deploy', 'validate')`,
    ),
    check(
      "scenario_source_commits_via_check",
      sql`${table.via} IN ('push', 'pull')`,
    ),
    check(
      "scenario_source_commits_state_check",
      sql`${table.state} IN ('fetching', 'compiling', 'ingesting', 'building', 'waiting', 'promoting', 'awaiting_promote', 'live', 'failed', 'invalid', 'superseded', 'validated')`,
    ),
  ],
);

export type ScenarioRevisionState = "building" | "ready" | "verified" | "failed";

/**
 * One row per published scenario, keyed by its global ID
 * `<namespace>/<slug>`. The namespace comes from the source binding: `intar`
 * for the public scope, else the organization's slug. Rows are never deleted,
 * so an ID is never reused.
 */
export const scenarios = sqliteTable(
  "scenarios",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    slug: text("slug").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    scopeKey: text("scope_key").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    play: integer("play", { mode: "boolean" }).notNull(),
    liveRev: text("live_rev"),
    candidateRev: text("candidate_rev"),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenarios_namespace_slug_uidx").on(table.namespace, table.slug),
    index("scenarios_organization_idx").on(table.organizationId),
    check(
      "scenarios_id_check",
      sql`${table.id} = ${table.namespace} || '/' || ${table.slug}`,
    ),
  ],
);

/** A scenario as one bundle revision compiled it; immutable once ready. */
export const scenarioRevisions = sqliteTable(
  "scenario_revisions",
  {
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    rev: text("rev").notNull(),
    guestContract: integer("guest_contract").notNull(),
    docJson: jsonText<ScenarioRevisionV1>("doc_json").notNull(),
    // sha256 of the canonical `doc_json`, set when the revision is ready.
    contentDigest: text("content_digest"),
    state: text("state").$type<ScenarioRevisionState>().notNull(),
    // Why a failed revision failed, in words a learner may read.
    failureReason: text("failure_reason"),
    verifyRunId: text("verify_run_id"),
    verifyReportJson: text("verify_report_json"),
    // When the revision first went live; only such a revision is a rollback
    // target.
    liveAt: integer("live_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scenarioId, table.rev] }),
    check(
      "scenario_revisions_state_check",
      sql`${table.state} IN ('building', 'ready', 'verified', 'failed')`,
    ),
    check(
      "scenario_revisions_doc_json_check",
      sql`json_valid(${table.docJson})`,
    ),
  ],
);

/** One uploaded source bundle, stored at `r2_key`. */
export const bundles = sqliteTable(
  "bundles",
  {
    rev: text("rev").primaryKey(),
    scopeKey: text("scope_key").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    compilerVersion: text("compiler_version").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [index("bundles_organization_idx").on(table.organizationId)],
);

/** What a platform admin has granted an organization. */
export const organizationEntitlements = sqliteTable(
  "organization_entitlements",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    publicPlayGrantedAt: integer("public_play_granted_at"),
    grantedBy: text("granted_by"),
  },
);
