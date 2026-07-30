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
import { agentHosts } from "./platform";
import { jsonText, nowMsDefault } from "./shared";
import { workshopTemplateRevisions } from "./workshops";

export type WorkshopPublicationStatus =
  | "queued"
  | "building"
  | "failed"
  | "published";
export type WorkshopProviderVerificationState =
  | "verifying"
  | "verified"
  | "failed"
  | "cleanup_pending";

export type WorkshopCheckpointBuildStatus =
  | "pending"
  | "building"
  | "verified"
  | "failed";

export const workshopRegistryTokens = sqliteTable(
  "workshop_registry_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_registry_tokens_hash_uidx").on(table.tokenHash),
    index("workshop_registry_tokens_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "workshop_registry_tokens_expiry_valid",
      sql`${table.expiresAt} is null OR ${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const workshopPublications = sqliteTable(
  "workshop_publications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    workshopSlug: text("workshop_slug").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceR2Key: text("source_r2_key").notNull(),
    compiledManifestJson: jsonText<Record<string, unknown>>(
      "compiled_manifest_json",
    ).notNull(),
    requiredCheckpointIdsJson: jsonText<string[]>(
      "required_checkpoint_ids_json",
    ).notNull(),
    status: text("status")
      .$type<WorkshopPublicationStatus>()
      .default("queued")
      .notNull(),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    registryTokenId: text("registry_token_id")
      .notNull()
      .references(() => workshopRegistryTokens.id, { onDelete: "restrict" }),
    builderHostId: text("builder_host_id").references(() => agentHosts.id, {
      onDelete: "restrict",
    }),
    publishedRevisionId: text("published_revision_id").references(
      () => workshopTemplateRevisions.id,
      { onDelete: "restrict" },
    ),
    error: text("error"),
    claimedAt: integer("claimed_at"),
    claimExpiresAt: integer("claim_expires_at"),
    providerVerificationState: text("provider_verification_state").$type<
      WorkshopProviderVerificationState | null
    >(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_publications_org_hash_uidx").on(
      table.organizationId,
      table.contentHash,
    ),
    index("workshop_publications_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("workshop_publications_builder_status_idx").on(
      table.builderHostId,
      table.status,
    ),
    index("workshop_publications_claim_lease_idx").on(
      table.status,
      table.claimExpiresAt,
      table.createdAt,
    ),
    check(
      "workshop_publications_status_valid",
      sql`${table.status} in ('queued', 'building', 'failed', 'published')`,
    ),
    check(
      "workshop_publications_manifest_json_valid",
      sql`json_valid(${table.compiledManifestJson})`,
    ),
    check(
      "workshop_publications_checkpoints_json_valid",
      sql`json_valid(${table.requiredCheckpointIdsJson})`,
    ),
    check(
      "workshop_publications_provider_verification_state_valid",
      sql`${table.providerVerificationState} is null OR ${table.providerVerificationState} in ('verifying', 'verified', 'failed', 'cleanup_pending')`,
    ),
  ],
);

export const workshopPublicationCheckpoints = sqliteTable(
  "workshop_publication_checkpoints",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => workshopPublications.id, { onDelete: "cascade" }),
    checkpointId: text("checkpoint_id").notNull(),
    status: text("status")
      .$type<WorkshopCheckpointBuildStatus>()
      .default("pending")
      .notNull(),
    vmImagesJson: jsonText<Array<Record<string, unknown>>>("vm_images_json"),
    sanitized: integer("sanitized", { mode: "boolean" })
      .default(false)
      .notNull(),
    coldBootVerified: integer("cold_boot_verified", { mode: "boolean" })
      .default(false)
      .notNull(),
    error: text("error"),
    verifiedAt: integer("verified_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_publication_checkpoints_uidx").on(
      table.publicationId,
      table.checkpointId,
    ),
    index("workshop_publication_checkpoints_status_idx").on(
      table.publicationId,
      table.status,
    ),
    check(
      "workshop_publication_checkpoints_status_valid",
      sql`${table.status} in ('pending', 'building', 'verified', 'failed')`,
    ),
    check(
      "workshop_publication_checkpoints_images_json_valid",
      sql`${table.vmImagesJson} is null OR json_valid(${table.vmImagesJson})`,
    ),
  ],
);
