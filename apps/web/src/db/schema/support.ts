import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { SupportStatus, SupportTopicType } from "@/lib/support-types";
import { user } from "./core";
import { nowMsDefault } from "./shared";

export const supportTopics = sqliteTable(
  "support_topics",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    type: text("type").$type<SupportTopicType>().notNull(),
    body: text("body").notNull(),
    status: text("status").$type<SupportStatus>().notNull().default("open"),
    createdAt: integer("created_at").notNull().default(nowMsDefault),
    updatedAt: integer("updated_at").notNull().default(nowMsDefault),
    lastActivityAt: integer("last_activity_at").notNull().default(nowMsDefault),
    solvedAt: integer("solved_at"),
    solvedById: text("solved_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    check(
      "support_topic_type",
      sql`${table.type} in ('bug', 'help', 'feedback')`,
    ),
    check("support_topic_status", sql`${table.status} in ('open', 'solved')`),
    check(
      "support_topic_resolution",
      sql`(${table.status} = 'open' and ${table.solvedAt} is null and ${table.solvedById} is null) or (${table.status} = 'solved' and ${table.solvedAt} is not null)`,
    ),
    index("support_topics_activity_idx").on(table.lastActivityAt, table.id),
    index("support_topics_author_idx").on(table.authorId, table.lastActivityAt),
    index("support_topics_status_idx").on(table.status, table.lastActivityAt),
  ],
);

export const supportComments = sqliteTable(
  "support_comments",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id")
      .notNull()
      .references(() => supportTopics.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(nowMsDefault),
    updatedAt: integer("updated_at").notNull().default(nowMsDefault),
  },
  (table) => [
    index("support_comments_topic_idx").on(
      table.topicId,
      table.createdAt,
      table.id,
    ),
    index("support_comments_author_idx").on(table.authorId),
  ],
);
