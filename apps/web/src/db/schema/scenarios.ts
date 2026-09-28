import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  ImageKey,
  ScenarioHintManifestV3,
  ScenarioManifestV5,
} from "@/generated/catalog";
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

export const vmScenarios = sqliteTable(
  "vm_scenarios",
  {
    scenarioId: text("scenario_id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    sourceRevision: text("source_revision"),
    title: text("title").notNull(),
    category: text("category").default("").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    tagsJson: jsonText<string[]>("tags_json").notNull(),
    briefingMarkdown: text("briefing_markdown").notNull(),
    solutionMarkdown: text("solution_markdown").notNull(),
    hintsJson: jsonText<ScenarioHintManifestV3[]>("hints_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),
    enabledAt: integer("enabled_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("vm_scenarios_enabled_idx").on(table.enabled, table.enabledAt),
    index("vm_scenarios_organization_enabled_idx").on(
      table.organizationId,
      table.enabled,
      table.enabledAt,
    ),
  ],
);

export const scenarioCatalogCandidates = sqliteTable(
  "scenario_catalog_candidates",
  {
    id: text("id").primaryKey(),
    revision: text("revision").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    scenarioId: text("scenario_id").notNull(),
    buildId: text("build_id").notNull(),
    manifestJson: jsonText<ScenarioManifestV5>("manifest_json").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [index("scenario_catalog_candidates_revision_idx").on(table.revision)],
);

export const scenarioCatalogSnapshots = sqliteTable(
  "scenario_catalog_snapshots",
  {
    id: text("id").primaryKey(),
    revision: text("revision").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    snapshotJson: jsonText<Record<string, unknown>>("snapshot_json").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [index("scenario_catalog_snapshots_created_idx").on(table.createdAt)],
);

export const vmScenarioVms = sqliteTable(
  "vm_scenario_vms",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => vmScenarios.scenarioId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    vmName: text("vm_name").notNull(),
    image: text("image").notNull(),
    imageKeyJson: jsonText<ImageKey>("image_key_json"),
    imageSha256: text("image_sha256"),
    imageFormat: text("image_format").notNull(),
    imageVirtualSizeBytes: integer("image_virtual_size_bytes").notNull(),
    chunkManifestSha256: text("chunk_manifest_sha256"),
    guestBootstrapAbi: integer("guest_bootstrap_abi"),
    kernelSha256: text("kernel_sha256").notNull(),
    initrdSha256: text("initrd_sha256").notNull(),
    bootCmdline: text("boot_cmdline").notNull(),
    cpuMillis: integer("cpu_millis").default(1_000).notNull(),
    memoryMib: integer("memory_mib").notNull(),
    diskMib: integer("disk_mib").notNull(),
  },
  (table) => [
    uniqueIndex("vm_scenario_vms_scenario_ordinal_uidx").on(
      table.scenarioId,
      table.ordinal,
    ),
    uniqueIndex("vm_scenario_vms_scenario_name_uidx").on(
      table.scenarioId,
      table.vmName,
    ),
    index("vm_scenario_vms_scenario_idx").on(table.scenarioId, table.ordinal),
  ],
);

export const vmScenarioProbes = sqliteTable(
  "vm_scenario_probes",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => vmScenarios.scenarioId, { onDelete: "cascade" }),
    scenarioVmId: text("scenario_vm_id")
      .notNull()
      .references(() => vmScenarioVms.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    title: text("title"),
    bodyMarkdown: text("body_markdown"),
    hintsJson: jsonText<ScenarioHintManifestV3[]>("hints_json").notNull(),
    phase: text("phase").default("scenario").notNull(),
    // Probe kind from the manifest (file_exists, port_open, service, …) —
    // drives the per-kind "why is this failing" rendering on the run page.
    kind: text("kind").default("probe").notNull(),
  },
  (table) => [
    uniqueIndex("vm_scenario_probes_vm_ordinal_uidx").on(
      table.scenarioVmId,
      table.ordinal,
    ),
    index("vm_scenario_probes_scenario_idx").on(
      table.scenarioId,
      table.scenarioVmId,
      table.ordinal,
    ),
  ],
);
