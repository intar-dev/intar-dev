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

// Revocation is terminal. The user row carries the access decision
// (`banned`); this row is the audit record and the cleanup ledger that user
// deletion requires to be complete.
export const accessRevocations = sqliteTable(
  "access_revocations",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "restrict" }),
    revocationId: text("revocation_id").notNull(),
    revokedBy: text("revoked_by").notNull(),
    reason: text("reason").notNull(),
    revokedAt: integer("revoked_at").notNull(),
    cleanupAttemptId: text("cleanup_attempt_id"),
    cleanupStartedAt: integer("cleanup_started_at"),
    cleanupCompletedAt: integer("cleanup_completed_at"),
  },
  (table) => [
    uniqueIndex("access_revocations_revocation_uidx").on(table.revocationId),
    check(
      "access_revocations_audit_valid",
      sql`length(${table.revokedBy}) BETWEEN 1 AND 255 AND length(${table.reason}) BETWEEN 1 AND 120 AND ${table.revokedAt} >= 0`,
    ),
    check(
      "access_revocations_cleanup_valid",
      sql`
        (${table.cleanupAttemptId} is null
          AND ${table.cleanupStartedAt} is null
          AND ${table.cleanupCompletedAt} is null)
        OR
        (${table.cleanupAttemptId} is not null
          AND ${table.cleanupStartedAt} is not null
          AND (${table.cleanupCompletedAt} is null
            OR ${table.cleanupCompletedAt} >= ${table.cleanupStartedAt}))`,
    ),
  ],
);

export type AccessEventType =
  | "access.blocked"
  | "access.revocation_cleanup_failed"
  | "access.revocation_cleanup_stalled"
  | "access.revocation_cleanup_completed"
  | "run.deleted_by_admin"
  | "user.deleted"
  | "signups.limit_changed"
  | "sso.external_email_signups_changed";

// Event rows contain identifiers and normalized reason codes only. They must
// never contain links, cookies, provider tokens, or IPs. Rows written before
// the invite gate was removed keep their historical invite ids.
export const accessEvents = sqliteTable(
  "access_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").$type<AccessEventType>().notNull(),
    inviteId: text("invite_id"),
    subjectUserId: text("subject_user_id"),
    githubAccountId: text("github_account_id"),
    // The person's first organization identity: its provider and subject.
    // Like the GitHub id, it outlives the account rows user deletion removes.
    ssoProviderId: text("sso_provider_id"),
    ssoAccountId: text("sso_account_id"),
    actorUserId: text("actor_user_id"),
    revocationId: text("revocation_id"),
    cleanupAttemptId: text("cleanup_attempt_id"),
    runId: text("run_id"),
    reason: text("reason"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("access_events_invite_idx").on(table.inviteId, table.createdAt),
    index("access_events_subject_idx").on(table.subjectUserId, table.createdAt),
    index("access_events_run_idx").on(table.runId, table.createdAt),
    index("access_events_created_idx").on(table.createdAt),
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
