import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organization, ssoProvider, user } from "./core";

// Written only by platform administrators. No row means sign-ups through the
// provider are limited to emails on its verified domain. A re-registered
// provider gets a new provider id, so it starts without an approval.
export const ssoProviderPolicies = sqliteTable(
  "sso_provider_policies",
  {
    providerId: text("provider_id")
      .primaryKey()
      .references(() => ssoProvider.providerId, { onDelete: "cascade" }),
    allowExternalEmailSignups: integer("allow_external_email_signups", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "sso_provider_policies_audit_valid",
      sql`length(${table.updatedBy}) BETWEEN 1 AND 255 AND ${table.updatedAt} >= 0`,
    ),
  ],
);

// A person an organization admin removed. The organization's identity
// provider can neither sign them in nor add them back until an admin
// restores them. Leaving an organization records nothing. Deleting the user
// keeps the row, so the removal of their logins below holds.
export const organizationMemberRemovals = sqliteTable(
  "organization_member_removals",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    removedBy: text("removed_by").notNull(),
    removedAt: integer("removed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_member_removals_user_idx").on(table.userId),
    check(
      "organization_member_removals_audit_valid",
      sql`length(${table.removedBy}) BETWEEN 1 AND 255 AND ${table.removedAt} >= 0`,
    ),
  ],
);

// The logins a removed person had at the organization's providers when they
// were removed, by issuer and subject. The provider can't sign these logins in
// or connect them to any account, including a new one, while the removal
// stands: after the identity row is gone because the person was deleted or
// the provider registered again. Restoring the person lifts them.
export const organizationMemberRemovedLogins = sqliteTable(
  "organization_member_removed_logins",
  {
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.issuer, table.subject],
    }),
    foreignKey({
      columns: [table.organizationId, table.userId],
      foreignColumns: [
        organizationMemberRemovals.organizationId,
        organizationMemberRemovals.userId,
      ],
    }).onDelete("cascade"),
    index("organization_member_removed_logins_removal_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);
