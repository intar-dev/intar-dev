import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  BuildPhase,
  HostDesiredStateV1,
  HostStateReportV1,
} from "@/generated/bridge";
import type {
  ImageArchitecture,
  ImageKey,
  ScenarioHintManifestV2,
} from "@/generated/catalog";

const nowMsDefault = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
const jsonText = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export interface ScenarioRunHintSnapshot {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  bodyMarkdown: string;
}

export type AgentHostRole = "agent" | "builder";
export type ImageBuildStatus =
  | "queued"
  | "assigned"
  | "building"
  | "succeeded"
  | "failed"
  | "stale";

export interface ImageBuildBundleMeta {
  buildFormatVersion: string;
  scenarios: Array<{
    scenarioId: string;
    arch: ImageArchitecture;
    contentHash: string;
  }>;
  [key: string]: unknown;
}

export interface ImageBuildTimings {
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastReportAt?: number | null;
}

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
});

export const userSshKeys = sqliteTable(
  "user_ssh_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label"),
    keyType: text("key_type").notNull(),
    comment: text("comment"),
    publicKeyOpenssh: text("public_key_openssh").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("user_ssh_keys_user_idx").on(table.userId, table.createdAt),
    uniqueIndex("user_ssh_keys_user_fingerprint_uidx").on(
      table.userId,
      table.fingerprintSha256,
    ),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = sqliteTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    metadata: text("metadata"),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
);

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const agentHosts = sqliteTable(
  "agent_hosts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
    hostInfoJson: text("host_info_json"),
    inventoryJson: text("inventory_json"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("agent_hosts_user_idx").on(table.userId),
    index("agent_hosts_role_idx").on(table.role, table.connected),
    index("agent_hosts_connected_idx").on(table.connected, table.updatedAt),
  ],
);

export const imageBuildBundles = sqliteTable("image_build_bundles", {
  rev: text("rev").primaryKey(),
  r2Key: text("r2_key").notNull(),
  kinoVersion: text("kino_version").notNull(),
  metaJson: jsonText<ImageBuildBundleMeta>("meta_json").notNull(),
  createdAt: integer("created_at").default(nowMsDefault).notNull(),
  updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
});

export const imageBuilds = sqliteTable(
  "image_builds",
  {
    id: text("id").primaryKey(),
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
    status: text("status").$type<ImageBuildStatus>().default("queued").notNull(),
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
    index("image_builds_host_idx").on(table.hostId, table.status),
    index("image_builds_rev_idx").on(table.rev),
  ],
);

export const hostDesiredState = sqliteTable(
  "host_desired_state",
  {
    hostId: text("host_id")
      .primaryKey()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    docJson: jsonText<HostDesiredStateV1>("doc_json").notNull(),
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
    reportJson: jsonText<HostStateReportV1>("report_json").notNull(),
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

export const agentBootstrapTokens = sqliteTable(
  "agent_bootstrap_tokens",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("agent_bootstrap_tokens_host_idx").on(table.hostId),
    index("agent_bootstrap_tokens_hash_idx").on(table.tokenHash),
  ],
);

export const scenarioRuns = sqliteTable(
  "scenario_runs",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    scenarioName: text("scenario_name").notNull(),
    title: text("title").notNull(),
    tagline: text("tagline").notNull(),
    briefingMarkdown: text("briefing_markdown").notNull(),
    objectivesJson: text("objectives_json").notNull(),
    difficulty: text("difficulty").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    tagsJson: jsonText<string[]>("tags_json").notNull(),
    hintsJson: jsonText<ScenarioRunHintSnapshot[]>("hints_json").notNull(),
    solutionMarkdown: text("solution_markdown").notNull(),
    revealedHintsJson: jsonText<string[]>("revealed_hints_json")
      .default([])
      .notNull(),
    solutionRevealedAt: integer("solution_revealed_at"),
    solutionAssisted: integer("solution_assisted", { mode: "boolean" })
      .default(false)
      .notNull(),
    vmCount: integer("vm_count").notNull(),
    state: text("state").notNull(),
    stateRank: integer("state_rank").notNull(),
    activeKey: text("active_key"),
    stateJson: text("state_json").notNull(),
    deleteRequestedAt: integer("delete_requested_at"),
    solvedAt: integer("solved_at"),
    completedAt: integer("completed_at"),
    failedAt: integer("failed_at"),
    hiddenAt: integer("hidden_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_runs_active_key_uidx").on(table.activeKey),
    index("scenario_runs_user_scenario_idx").on(
      table.userId,
      table.scenarioId,
      table.createdAt,
    ),
    index("scenario_runs_host_idx").on(table.hostId, table.createdAt),
  ],
);

