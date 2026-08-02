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
  ProviderAllocationPhase,
  RuntimeHardwareShape,
  RuntimeProviderKind,
} from "@/lib/workshops/runtime-provider";
import { organization, user } from "./core";
import { runtimeArtifacts, runtimeExecutions } from "./runtime";
import { jsonText, nowMsDefault } from "./shared";
import {
  workshopSessions,
  workshopTemplateRevisions,
} from "./workshops";

export type DirectCloudProviderKind = Exclude<
  RuntimeProviderKind,
  "agent_kvm"
>;
export type ProviderConnectionState =
  | "validating"
  | "active"
  | "rotation_required"
  | "cleanup_pending"
  | "disconnected";
export type ProviderOperationState =
  | "pending"
  | "running"
  | "succeeded"
  | "retryable"
  | "failed";

export interface StoredResolvedRuntimeProfile {
  providerKind: RuntimeProviderKind;
  vmId: string;
  machineType: string | null;
  systemImage: string;
  resolvedImageId: string | null;
  rootDiskType: string | null;
  locations: string[];
  hardware: RuntimeHardwareShape;
  configuration: Record<string, unknown>;
}

/** One organization-owned identity; secret material lives only in versions. */
export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    providerKind: text("provider_kind")
      .$type<DirectCloudProviderKind>()
      .notNull(),
    displayName: text("display_name").notNull(),
    state: text("state")
      .$type<ProviderConnectionState>()
      .default("validating")
      .notNull(),
    externalProjectId: text("external_project_id").notNull(),
    projectFingerprint: text("project_fingerprint").notNull(),
    activeCredentialVersionId: text("active_credential_version_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    lastValidatedAt: integer("last_validated_at"),
    disconnectedAt: integer("disconnected_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("provider_connections_org_kind_project_uidx").on(
      table.organizationId,
      table.providerKind,
      table.externalProjectId,
    ),
    index("provider_connections_org_state_idx").on(
      table.organizationId,
      table.state,
      table.updatedAt,
    ),
    check(
      "provider_connections_kind_valid",
      sql`${table.providerKind} in ('hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "provider_connections_state_valid",
      sql`${table.state} in ('validating', 'active', 'rotation_required', 'cleanup_pending', 'disconnected')`,
    ),
  ],
);

export const providerCredentialVersions = sqliteTable(
  "provider_credential_versions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    algorithm: text("algorithm").$type<"AES-256-GCM">().notNull(),
    kekVersion: text("kek_version").notNull(),
    aadSha256: text("aad_sha256").notNull(),
    encryptedPayloadB64: text("encrypted_payload_b64").notNull(),
    payloadIvB64: text("payload_iv_b64").notNull(),
    wrappedDekB64: text("wrapped_dek_b64").notNull(),
    dekIvB64: text("dek_iv_b64").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
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
    uniqueIndex(
      "provider_credential_versions_connection_fingerprint_uidx",
    ).on(table.connectionId, table.credentialFingerprint),
    check(
      "provider_credential_versions_valid",
      sql`${table.version} > 0 AND ${table.algorithm} = 'AES-256-GCM' AND length(${table.kekVersion}) > 0 AND length(${table.aadSha256}) = 64`,
    ),
    check(
      "provider_credential_versions_lifecycle_valid",
      sql`${table.supersededAt} is null OR ${table.supersededAt} >= ${table.activatedAt}`,
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
      () => providerConnections.id,
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
      "provider_audit_events_payload_valid",
      sql`json_valid(${table.payloadJson})`,
    ),
  ],
);

export const hetznerConnectionDetails = sqliteTable(
  "hetzner_connection_details",
  {
    connectionId: text("connection_id")
      .primaryKey()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    sentinelFirewallId: text("sentinel_firewall_id").notNull(),
    approvedLocationsJson: jsonText<string[]>("approved_locations_json")
      .default(["nbg1", "fsn1", "hel1"])
      .notNull(),
    maxConcurrentAllocations: integer("max_concurrent_allocations")
      .default(5)
      .notNull(),
    maxSessionCostNanos: integer("max_session_cost_nanos"),
    nativeCurrency: text("native_currency").notNull(),
    ipv4Enabled: integer("ipv4_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    cleanupAcknowledgedAt: integer("cleanup_acknowledged_at"),
    cleanupAcknowledgedBy: text("cleanup_acknowledged_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    check(
      "hetzner_connection_details_locations_valid",
      sql`json_valid(${table.approvedLocationsJson})`,
    ),
    check(
      "hetzner_connection_details_limits_valid",
      sql`${table.maxConcurrentAllocations} > 0 AND (${table.maxSessionCostNanos} is null OR ${table.maxSessionCostNanos} >= 0)`,
    ),
    check(
      "hetzner_connection_details_ipv4_required",
      sql`${table.ipv4Enabled} = 1`,
    ),
  ],
);

export const gcpConnectionDetails = sqliteTable(
  "gcp_connection_details",
  {
    connectionId: text("connection_id")
      .primaryKey()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    projectNumber: text("project_number").notNull(),
    networkName: text("network_name").notNull(),
    networkSelfLink: text("network_self_link").notNull(),
    subnetName: text("subnet_name").notNull(),
    subnetSelfLink: text("subnet_self_link").notNull(),
    subnetCidr: text("subnet_cidr").notNull(),
    firewallName: text("firewall_name").notNull(),
    firewallSelfLink: text("firewall_self_link").notNull(),
    approvedZonesJson: jsonText<string[]>("approved_zones_json").notNull(),
    maxConcurrentAllocations: integer("max_concurrent_allocations")
      .default(5)
      .notNull(),
    maxSessionCostNanos: integer("max_session_cost_nanos"),
    cleanupAcknowledgedAt: integer("cleanup_acknowledged_at"),
    cleanupAcknowledgedBy: text("cleanup_acknowledged_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("gcp_connection_details_project_number_uidx").on(
      table.projectNumber,
    ),
    check(
      "gcp_connection_details_zones_valid",
      sql`json_valid(${table.approvedZonesJson})`,
    ),
    check(
      "gcp_connection_details_limits_valid",
      sql`${table.maxConcurrentAllocations} > 0 AND (${table.maxSessionCostNanos} is null OR ${table.maxSessionCostNanos} >= 0)`,
    ),
  ],
);

export const workshopRuntimeProfiles = sqliteTable(
  "workshop_runtime_profiles",
  {
    id: text("id").primaryKey(),
    templateRevisionId: text("template_revision_id")
      .notNull()
      .references(() => workshopTemplateRevisions.id, { onDelete: "cascade" }),
    profileId: text("profile_id").notNull(),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    vmId: text("vm_id").notNull(),
    machineType: text("machine_type"),
    systemImage: text("system_image").notNull(),
    resolvedImageId: text("resolved_image_id"),
    rootDiskType: text("root_disk_type"),
    architecture: text("architecture").$type<"x86_64">().notNull(),
    cpuMillis: integer("cpu_millis").notNull(),
    memoryMib: integer("memory_mib").notNull(),
    diskMib: integer("disk_mib").notNull(),
    locationsJson: jsonText<string[]>("locations_json").notNull(),
    configurationJson: jsonText<Record<string, unknown>>("configuration_json")
      .default({})
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_runtime_profiles_revision_profile_uidx").on(
      table.templateRevisionId,
      table.profileId,
    ),
    index("workshop_runtime_profiles_revision_provider_idx").on(
      table.templateRevisionId,
      table.providerKind,
    ),
    check(
      "workshop_runtime_profiles_provider_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "workshop_runtime_profiles_shape_valid",
      sql`${table.architecture} = 'x86_64' AND ${table.cpuMillis} > 0 AND ${table.memoryMib} > 0 AND ${table.diskMib} > 0`,
    ),
    check(
      "workshop_runtime_profiles_json_valid",
      sql`json_valid(${table.locationsJson}) AND json_valid(${table.configurationJson})`,
    ),
    check(
      "workshop_runtime_profiles_provider_fields_valid",
      sql`(${table.providerKind} = 'agent_kvm') OR (${table.machineType} is not null AND ${table.resolvedImageId} is not null)`,
    ),
  ],
);

export const workshopRuntimeProfileCertifications = sqliteTable(
  "workshop_runtime_profile_certifications",
  {
    id: text("id").primaryKey(),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => workshopRuntimeProfiles.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(
      () => providerConnections.id,
      { onDelete: "restrict" },
    ),
    state: text("state")
      .$type<"pending" | "verifying" | "verified" | "failed" | "cleanup_pending">()
      .default("pending")
      .notNull(),
    verifierAllocationId: text("verifier_allocation_id"),
    evidenceJson: jsonText<Record<string, unknown>>("evidence_json")
      .default({})
      .notNull(),
    errorCode: text("error_code"),
    startedAt: integer("started_at"),
    verifiedAt: integer("verified_at"),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_runtime_profile_certifications_profile_uidx").on(
      table.runtimeProfileId,
    ),
    index("workshop_runtime_profile_certifications_state_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "workshop_runtime_profile_certifications_state_valid",
      sql`${table.state} in ('pending', 'verifying', 'verified', 'failed', 'cleanup_pending')`,
    ),
    check(
      "workshop_runtime_profile_certifications_evidence_valid",
      sql`json_valid(${table.evidenceJson})`,
    ),
    check(
      "workshop_runtime_profile_certifications_verified_valid",
      sql`${table.state} != 'verified' OR (${table.verifiedAt} is not null AND ${table.deletionConfirmedAt} is not null)`,
    ),
  ],
);

export const workshopSessionRuntimeSelections = sqliteTable(
  "workshop_session_runtime_selections",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => workshopRuntimeProfiles.id, { onDelete: "restrict" }),
    profileId: text("profile_id").notNull(),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    connectionId: text("connection_id").references(
      () => providerConnections.id,
      { onDelete: "restrict" },
    ),
    resolvedProfileJson: jsonText<StoredResolvedRuntimeProfile>(
      "resolved_profile_json",
    ).notNull(),
    grossCeilingOverrideAt: integer("gross_ceiling_override_at"),
    grossCeilingOverrideBy: text("gross_ceiling_override_by").references(
      () => user.id,
      { onDelete: "restrict" },
    ),
    preflightRequestedSeats: integer("preflight_requested_seats"),
    preflightAvailableSeats: integer("preflight_available_seats"),
    preflightOk: integer("preflight_ok", { mode: "boolean" }),
    preflightPreferredLocation: text("preflight_preferred_location"),
    preflightReasonsJson: jsonText<string[]>("preflight_reasons_json")
      .default([])
      .notNull(),
    preflightCheckedAt: integer("preflight_checked_at"),
    preflightExpiresAt: integer("preflight_expires_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("workshop_session_runtime_selections_connection_idx").on(
      table.connectionId,
      table.providerKind,
    ),
    check(
      "workshop_session_runtime_selections_provider_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "workshop_session_runtime_selections_connection_valid",
      sql`(${table.providerKind} = 'agent_kvm' AND ${table.connectionId} is null) OR (${table.providerKind} in ('hetzner_cloud', 'gcp_compute') AND ${table.connectionId} is not null)`,
    ),
    check(
      "workshop_session_runtime_selections_profile_valid",
      sql`json_valid(${table.resolvedProfileJson})`,
    ),
    check(
      "workshop_session_runtime_selections_preflight_json_valid",
      sql`json_valid(${table.preflightReasonsJson})`,
    ),
    check(
      "workshop_session_runtime_selections_preflight_valid",
      sql`(${table.preflightCheckedAt} is null AND ${table.preflightExpiresAt} is null AND ${table.preflightRequestedSeats} is null AND ${table.preflightAvailableSeats} is null AND ${table.preflightOk} is null) OR (${table.preflightCheckedAt} is not null AND ${table.preflightExpiresAt} >= ${table.preflightCheckedAt} AND ${table.preflightRequestedSeats} >= 0 AND ${table.preflightAvailableSeats} >= 0 AND ${table.preflightAvailableSeats} <= ${table.preflightRequestedSeats} AND ${table.preflightOk} in (0, 1))`,
    ),
  ],
);

/** Provider-neutral reconstruction bytes shared by all compatible profiles. */
export const runtimeCheckpointBundles = sqliteTable(
  "runtime_checkpoint_bundles",
  {
    id: text("id").primaryKey(),
    templateRevisionId: text("template_revision_id")
      .notNull()
      .references(() => workshopTemplateRevisions.id, { onDelete: "cascade" }),
    checkpointId: text("checkpoint_id").notNull(),
    format: text("format")
      .$type<"direct_cloud_linux_x86_64_v1">()
      .notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    compression: text("compression").$type<"zstd">().notNull(),
    signatureB64: text("signature_b64").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    workspaceAgentSha256: text("workspace_agent_sha256").notNull(),
    kinoSha256: text("kino_sha256").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_checkpoint_bundles_revision_checkpoint_uidx").on(
      table.templateRevisionId,
      table.checkpointId,
    ),
    index("runtime_checkpoint_bundles_content_idx").on(
      table.sha256,
      table.sizeBytes,
    ),
    check(
      "runtime_checkpoint_bundles_payload_valid",
      sql`${table.format} = 'direct_cloud_linux_x86_64_v1' AND ${table.compression} = 'zstd' AND ${table.sizeBytes} > 0 AND length(${table.sha256}) = 64`,
    ),
    check(
      "runtime_checkpoint_bundles_tools_valid",
      sql`length(${table.workspaceAgentSha256}) = 64 AND length(${table.kinoSha256}) = 64`,
    ),
  ],
);

export const runtimeProviderAllocations = sqliteTable(
  "runtime_provider_allocations",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "restrict" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => workshopRuntimeProfiles.id, { onDelete: "restrict" }),
    priceObservationId: text("price_observation_id")
      .notNull()
      .references(() => providerPriceObservations.id, { onDelete: "restrict" }),
    costForecastId: text("cost_forecast_id").references(
      () => workshopSessionCostForecasts.id,
      { onDelete: "restrict" },
    ),
    providerKind: text("provider_kind")
      .$type<DirectCloudProviderKind>()
      .notNull(),
    deterministicName: text("deterministic_name").notNull(),
    machineType: text("machine_type").notNull(),
    resolvedImageId: text("resolved_image_id").notNull(),
    locationAttemptsJson: jsonText<string[]>("location_attempts_json").notNull(),
    location: text("location").notNull(),
    locationAttempt: integer("location_attempt").default(1).notNull(),
    locationAttemptStartedAt: integer("location_attempt_started_at")
      .default(nowMsDefault)
      .notNull(),
    fallbackPending: integer("fallback_pending", { mode: "boolean" })
      .default(false)
      .notNull(),
    state: text("state")
      .$type<ProviderAllocationPhase>()
      .default("pending")
      .notNull(),
    externalIpv4: text("external_ipv4"),
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
    uniqueIndex("runtime_provider_allocations_execution_uidx").on(
      table.executionId,
    ),
    uniqueIndex("runtime_provider_allocations_connection_name_uidx").on(
      table.connectionId,
      table.deterministicName,
    ),
    index("runtime_provider_allocations_state_updated_idx").on(
      table.providerKind,
      table.state,
      table.updatedAt,
    ),
    index("runtime_provider_allocations_price_attribution_idx").on(
      table.priceObservationId,
      table.costForecastId,
    ),
    check(
      "runtime_provider_allocations_kind_valid",
      sql`${table.providerKind} in ('hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "runtime_provider_allocations_state_valid",
      sql`${table.state} in ('pending', 'creating', 'bootstrapping', 'ready', 'degraded', 'rebooting', 'draining', 'deleting', 'deleted', 'cleanup_pending', 'failed')`,
    ),
    check(
      "runtime_provider_allocations_counters_valid",
      sql`${table.retryCount} >= 0 AND ${table.lastReportSequence} >= 0 AND ${table.locationAttempt} > 0`,
    ),
    check(
      "runtime_provider_allocations_locations_valid",
      sql`json_valid(${table.locationAttemptsJson}) AND json_array_length(${table.locationAttemptsJson}) >= ${table.locationAttempt} AND json_extract(${table.locationAttemptsJson}, '$[' || (${table.locationAttempt} - 1) || ']') = ${table.location}`,
    ),
    check(
      "runtime_provider_allocations_drain_valid",
      sql`${table.recordingDrainCompletedAt} is null OR (${table.recordingDrainRequestedAt} is not null AND ${table.recordingDrainCompletedAt} >= ${table.recordingDrainRequestedAt})`,
    ),
  ],
);

