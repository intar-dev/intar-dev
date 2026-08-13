import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  BuildPhase,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type { ImageArchitecture } from "@/generated/catalog";
import { organization, user } from "./core";
import {
  type AgentHostRole,
  type HostCpuReservationQuotaPhase,
  type HostCpuReservationState,
  type ImageBuildBundleMeta,
  type ImageBuildStatus,
  type ImageBuildTimings,
  jsonText,
  nowMsDefault,
} from "./shared";

export const agentHosts = sqliteTable(
  "agent_hosts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    role: text("role").$type<AgentHostRole>().default("agent").notNull(),
    scenarioEnabled: integer("scenario_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    disabled: integer("disabled", { mode: "boolean" }).default(false).notNull(),
    connected: integer("connected", { mode: "boolean" })
      .default(false)
      .notNull(),
    connectedAt: integer("connected_at"),
    disconnectedAt: integer("disconnected_at"),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    lastInventoryAt: integer("last_inventory_at"),
    activeSessionId: text("active_session_id"),
    lastClientHelloAt: integer("last_client_hello_at"),
    lastServerHelloAt: integer("last_server_hello_at"),
    agentVersion: text("agent_version"),
    inventoryJson: text("inventory_json"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("agent_hosts_user_idx").on(table.userId),
    index("agent_hosts_organization_idx").on(
      table.organizationId,
      table.role,
      table.connected,
    ),
    index("agent_hosts_role_idx").on(table.role, table.connected),
    index("agent_hosts_connected_idx").on(table.connected, table.updatedAt),
  ],
);

export const imageBuildBundles = sqliteTable(
  "image_build_bundles",
  {
    rev: text("rev").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    r2Key: text("r2_key").notNull(),
    kinoVersion: text("kino_version").notNull(),
    metaJson: jsonText<ImageBuildBundleMeta>("meta_json").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("image_build_bundles_organization_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
  ],
);

export const imageBuilds = sqliteTable(
  "image_builds",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    scenarioId: text("scenario_id").notNull(),
    arch: text("arch").$type<ImageArchitecture>().notNull(),
    rev: text("rev")
      .notNull()
      .references(() => imageBuildBundles.rev, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    kinoVersion: text("kino_version").notNull(),
    hostId: text("host_id").references(() => agentHosts.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .$type<ImageBuildStatus>()
      .default("queued")
      .notNull(),
    phase: text("phase").$type<BuildPhase>().default("queued").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    error: text("error"),
    logR2Key: text("log_r2_key"),
    timingsJson: jsonText<ImageBuildTimings>("timings_json")
      .default({})
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("image_builds_scenario_arch_hash_uidx").on(
      table.scenarioId,
      table.arch,
      table.contentHash,
    ),
    index("image_builds_status_idx").on(table.status, table.updatedAt),
    index("image_builds_organization_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    index("image_builds_host_idx").on(table.hostId, table.status),
    index("image_builds_rev_idx").on(table.rev),
  ],
);

export const imageBuildCoordinationLocks = sqliteTable(
  "image_build_coordination_locks",
  {
    key: text("key").primaryKey(),
    ownerToken: text("owner_token").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("image_build_coordination_locks_expiry_idx").on(table.expiresAt),
  ],
);

export const hostDesiredState = sqliteTable(
  "host_desired_state",
  {
    hostId: text("host_id")
      .primaryKey()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    docJson: jsonText<HostDesiredStateV2>("doc_json").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [index("host_desired_state_version_idx").on(table.version)],
);

export const hostActualState = sqliteTable(
  "host_actual_state",
  {
    hostId: text("host_id")
      .primaryKey()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    appliedDesiredVersion: integer("applied_desired_version").notNull(),
    observedAt: integer("observed_at").notNull(),
    reportJson: jsonText<HostStateReportV2>("report_json").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("host_actual_state_applied_version_idx").on(
      table.appliedDesiredVersion,
    ),
    index("host_actual_state_observed_idx").on(table.observedAt),
  ],
);

export const hostCpuReservations = sqliteTable(
  "host_cpu_reservations",
  {
    runId: text("run_id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    cpuMillis: integer("cpu_millis").notNull(),
    steadyCpuMillis: integer("steady_cpu_millis").notNull(),
    bootCpuMillis: integer("boot_cpu_millis").notNull(),
    quotaPhase: text("quota_phase")
      .$type<HostCpuReservationQuotaPhase>()
      .notNull(),
    state: text("state").$type<HostCpuReservationState>().notNull(),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    check("host_cpu_reservations_cpu_positive", sql`${table.cpuMillis} > 0`),
    check(
      "host_cpu_reservations_quota_positive",
      sql`${table.steadyCpuMillis} > 0 AND ${table.bootCpuMillis} >= ${table.steadyCpuMillis}`,
    ),
    check(
      "host_cpu_reservations_quota_phase_valid",
      sql`${table.quotaPhase} in ('boot', 'steady')`,
    ),
    check(
      "host_cpu_reservations_current_quota_valid",
      sql`(${table.quotaPhase} = 'boot' AND ${table.cpuMillis} = ${table.bootCpuMillis}) OR (${table.quotaPhase} = 'steady' AND ${table.cpuMillis} = ${table.steadyCpuMillis})`,
    ),
    check(
      "host_cpu_reservations_state_valid",
      sql`${table.state} in ('pending', 'committed')`,
    ),
    index("host_cpu_reservations_host_state_idx").on(table.hostId, table.state),
    index("host_cpu_reservations_pending_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
  ],
);

export const agentBootstrapTokens = sqliteTable(
  "agent_bootstrap_tokens",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("agent_bootstrap_tokens_host_idx").on(table.hostId),
    index("agent_bootstrap_tokens_hash_idx").on(table.tokenHash),
  ],
);