export const scenarioRunSshKeys = sqliteTable(
  "scenario_run_ssh_keys",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    runtimeVmName: text("runtime_vm_name").notNull(),
    publicKeyOpenssh: text("public_key_openssh").notNull(),
    privateKeyCiphertextB64: text("private_key_ciphertext_b64").notNull(),
    privateKeyIvB64: text("private_key_iv_b64").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_run_ssh_keys_run_vm_uidx").on(
      table.runId,
      table.vmId,
    ),
    index("scenario_run_ssh_keys_run_runtime_idx").on(
      table.runId,
      table.runtimeVmName,
    ),
  ],
);

export const scenarioRunProbeSnapshots = sqliteTable(
  "scenario_run_probe_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    runtimeVmName: text("runtime_vm_name").notNull(),
    messageId: text("message_id").notNull(),
    collectionState: text("collection_state"),
    collectionError: text("collection_error"),
    summaryJson: text("summary_json"),
    snapshotJson: text("snapshot_json").notNull(),
    generatedAt: integer("generated_at"),
    observedAt: integer("observed_at").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_run_probe_snapshots_run_vm_message_uidx").on(
      table.runId,
      table.vmId,
      table.messageId,
    ),
    index("scenario_run_probe_snapshots_run_vm_idx").on(
      table.runId,
      table.vmId,
      table.createdAt,
    ),
  ],
);

export const scenarioRunArtifacts = sqliteTable(
  "scenario_run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
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
    uniqueIndex("scenario_run_artifacts_vm_ordinal_uidx").on(
      table.vmId,
      table.ordinal,
    ),
    index("scenario_run_artifacts_run_idx").on(
      table.runId,
      table.vmId,
      table.ordinal,
    ),
    index("scenario_run_artifacts_r2_key_idx").on(table.r2Key),
  ],
);

export const scenarioRunArtifactUploads = sqliteTable(
  "scenario_run_artifact_uploads",
  {
    artifactId: text("artifact_id").primaryKey(),
    r2UploadId: text("r2_upload_id"),
    uploadedPartsJson: text("uploaded_parts_json").notNull(),
    nextExpectedPart: integer("next_expected_part").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
);

export const vmScenarios = sqliteTable(
  "vm_scenarios",
  {
    scenarioId: text("scenario_id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    tagsJson: jsonText<string[]>("tags_json").notNull(),
    briefingMarkdown: text("briefing_markdown").notNull(),
    solutionMarkdown: text("solution_markdown").notNull(),
    hintsJson: jsonText<ScenarioHintManifestV2[]>("hints_json").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(false).notNull(),
    enabledAt: integer("enabled_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("vm_scenarios_enabled_idx").on(table.enabled, table.enabledAt),
  ],
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
    kernelSha256: text("kernel_sha256").notNull(),
    initrdSha256: text("initrd_sha256").notNull(),
    bootCmdline: text("boot_cmdline").notNull(),
    cpu: integer("cpu").notNull(),
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
    hintsJson: jsonText<ScenarioHintManifestV2[]>("hints_json").notNull(),
    phase: text("phase").default("scenario").notNull(),
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

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    disabled: integer("disabled", { mode: "boolean" }).default(false).notNull(),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: jsonText<string[]>("scopes"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: jsonText<string[]>("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: jsonText<string[]>("redirect_uris").notNull(),
    postLogoutRedirectUris: jsonText<string[]>("post_logout_redirect_uris"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    grantTypes: jsonText<string[]>("grant_types"),
    responseTypes: jsonText<string[]>("response_types"),
    public: integer("public", { mode: "boolean" }).default(false).notNull(),
    type: text("type"),
    requirePKCE: integer("require_pkce", { mode: "boolean" })
      .default(true)
      .notNull(),
    referenceId: text("reference_id"),
    metadata: jsonText<Record<string, unknown>>("metadata"),
  },
  (table) => [
    index("oauthClient_userId_idx").on(table.userId),
    index("oauthClient_referenceId_idx").on(table.referenceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .notNull(),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    scopes: jsonText<string[]>("scopes").notNull(),
  },
  (table) => [
    index("oauthRefreshToken_clientId_idx").on(table.clientId),
    index("oauthRefreshToken_sessionId_idx").on(table.sessionId),
    index("oauthRefreshToken_userId_idx").on(table.userId),
    index("oauthRefreshToken_referenceId_idx").on(table.referenceId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .notNull(),
    scopes: jsonText<string[]>("scopes").notNull(),
  },
  (table) => [
    index("oauthAccessToken_clientId_idx").on(table.clientId),
    index("oauthAccessToken_sessionId_idx").on(table.sessionId),
    index("oauthAccessToken_userId_idx").on(table.userId),
    index("oauthAccessToken_referenceId_idx").on(table.referenceId),
    index("oauthAccessToken_refreshId_idx").on(table.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    scopes: jsonText<string[]>("scopes").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMsDefault)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").on(table.clientId),
    index("oauthConsent_userId_idx").on(table.userId),
    index("oauthConsent_referenceId_idx").on(table.referenceId),
  ],
);

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(nowMsDefault)
    .notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
});
