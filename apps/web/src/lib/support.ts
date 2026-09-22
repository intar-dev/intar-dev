import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ne,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "@/db/client";
import { supportComments, supportTopics, user } from "@/db/schema";
import type { UserContext } from "./agent-bridge";
import { appError } from "./app-error";
import { createAppId } from "./id";
import {
  SUPPORT_LIMITS,
  SUPPORT_PAGE_SIZE,
  supportPage,
  type SupportComment,
  type SupportPage,
  type SupportSearch,
  type SupportTopic,
  type SupportTopicSummary,
  type SupportTopicType,
} from "./support-types";

type Actor = Pick<UserContext, "userId" | "isAdmin">;
const resolver = alias(user, "support_resolver");
const deletedAuthor = { id: null, name: "Deleted user" };
const {
  body: _body,
  authorId: _authorId,
  solvedById: _solvedById,
  ...summaryColumns
} = getTableColumns(supportTopics);
const topicSelection = {
  ...summaryColumns,
  author: { id: user.id, name: user.name },
  solvedBy: { id: resolver.id, name: resolver.name },
  commentCount:
    sql<number>`(select count(*) from ${supportComments} where ${supportComments.topicId} = ${supportTopics.id})`.mapWith(
      Number,
    ),
};

function topicPermissions(actor: Actor, authorId: string | null) {
  const own = authorId === actor.userId;
  return {
    canEdit: own,
    canDelete: own || actor.isAdmin,
    canResolve: own || actor.isAdmin,
  };
}

export async function listSupportTopics(
  actor: Actor,
  search: SupportSearch,
): Promise<SupportPage<SupportTopicSummary>> {
  const filters = and(
    search.type !== "all" ? eq(supportTopics.type, search.type) : undefined,
    search.status !== "all"
      ? eq(supportTopics.status, search.status)
      : undefined,
    search.mine ? eq(supportTopics.authorId, actor.userId) : undefined,
    search.q
      ? sql`(instr(lower(${supportTopics.title}), lower(${search.q})) > 0 or instr(lower(${supportTopics.body}), lower(${search.q})) > 0)`
      : undefined,
  );
  const [total] = await db
    .select({ count: count() })
    .from(supportTopics)
    .where(filters);
  const totalItems = total!.count;
  const page = Math.min(
    supportPage(search.page),
    Math.max(1, Math.ceil(totalItems / SUPPORT_PAGE_SIZE)),
  );
  const rows = await db
    .select(topicSelection)
    .from(supportTopics)
    .leftJoin(user, eq(user.id, supportTopics.authorId))
    .leftJoin(resolver, eq(resolver.id, supportTopics.solvedById))
    .where(filters)
    .orderBy(desc(supportTopics.lastActivityAt), desc(supportTopics.id))
    .limit(SUPPORT_PAGE_SIZE)
    .offset((page - 1) * SUPPORT_PAGE_SIZE);
  return {
    items: rows.map((row) => ({
      ...row,
      author: row.author ?? deletedAuthor,
      ...topicPermissions(actor, row.author?.id ?? null),
    })),
    page,
    pageSize: SUPPORT_PAGE_SIZE,
    totalItems,
  };
}

export async function getSupportTopic(
  actor: Actor,
  topicId: string,
): Promise<SupportTopic> {
  const [row] = await db
    .select({ ...topicSelection, body: supportTopics.body })
    .from(supportTopics)
    .leftJoin(user, eq(user.id, supportTopics.authorId))
    .leftJoin(resolver, eq(resolver.id, supportTopics.solvedById))
    .where(eq(supportTopics.id, topicId))
    .limit(1);
  if (!row) throw appError(404, "topic_not_found", "Topic not found");
  return {
    ...row,
    author: row.author ?? deletedAuthor,
    ...topicPermissions(actor, row.author?.id ?? null),
  };
}

function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw appError(
      400,
      "invalid_support_content",
      `${label} must contain 1 to ${limit} characters`,
    );
  }
  return value.trim();
}

function topicContent(input: Record<string, unknown>) {
  if (
    input.type !== "bug" &&
    input.type !== "help" &&
    input.type !== "feedback"
  ) {
    throw appError(400, "invalid_topic_type", "Select Bug, Help, or Feedback");
  }
  return {
    title: requiredText(input.title, "Title", SUPPORT_LIMITS.title),
    type: input.type as SupportTopicType,
    body: requiredText(input.body, "Description", SUPPORT_LIMITS.body),
  };
}

function requirePermission(allowed: boolean) {
  if (!allowed)
    throw appError(403, "support_forbidden", "You cannot change this post");
}