export const runtimeProviderResources = sqliteTable(
  "runtime_provider_resources",
  {
    id: text("id").primaryKey(),
    allocationId: text("allocation_id")
      .notNull()
      .references(() => runtimeProviderAllocations.id, {
        onDelete: "restrict",
      }),
    providerKind: text("provider_kind")
      .$type<DirectCloudProviderKind>()
      .notNull(),
    resourceKind: text("resource_kind")
      .$type<"instance" | "boot_disk" | "ipv4" | "ssh_key">()
      .notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    locationAttempt: integer("location_attempt").notNull(),
    location: text("location").notNull(),
    providerState: text("provider_state").notNull(),
    configurationJson: jsonText<Record<string, unknown>>("configuration_json")
      .default({})
      .notNull(),
    providerCreatedAt: integer("provider_created_at"),
    disappearanceConfirmedAt: integer("disappearance_confirmed_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_resources_allocation_kind_uidx").on(
      table.allocationId,
      table.locationAttempt,
      table.resourceKind,
    ),
    index("runtime_provider_resources_external_idx").on(
      table.providerKind,
      table.resourceKind,
      table.providerResourceId,
    ),
    index("runtime_provider_resources_allocation_idx").on(
      table.allocationId,
      table.resourceKind,
    ),
    check(
      "runtime_provider_resources_kind_valid",
      sql`${table.resourceKind} in ('instance', 'boot_disk', 'ipv4', 'ssh_key')`,
    ),
    check(
      "runtime_provider_resources_attempt_valid",
      sql`${table.locationAttempt} > 0`,
    ),
    check(
      "runtime_provider_resources_configuration_valid",
      sql`json_valid(${table.configurationJson})`,
    ),
  ],
);

