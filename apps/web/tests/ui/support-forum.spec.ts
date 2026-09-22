import type { Page } from "@playwright/test";
import type { SupportComment, SupportTopic } from "../../src/lib/support-types";
import { FIXED_NOW } from "./fixtures/data";
import { test, expect } from "./fixtures/test";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

const author = { id: "user-learner", name: "Mina Learner" };
function fixtureTopic(overrides: Partial<SupportTopic> = {}): SupportTopic {
  return {
    id: "terminal-help",
    title: "Terminal does not connect after a run starts",
    type: "bug",
    status: "open",
    body: "The run starts, but the terminal stays on **Connecting**.\n\nSteps to reproduce:\n\n1. Start the Nginx repair scenario.\n2. Open the terminal.\n\nExpected: a shell prompt. The page still shows Connecting after one minute.\n\n```text\nConnecting to the scenario…\n```",
    author,
    createdAt: FIXED_NOW - 3_600_000,
    updatedAt: FIXED_NOW - 3_600_000,
    lastActivityAt: FIXED_NOW - 60_000,
    solvedAt: null,
    solvedBy: null,
    commentCount: 0,
    canEdit: true,
    canDelete: true,
    canResolve: true,
    ...overrides,
  };
}

async function mockForum(page: Page, initial = [fixtureTopic()]) {
  const state = {
    topics: initial,
    comments: [] as SupportComment[],
    failWrite: false,
    failRead: false,
    missing: false,
    requests: [] as string[],
  };
  await page.route("**/api/support/topics{,/**,?*}", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const parts = url.pathname.split("/");
    const topicId = parts[4];
    const commentId = parts[6];
    state.requests.push(`${method} ${url.pathname}${url.search}`);
    if (
      (state.failWrite && method !== "GET") ||
      (state.failRead && method === "GET")
    ) {
      return route.fulfill({
        status: 503,
        json: { error: "The forum is unavailable. Try again." },
      });
    }
    if (
      topicId &&
      (state.missing || !state.topics.some((topic) => topic.id === topicId))
    ) {
      return route.fulfill({ status: 404, json: { error: "Topic not found" } });
    }
    const body =
      method === "POST" || method === "PATCH"
        ? request.postDataJSON()
        : undefined;
    const topic = state.topics.find((entry) => entry.id === topicId);
    if (parts[5] === "comments") {
      if (method === "GET") {
        const all = state.comments.filter((item) => item.topicId === topicId);
        const pageNumber = Math.min(
          Number(url.searchParams.get("page")) || 1,
          Math.max(1, Math.ceil(all.length / 20)),
        );
        return route.fulfill({
          json: {
            items: all.slice((pageNumber - 1) * 20, pageNumber * 20),
            totalItems: all.length,
            page: pageNumber,
            pageSize: 20,
          },
        });
      }
      if (method === "POST") {
        const reply: SupportComment = {
          id: `reply-${state.comments.length}`,
          topicId: topicId!,
          body: body.body,
          author,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
          canEdit: true,
          canDelete: true,
        };
        state.comments.push(reply);
        topic!.commentCount++;
        return route.fulfill({ status: 201, json: { comment: reply } });
      }
      const reply = state.comments.find((item) => item.id === commentId)!;
      if (method === "PATCH") {
        reply.body = body.body;
        return route.fulfill({ json: { comment: reply } });
      }
      state.comments = state.comments.filter((item) => item.id !== commentId);
      topic!.commentCount--;
      return route.fulfill({ status: 204 });
    }
    if (method === "POST") {
      const item = fixtureTopic({ ...body, id: "new-topic" });
      state.topics.unshift(item);
      return route.fulfill({ status: 201, json: { topic: item } });
    }
    if (topic) {
      if (method === "DELETE") {
        state.topics = state.topics.filter((item) => item.id !== topicId);
        state.comments = state.comments.filter(
          (item) => item.topicId !== topicId,
        );
        return route.fulfill({ status: 204 });
      }
      if (method === "PATCH") {
        Object.assign(topic, body);
        if (body.status)
          Object.assign(topic, {
            solvedAt: body.status === "solved" ? FIXED_NOW : null,
            solvedBy: body.status === "solved" ? author : null,
          });
      }
      return route.fulfill({ json: { topic } });
    }
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    const all = state.topics.filter(
      (item) =>
        (!type || type === "all" || item.type === type) &&
        (!status || status === "all" || item.status === status) &&
        `${item.title} ${item.body}`.toLowerCase().includes(q) &&
        (url.searchParams.get("mine") !== "true" ||
          item.author.id === author.id),
    );
    const pageNumber = Math.min(
      Number(url.searchParams.get("page")) || 1,
      Math.max(1, Math.ceil(all.length / 20)),
    );
    return route.fulfill({
      json: {
        items: all.slice((pageNumber - 1) * 20, pageNumber * 20),
        totalItems: all.length,
        page: pageNumber,
        pageSize: 20,
      },
    });
  });
  return state;
}

