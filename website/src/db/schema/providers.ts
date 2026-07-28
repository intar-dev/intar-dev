import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./core";
import { runtimeArtifacts, runtimeExecutions } from "./runtime";
import { jsonText, nowMsDefault } from "./shared";
import { workshopSessions, workshopTemplateRevisions } from "./workshops";

export type RuntimeProviderKind = "agent_kvm" | "hetzner_cloud";
export type ProviderConnectionState =
  | "active"
  | "rotation_required"
  | "cleanup_pending"
  | "disconnected";
export type HetznerAllocationState =
  | "pending"
  | "creating"
  | "bootstrapping"
  | "ready"
  | "degraded"
  | "rebooting"
  | "draining"
  | "deleting"
  | "deleted"
  | "cleanup_pending"
  | "failed";

export interface ProviderHardwareShape {
  architecture: "x86";
  cores: number;
  memoryMib: number;
  diskMib: number;
}

export interface ProviderPriceObservation {
  currency: string;
  observedAt: number;
  expiresAt: number;
  serverType: string;
  locations: Array<{
    location: string;
    available: boolean;
    serverHourlyNet: string;
    serverHourlyGross: string;
    serverMonthlyNet?: string;
    serverMonthlyGross?: string;
    ipv4HourlyNet: string;
    ipv4HourlyGross: string;
    ipv4MonthlyNet?: string;
    ipv4MonthlyGross?: string;
  }>;
}

export interface WorkshopCostScenarioJson {
  lifetimeSeconds: number;
  billableHours: number;
  generationBillableHours: number[];
  location: string;
  participantCount: number;
  serverNetMicrosPerLearner: number;
  serverGrossMicrosPerLearner: number;
  ipv4NetMicrosPerLearner: number;
  ipv4GrossMicrosPerLearner: number;
  totalNetMicros: number;
  totalGrossMicros: number;
}

export const organizationProviderConnections = sqliteTable(
  "organization_provider_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    providerKind: text("provider_kind").$type<"hetzner_cloud">().notNull(),
    displayName: text("display_name").notNull(),
    state: text("state")
      .$type<ProviderConnectionState>()
      .default("active")
      .notNull(),
    projectFingerprint: text("project_fingerprint").notNull(),
    sentinelFirewallId: text("sentinel_firewall_id").notNull(),
    activeCredentialVersionId: text("active_credential_version_id"),
    approvedLocationsJson: jsonText<string[]>("approved_locations_json")
      .default(["nbg1", "fsn1", "hel1"])
      .notNull(),
    maxConcurrentServers: integer("max_concurrent_servers")
      .default(5)
      .notNull(),
    maxSessionGrossMicros: integer("max_session_gross_micros"),
    currency: text("currency").notNull(),
    ipv4Enabled: integer("ipv4_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    lastValidatedAt: integer("last_validated_at").notNull(),
    cleanupAcknowledgedAt: integer("cleanup_acknowledged_at"),
    cleanupAcknowledgedBy: text("cleanup_acknowledged_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("organization_provider_connections_org_provider_uidx").on(
      table.organizationId,
      table.providerKind,
    ),
    index("organization_provider_connections_state_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "organization_provider_connections_kind_valid",
      sql`${table.providerKind} = 'hetzner_cloud'`,
    ),
    check(
      "organization_provider_connections_state_valid",
      sql`${table.state} in ('active', 'rotation_required', 'cleanup_pending', 'disconnected')`,
    ),
    check(
      "organization_provider_connections_locations_json_valid",
      sql`json_valid(${table.approvedLocationsJson})`,
    ),
    check(
      "organization_provider_connections_server_limit_valid",
      sql`${table.maxConcurrentServers} > 0`,
    ),
    check(
      "organization_provider_connections_cost_limit_valid",
      sql`${table.maxSessionGrossMicros} is null OR ${table.maxSessionGrossMicros} >= 0`,
    ),
  ],
);

