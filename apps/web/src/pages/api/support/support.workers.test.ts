import type { APIContext, APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import {
  member,
  organization,
  session,
  supportComments,
  supportTopics,
  user,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { revokeAccount } from "@/lib/access-revocation-store";
import {
  createSupportComment,
  createSupportTopic,
  getSupportTopic,
  listSupportTopics,
} from "@/lib/support";
import {
  validateSupportSearch,
  type SupportComment,
  type SupportPage,
  type SupportTopic,
} from "@/lib/support-types";
import { resetDatabase } from "@/test/database-migrations";
import { ensureFixtureMember } from "@/test/account-fixtures";
import * as topics from "./topics/index";
import * as topic from "./topics/[topicId]/index";
import * as comments from "./topics/[topicId]/comments/index";
import * as comment from "./topics/[topicId]/comments/[commentId]";

const actor = { userId: "reporter", isAdmin: false };
const input = {
  title: "Terminal does not open",
  type: "bug",
  body: "Open a run, then select Terminal.",
};
let cookies: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  cookies = {};
  for (const id of ["reporter", "reader", "moderator", "inactive"]) {
    await db
      .insert(user)
      .values({
        id,
        name: id,
        email: `${id}@example.test`,
        role: id === "moderator" ? "admin" : "user",
        banned: id === "inactive",
      });
    if (id !== "inactive")
      await ensureFixtureMember({ d1: env.DB, userId: id });
    await db
      .insert(session)
      .values({
        id: `session-${id}`,
        token: `token-${id}`,
        userId: id,
        expiresAt: new Date(Date.now() + 60_000),
      });
    cookies[id] = await signedSessionCookie(`token-${id}`);
  }
});