export const runtimeProviderOperations = sqliteTable(
  "runtime_provider_operations",
  {
    id: text("id").primaryKey(),
    allocationId: text("allocation_id")
      .notNull()
      .references(() => runtimeProviderAllocations.id, {
        onDelete: "restrict",
      }),
    providerKind: text("provider_kind")
      .$type<DirectCloudProviderKind>()
      .notNull(),
    operationKind: text("operation_kind").notNull(),
    locationAttempt: integer("location_attempt").notNull(),
    providerOperationId: text("provider_operation_id"),
    requestId: text("request_id").notNull(),
    state: text("state")
      .$type<ProviderOperationState>()
      .default("pending")
      .notNull(),
    attempt: integer("attempt").default(1).notNull(),
    retryAt: integer("retry_at"),
    lastPolledAt: integer("last_polled_at"),
    completedAt: integer("completed_at"),
    errorClass: text("error_class"),
    errorCode: text("error_code"),
    sanitizedResultJson: jsonText<Record<string, unknown>>(
      "sanitized_result_json",
    ),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_operations_request_uidx").on(
      table.providerKind,
      table.requestId,
    ),
    uniqueIndex("runtime_provider_operations_allocation_external_uidx").on(
      table.allocationId,
      table.locationAttempt,
      table.providerOperationId,
    ),
    index("runtime_provider_operations_sweep_idx").on(
      table.state,
      table.retryAt,
      table.updatedAt,
    ),
    check(
      "runtime_provider_operations_state_valid",
      sql`${table.state} in ('pending', 'running', 'succeeded', 'retryable', 'failed')`,
    ),
    check(
      "runtime_provider_operations_attempt_valid",
      sql`${table.attempt} > 0 AND ${table.locationAttempt} > 0`,
    ),
    check(
      "runtime_provider_operations_result_valid",
      sql`${table.sanitizedResultJson} is null OR json_valid(${table.sanitizedResultJson})`,
    ),
  ],
);