export const providerCredentialVersions = sqliteTable(
  "provider_credential_versions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => organizationProviderConnections.id, {
        onDelete: "restrict",
      }),
    version: integer("version").notNull(),
    algorithm: text("algorithm").notNull(),
    kekVersion: text("kek_version").notNull(),
    aadSha256: text("aad_sha256").notNull(),
    encryptedTokenB64: text("encrypted_token_b64").notNull(),
    tokenIvB64: text("token_iv_b64").notNull(),
    wrappedDekB64: text("wrapped_dek_b64").notNull(),
    dekIvB64: text("dek_iv_b64").notNull(),
    envelopeCreatedAt: integer("envelope_created_at").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    activatedAt: integer("activated_at").notNull(),
    supersededAt: integer("superseded_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("provider_credential_versions_connection_version_uidx").on(
      table.connectionId,
      table.version,
    ),
    uniqueIndex("provider_credential_versions_token_fingerprint_uidx").on(
      table.connectionId,
      table.tokenFingerprint,
    ),
    check(
      "provider_credential_versions_version_positive",
      sql`${table.version} > 0 AND ${table.algorithm} = 'AES-256-GCM' AND length(${table.kekVersion}) > 0`,
    ),
  ],
);

export const providerAuditEvents = sqliteTable(
  "provider_audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").references(
      () => organizationProviderConnections.id,
      { onDelete: "restrict" },
    ),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    type: text("type").notNull(),
    payloadJson: jsonText<Record<string, unknown>>("payload_json")
      .default({})
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("provider_audit_events_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("provider_audit_events_connection_created_idx").on(
      table.connectionId,
      table.createdAt,
    ),
    check(
      "provider_audit_events_payload_json_valid",
      sql`json_valid(${table.payloadJson})`,
    ),
  ],
);

export const workshopSessionRuntimeProviders = sqliteTable(
  "workshop_session_runtime_providers",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    providerKind: text("provider_kind")
      .$type<RuntimeProviderKind>()
      .default("agent_kvm")
      .notNull(),
    connectionId: text("connection_id").references(
      () => organizationProviderConnections.id,
      { onDelete: "restrict" },
    ),
    serverType: text("server_type"),
    hardwareJson: jsonText<ProviderHardwareShape>("hardware_json"),
    permittedLocationsJson: jsonText<string[]>("permitted_locations_json")
      .default([])
      .notNull(),
    initialPriceObservationJson: jsonText<ProviderPriceObservation>(
      "initial_price_observation_json",
    ),
    grossCeilingOverrideAt: integer("gross_ceiling_override_at"),
    grossCeilingOverrideBy: text("gross_ceiling_override_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("workshop_session_runtime_providers_connection_idx").on(
      table.connectionId,
      table.providerKind,
    ),
    check(
      "workshop_session_runtime_providers_kind_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud')`,
    ),
    check(
      "workshop_session_runtime_providers_shape_valid",
      sql`(${table.providerKind} = 'agent_kvm' AND ${table.connectionId} is null AND ${table.serverType} is null AND ${table.hardwareJson} is null) OR (${table.providerKind} = 'hetzner_cloud' AND ${table.connectionId} is not null AND ${table.serverType} is not null AND json_valid(${table.hardwareJson}))`,
    ),
    check(
      "workshop_session_runtime_providers_locations_json_valid",
      sql`json_valid(${table.permittedLocationsJson})`,
    ),
  ],
);

