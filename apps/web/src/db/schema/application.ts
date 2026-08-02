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

// Strongly-consistent authorization source for GitHub sign-in and every
// authenticated request. Access-request rows are audit/workflow records; this
// table alone decides whether a username currently has access.
export const accessAllowlist = sqliteTable(
  "access_allowlist",
  {
    // Normalized (lowercased) GitHub username.
    githubUsername: text("github_username").primaryKey(),
    approvedBy: text("approved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    approvedAt: integer("approved_at").notNull(),
  },
  (table) => [index("access_allowlist_approved_by_idx").on(table.approvedBy)],
);

// One-row commissioning receipt for the destructive clean-D1 cutover. The
// protected workflow writes it before the first OAuth login and finalizes it
// only after the sole GitHub account is bound to the intended user. It is not
// a feature flag and must never be repurposed for ordinary administrator
// provisioning.
export const cleanD1Commissioning = sqliteTable(
  "clean_d1_commissioning",
  {
    id: text("id").primaryKey(),
    databaseName: text("database_name").notNull(),
    databaseId: text("database_id").notNull(),
    baselineSha256: text("baseline_sha256").notNull(),
    sourceSha: text("source_sha").notNull(),
    ownerGithubLogin: text("owner_github_login").notNull(),
    ownerGithubId: text("owner_github_id").notNull(),
    applyRunId: text("apply_run_id").notNull(),
    applyRunAttempt: integer("apply_run_attempt").notNull(),
    status: text("status", {
      enum: ["allowlisted", "owner_finalized"],
    }).notNull(),
    ownerUserId: text("owner_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "clean_d1_commissioning_singleton",
      sql`${table.id} = 'first-owner-v1'`,
    ),
    check(
      "clean_d1_commissioning_run_attempt",
      sql`${table.applyRunAttempt} = 1`,
    ),
    check(
      "clean_d1_commissioning_status",
      sql`${table.status} IN ('allowlisted', 'owner_finalized')`,
    ),
    check(
      "clean_d1_commissioning_owner_state",
      sql`(
        (${table.status} = 'allowlisted' AND ${table.ownerUserId} IS NULL)
        OR
        (${table.status} = 'owner_finalized' AND ${table.ownerUserId} IS NOT NULL)
      )`,
    ),
  ],
);

export const accessRequests = sqliteTable(
  "access_requests",
  {
    id: text("id").primaryKey(),
    // Normalized (lowercased) GitHub username — the allowlist key.
    githubUsername: text("github_username").notNull(),
    note: text("note"),
    status: text("status", {
      enum: ["pending", "approved", "rejected"],
    })
      .default("pending")
      .notNull(),
    decidedBy: text("decided_by").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("access_requests_username_uidx").on(table.githubUsername),
    index("access_requests_status_idx").on(table.status, table.createdAt),
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