test("create, comment, solve, reopen, edit, and delete a topic", async ({
  page,
  ui,
}) => {
  await mockForum(page, []);
  await ui.open({ path: "/support", sessionRole: "learner" });
  await expect(
    page.getByRole("heading", { name: "Start a conversation" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "New topic" }).first().click();
  await page.getByLabel("Title", { exact: true }).fill("Terminal disconnects");
  await page.getByLabel("Type", { exact: true }).selectOption("bug");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Open the terminal. It **disconnects**.");
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(
    page.getByRole("heading", { name: "Terminal disconnects", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Add a comment", { exact: true })
    .fill("I can reproduce this with a new run.");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(
    page.getByText("I can reproduce this with a new run.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Add a comment", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Mark as solved" }).click();
  await expect(
    page.getByText(/Marked as solved by Mina Learner/),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Add a comment", { exact: true })
    .fill("Thanks. The fix works.");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(
    page.getByText("Thanks. The fix works.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Mark as solved" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit comment", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Edit comment", { exact: true })
    .fill("Updated reproduction steps.");
  await page.getByRole("button", { name: "Save comment" }).click();
  await expect(
    page.getByText("Updated reproduction steps.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({
      has: page.getByText("Updated reproduction steps.", { exact: true }),
    })
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    page.getByText("Updated reproduction steps.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Edit topic", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Terminal disconnects after reconnect");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Terminal disconnects after reconnect",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete topic", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "including comments from other users",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Delete topic", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete topic", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Start a conversation" }),
  ).toBeVisible();
});

test("keeps search, filters, and pagination in the URL", async ({
  page,
  ui,
}) => {
  const state = await mockForum(
    page,
    Array.from({ length: 23 }, (_, index) =>
      fixtureTopic({ id: `topic-${index}`, title: `Terminal report ${index}` }),
    ),
  );
  await ui.open({ path: "/support", sessionRole: "learner" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(
    page.getByRole("link", { name: "Terminal report 22", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search topics", { exact: true }).fill("report 22");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/page=1/);
  await page.getByLabel("Type", { exact: true }).selectOption("bug");
  await page.getByLabel("Status", { exact: true }).selectOption("solved");
  await expect(
    page.getByRole("heading", { name: "No topics match these filters" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("all");
  await page.getByLabel("My topics", { exact: true }).check();
  await expect.poll(() => state.requests.at(-1)).toContain("mine=true");
});

test("preserves drafts after failed writes and shows missing topics", async ({
  page,
  ui,
}) => {
  const state = await mockForum(page);
  await ui.open({ path: "/support/new", sessionRole: "learner" });
  await page.getByLabel("Title", { exact: true }).fill("Keep this title");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Keep this description");
  state.failWrite = true;
  ui.server.state.variant = "error";
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Keep this title",
  );
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Keep this description",
  );
  state.failWrite = false;
  await page.getByRole("button", { name: "Create topic" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep this title", exact: true }),
  ).toBeVisible();
  state.failWrite = true;
  await page
    .getByLabel("Add a comment", { exact: true })
    .fill("Keep this comment");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await expect(page.getByLabel("Add a comment", { exact: true })).toHaveValue(
    "Keep this comment",
  );
  state.missing = true;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Topic not found" }),
  ).toBeVisible();
});

test("hides owner controls for other users", async ({ page, ui }) => {
  await mockForum(page, [
    fixtureTopic({ canEdit: false, canDelete: false, canResolve: false }),
  ]);
  await ui.open({ path: "/support/terminal-help", sessionRole: "learner" });
  await expect(page.getByLabel("Add a comment", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Edit topic|Delete topic|Mark as solved/,
    }),
  ).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`forum pages are accessible at ${width}px in ${theme} mode`, async ({
      page,
      ui,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const state = await mockForum(page, [
        fixtureTopic(),
        fixtureTopic({
          id: "solved-help",
          title: "How can I save the commands from a run?",
          type: "help",
          status: "solved",
          solvedAt: FIXED_NOW - 120_000,
          solvedBy: author,
        }),
        fixtureTopic({
          id: "feedback",
          title: "Show the next lecture after a completed run",
          type: "feedback",
        }),
      ]);
      state.comments.push({
        id: "reply",
        topicId: "terminal-help",
        author: { id: "user-other", name: "Sam Operator" },
        body: "I see the same behavior. Reloading the page connects the terminal.",
        createdAt: FIXED_NOW - 60_000,
        updatedAt: FIXED_NOW - 60_000,
        canEdit: false,
        canDelete: false,
      });
      state.topics[0]!.commentCount = 1;
      for (const [name, path] of [
        ["list", "/support"],
        ["topic", "/support/terminal-help"],
        ["new", "/support/new"],
      ]) {
        await ui.open({ path: path!, sessionRole: "learner", theme });
        if (name === "list")
          await expect(
            page.getByRole("link", {
              name: state.topics[0]!.title,
              exact: true,
            }),
          ).toBeVisible();
        if (name === "topic")
          await expect(
            page.getByLabel("Add a comment", { exact: true }),
          ).toBeVisible();
        if (name === "new")
          await expect(
            page.getByLabel("Description", { exact: true }),
          ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page, testInfo);
        await expect(page).toHaveScreenshot(
          `support-${name}-${theme}-${width}.png`,
          { fullPage: true },
        );
      }
    });
  }
}
