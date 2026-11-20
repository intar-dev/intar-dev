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

/** Who builds a source's machine images. */
export type ImageProducer = "builder" | "pipeline";
export type SourcePromotion = "manual" | "automatic";

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
    /**
     * Who builds this source's machine images: the platform's builder, or the
     * repository's own pipeline, which pushes them (#441). No CHECK: adding
     * one to this table would recreate it.
     */
    imageProducer: text("image_producer")
      .$type<ImageProducer>()
      .default("builder")
      .notNull(),
    /** Whether a pipeline on a runner that is not GitHub-hosted may publish. */
    allowSelfHostedRunners: integer("allow_self_hosted_runners", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    /**
     * Who puts a commit's labs live once they are checked (#454): an
     * administrator, or the source's own pass.
     */
    promotion: text("promotion").$type<SourcePromotion>().default("manual").notNull(),
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
    // How the revision behaves, without what only people read (#454): set
    // with `content_digest`. Null on a row from before, until the source's
    // pass fills it in.
    behaviourDigest: text("behaviour_digest"),
    // Each machine's spec without its tasks, taken at ingest; and, once the
    // revision is ready, that with each machine's image and shape: what a
    // snapshot start depends on. Null on a row from before.
    restoreBasis: text("restore_basis"),
    restoreDigest: text("restore_digest"),
    state: text("state").$type<ScenarioRevisionState>().notNull(),
    // Why a failed revision failed, in words a learner may read.
    failureReason: text("failure_reason"),
    verifyRunId: text("verify_run_id"),
    verifyReportJson: text("verify_report_json"),
    // When the revision was last made live; only such a revision is a rollback
    // target.
    liveAt: integer("live_at"),
    // When the revision's checks passed in a lab that a host started from
    // its snapshot. Only then may a run of the revision start that way.
    restoreVerifiedAt: integer("restore_verified_at"),
    // The last restore check: its verify run, and what came of it.
    restoreVerifyRunId: text("restore_verify_run_id"),
    restoreVerifyReportJson: text("restore_verify_report_json"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scenarioId, table.rev] }),
    // A pipeline's pushes and the deadline of its revisions go by rev.
    index("scenario_revisions_rev_idx").on(table.rev),
    index("scenario_revisions_behaviour_idx").on(table.scenarioId, table.behaviourDigest),
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

/**
 * A behaviour of a scenario that must not go live again by itself (#454): a
 * rollback puts the one it rolled away from here. While a hold is not
 * lifted, no revision of the scenario with that digest is verified by
 * inheritance or promoted.
 */
export const scenarioRevisionHolds = sqliteTable(
  "scenario_revision_holds",
  {
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    behaviourDigest: text("behaviour_digest").notNull(),
    heldAt: integer("held_at").default(nowMsDefault).notNull(),
    heldByUserId: text("held_by_user_id"),
    liftedAt: integer("lifted_at"),
    liftedByUserId: text("lifted_by_user_id"),
  },
  (table) => [
    primaryKey({ columns: [table.scenarioId, table.behaviourDigest] }),
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
    /**
     * The source's producer when this bundle was ingested. A revision keeps
     * it: switching the source applies from the next commit.
     */
    imageProducer: text("image_producer")
      .$type<ImageProducer>()
      .default("builder")
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [index("bundles_organization_idx").on(table.organizationId)],
);

/**
 * A machine image a pipeline recorded for a scope (#441). A pipeline says
 * which build key its image is of and nothing can check that, so its images
 * are held per scope and satisfy that scope's revisions only; the builder's
 * are in `machine_builds`, by key alone. `scope_key` is a scenario's, with
 * no foreign key, as in `scenarios`.
 */
export const scopeMachineImages = sqliteTable(
  "scope_machine_images",
  {
    scopeKey: text("scope_key").notNull(),
    buildKey: text("build_key").notNull(),
    architecture: text("architecture").$type<"amd64" | "arm64">().notNull(),
    imageDigest: text("image_digest").notNull(),
    imageFormat: text("image_format").notNull(),
    /** The manifest's config and layers. */
    sizeBytes: integer("size_bytes").notNull(),
    // Who built it.
    githubRepositoryId: integer("github_repository_id").notNull(),
    githubRepository: text("github_repository").notNull(),
    sha: text("sha").notNull(),
    runId: text("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    runnerEnvironment: text("runner_environment").notNull(),
    jobWorkflowSha: text("job_workflow_sha").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scopeKey, table.buildKey, table.architecture],
    }),
    index("scope_machine_images_digest_idx").on(table.imageDigest),
    check(
      "scope_machine_images_architecture_check",
      sql`${table.architecture} IN ('amd64', 'arm64')`,
    ),
  ],
);

/**
 * The credential a pipeline pushes images with (#441). A GitHub OIDC token
 * lives for minutes and an image uploads for longer, so the token is checked
 * once, when the session is opened, and the session is bound to what the
 * token said. Only the hash of the session's own token is kept.
 */
export const pipelineUploadSessions = sqliteTable(
  "pipeline_upload_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    scopeKey: text("scope_key")
      .notNull()
      .references(() => scenarioSources.scopeKey, { onDelete: "cascade" }),
    githubRepositoryId: integer("github_repository_id").notNull(),
    githubRepository: text("github_repository").notNull(),
    ref: text("ref").notNull(),
    sha: text("sha").notNull(),
    rev: text("rev").notNull(),
    runId: text("run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    runnerEnvironment: text("runner_environment").notNull(),
    jobWorkflowSha: text("job_workflow_sha").notNull(),
    bytesPut: integer("bytes_put").default(0).notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    /** Absolute, and never extended. */
    expiresAt: integer("expires_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    uniqueIndex("pipeline_upload_sessions_token_hash_uidx").on(table.tokenHash),
    index("pipeline_upload_sessions_scope_expires_idx").on(
      table.scopeKey,
      table.expiresAt,
    ),
  ],
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