export const runtimeProviderReconciliation = sqliteTable(
  "runtime_provider_reconciliation",
  {
    allocationId: text("allocation_id")
      .primaryKey()
      .references(() => runtimeProviderAllocations.id, {
        onDelete: "cascade",
      }),
    desiredState: text("desired_state").notNull(),
    observedState: text("observed_state").notNull(),
    sweepAfter: integer("sweep_after").notNull(),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastReconciledAt: integer("last_reconciled_at"),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_provider_reconciliation_sweep_idx").on(
      table.sweepAfter,
      table.claimExpiresAt,
    ),
    check(
      "runtime_provider_reconciliation_claim_valid",
      sql`(${table.claimId} is null AND ${table.claimExpiresAt} is null) OR (${table.claimId} is not null AND ${table.claimExpiresAt} is not null)`,
    ),
    check(
      "runtime_provider_reconciliation_failures_valid",
      sql`${table.consecutiveFailures} >= 0`,
    ),
  ],
);

export const runtimeGuestCredentials = sqliteTable(
  "runtime_guest_credentials",
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
    reportCredentialExpiresAt: integer("report_credential_expires_at").notNull(),
    reportCredentialRevokedAt: integer("report_credential_revoked_at"),
    checkpointBundleId: text("checkpoint_bundle_id")
      .notNull()
      .references(() => runtimeCheckpointBundles.id, { onDelete: "restrict" }),
    checkpointDownloadTokenHash: text("checkpoint_download_token_hash"),
    checkpointDownloadExpiresAt: integer("checkpoint_download_expires_at"),
    checkpointFirstDownloadedAt: integer("checkpoint_first_downloaded_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_guest_credentials_execution_uidx").on(
      table.executionId,
    ),
    uniqueIndex("runtime_guest_credentials_bootstrap_hash_uidx").on(
      table.bootstrapTokenHash,
    ),
    uniqueIndex("runtime_guest_credentials_report_hash_uidx").on(
      table.reportCredentialHash,
    ),
    uniqueIndex("runtime_guest_credentials_checkpoint_hash_uidx").on(
      table.checkpointDownloadTokenHash,
    ),
    check(
      "runtime_guest_credentials_generation_valid",
      sql`${table.generation} > 0`,
    ),
    check(
      "runtime_guest_credentials_lifecycle_valid",
      sql`(${table.bootstrapConsumedAt} is null AND ${table.reportCredentialHash} is null AND ${table.reportCredentialIssuedAt} is null AND ${table.checkpointDownloadTokenHash} is null AND ${table.checkpointDownloadExpiresAt} is null) OR (${table.bootstrapConsumedAt} is not null AND ${table.reportCredentialHash} is not null AND ${table.reportCredentialIssuedAt} is not null AND ${table.checkpointDownloadTokenHash} is not null AND ${table.checkpointDownloadExpiresAt} is not null)`,
    ),
  ],
);

