import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  organizationProviderConnections,
  type ProviderPriceObservation,
} from "./providers";
import { jsonText, nowMsDefault } from "./shared";
import { workshopPublications } from "./workshop-registry";
import type { WorkshopManifestV1 } from "./workshops";

export type WorkshopPublicationProviderVerificationStatus =
  | "pending"
  | "allocating"
  | "bootstrapping"
  | "applying"
  | "proof_succeeded"
  | "deleting"
  | "verified"
  | "failed"
  | "cleanup_pending";

export type WorkshopPublicationProviderAttemptStatus =
  | "allocating"
  | "bootstrapping"
  | "applying"
  | "proof_succeeded"
  | "deleting"
  | "deleted"
  | "failed"
  | "cleanup_pending";

type ResolvedProvider = NonNullable<
  WorkshopManifestV1["workspace"]["provider"]
>;

export interface WorkshopPublicationExpectedProbe {
  moduleId: string;
  probeId: string;
}

/**
 * Builder artifacts are staged here before an immutable template revision
 * exists. A row becomes trusted only after the exact signed bytes reach
 * `verified` through an Intar-owned direct Hetzner attempt whose resources
 * have all been confirmed deleted.
 */
export const workshopPublicationProviderCheckpoints = sqliteTable(
  "workshop_publication_provider_checkpoints",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => workshopPublications.id, { onDelete: "cascade" }),
    checkpointId: text("checkpoint_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    coveredModuleIdsJson: jsonText<string[]>(
      "covered_module_ids_json",
    ).notNull(),
    expectedProbesJson: jsonText<WorkshopPublicationExpectedProbe[]>(
      "expected_probes_json",
    ).notNull(),
    providerKind: text("provider_kind").$type<"hetzner_cloud">().notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => organizationProviderConnections.id, {
        onDelete: "restrict",
      }),
    resolvedProviderJson: jsonText<ResolvedProvider>(
      "resolved_provider_json",
    ).notNull(),
    permittedLocationsJson: jsonText<string[]>(
      "permitted_locations_json",
    ).notNull(),
    priceObservationJson: jsonText<ProviderPriceObservation>(
      "price_observation_json",
    ).notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    compression: text("compression")
      .$type<"none" | "gzip" | "zstd">()
      .notNull(),
    signatureB64: text("signature_b64").notNull(),
    signingKeyId: text("signing_key_id").notNull(),
    workspaceAgentSha256: text("workspace_agent_sha256").notNull(),
    kinoSha256: text("kino_sha256").notNull(),
    verificationStatus: text("verification_status")
      .$type<WorkshopPublicationProviderVerificationStatus>()
      .default("pending")
      .notNull(),
    verificationBasisCheckpointId: text("verification_basis_checkpoint_id"),
    proofVerifiedAt: integer("proof_verified_at"),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    error: text("error"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_publication_provider_checkpoint_uidx").on(
      table.publicationId,
      table.checkpointId,
    ),
    index("workshop_publication_provider_status_idx").on(
      table.publicationId,
      table.verificationStatus,
      table.ordinal,
    ),
    index("workshop_publication_provider_verification_basis_idx").on(
      table.verificationBasisCheckpointId,
    ),
    check(
      "workshop_publication_provider_kind_valid",
      sql`${table.providerKind} = 'hetzner_cloud'`,
    ),
    check(
      "workshop_publication_provider_status_valid",
      sql`${table.verificationStatus} in ('pending', 'allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'verified', 'failed', 'cleanup_pending')`,
    ),
    check(
      "workshop_publication_provider_artifact_valid",
      sql`${table.ordinal} >= 0 AND ${table.sizeBytes} > 0 AND length(${table.sha256}) = 64 AND ${table.compression} in ('none', 'gzip', 'zstd')`,
    ),
    check(
      "workshop_publication_provider_guest_tools_valid",
      sql`length(${table.workspaceAgentSha256}) = 64 AND ${table.workspaceAgentSha256} NOT GLOB '*[^0-9a-f]*' AND length(${table.kinoSha256}) = 64 AND ${table.kinoSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "workshop_publication_provider_json_valid",
      sql`json_valid(${table.coveredModuleIdsJson}) AND json_valid(${table.expectedProbesJson}) AND json_valid(${table.resolvedProviderJson}) AND json_valid(${table.permittedLocationsJson}) AND json_valid(${table.priceObservationJson})`,
    ),
    check(
      "workshop_publication_provider_verified_lifecycle",
      sql`${table.verificationStatus} != 'verified' OR (${table.proofVerifiedAt} is not null AND ${table.deletionConfirmedAt} is not null)`,
    ),
  ],
);

/**
 * One direct provider attempt. It is deliberately not a learner
 * runtime_execution or hetzner_allocation, so an unpublished checkpoint can
 * never be mistaken for a learner workspace or acquire routes/slots.
 */
export const workshopPublicationProviderAttempts = sqliteTable(
  "workshop_publication_provider_attempts",
  {
    id: text("id").primaryKey(),
    providerCheckpointId: text("provider_checkpoint_id")
      .notNull()
      .references(() => workshopPublicationProviderCheckpoints.id, {
        onDelete: "cascade",
      }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => organizationProviderConnections.id, {
        onDelete: "restrict",
      }),
    ordinal: integer("ordinal").notNull(),
    deterministicName: text("deterministic_name").notNull(),
    serverType: text("server_type").notNull(),
    systemImage: text("system_image").notNull(),
    location: text("location").notNull(),
    serverId: text("server_id"),
    primaryIpId: text("primary_ip_id"),
    primaryIpv4: text("primary_ipv4"),
    sshKeyId: text("ssh_key_id"),
    createActionId: text("create_action_id"),
    deleteActionId: text("delete_action_id"),
    state: text("state")
      .$type<WorkshopPublicationProviderAttemptStatus>()
      .default("allocating")
      .notNull(),
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
    checkpointDownloadTokenHash: text("checkpoint_download_token_hash"),
    checkpointDownloadExpiresAt: integer("checkpoint_download_expires_at"),
    checkpointFirstDownloadedAt: integer("checkpoint_first_downloaded_at"),
    lastReportSequence: integer("last_report_sequence").default(0).notNull(),
    lastReportPhase: text("last_report_phase"),
    lastReportHealth: text("last_report_health"),
    lastReportAt: integer("last_report_at"),
    reportJson: jsonText<Record<string, unknown>>("report_json"),
    proofReportSequence: integer("proof_report_sequence"),
    proofVerifiedAt: integer("proof_verified_at"),
    deletionRequestedAt: integer("deletion_requested_at"),
    deletionConfirmedAt: integer("deletion_confirmed_at"),
    lastErrorCode: text("last_error_code"),
    error: text("error"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_publication_provider_attempt_ordinal_uidx").on(
      table.providerCheckpointId,
      table.ordinal,
    ),
    uniqueIndex("workshop_publication_provider_attempt_name_uidx").on(
      table.connectionId,
      table.deterministicName,
    ),
    uniqueIndex("workshop_publication_provider_attempt_bootstrap_uidx").on(
      table.bootstrapTokenHash,
    ),
    uniqueIndex("workshop_publication_provider_attempt_report_uidx").on(
      table.reportCredentialHash,
    ),
    uniqueIndex("workshop_publication_provider_attempt_download_uidx").on(
      table.checkpointDownloadTokenHash,
    ),
    index("workshop_publication_provider_attempt_state_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "workshop_publication_provider_attempt_state_valid",
      sql`${table.state} in ('allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'deleted', 'failed', 'cleanup_pending')`,
    ),
    check(
      "workshop_publication_provider_attempt_ordinal_valid",
      sql`${table.ordinal} > 0 AND ${table.lastReportSequence} >= 0`,
    ),
    check(
      "workshop_publication_provider_attempt_report_valid",
      sql`${table.reportJson} is null OR json_valid(${table.reportJson})`,
    ),
    check(
      "workshop_publication_provider_attempt_credential_lifecycle",
      sql`(${table.bootstrapConsumedAt} is null AND ${table.reportCredentialHash} is null AND ${table.reportCredentialIssuedAt} is null AND ${table.checkpointDownloadTokenHash} is null AND ${table.checkpointDownloadExpiresAt} is null) OR (${table.bootstrapConsumedAt} is not null AND ${table.reportCredentialHash} is not null AND ${table.reportCredentialIssuedAt} is not null AND ${table.checkpointDownloadTokenHash} is not null AND ${table.checkpointDownloadExpiresAt} is not null)`,
    ),
    check(
      "workshop_publication_provider_attempt_proof_lifecycle",
      sql`${table.proofVerifiedAt} is null OR (${table.proofReportSequence} is not null AND ${table.proofReportSequence} > 0)`,
    ),
    check(
      "workshop_publication_provider_attempt_deletion_lifecycle",
      sql`${table.deletionConfirmedAt} is null OR (${table.deletionRequestedAt} is not null AND ${table.deletionConfirmedAt} >= ${table.deletionRequestedAt})`,
    ),
  ],
);

export const workshopPublicationProviderCostLedger = sqliteTable(
  "workshop_publication_provider_cost_ledger",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => workshopPublicationProviderAttempts.id, {
        onDelete: "restrict",
      }),
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
    uniqueIndex("workshop_publication_provider_cost_resource_uidx").on(
      table.attemptId,
      table.resourceKind,
      table.providerResourceId,
    ),
    index("workshop_publication_provider_cost_attempt_idx").on(
      table.attemptId,
      table.providerCreatedAt,
    ),
    check(
      "workshop_publication_provider_cost_kind_valid",
      sql`${table.resourceKind} in ('server', 'primary_ipv4')`,
    ),
    check(
      "workshop_publication_provider_cost_values_valid",
      sql`${table.hourlyNetMicros} >= 0 AND ${table.hourlyGrossMicros} >= 0 AND (${table.monthlyNetMicros} is null OR ${table.monthlyNetMicros} >= 0) AND (${table.monthlyGrossMicros} is null OR ${table.monthlyGrossMicros} >= 0)`,
    ),
  ],
);
