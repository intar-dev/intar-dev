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
import { nowMsDefault } from "./shared";

export const scenarioAssignments = sqliteTable(
  "scenario_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    assignedBy: text("assigned_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_assignments_org_scenario_uidx").on(
      table.organizationId,
      table.scenarioId,
    ),
  ],
);

export type AccessInviteKind = "standard" | "bootstrap_admin";
export type AccessInviteState = "pending" | "leased" | "redeemed" | "revoked";

// Raw invite codes never enter D1. The public fragment is hashed before this
// table is queried; codePrefix is intentionally short enough to be safe in
// administration and audit surfaces.
export const accessInviteCodes = sqliteTable(
  "access_invite_codes",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    codePrefix: text("code_prefix").notNull(),
    kind: text("kind").$type<AccessInviteKind>().notNull(),
    state: text("state")
      .$type<AccessInviteState>()
      .default("pending")
      .notNull(),
    label: text("label"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    expiresAt: integer("expires_at").notNull(),
    leaseId: text("lease_id"),
    leasedAt: integer("leased_at"),
    leaseExpiresAt: integer("lease_expires_at"),
    redeemerUserId: text("redeemer_user_id"),
    redeemerGithubAccountId: text("redeemer_github_account_id"),
    redeemerGithubUsername: text("redeemer_github_username"),
    redeemedAt: integer("redeemed_at"),
    revokedBy: text("revoked_by"),
    revocationReason: text("revocation_reason"),
    revokedAt: integer("revoked_at"),
    replacesInviteId: text("replaces_invite_id"),
    replacesInviteVersion: integer("replaces_invite_version"),
    replacedByInviteId: text("replaced_by_invite_id"),
    version: integer("version").default(1).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("access_invite_codes_hash_uidx").on(table.codeHash),
    index("access_invite_codes_state_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
    index("access_invite_codes_creator_idx").on(
      table.createdBy,
      table.createdAt,
    ),
    index("access_invite_codes_lease_idx").on(
      table.state,
      table.leaseExpiresAt,
    ),
    check(
      "access_invite_codes_hash_valid",
      sql`length(${table.codeHash}) = 64 AND ${table.codeHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "access_invite_codes_kind_valid",
      sql`${table.kind} in ('standard', 'bootstrap_admin')`,
    ),
    check(
      "access_invite_codes_creator_valid",
      sql`(${table.kind} = 'standard' AND ${table.createdBy} is not null) OR (${table.kind} = 'bootstrap_admin' AND ${table.createdBy} is null)`,
    ),
    check(
      "access_invite_codes_expiry_valid",
      // Existing audit rows retain the original 48-hour expiry. New invites
      // use the 14-day default.
      sql`${table.expiresAt} in (${table.createdAt} + 172800000, ${table.createdAt} + 1209600000)`,
    ),
    check("access_invite_codes_version_valid", sql`${table.version} > 0`),
    check(
      "access_invite_codes_replacement_valid",
      sql`(${table.replacesInviteId} is null AND ${table.replacesInviteVersion} is null) OR (${table.replacesInviteId} is not null AND ${table.replacesInviteVersion} > 0)`,
    ),
    check(
      "access_invite_codes_state_valid",
      sql`
        (${table.state} = 'pending'
          AND ${table.leaseId} is null
          AND ${table.leasedAt} is null
          AND ${table.leaseExpiresAt} is null
          AND ${table.redeemerUserId} is null
          AND ${table.redeemerGithubAccountId} is null
          AND ${table.redeemerGithubUsername} is null
          AND ${table.redeemedAt} is null
          AND ${table.revokedBy} is null
          AND ${table.revocationReason} is null
          AND ${table.revokedAt} is null
          AND ${table.replacedByInviteId} is null)
        OR
        (${table.state} = 'leased'
          AND ${table.leaseId} is not null
          AND ${table.leasedAt} is not null
          AND ${table.leaseExpiresAt} = ${table.leasedAt} + 600000
          AND ${table.redeemerUserId} is null
          AND ${table.redeemerGithubAccountId} is null
          AND ${table.redeemerGithubUsername} is null
          AND ${table.redeemedAt} is null
          AND ${table.revokedBy} is null
          AND ${table.revocationReason} is null
          AND ${table.revokedAt} is null
          AND ${table.replacedByInviteId} is null)
        OR
        (${table.state} = 'redeemed'
          AND ${table.leaseId} is not null
          AND ${table.leasedAt} is not null
          AND ${table.leaseExpiresAt} = ${table.leasedAt} + 600000
          AND ${table.redeemerUserId} is not null
          AND ${table.redeemerGithubAccountId} is not null
          AND ${table.redeemerGithubUsername} is not null
          AND ${table.redeemedAt} is not null
          AND ${table.revokedBy} is null
          AND ${table.revocationReason} is null
          AND ${table.revokedAt} is null
          AND ${table.replacedByInviteId} is null)
        OR
        (${table.state} = 'revoked'
          AND ${table.leaseId} is null
          AND ${table.leasedAt} is null
          AND ${table.leaseExpiresAt} is null
          AND ${table.redeemerUserId} is null
          AND ${table.redeemerGithubAccountId} is null
          AND ${table.redeemerGithubUsername} is null
          AND ${table.redeemedAt} is null
          AND ${table.revokedBy} is not null
          AND ${table.revocationReason} is not null
          AND ${table.revokedAt} is not null)`,
    ),
  ],
);

// Removing an invite is a presentation-level archive, not a destructive
// delete. The invite row remains the immutable authorization and audit source.
export const accessInviteRemovals = sqliteTable(
  "access_invite_removals",
  {
    inviteId: text("invite_id")
      .primaryKey()
      .references(() => accessInviteCodes.id, { onDelete: "restrict" }),
    inviteVersion: integer("invite_version").notNull(),
    removedBy: text("removed_by").notNull(),
    removedAt: integer("removed_at").notNull(),
  },
  (table) => [
    index("access_invite_removals_removed_idx").on(table.removedAt),
    check(
      "access_invite_removals_version_valid",
      sql`${table.inviteVersion} > 0`,
    ),
    check(
      "access_invite_removals_actor_valid",
      sql`length(${table.removedBy}) BETWEEN 1 AND 255`,
    ),
    check(
      "access_invite_removals_timestamp_valid",
      sql`${table.removedAt} >= 0`,
    ),
  ],
);

// This is the sole beta authorization registry. Authorization is by Better
// Auth user id and state only; GitHub fields are immutable audit snapshots.
export const accessAllowlist = sqliteTable(
  "access_allowlist",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "restrict" }),
    state: text("state")
      .$type<"active" | "blocked">()
      .default("active")
      .notNull(),
    githubAccountId: text("github_account_id").notNull(),
    githubUsername: text("github_username").notNull(),
    sourceInviteId: text("source_invite_id")
      .notNull()
      .references(() => accessInviteCodes.id, { onDelete: "restrict" }),
    sourceLeaseId: text("source_lease_id").notNull(),
    grantedBy: text("granted_by"),
    grantReason: text("grant_reason").notNull(),
    grantedAt: integer("granted_at").notNull(),
    revocationId: text("revocation_id"),
    revokedBy: text("revoked_by"),
    revocationReason: text("revocation_reason"),
    revokedAt: integer("revoked_at"),
    revocationCleanupAttemptId: text("revocation_cleanup_attempt_id"),
    revocationCleanupStartedAt: integer("revocation_cleanup_started_at"),
    revocationCleanupCompletedAt: integer("revocation_cleanup_completed_at"),
  },
  (table) => [
    uniqueIndex("access_allowlist_github_account_uidx").on(
      table.githubAccountId,
    ),
    uniqueIndex("access_allowlist_source_invite_uidx").on(table.sourceInviteId),
    uniqueIndex("access_allowlist_revocation_uidx").on(table.revocationId),
    index("access_allowlist_state_idx").on(table.state, table.grantedAt),
    index("access_allowlist_granted_by_idx").on(table.grantedBy),
    check(
      "access_allowlist_state_valid",
      sql`
        (${table.state} = 'active'
          AND ${table.revocationId} is null
          AND ${table.revokedBy} is null
          AND ${table.revocationReason} is null
          AND ${table.revokedAt} is null
          AND ${table.revocationCleanupAttemptId} is null
          AND ${table.revocationCleanupStartedAt} is null
          AND ${table.revocationCleanupCompletedAt} is null)
        OR
        (${table.state} = 'blocked'
          AND ${table.revocationId} is not null
          AND ${table.revokedBy} is not null
          AND ${table.revocationReason} is not null
          AND ${table.revokedAt} is not null
          AND (
            (${table.revocationCleanupAttemptId} is null
              AND ${table.revocationCleanupStartedAt} is null
              AND ${table.revocationCleanupCompletedAt} is null)
            OR
            (${table.revocationCleanupAttemptId} is not null
              AND ${table.revocationCleanupStartedAt} is not null
              AND (${table.revocationCleanupCompletedAt} is null
                OR ${table.revocationCleanupCompletedAt} >= ${table.revocationCleanupStartedAt}))
          ))`,
    ),
  ],
);

export type AccessEventType =
  | "invite.created"
  | "invite.leased"
  | "invite.lease_released"
  | "invite.redeemed"
  | "invite.revoked"
  | "invite.replaced"
  | "invite.removed"
  | "invite.exchange_failed"
  | "invite.lease_failed"
  | "invite.claim_failed"
  | "access.granted"
  | "access.blocked"
  | "access.revocation_cleanup_failed"
  | "access.revocation_cleanup_stalled"
  | "access.revocation_cleanup_completed"
  | "access.reinvite_allowed";

// Event rows contain identifiers and normalized reason codes only. They must
// never contain raw invite codes, links, cookies, provider tokens, or IPs.
export const accessEvents = sqliteTable(
  "access_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").$type<AccessEventType>().notNull(),
    inviteId: text("invite_id"),
    subjectUserId: text("subject_user_id"),
    githubAccountId: text("github_account_id"),
    actorUserId: text("actor_user_id"),
    revocationId: text("revocation_id"),
    cleanupAttemptId: text("cleanup_attempt_id"),
    reason: text("reason"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("access_events_invite_idx").on(table.inviteId, table.createdAt),
    index("access_events_subject_idx").on(table.subjectUserId, table.createdAt),
    index("access_events_created_idx").on(table.createdAt),
  ],
);

// Authoring drafts: the HCL system-of-record for scenarios written in the
// app (repo/CI-authored scenarios don't appear here).
export const scenarioSources = sqliteTable(
  "scenario_sources",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    hcl: text("hcl").notNull(),
    status: text("status", {
      enum: ["draft", "published"],
    })
      .default("draft")
      .notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_sources_scenario_uidx").on(table.scenarioId),
    index("scenario_sources_organization_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
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