export const runtimeGuestReports = sqliteTable(
  "runtime_guest_reports",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    bootId: text("boot_id").notNull(),
    phase: text("phase").notNull(),
    health: text("health").notNull(),
    terminalReady: integer("terminal_ready", { mode: "boolean" })
      .default(false)
      .notNull(),
    sshHostKeyOpenssh: text("ssh_host_key_openssh"),
    probesJson: jsonText<Array<Record<string, unknown>>>("probes_json")
      .default([])
      .notNull(),
    completedModuleIdsJson: jsonText<string[]>("completed_module_ids_json")
      .default([])
      .notNull(),
    reportJson: jsonText<Record<string, unknown>>("report_json").notNull(),
    reportedAt: integer("reported_at").notNull(),
    receivedAt: integer("received_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_guest_reports_generation_sequence_uidx").on(
      table.executionId,
      table.generation,
      table.sequence,
    ),
    index("runtime_guest_reports_execution_received_idx").on(
      table.executionId,
      table.receivedAt,
    ),
    check(
      "runtime_guest_reports_provider_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "runtime_guest_reports_sequence_valid",
      sql`${table.generation} > 0 AND ${table.sequence} >= 0`,
    ),
    check(
      "runtime_guest_reports_boot_id_valid",
      sql`length(${table.bootId}) = 36 AND lower(${table.bootId}) = ${table.bootId}`,
    ),
    check(
      "runtime_guest_reports_json_valid",
      sql`json_valid(${table.probesJson}) AND json_valid(${table.completedModuleIdsJson}) AND json_valid(${table.reportJson})`,
    ),
  ],
);

