import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { VmActualStateV2, VmPhase } from "@/generated/bridge";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import { organization, user } from "./core";
import { agentHosts } from "./platform";
import { jsonText, nowMsDefault } from "./shared";

export type RuntimeDomainKind =
  | "scenario"
  | "workshop"
  | "workshop_certification";
export type { RuntimeProviderKind } from "@intar/workshop-contracts";
export type RuntimeExecutionState =
  | "queued"
  | "provisioning"
  | "ready"
  | "archiving"
  | "archived"
  | "failed";
export type HostResourceReservationState = "pending" | "committed" | "released";

export const runtimeExecutions = sqliteTable(
  "runtime_executions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    hostId: text("host_id").references(() => agentHosts.id, {
      onDelete: "set null",
    }),
    providerKind: text("provider_kind")
      .$type<RuntimeProviderKind>()
      .default("agent_kvm")
      .notNull(),
    providerConnectionId: text("provider_connection_id"),
    domainKind: text("domain_kind").$type<RuntimeDomainKind>().notNull(),
    domainId: text("domain_id").notNull(),
    generation: integer("generation").notNull(),
    sourceExecutionId: text("source_execution_id"),
    checkpointId: text("checkpoint_id"),
    state: text("state")
      .$type<RuntimeExecutionState>()
      .default("queued")
      .notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    archiveRequestedAt: integer("archive_requested_at"),
    endedAt: integer("ended_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    foreignKey({
      name: "runtime_executions_source_fk",
      columns: [table.sourceExecutionId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
    uniqueIndex("runtime_executions_domain_generation_uidx").on(
      table.domainKind,
      table.domainId,
      table.generation,
    ),
    index("runtime_executions_user_state_idx").on(
      table.userId,
      table.state,
      table.updatedAt,
    ),
    index("runtime_executions_organization_state_idx").on(
      table.organizationId,
      table.state,
      table.updatedAt,
    ),
    index("runtime_executions_host_state_idx").on(
      table.hostId,
      table.state,
      table.updatedAt,
    ),
    index("runtime_executions_source_idx").on(table.sourceExecutionId),
    check(
      "runtime_executions_domain_kind_valid",
      sql`${table.domainKind} in ('scenario', 'workshop', 'workshop_certification')`,
    ),
    check(
      "runtime_executions_provider_kind_valid",
      sql`${table.providerKind} in ('agent_kvm', 'hetzner_cloud', 'gcp_compute')`,
    ),
    check(
      "runtime_executions_provider_identity_valid",
      sql`(${table.providerKind} = 'agent_kvm' AND ${table.providerConnectionId} is null) OR (${table.providerKind} in ('hetzner_cloud', 'gcp_compute') AND ${table.domainKind} in ('workshop', 'workshop_certification') AND ${table.providerConnectionId} is not null AND ${table.hostId} is null)`,
    ),
    check(
      "runtime_executions_generation_positive",
      sql`${table.generation} > 0`,
    ),
    check(
      "runtime_executions_state_valid",
      sql`${table.state} in ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed')`,
    ),
  ],
);