export async function createSupportTopic(
  actor: Actor,
  input: Record<string, unknown>,
): Promise<SupportTopic> {
  const content = topicContent(input);
  const id = createAppId();
  const now = Date.now();
  await db
    .insert(supportTopics)
    .values({
      id,
      authorId: actor.userId,
      ...content,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
  return getSupportTopic(actor, id);
}

export async function updateSupportTopic(
  actor: Actor,
  topicId: string,
  input: Record<string, unknown>,
): Promise<SupportTopic> {
  const topic = await getSupportTopic(actor, topicId);
  const now = Date.now();
  if ("status" in input) {
    requirePermission(topic.canResolve);
    if (
      (input.status !== "open" && input.status !== "solved") ||
      Object.keys(input).length !== 1
    ) {
      throw appError(
        400,
        "invalid_topic_status",
        "Set only an Open or Solved status",
      );
    }
    await db
      .update(supportTopics)
      .set({
        status: input.status,
        solvedAt: input.status === "solved" ? now : null,
        solvedById: input.status === "solved" ? actor.userId : null,
        lastActivityAt: now,
      })
      .where(
        and(
          eq(supportTopics.id, topicId),
          ne(supportTopics.status, input.status),
        ),
      );
  } else {
    requirePermission(topic.canEdit);
    await db
      .update(supportTopics)
      .set({ ...topicContent(input), updatedAt: now, lastActivityAt: now })
      .where(
        and(
          eq(supportTopics.id, topicId),
          eq(supportTopics.authorId, actor.userId),
        ),
      );
  }
  return getSupportTopic(actor, topicId);
}

export async function deleteSupportTopic(
  actor: Actor,
  topicId: string,
): Promise<void> {
  const topic = await getSupportTopic(actor, topicId);
  requirePermission(topic.canDelete);
  await db.delete(supportTopics).where(eq(supportTopics.id, topicId));
}

const commentSelection = {
  id: supportComments.id,
  topicId: supportComments.topicId,
  body: supportComments.body,
  createdAt: supportComments.createdAt,
  updatedAt: supportComments.updatedAt,
  author: { id: user.id, name: user.name },
};

async function getSupportComment(
  actor: Actor,
  topicId: string,
  commentId: string,
): Promise<SupportComment> {
  const [row] = await db
    .select(commentSelection)
    .from(supportComments)
    .leftJoin(user, eq(user.id, supportComments.authorId))
    .where(
      and(
        eq(supportComments.topicId, topicId),
        eq(supportComments.id, commentId),
      ),
    )
    .limit(1);
  if (!row) throw appError(404, "comment_not_found", "Comment not found");
  return {
    ...row,
    author: row.author ?? deletedAuthor,
    canEdit: row.author?.id === actor.userId,
    canDelete: row.author?.id === actor.userId || actor.isAdmin,
  };
}

export async function listSupportComments(
  actor: Actor,
  topicId: string,
  requestedPage: unknown,
): Promise<SupportPage<SupportComment>> {
  await getSupportTopic(actor, topicId);
  const [total] = await db
    .select({ count: count() })
    .from(supportComments)
    .where(eq(supportComments.topicId, topicId));
  const totalItems = total!.count;
  const page = Math.min(
    supportPage(requestedPage),
    Math.max(1, Math.ceil(totalItems / SUPPORT_PAGE_SIZE)),
  );
  const rows = await db
    .select(commentSelection)
    .from(supportComments)
    .leftJoin(user, eq(user.id, supportComments.authorId))
    .where(eq(supportComments.topicId, topicId))
    .orderBy(asc(supportComments.createdAt), asc(supportComments.id))
    .limit(SUPPORT_PAGE_SIZE)
    .offset((page - 1) * SUPPORT_PAGE_SIZE);
  return {
    items: rows.map((row) => ({
      ...row,
      author: row.author ?? deletedAuthor,
      canEdit: row.author?.id === actor.userId,
      canDelete: row.author?.id === actor.userId || actor.isAdmin,
    })),
    page,
    pageSize: SUPPORT_PAGE_SIZE,
    totalItems,
  };
}

export async function createSupportComment(
  actor: Actor,
  topicId: string,
  input: Record<string, unknown>,
): Promise<SupportComment> {
  const body = requiredText(input.body, "Comment", SUPPORT_LIMITS.comment);
  await getSupportTopic(actor, topicId);
  const now = Date.now();
  const id = createAppId();
  await db.batch([
    db
      .insert(supportComments)
      .values({
        id,
        topicId,
        authorId: actor.userId,
        body,
        createdAt: now,
        updatedAt: now,
      }),
    db
      .update(supportTopics)
      .set({ lastActivityAt: now })
      .where(eq(supportTopics.id, topicId)),
  ]);
  return getSupportComment(actor, topicId, id);
}

export async function updateSupportComment(
  actor: Actor,
  topicId: string,
  commentId: string,
  input: Record<string, unknown>,
): Promise<SupportComment> {
  const comment = await getSupportComment(actor, topicId, commentId);
  requirePermission(comment.canEdit);
  const body = requiredText(input.body, "Comment", SUPPORT_LIMITS.comment);
  const now = Date.now();
  await db.batch([
    db
      .update(supportComments)
      .set({ body, updatedAt: now })
      .where(
        and(
          eq(supportComments.id, commentId),
          eq(supportComments.topicId, topicId),
          eq(supportComments.authorId, actor.userId),
        ),
      ),
    db
      .update(supportTopics)
      .set({ lastActivityAt: now })
      .where(eq(supportTopics.id, topicId)),
  ]);
  return getSupportComment(actor, topicId, commentId);
}

export async function deleteSupportComment(
  actor: Actor,
  topicId: string,
  commentId: string,
): Promise<void> {
  const comment = await getSupportComment(actor, topicId, commentId);
  requirePermission(comment.canDelete);
  await db.batch([
    db
      .delete(supportComments)
      .where(
        and(
          eq(supportComments.id, commentId),
          eq(supportComments.topicId, topicId),
        ),
      ),
    db
      .update(supportTopics)
      .set({ lastActivityAt: Date.now() })
      .where(eq(supportTopics.id, topicId)),
  ]);
}