function call(
  route: APIRoute,
  method: string,
  path = "",
  body?: unknown,
  identity: string | null = "reporter",
) {
  const url = new URL(`http://localhost/api/support/topics${path}`);
  const parts = url.pathname.split("/");
  const request = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(identity ? { cookie: cookies[identity]! } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const context: Pick<APIContext, "request" | "url" | "params"> = {
    request,
    url,
    params: { topicId: parts[4], commentId: parts[6] },
  };
  return route(context as APIContext);
}

describe("support forum API", () => {
  it("shares topics across organizations and keeps profile email private", async () => {
    for (const id of ["reporter", "reader"]) {
      await db
        .insert(organization)
        .values({ id, name: id, slug: id, createdAt: new Date() });
      await db
        .insert(member)
        .values({
          id,
          userId: id,
          organizationId: id,
          role: "admin",
          createdAt: new Date(),
        });
    }
    const created = await call(topics.POST, "POST", "", input);
    expect(created.status).toBe(201);
    const { topic: item } = (await created.json()) as { topic: SupportTopic };
    const list = await call(topics.GET, "GET", "", undefined, "reader");
    const data = (await list.json()) as SupportPage<SupportTopic>;
    expect(data.items[0]).toMatchObject({
      id: item.id,
      status: "open",
      author: { name: "reporter" },
      canEdit: false,
      canDelete: false,
      canResolve: false,
    });
    expect(JSON.stringify(data)).not.toContain("@example.test");
    expect(data.items[0]).not.toHaveProperty("body");
    const blocked = await call(
      topic.PATCH,
      "PATCH",
      `/${item.id}`,
      { status: "solved" },
      "reader",
    );
    expect(blocked.status).toBe(403);
  });

  it.each([null, "inactive"])(
    "checks access on every endpoint for %s",
    async (identity) => {
      for (const [route, method, path] of [
        [topics.GET, "GET", ""],
        [topics.POST, "POST", ""],
        [topic.GET, "GET", "/topic"],
        [topic.PATCH, "PATCH", "/topic"],
        [topic.DELETE, "DELETE", "/topic"],
        [comments.GET, "GET", "/topic/comments"],
        [comments.POST, "POST", "/topic/comments"],
        [comment.PATCH, "PATCH", "/topic/comments/comment"],
        [comment.DELETE, "DELETE", "/topic/comments/comment"],
      ] as const) {
        const response = await call(route, method, path, undefined, identity);
        expect(response.status).toBe(identity === null ? 401 : 403);
      }
    },
  );

  it("allows only the author or a platform administrator to solve and reopen", async () => {
    const item = await createSupportTopic(actor, input);
    expect(
      (
        await call(
          topic.PATCH,
          "PATCH",
          `/${item.id}`,
          { status: "solved" },
          "reader",
        )
      ).status,
    ).toBe(403);
    const solved = await call(topic.PATCH, "PATCH", `/${item.id}`, {
      status: "solved",
    });
    const { topic: resolved } = (await solved.json()) as {
      topic: SupportTopic;
    };
    expect(resolved).toMatchObject({
      status: "solved",
      solvedBy: { id: "reporter", name: "reporter" },
    });
    expect(resolved.solvedAt).toEqual(expect.any(Number));
    const repeat = await call(
      topic.PATCH,
      "PATCH",
      `/${item.id}`,
      { status: "solved" },
      "moderator",
    );
    expect(
      ((await repeat.json()) as { topic: SupportTopic }).topic.solvedAt,
    ).toBe(resolved.solvedAt);
    expect(
      (
        await call(
          comments.POST,
          "POST",
          `/${item.id}/comments`,
          { body: "This also works for me." },
          "reader",
        )
      ).status,
    ).toBe(201);
    const reopened = await call(
      topic.PATCH,
      "PATCH",
      `/${item.id}`,
      { status: "open" },
      "moderator",
    );
    expect(
      ((await reopened.json()) as { topic: SupportTopic }).topic,
    ).toMatchObject({ status: "open", solvedAt: null, solvedBy: null });
    expect(
      (await call(topic.PATCH, "PATCH", `/${item.id}`, input, "moderator"))
        .status,
    ).toBe(403);
  });

  it("rejects a session after access is revoked", async () => {
    await revokeAccount({
      d1: env.DB,
      userId: "reporter",
      actorUserId: "moderator",
      reason: "forum_test",
    });
    expect((await call(topics.GET, "GET")).status).toBe(403);
    expect((await call(topics.POST, "POST", "", input)).status).toBe(403);
  });

  it("edits owned content, rejects other authors, and cascades topic deletion", async () => {
    const item = await createSupportTopic(actor, input);
    expect(
      (
        await call(topic.PATCH, "PATCH", `/${item.id}`, {
          ...input,
          title: "Updated title",
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(topic.DELETE, "DELETE", `/${item.id}`, undefined, "reader"))
        .status,
    ).toBe(403);
    const created = await call(
      comments.POST,
      "POST",
      `/${item.id}/comments`,
      { body: "A reply" },
      "reader",
    );
    const { comment: reply } = (await created.json()) as {
      comment: SupportComment;
    };
    expect(
      (
        await call(comment.PATCH, "PATCH", `/${item.id}/comments/${reply.id}`, {
          body: "Changed",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(comment.DELETE, "DELETE", `/${item.id}/comments/${reply.id}`))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          comment.PATCH,
          "PATCH",
          `/${item.id}/comments/${reply.id}`,
          { body: "Changed" },
          "reader",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          comment.DELETE,
          "DELETE",
          `/wrong-topic/comments/${reply.id}`,
          undefined,
          "moderator",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          comment.DELETE,
          "DELETE",
          `/${item.id}/comments/${reply.id}`,
          undefined,
          "moderator",
        )
      ).status,
    ).toBe(204);
    await createSupportComment(actor, item.id, { body: "Another reply" });
    expect((await call(topic.DELETE, "DELETE", `/${item.id}`)).status).toBe(
      204,
    );
    expect(await db.select().from(supportComments)).toEqual([]);
    expect((await call(topic.GET, "GET", `/${item.id}`)).status).toBe(404);
    expect(
      (
        await call(comments.POST, "POST", `/${item.id}/comments`, {
          body: "Too late",
        })
      ).status,
    ).toBe(404);
    const another = await createSupportTopic(actor, input);
    expect(
      (
        await call(
          topic.DELETE,
          "DELETE",
          `/${another.id}`,
          undefined,
          "moderator",
        )
      ).status,
    ).toBe(204);
  });

  it("rejects empty, oversized, malformed, and mixed status/content input", async () => {
    for (const body of [
      null,
      [],
      { ...input, title: " " },
      { ...input, title: "x".repeat(161) },
      { ...input, body: "x".repeat(20_001) },
      { ...input, type: "other" },
    ]) {
      expect((await call(topics.POST, "POST", "", body)).status).toBe(400);
    }
    const item = await createSupportTopic(actor, input);
    for (const body of [" ", "x".repeat(10_001), 42]) {
      expect(
        (await call(comments.POST, "POST", `/${item.id}/comments`, { body }))
          .status,
      ).toBe(400);
    }
    for (const body of [{ status: "closed" }, { ...input, status: "solved" }]) {
      expect(
        (await call(topic.PATCH, "PATCH", `/${item.id}`, body)).status,
      ).toBe(400);
    }
  });

  it("paginates and filters topics, and updates activity with comments", async () => {
    for (let i = 0; i < 23; i++)
      await db.insert(supportTopics).values({
        id: `topic-${String(i).padStart(2, "0")}`,
        authorId: i % 2 ? "reader" : "reporter",
        ...input,
        type: "bug" as const,
        title: `Topic ${i}`,
        body: i === 5 ? "unique search phrase" : input.body,
        createdAt: i + 1,
        updatedAt: i + 1,
        lastActivityAt: i + 1,
      });
    const first = await listSupportTopics(actor, validateSupportSearch({}));
    const second = await listSupportTopics(
      actor,
      validateSupportSearch({ page: 2 }),
    );
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(3);
    expect(first.items[0]!.id).toBe("topic-22");
    expect(
      (
        await listSupportTopics(
          actor,
          validateSupportSearch({ q: "UNIQUE SEARCH" }),
        )
      ).items[0]!.id,
    ).toBe("topic-05");
    expect(
      (await listSupportTopics(actor, validateSupportSearch({ mine: true })))
        .totalItems,
    ).toBe(12);
    expect(
      (await listSupportTopics(actor, validateSupportSearch({ type: "help" })))
        .totalItems,
    ).toBe(0);
    expect(
      (
        await listSupportTopics(
          actor,
          validateSupportSearch({ status: "solved" }),
        )
      ).totalItems,
    ).toBe(0);
    await createSupportComment(actor, "topic-00", { body: "New activity" });
    const refreshed = await listSupportTopics(actor, validateSupportSearch({}));
    expect(refreshed.items[0]).toMatchObject({
      id: "topic-00",
      commentCount: 1,
    });
    for (let i = 0; i < 21; i++)
      await db
        .insert(supportComments)
        .values({
          id: `comment-${i}`,
          topicId: "topic-00",
          authorId: "reader",
          body: `Reply ${i}`,
          createdAt: i + 1,
          updatedAt: i + 1,
        });
    const response = await call(
      comments.GET,
      "GET",
      "/topic-00/comments?page=2",
    );
    const page = (await response.json()) as SupportPage<SupportComment>;
    expect(page).toMatchObject({ totalItems: 22, page: 2, pageSize: 20 });
    expect(page.items.map((entry) => entry.body)).toEqual([
      "Reply 20",
      "New activity",
    ]);
  });

  it("keeps posts readable when accounts become deleted or are removed", async () => {
    const item = await createSupportTopic(actor, input);
    await call(topic.PATCH, "PATCH", `/${item.id}`, { status: "solved" });
    await db
      .update(user)
      .set({
        name: "Deleted user",
        email: "deleted@example.invalid",
        deletedAt: new Date(),
      })
      .where(eq(user.id, "reporter"));
    expect(
      (await getSupportTopic({ userId: "reader", isAdmin: false }, item.id))
        .author.name,
    ).toBe("Deleted user");
    // Foreign-key behavior also supports a hard-deleted identity.
    await db
      .insert(user)
      .values({
        id: "temporary",
        name: "Temporary",
        email: "temporary@example.test",
      });
    const reply = await createSupportComment(
      { userId: "temporary", isAdmin: false },
      item.id,
      { body: "Retained reply" },
    );
    await db.delete(user).where(eq(user.id, "temporary"));
    const response = await call(
      comments.GET,
      "GET",
      `/${item.id}/comments`,
      undefined,
      "reader",
    );
    expect(
      ((await response.json()) as SupportPage<SupportComment>).items[0],
    ).toMatchObject({
      id: reply.id,
      author: { id: null, name: "Deleted user" },
    });
  });

  it("rolls back a comment when its topic activity update fails", async () => {
    const item = await createSupportTopic(actor, input);
    await env.DB.exec(
      "CREATE TRIGGER support_test_failure BEFORE UPDATE ON support_topics BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        (
          await call(comments.POST, "POST", `/${item.id}/comments`, {
            body: "Must not remain",
          })
        ).status,
      ).toBe(500);
      expect(await db.select().from(supportComments)).toEqual([]);
      expect((await getSupportTopic(actor, item.id)).lastActivityAt).toBe(
        item.lastActivityAt,
      );
    } finally {
      await env.DB.exec("DROP TRIGGER support_test_failure");
      log.mockRestore();
    }
  });
});

async function signedSessionCookie(token: string): Promise<string> {
  const context = await auth.$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`;
}