export const runtimeProviderCheckpointArtifacts = sqliteTable(
  "runtime_provider_checkpoint_artifacts",
  {
    id: text("id").primaryKey(),
    templateRevisionId: text("template_revision_id")
      .notNull()
      .references(() => workshopTemplateRevisions.id, {
        onDelete: "cascade",
      }),
    checkpointId: text("checkpoint_id").notNull(),
    providerKind: text("provider_kind").$type<"hetzner_cloud">().notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    compression: text("compression")
      .$type<"none" | "gzip" | "zstd">()
      .default("zstd")
      .notNull(),
    signatureB64: text("signature_b64").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    workspaceAgentSha256: text("workspace_agent_sha256"),
    kinoSha256: text("kino_sha256"),
    status: text("status").$type<"pending" | "verified">().notNull(),
    coldBootVerifiedAt: integer("cold_boot_verified_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_checkpoint_revision_checkpoint_uidx").on(
      table.templateRevisionId,
      table.checkpointId,
      table.providerKind,
    ),
    check(
      "runtime_provider_checkpoint_kind_valid",
      sql`${table.providerKind} = 'hetzner_cloud'`,
    ),
    check(
      "runtime_provider_checkpoint_status_valid",
      sql`${table.status} in ('pending', 'verified')`,
    ),
    check(
      "runtime_provider_checkpoint_payload_valid",
      sql`${table.sizeBytes} > 0 AND length(${table.sha256}) = 64 AND ${table.compression} in ('none', 'gzip', 'zstd')`,
    ),
    check(
      "runtime_provider_checkpoint_guest_tools_valid",
      sql`length(${table.workspaceAgentSha256}) = 64 AND ${table.workspaceAgentSha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.kinoSha256}) = 64 AND ${table.kinoSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

/**
 * One row is the complete guest credential boundary for one immutable runtime
 * generation. Only digests of capabilities are persisted. The plaintext
 * bootstrap/report/download values exist only in the issue/exchange response.
 */
export const runtimeProviderGuestCredentials = sqliteTable(
  "runtime_provider_guest_credentials",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    generation: integer("generation").notNull(),
    controlPlaneBaseUrl: text("control_plane_base_url").notNull(),
    bootstrapTokenHash: text("bootstrap_token_hash").notNull(),
    bootstrapExpiresAt: integer("bootstrap_expires_at").notNull(),
    bootstrapConsumedAt: integer("bootstrap_consumed_at"),
    reportCredentialHash: text("report_credential_hash"),
    reportCredentialIssuedAt: integer("report_credential_issued_at"),
    reportCredentialExpiresAt: integer(
      "report_credential_expires_at",
    ).notNull(),
    reportCredentialRevokedAt: integer("report_credential_revoked_at"),
    checkpointArtifactId: text("checkpoint_artifact_id")
      .notNull()
      .references(() => runtimeProviderCheckpointArtifacts.id, {
        onDelete: "restrict",
      }),
    checkpointDownloadTokenHash: text("checkpoint_download_token_hash"),
    checkpointDownloadExpiresAt: integer("checkpoint_download_expires_at"),
    checkpointFirstDownloadedAt: integer("checkpoint_first_downloaded_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_guest_credentials_execution_uidx").on(
      table.executionId,
    ),
    uniqueIndex("runtime_provider_guest_credentials_bootstrap_hash_uidx").on(
      table.bootstrapTokenHash,
    ),
    uniqueIndex("runtime_provider_guest_credentials_report_hash_uidx").on(
      table.reportCredentialHash,
    ),
    uniqueIndex("runtime_provider_guest_credentials_checkpoint_hash_uidx").on(
      table.checkpointDownloadTokenHash,
    ),
    index("runtime_provider_guest_credentials_report_expiry_idx").on(
      table.reportCredentialExpiresAt,
      table.reportCredentialRevokedAt,
    ),
    check(
      "runtime_provider_guest_credentials_generation_valid",
      sql`${table.generation} > 0`,
    ),
    check(
      "runtime_provider_guest_credentials_lifecycle_valid",
      sql`(${table.bootstrapConsumedAt} is null AND ${table.reportCredentialHash} is null AND ${table.reportCredentialIssuedAt} is null AND ${table.checkpointDownloadTokenHash} is null AND ${table.checkpointDownloadExpiresAt} is null) OR (${table.bootstrapConsumedAt} is not null AND ${table.reportCredentialHash} is not null AND ${table.reportCredentialIssuedAt} is not null AND ${table.checkpointDownloadTokenHash} is not null AND ${table.checkpointDownloadExpiresAt} is not null)`,
    ),
  ],
);

export const runtimeProviderArtifactUploadGrants = sqliteTable(
  "runtime_provider_artifact_upload_grants",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => runtimeArtifacts.id, { onDelete: "cascade" }),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_artifact_upload_grants_token_hash_uidx").on(
      table.tokenHash,
    ),
    index("runtime_provider_artifact_upload_grants_execution_expiry_idx").on(
      table.executionId,
      table.expiresAt,
    ),
    check(
      "runtime_provider_artifact_upload_grants_generation_valid",
      sql`${table.generation} > 0`,
    ),
  ],
);

export const hetznerAllocations = sqliteTable(
  "hetzner_allocations",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "restrict" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => organizationProviderConnections.id, {
        onDelete: "restrict",
      }),
    deterministicName: text("deterministic_name").notNull(),
    serverId: text("server_id"),
    primaryIpId: text("primary_ip_id"),
    primaryIpv4: text("primary_ipv4"),
    sshKeyId: text("ssh_key_id"),
    createActionId: text("create_action_id"),
    deleteActionId: text("delete_action_id"),
    serverType: text("server_type").notNull(),
    systemImage: text("system_image").notNull(),
    location: text("location").notNull(),
    state: text("state")
      .$type<HetznerAllocationState>()
      .default("pending")
      .notNull(),
    provisioningAttemptId: text("provisioning_attempt_id"),
    provisioningHeartbeatAt: integer("provisioning_heartbeat_at"),
    retryCount: integer("retry_count").default(0).notNull(),
    lastReportSequence: integer("last_report_sequence").default(0).notNull(),
    lastReportAt: integer("last_report_at"),
    lastErrorCode: text("last_error_code"),
    recordingDrainRequestedAt: integer("recording_drain_requested_at"),
    recordingDrainCompletedAt: integer("recording_drain_completed_at"),
    deletionRequestedAt: integer("deletion_requested_at"),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("hetzner_allocations_execution_uidx").on(table.executionId),
    uniqueIndex("hetzner_allocations_connection_name_uidx").on(
      table.connectionId,
      table.deterministicName,
    ),
    index("hetzner_allocations_state_updated_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "hetzner_allocations_state_valid",
      sql`${table.state} in ('pending', 'creating', 'bootstrapping', 'ready', 'degraded', 'rebooting', 'draining', 'deleting', 'deleted', 'cleanup_pending', 'failed')`,
    ),
    check(
      "hetzner_allocations_recording_drain_valid",
      sql`${table.recordingDrainCompletedAt} is null OR (${table.recordingDrainRequestedAt} is not null AND ${table.recordingDrainCompletedAt} >= ${table.recordingDrainRequestedAt})`,
    ),
    check(
      "hetzner_allocations_retry_valid",
      sql`${table.retryCount} >= 0 AND ${table.lastReportSequence} >= 0`,
    ),
  ],
);

export const runtimeProviderActualState = sqliteTable(
  "runtime_provider_actual_state",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    sourceId: text("source_id").notNull(),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    phase: text("phase").notNull(),
    health: text("health").notNull(),
    terminalReady: integer("terminal_ready", { mode: "boolean" })
      .default(false)
      .notNull(),
    sshHostKeysJson: jsonText<string[]>("ssh_host_keys_json")
      .default([])
      .notNull(),
    probesJson: jsonText<Array<Record<string, unknown>>>("probes_json")
      .default([])
      .notNull(),
    reportJson: jsonText<Record<string, unknown>>("report_json").notNull(),
    reportedAt: integer("reported_at").notNull(),
    observedAt: integer("observed_at").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_provider_actual_state_source_observed_idx").on(
      table.providerKind,
      table.sourceId,
      table.observedAt,
    ),
    check(
      "runtime_provider_actual_state_kind_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud')`,
    ),
    check(
      "runtime_provider_actual_state_sequence_valid",
      sql`${table.generation} > 0 AND ${table.sequence} >= 0`,
    ),
    check(
      "runtime_provider_actual_state_phase_health_valid",
      sql`${table.phase} in ('bootstrapping', 'applying_checkpoint', 'starting_services', 'ready', 'degraded', 'failed') AND ${table.health} in ('unknown', 'healthy', 'degraded', 'failed')`,
    ),
    check(
      "runtime_provider_actual_state_report_json_valid",
      sql`json_valid(${table.reportJson}) AND json_valid(${table.sshHostKeysJson}) AND json_valid(${table.probesJson})`,
    ),
  ],
);