export const runtimeVms = sqliteTable(
  "runtime_vms",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    runtimeVmName: text("runtime_vm_name").notNull(),
    imageKeyJson: jsonText<Record<string, unknown>>("image_key_json").notNull(),
    imageSha256: text("image_sha256").notNull(),
    cpuMillis: integer("cpu_millis").notNull(),
    memoryMib: integer("memory_mib").notNull(),
    diskMib: integer("disk_mib").notNull(),
    terminalHost: text("terminal_host"),
    terminalPort: integer("terminal_port"),
    terminalUsername: text("terminal_username"),
    terminalHostKeyOpenssh: text("terminal_host_key_openssh"),
    terminalPrivateKeyCiphertextB64: text(
      "terminal_private_key_ciphertext_b64",
    ),
    terminalPrivateKeyIvB64: text("terminal_private_key_iv_b64"),
    terminalObservedAt: integer("terminal_observed_at"),
    artifactWritesSealed: integer("artifact_writes_sealed", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_vms_execution_vm_uidx").on(
      table.executionId,
      table.vmId,
    ),
    uniqueIndex("runtime_vms_execution_ordinal_uidx").on(
      table.executionId,
      table.ordinal,
    ),
    uniqueIndex("runtime_vms_execution_name_uidx").on(
      table.executionId,
      table.runtimeVmName,
    ),
    check("runtime_vms_ordinal_valid", sql`${table.ordinal} >= 0`),
    check("runtime_vms_cpu_positive", sql`${table.cpuMillis} > 0`),
    check("runtime_vms_memory_positive", sql`${table.memoryMib} > 0`),
    check("runtime_vms_disk_positive", sql`${table.diskMib} > 0`),
    check(
      "runtime_vms_terminal_target_complete",
      sql`(${table.terminalHost} is null AND ${table.terminalPort} is null AND ${table.terminalUsername} is null AND ${table.terminalHostKeyOpenssh} is null AND ${table.terminalPrivateKeyCiphertextB64} is null AND ${table.terminalPrivateKeyIvB64} is null AND ${table.terminalObservedAt} is null) OR (${table.terminalHost} is not null AND ${table.terminalPort} > 0 AND ${table.terminalUsername} is not null AND ${table.terminalHostKeyOpenssh} is not null AND ${table.terminalPrivateKeyCiphertextB64} is not null AND ${table.terminalPrivateKeyIvB64} is not null AND ${table.terminalObservedAt} is not null)`,
    ),
    check(
      "runtime_vms_image_key_json_valid",
      sql`json_valid(${table.imageKeyJson})`,
    ),
  ],
);

export const runtimeArtifacts = sqliteTable(
  "runtime_artifacts",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    runtimeVmId: text("runtime_vm_id")
      .notNull()
      .references(() => runtimeVms.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    uploadStatus: text("upload_status").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    uploadedAt: integer("uploaded_at"),
  },
  (table) => [
    uniqueIndex("runtime_artifacts_vm_ordinal_uidx").on(
      table.runtimeVmId,
      table.ordinal,
    ),
    index("runtime_artifacts_execution_idx").on(
      table.executionId,
      table.runtimeVmId,
      table.ordinal,
    ),
    index("runtime_artifacts_r2_key_idx").on(table.r2Key),
    uniqueIndex("runtime_artifacts_terminal_recording_content_uidx")
      .on(table.runtimeVmId, table.kind, table.sha256, table.sizeBytes)
      .where(sql`${table.kind} = 'terminal_recording'`),
    check("runtime_artifacts_ordinal_valid", sql`${table.ordinal} >= 0`),
    check("runtime_artifacts_size_valid", sql`${table.sizeBytes} >= 0`),
    check(
      "runtime_artifacts_upload_status_valid",
      sql`${table.uploadStatus} in ('pending', 'uploaded')`,
    ),
    check(
      "runtime_artifacts_uploaded_at_valid",
      sql`(${table.uploadStatus} = 'pending' AND ${table.uploadedAt} is null) OR (${table.uploadStatus} = 'uploaded' AND ${table.uploadedAt} is not null)`,
    ),
  ],
);

export const runtimeArtifactUploads = sqliteTable(
  "runtime_artifact_uploads",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => runtimeArtifacts.id, { onDelete: "cascade" }),
    r2UploadId: text("r2_upload_id"),
    uploadedPartsJson: jsonText<Array<{ partNumber: number; etag: string }>>(
      "uploaded_parts_json",
    )
      .default([])
      .notNull(),
    nextExpectedPart: integer("next_expected_part").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    check(
      "runtime_artifact_uploads_next_part_positive",
      sql`${table.nextExpectedPart} > 0`,
    ),
    check(
      "runtime_artifact_uploads_parts_json_valid",
      sql`json_valid(${table.uploadedPartsJson})`,
    ),
  ],
);

