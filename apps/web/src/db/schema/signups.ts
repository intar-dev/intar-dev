import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { user } from "./core";

// One row, written by administrators. No row means a limit of 0: sign-ups stay
// closed until an administrator sets one.
export const signupSettings = sqliteTable(
  "signup_settings",
  {
    id: integer("id").primaryKey(),
    signupLimit: integer("signup_limit").notNull(),
    version: integer("version").default(1).notNull(),
    updatedBy: text("updated_by"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("signup_settings_singleton", sql`${table.id} = 1`),
    check(
      "signup_settings_limit_valid",
      sql`${table.signupLimit} BETWEEN 0 AND 1000000`,
    ),
    check("signup_settings_version_valid", sql`${table.version} > 0`),
  ],
);

// A spot held while a new member's GitHub account is being linked. It stops
// counting once the account exists and expires if the link never completes.
export const signupReservations = sqliteTable(
  "signup_reservations",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("signup_reservations_expires_idx").on(table.expiresAt),
    check(
      "signup_reservations_window_valid",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