export const runtimeActualState = sqliteTable(
  "runtime_actual_state",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    latestReportId: text("latest_report_id").references(
      () => runtimeGuestReports.id,
      { onDelete: "restrict" },
    ),
    sourceKind: text("source_kind")
      .$type<"agent_report" | "guest_report" | "provider_observation">()
      .notNull(),
    sourceId: text("source_id").notNull(),
    generation: integer("generation").notNull(),
    sequence: integer("sequence").notNull(),
    phase: text("phase").notNull(),
    health: text("health").notNull(),
    observedAt: integer("observed_at").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_actual_state_source_idx").on(
      table.sourceKind,
      table.sourceId,
      table.observedAt,
    ),
    check(
      "runtime_actual_state_source_valid",
      sql`${table.sourceKind} in ('agent_report', 'guest_report', 'provider_observation')`,
    ),
    check(
      "runtime_actual_state_sequence_valid",
      sql`${table.generation} > 0 AND ${table.sequence} >= 0`,
    ),
  ],
);

export const providerPriceObservations = sqliteTable(
  "provider_price_observations",
  {
    id: text("id").primaryKey(),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    connectionId: text("connection_id").references(
      () => providerConnections.id,
      { onDelete: "restrict" },
    ),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => workshopRuntimeProfiles.id, { onDelete: "restrict" }),
    currency: text("currency").notNull(),
    source: text("source").notNull(),
    rawObservationJson: jsonText<Record<string, unknown>>(
      "raw_observation_json",
    ).notNull(),
    observedAt: integer("observed_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("provider_price_observations_profile_expiry_idx").on(
      table.runtimeProfileId,
      table.expiresAt,
    ),
    check(
      "provider_price_observations_provider_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "provider_price_observations_times_valid",
      sql`${table.expiresAt} > ${table.observedAt}`,
    ),
    check(
      "provider_price_observations_raw_valid",
      sql`json_valid(${table.rawObservationJson})`,
    ),
  ],
);

