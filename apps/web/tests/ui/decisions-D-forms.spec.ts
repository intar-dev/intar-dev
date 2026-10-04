import type { Page } from "@playwright/test";
import type { SupportTopic } from "../../src/lib/support-types";
import { FIXED_NOW } from "./fixtures/data";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

// Decisions 22, 24 and 34: the forum topic's title is the page heading, form
// inputs stop at --field-max while search inputs stretch, and failed requests
// say what happened in plain words, at the field they are about.

const author = { id: "user-learner", name: "Mina Learner" };

function fixtureTopic(): SupportTopic {
  return {
    id: "terminal-help",
    title: "Terminal does not connect after a run starts",
    type: "bug",
    status: "open",
    body: "The run starts, but the terminal stays on **Connecting**.",
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
  };
}

async function mockTopic(
  page: Page,
  refuse?: { status: number; body: unknown },
) {
  const topic = fixtureTopic();
  await page.route("**/api/support/topics{,/**,?*}", async (route) => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split("/");
    if (request.method() !== "GET" && refuse) {
      return route.fulfill({ status: refuse.status, json: refuse.body });
    }
    if (parts[5] === "comments") {
      return route.fulfill({
        json: { items: [], totalItems: 0, page: 1, pageSize: 12 },
      });
    }
    if (parts[4] === topic.id) return route.fulfill({ json: { topic } });
    return route.fulfill({
      json: { items: [topic], totalItems: 1, page: 1, pageSize: 12 },
    });
  });
  return topic;
}

test("the topic title is the page heading and the bar shows the forum", async ({
  page,
  ui,
}) => {
  const topic = await mockTopic(page);
  await ui.open({ path: `/support/${topic.id}`, sessionRole: "learner" });

  const headings = page.getByRole("heading", { level: 1 });
  await expect(headings).toHaveCount(1);
  await expect(headings).toHaveText(topic.title);
  // The article is named by its heading, and the old "Topic" label is gone.
  await expect(page.getByRole("article", { name: topic.title })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Topic", exact: true })).toHaveCount(0);
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "Forum" })).toHaveAttribute(
    "href",
    "/support",
  );
  await expect(crumbs).not.toContainText(topic.title);
});

test("form inputs stop at the field width and search inputs stretch", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockTopic(page);
  await ui.open({ path: "/support/new", sessionRole: "learner" });
  const title = page.getByLabel("Title", { exact: true });
  const description = page.getByLabel("Description", { exact: true });
  for (const field of [title, description]) {
    const box = await field.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(448 + 1);
    expect(box!.width).toBeGreaterThan(300);
  }

  await ui.open({ path: "/support", sessionRole: "learner" });
  const search = page.getByRole("searchbox");
  await expect(search).toBeVisible();
  expect(await search.evaluate((node) => getComputedStyle(node).maxWidth)).toBe(
    "none",
  );
});

test("a refused title is said at the title field", async ({ page, ui }) => {
  await mockTopic(page, {
    status: 409,
    body: { error: "A topic with this title already exists" },
  });
  await ui.open({ path: "/support/new", sessionRole: "learner" });
  await page.getByLabel("Title", { exact: true }).fill("Hi");
  await page.getByLabel("Description", { exact: true }).fill("Details");
  // The harness allows one 409 console line, counted here.
  ui.server.expectedNativeSshNoProfileConflicts = 1;
  await page.getByRole("button", { name: "Create topic" }).click();

  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toHaveText(
    "A topic with this title already exists.",
  );
  await expect(page.getByLabel("Description", { exact: true })).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a server fault is said on the form, in plain words", async ({
  page,
  ui,
}) => {
  await mockTopic(page, { status: 503, body: { error: "do binding: no such table" } });
  await ui.open({ path: "/support/new", sessionRole: "learner" });
  await page.getByLabel("Title", { exact: true }).fill("A real title");
  await page.getByLabel("Description", { exact: true }).fill("Details");
  ui.server.state.variant = "error";
  await page.getByRole("button", { name: "Create topic" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(
    "Intar is temporarily unavailable. Try again in a moment.",
  );
  await expect(page.getByLabel("Title", { exact: true })).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("a taken organization name is said at the name field", async ({
  page,
  ui,
}) => {
  await page.route("**/api/organizations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 409,
      json: { error: "Organization name is already taken" },
    });
  });
  await ui.open(routeCase("organizations"));
  ui.server.state.organizationCreation = { enabled: true, reason: null };
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page.getByRole("button", { name: "New organization" }).click();
  const sheet = page.getByRole("dialog", { name: "Create an organization" });
  const name = sheet.getByLabel("Organization name");
  await name.fill("Night shift");
  ui.server.expectedNativeSshNoProfileConflicts = 1;
  await sheet.getByRole("button", { name: "Create" }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(sheet.getByRole("alert")).toHaveText(
    "Organization name is already taken.",
  );
});