export const runtimeTerminalSessions = sqliteTable(
  "runtime_terminal_sessions",
  {
    id: text("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    runtimeVmId: text("runtime_vm_id")
      .notNull()
      .references(() => runtimeVms.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    exitCode: integer("exit_code"),
    recordingArtifactId: text("recording_artifact_id").references(
      () => runtimeArtifacts.id,
      { onDelete: "set null" },
    ),
    transcriptR2Key: text("transcript_r2_key"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_terminal_sessions_vm_ordinal_uidx").on(
      table.runtimeVmId,
      table.ordinal,
    ),
    index("runtime_terminal_sessions_execution_idx").on(
      table.executionId,
      table.runtimeVmId,
      table.startedAt,
    ),
    check(
      "runtime_terminal_sessions_ordinal_valid",
      sql`${table.ordinal} >= 0`,
    ),
    check(
      "runtime_terminal_sessions_duration_valid",
      sql`${table.endedAt} is null OR ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const activeRuntimeSlots = sqliteTable(
  "active_runtime_slots",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    acquiredAt: integer("acquired_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("active_runtime_slots_execution_uidx").on(table.executionId),
  ],
);

export const hostResourceReservations = sqliteTable(
  "host_resource_reservations",
  {
    executionId: text("execution_id")
      .primaryKey()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    cpuMillis: integer("cpu_millis").notNull(),
    memoryMib: integer("memory_mib").notNull(),
    worstCaseDiskMib: integer("worst_case_disk_mib").notNull(),
    state: text("state")
      .$type<HostResourceReservationState>()
      .default("pending")
      .notNull(),
    expiresAt: integer("expires_at"),
    releasedAt: integer("released_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("host_resource_reservations_host_state_idx").on(
      table.hostId,
      table.state,
    ),
    index("host_resource_reservations_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
    check(
      "host_resource_reservations_cpu_positive",
      sql`${table.cpuMillis} > 0`,
    ),
    check(
      "host_resource_reservations_memory_positive",
      sql`${table.memoryMib} > 0`,
    ),
    check(
      "host_resource_reservations_disk_positive",
      sql`${table.worstCaseDiskMib} > 0`,
    ),
    check(
      "host_resource_reservations_state_valid",
      sql`${table.state} in ('pending', 'committed', 'released')`,
    ),
  ],
);

export const runtimeAllocationLocks = sqliteTable(
  "runtime_allocation_locks",
  {
    key: text("key").primaryKey(),
    ownerToken: text("owner_token").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_allocation_locks_expiry_idx").on(table.expiresAt),
    check(
      "runtime_allocation_locks_expiry_valid",
      sql`${table.expiresAt} > 0`,
    ),
  ],
);

export const runtimeVmAccessKeys = sqliteTable(
  "runtime_vm_access_keys",
  {
    runtimeVmId: text("runtime_vm_id")
      .primaryKey()
      .references(() => runtimeVms.id, { onDelete: "cascade" }),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    publicKeyOpenssh: text("public_key_openssh").notNull(),
    privateKeyCiphertextB64: text("private_key_ciphertext_b64").notNull(),
    privateKeyIvB64: text("private_key_iv_b64").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_vm_access_keys_execution_idx").on(table.executionId),
  ],
);

export const runtimeVmActualState = sqliteTable(
  "runtime_vm_actual_state",
  {
    runtimeVmId: text("runtime_vm_id")
      .primaryKey()
      .references(() => runtimeVms.id, { onDelete: "cascade" }),
    executionId: text("execution_id")
      .notNull()
      .references(() => runtimeExecutions.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    phase: text("phase").$type<VmPhase>().notNull(),
    desiredVersion: integer("desired_version"),
    reportJson: jsonText<VmActualStateV2>("report_json").notNull(),
    observedAt: integer("observed_at").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("runtime_vm_actual_state_execution_idx").on(
      table.executionId,
      table.phase,
    ),
    index("runtime_vm_actual_state_host_observed_idx").on(
      table.hostId,
      table.observedAt,
    ),
    check(
      "runtime_vm_actual_state_phase_valid",
      sql`${table.phase} in ('pending', 'pulling_image', 'creating_disks', 'booting', 'running', 'ready', 'solved', 'stopping', 'stopped', 'failed', 'absent')`,
    ),
    check(
      "runtime_vm_actual_state_desired_version_valid",
      sql`${table.desiredVersion} is null OR ${table.desiredVersion} >= 0`,
    ),
    check(
      "runtime_vm_actual_state_report_json_valid",
      sql`json_valid(${table.reportJson})`,
    ),
  ],
);