export const workshopSessionCostForecasts = sqliteTable(
  "workshop_session_cost_forecasts",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => organizationProviderConnections.id, {
        onDelete: "restrict",
      }),
    currency: text("currency").notNull(),
    participantCount: integer("participant_count").notNull(),
    preferredLocation: text("preferred_location").notNull(),
    trigger: text("trigger").notNull(),
    priceObservationJson: jsonText<ProviderPriceObservation>(
      "price_observation_json",
    ).notNull(),
    expectedJson: jsonText<WorkshopCostScenarioJson>("expected_json").notNull(),
    leaseCeilingJson:
      jsonText<WorkshopCostScenarioJson>("lease_ceiling_json").notNull(),
    oneRestoreJson:
      jsonText<WorkshopCostScenarioJson>("one_restore_json").notNull(),
    expectedNetMicros: integer("expected_net_micros").notNull(),
    expectedGrossMicros: integer("expected_gross_micros").notNull(),
    leaseCeilingNetMicros: integer("lease_ceiling_net_micros").notNull(),
    leaseCeilingGrossMicros: integer("lease_ceiling_gross_micros").notNull(),
    oneRestoreNetMicros: integer("one_restore_net_micros").notNull(),
    oneRestoreGrossMicros: integer("one_restore_gross_micros").notNull(),
    exceedsGrossCeiling: integer("exceeds_gross_ceiling", { mode: "boolean" })
      .default(false)
      .notNull(),
    assumptionsJson: jsonText<string[]>("assumptions_json").notNull(),
    exclusionsJson: jsonText<string[]>("exclusions_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_session_cost_forecasts_version_uidx").on(
      table.sessionId,
      table.version,
    ),
    index("workshop_session_cost_forecasts_expiry_idx").on(
      table.sessionId,
      table.expiresAt,
    ),
    check(
      "workshop_session_cost_forecasts_values_valid",
      sql`${table.version} > 0 AND ${table.participantCount} >= 0 AND ${table.expectedNetMicros} >= 0 AND ${table.expectedGrossMicros} >= 0 AND ${table.leaseCeilingNetMicros} >= 0 AND ${table.leaseCeilingGrossMicros} >= 0 AND ${table.oneRestoreNetMicros} >= 0 AND ${table.oneRestoreGrossMicros} >= 0`,
    ),
  ],
);