export const providerPriceLineItems = sqliteTable(
  "provider_price_line_items",
  {
    id: text("id").primaryKey(),
    observationId: text("observation_id")
      .notNull()
      .references(() => providerPriceObservations.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    resourceKind: text("resource_kind").notNull(),
    location: text("location").notNull(),
    rawPrice: text("raw_price").notNull(),
    priceNanos: integer("price_nanos").notNull(),
    unit: text("unit").notNull(),
    quantityNanos: integer("quantity_nanos").notNull(),
    billingIncrementSeconds: integer("billing_increment_seconds").notNull(),
    minimumDurationSeconds: integer("minimum_duration_seconds")
      .default(0)
      .notNull(),
    capPriceNanos: integer("cap_price_nanos"),
    taxTreatment: text("tax_treatment")
      .$type<
        "provider_net" | "provider_gross" | "tax_excluded_public_list"
      >()
      .notNull(),
    metadataJson: jsonText<Record<string, unknown>>("metadata_json")
      .default({})
      .notNull(),
  },
  (table) => [
    uniqueIndex("provider_price_line_items_observation_sku_location_uidx").on(
      table.observationId,
      table.sku,
      table.location,
      table.taxTreatment,
    ),
    check(
      "provider_price_line_items_values_valid",
      sql`${table.priceNanos} >= 0 AND ${table.quantityNanos} > 0 AND ${table.billingIncrementSeconds} > 0 AND ${table.minimumDurationSeconds} >= 0 AND (${table.capPriceNanos} is null OR ${table.capPriceNanos} >= 0)`,
    ),
    check(
      "provider_price_line_items_tax_valid",
      sql`${table.taxTreatment} in ('provider_net', 'provider_gross', 'tax_excluded_public_list')`,
    ),
    check(
      "provider_price_line_items_metadata_valid",
      sql`json_valid(${table.metadataJson})`,
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
    priceObservationId: text("price_observation_id")
      .notNull()
      .references(() => providerPriceObservations.id, { onDelete: "restrict" }),
    providerKind: text("provider_kind").$type<RuntimeProviderKind>().notNull(),
    currency: text("currency").notNull(),
    participantCount: integer("participant_count").notNull(),
    trigger: text("trigger").notNull(),
    expectedCostNanos: integer("expected_cost_nanos").notNull(),
    leaseCeilingCostNanos: integer("lease_ceiling_cost_nanos").notNull(),
    oneRestoreCostNanos: integer("one_restore_cost_nanos").notNull(),
    exceedsBudgetCeiling: integer("exceeds_budget_ceiling", { mode: "boolean" })
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
      sql`${table.version} > 0 AND ${table.participantCount} >= 0 AND ${table.expectedCostNanos} >= 0 AND ${table.leaseCeilingCostNanos} >= 0 AND ${table.oneRestoreCostNanos} >= 0`,
    ),
  ],
);

export const workshopSessionCostForecastLineItems = sqliteTable(
  "workshop_session_cost_forecast_line_items",
  {
    id: text("id").primaryKey(),
    forecastId: text("forecast_id")
      .notNull()
      .references(() => workshopSessionCostForecasts.id, {
        onDelete: "cascade",
      }),
    priceLineItemId: text("price_line_item_id")
      .notNull()
      .references(() => providerPriceLineItems.id, { onDelete: "restrict" }),
    scenario: text("scenario")
      .$type<"expected" | "lease_ceiling" | "one_restore">()
      .notNull(),
    participantCount: integer("participant_count").notNull(),
    generationCount: integer("generation_count").notNull(),
    lifetimeSeconds: integer("lifetime_seconds").notNull(),
    billedQuantityNanos: integer("billed_quantity_nanos").notNull(),
    calculatedCostNanos: integer("calculated_cost_nanos").notNull(),
    calculationJson: jsonText<Record<string, unknown>>(
      "calculation_json",
    ).notNull(),
  },
  (table) => [
    index("workshop_session_cost_forecast_line_items_scenario_idx").on(
      table.forecastId,
      table.scenario,
    ),
    check(
      "workshop_session_cost_forecast_line_items_scenario_valid",
      sql`${table.scenario} in ('expected', 'lease_ceiling', 'one_restore')`,
    ),
    check(
      "workshop_session_cost_forecast_line_items_values_valid",
      sql`${table.participantCount} >= 0 AND ${table.generationCount} > 0 AND ${table.lifetimeSeconds} >= 0 AND ${table.billedQuantityNanos} >= 0 AND ${table.calculatedCostNanos} >= 0`,
    ),
    check(
      "workshop_session_cost_forecast_line_items_calculation_valid",
      sql`json_valid(${table.calculationJson})`,
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
      .references(() => runtimeProviderAllocations.id, {
        onDelete: "restrict",
      }),
    providerResourceId: text("provider_resource_id")
      .notNull()
      .references(() => runtimeProviderResources.id, { onDelete: "restrict" }),
    forecastId: text("forecast_id").references(
      () => workshopSessionCostForecasts.id,
      { onDelete: "restrict" },
    ),
    priceLineItemId: text("price_line_item_id")
      .notNull()
      .references(() => providerPriceLineItems.id, { onDelete: "restrict" }),
    providerKind: text("provider_kind")
      .$type<DirectCloudProviderKind>()
      .notNull(),
    resourceKind: text("resource_kind").notNull(),
    sku: text("sku").notNull(),
    location: text("location").notNull(),
    currency: text("currency").notNull(),
    rawPrice: text("raw_price").notNull(),
    priceNanos: integer("price_nanos").notNull(),
    unit: text("unit").notNull(),
    quantityNanos: integer("quantity_nanos").notNull(),
    billingIncrementSeconds: integer("billing_increment_seconds").notNull(),
    minimumDurationSeconds: integer("minimum_duration_seconds").notNull(),
    capPriceNanos: integer("cap_price_nanos"),
    taxTreatment: text("tax_treatment").notNull(),
    providerCreatedAt: integer("provider_created_at").notNull(),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    finalCostNanos: integer("final_cost_nanos"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_provider_cost_ledger_resource_sku_tax_uidx").on(
      table.providerResourceId,
      table.sku,
      table.taxTreatment,
    ),
    index("runtime_provider_cost_ledger_execution_idx").on(
      table.executionId,
      table.providerCreatedAt,
    ),
    check(
      "runtime_provider_cost_ledger_values_valid",
      sql`${table.priceNanos} >= 0 AND ${table.quantityNanos} > 0 AND ${table.billingIncrementSeconds} > 0 AND ${table.minimumDurationSeconds} >= 0 AND (${table.capPriceNanos} is null OR ${table.capPriceNanos} >= 0) AND (${table.finalCostNanos} is null OR ${table.finalCostNanos} >= 0)`,
    ),
    check(
      "runtime_provider_cost_ledger_lifecycle_valid",
      sql`(${table.deletionConfirmedAt} is null AND ${table.finalCostNanos} is null) OR (${table.deletionConfirmedAt} is not null AND ${table.deletionConfirmedAt} >= ${table.providerCreatedAt} AND ${table.finalCostNanos} is not null)`,
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
    finalCostNanos: integer("final_cost_nanos"),
    forecastVarianceNanos: integer("forecast_variance_nanos"),
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

export const runtimeArtifactUploadGrants = sqliteTable(
  "runtime_artifact_upload_grants",
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
    uniqueIndex("runtime_artifact_upload_grants_token_hash_uidx").on(
      table.tokenHash,
    ),
    index("runtime_artifact_upload_grants_execution_expiry_idx").on(
      table.executionId,
      table.expiresAt,
    ),
    check(
      "runtime_artifact_upload_grants_generation_valid",
      sql`${table.generation} > 0`,
    ),
  ],
);
