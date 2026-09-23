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
import type {
  ImageArchitecture,
  ScenarioManifestV5,
} from "@/generated/catalog";
import { organization, user } from "./core";
import {
  type AgentHostRole,
  type HostCpuReservationState,
  type ImageBuildBundleMeta,
  type ImageBuildStatus,
  type ImageBuildTimings,
  type ImageRegistryEnforcementMode,
  type ImageRegistryGateState,
  type ImageRegistryGcRunState,
  type ImageRegistryOperationKind,
  type ImageRegistrySessionOwnerKind,
  type ImageRegistrySessionState,
  type ImageRegistryWriterOutcome,
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
    name: text("name").notNull(),
    scope: text("scope").$type<"personal" | "platform" | "organization">(),
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "restrict" }),
    ownerRemovalId: text("owner_removal_id"),
    ownerRemovalCompletedAt: integer("owner_removal_completed_at"),
    credentialGeneration: integer("credential_generation").default(0).notNull(),
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
    check("agent_hosts_scope_valid", sql`"scope" is null OR "scope" in ('personal', 'platform', 'organization')`),
    check("agent_hosts_personal_role_valid", sql`"scope" is null OR "scope" not in ('personal', 'organization') OR "role" = 'agent'`),
    check("agent_hosts_organization_valid", sql`("scope" is 'organization' AND "organization_id" is not null) OR ("scope" is not 'organization' AND "organization_id" is null)`),
    index("agent_hosts_organization_idx").on(table.organizationId),
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
    catalogChannel: text("catalog_channel")
      .$type<"candidate" | "live">()
      .default("live")
      .notNull(),
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
    publishedManifestJson: jsonText<ScenarioManifestV5>(
      "published_manifest_json",
    ),
    /**
     * Set when the catalog policy retires this build's objects. A build whose
     * artifacts are retired is no longer a reason to keep its R2 objects.
     */
    artifactsRetiredAt: integer("artifacts_retired_at"),
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

export const runtimeOperationGates = sqliteTable("runtime_operation_gates", {
  key: text("key").primaryKey(),
  state: text("state").$type<"open" | "drained">().notNull(),
  evidenceJson: text("evidence_json"),
  updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
});

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
    state: text("state").$type<HostCpuReservationState>().notNull(),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    check("host_cpu_reservations_cpu_positive", sql`"cpu_millis" > 0`),
    check(
      "host_cpu_reservations_state_valid",
      sql`"state" in ('pending', 'committed')`,
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
    credentialGeneration: integer("credential_generation").default(0).notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("agent_bootstrap_tokens_host_idx").on(table.hostId),
    index("agent_bootstrap_tokens_hash_idx").on(table.tokenHash),
  ],
);