export const runtimeProviderCostLedger = sqliteTable(
  "runtime_provider_cost_ledger",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "restrict" }),
    allocationId: text("allocation_id")
      .notNull()
      .references(() => hetznerAllocations.id, { onDelete: "restrict" }),
    forecastId: text("forecast_id").references(
      () => workshopSessionCostForecasts.id,
      { onDelete: "restrict" },
    ),
    providerResourceId: text("provider_resource_id").notNull(),
    resourceKind: text("resource_kind")
      .$type<"server" | "primary_ipv4">()
      .notNull(),
    resourceType: text("resource_type").notNull(),
    location: text("location").notNull(),
    currency: text("currency").notNull(),
    hourlyNetRaw: text("hourly_net_raw").notNull(),
    hourlyGrossRaw: text("hourly_gross_raw").notNull(),
    hourlyNetMicros: integer("hourly_net_micros").notNull(),
    hourlyGrossMicros: integer("hourly_gross_micros").notNull(),
    monthlyNetRaw: text("monthly_net_raw"),
    monthlyGrossRaw: text("monthly_gross_raw"),
    monthlyNetMicros: integer("monthly_net_micros"),
    monthlyGrossMicros: integer("monthly_gross_micros"),
    providerCreatedAt: integer("provider_created_at").notNull(),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_cost_ledger_resource_uidx").on(
      table.allocationId,
      table.resourceKind,
      table.providerResourceId,
    ),
    index("runtime_provider_cost_ledger_execution_idx").on(
      table.executionId,
      table.providerCreatedAt,
    ),
    check(
      "runtime_provider_cost_ledger_kind_valid",
      sql`${table.resourceKind} in ('server', 'primary_ipv4')`,
    ),
    check(
      "runtime_provider_cost_ledger_values_valid",
      sql`${table.hourlyNetMicros} >= 0 AND ${table.hourlyGrossMicros} >= 0 AND (${table.monthlyNetMicros} is null OR ${table.monthlyNetMicros} >= 0) AND (${table.monthlyGrossMicros} is null OR ${table.monthlyGrossMicros} >= 0)`,
    ),
  ],
);

export const workshopSessionCostSummaries = sqliteTable(
  "workshop_session_cost_summaries",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    finalNetMicros: integer("final_net_micros"),
    finalGrossMicros: integer("final_gross_micros"),
    forecastNetVarianceMicros: integer("forecast_net_variance_micros"),
    forecastGrossVarianceMicros: integer("forecast_gross_variance_micros"),
    generationCount: integer("generation_count").default(0).notNull(),
    restoreCount: integer("restore_count").default(0).notNull(),
    cleanupPendingCount: integer("cleanup_pending_count").default(0).notNull(),
    manualCleanupUnverified: integer("manual_cleanup_unverified", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    finalizedAt: integer("finalized_at"),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    check(
      "workshop_session_cost_summaries_counts_valid",
      sql`${table.generationCount} >= 0 AND ${table.restoreCount} >= 0 AND ${table.cleanupPendingCount} >= 0`,
    ),
  ],
);