export const hostEnrollments = sqliteTable("host_enrollments", {
  tokenHash: text("token_hash").primaryKey(),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  hostId: text("host_id").notNull().unique(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  scope: text("scope").$type<"personal" | "platform" | "organization">().notNull(),
  role: text("role").$type<AgentHostRole>().notNull(),
  expiresAt: integer("expires_at").notNull(),
  claimedAt: integer("claimed_at"),
  credentialHash: text("credential_hash"),
  revokedAt: integer("revoked_at"),
}, (table) => [
  index("host_enrollments_organization_idx").on(table.organizationId),
  check("host_enrollments_scope_valid", sql`"scope" in ('personal', 'platform', 'organization')`),
  check("host_enrollments_user_managed_role_valid", sql`"scope" = 'platform' OR "role" = 'agent'`),
  check("host_enrollments_organization_valid", sql`("scope" = 'organization' AND "organization_id" is not null) OR ("scope" <> 'organization' AND "organization_id" is null)`),
]);

/**
 * Single gate row for the image registry. Shared writers (uploads, publishes,
 * catalog pointer mutations) and one exclusive collector sweep cannot overlap.
 * The epoch moves every time a sweep starts, so a request that was already in
 * flight when the sweep began is rejected instead of continuing.
 */
export const imageRegistryAdmission = sqliteTable("image_registry_admission", {
  key: text("key").primaryKey(),
  protocolVersion: integer("protocol_version").notNull(),
  enforcement: text("enforcement")
    .$type<ImageRegistryEnforcementMode>()
    .default("report_only")
    .notNull(),
  epoch: integer("epoch").default(0).notNull(),
  state: text("state").$type<ImageRegistryGateState>().default("open").notNull(),
  sweepToken: text("sweep_token"),
  sweepOwner: text("sweep_owner"),
  sweepStartedAt: integer("sweep_started_at"),
  sweepHeartbeatAt: integer("sweep_heartbeat_at"),
  sweepExpiresAt: integer("sweep_expires_at"),
  pauseReason: text("pause_reason"),
  pausedAt: integer("paused_at"),
  updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
});

/**
 * Upload session: the protection window that starts at the first
 * `image-chunks/exists` probe and ends when the uploader publishes or gives up.
 * An open session blocks a destructive sweep until it is completed, abandoned
 * or deliberately reaped by an operator.
 */
export const imageRegistryUploadSessions = sqliteTable(
  "image_registry_upload_sessions",
  {
    id: text("id").primaryKey(),
    ownerKind: text("owner_kind")
      .$type<ImageRegistrySessionOwnerKind>()
      .notNull(),
    ownerId: text("owner_id").notNull(),
    intent: text("intent"),
    epoch: integer("epoch").notNull(),
    state: text("state")
      .$type<ImageRegistrySessionState>()
      .default("open")
      .notNull(),
    createdAt: integer("created_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
  },
  (table) => [
    index("image_registry_upload_sessions_state_idx").on(
      table.state,
      table.expiresAt,
    ),
    index("image_registry_upload_sessions_owner_idx").on(
      table.ownerKind,
      table.ownerId,
      table.state,
    ),
  ],
);

/**
 * One row per admitted registry operation. A row that is never released cannot
 * be resolved by a timeout: it blocks the destructive sweep until an operator
 * reaps it, so an interrupted write can never be silently ignored.
 */
export const imageRegistryOperationWriters = sqliteTable(
  "image_registry_operation_writers",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(
      () => imageRegistryUploadSessions.id,
      { onDelete: "set null" },
    ),
    ownerKind: text("owner_kind")
      // A writer row is either a credential holder (the same kinds an upload
      // session uses) or the trusted `system` identity of an internal
      // parent-Worker window such as a learner run start.
      .$type<ImageRegistrySessionOwnerKind | "system">()
      .notNull(),
    ownerId: text("owner_id").notNull(),
    operation: text("operation").$type<ImageRegistryOperationKind>().notNull(),
    epoch: integer("epoch").notNull(),
    outcome: text("outcome")
      .$type<ImageRegistryWriterOutcome>()
      .default("pending")
      .notNull(),
    createdAt: integer("created_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    releasedAt: integer("released_at"),
  },
  (table) => [
    index("image_registry_operation_writers_open_idx").on(
      table.releasedAt,
      table.expiresAt,
    ),
    index("image_registry_operation_writers_session_idx").on(table.sessionId),
    index("image_registry_operation_writers_operation_idx").on(
      table.operation,
      table.createdAt,
    ),
  ],
);

/**
 * Collector run progress. Exactly one run is `running` per active sweep; the
 * counters only move forward so a retried progress report cannot lose work.
 */
export const imageRegistryGcRuns = sqliteTable(
  "image_registry_gc_runs",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    sweepToken: text("sweep_token").notNull(),
    state: text("state").$type<ImageRegistryGcRunState>().default("running").notNull(),
    startedAt: integer("started_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    finishedAt: integer("finished_at"),
    scannedObjects: integer("scanned_objects").default(0).notNull(),
    deletedObjects: integer("deleted_objects").default(0).notNull(),
    blockedObjects: integer("blocked_objects").default(0).notNull(),
    bytesReclaimed: integer("bytes_reclaimed").default(0).notNull(),
    error: text("error"),
    detailJson: jsonText<Record<string, unknown>>("detail_json"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("image_registry_gc_runs_sweep_uidx").on(table.sweepToken),
    index("image_registry_gc_runs_state_idx").on(table.state, table.startedAt),
  ],
);
