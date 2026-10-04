import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { makeMultiReplayRun } from "./fixtures/data";
import { ROUTE_CASES, routeCase } from "./routes";
import {
  coarsePointerTargetViolations,
  expectNoHorizontalOverflow,
} from "./support/layout";
import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_FONT_LOAD,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_ROWS,
} from "../../src/lib/replay/config";

async function expectNoVisibleBoxShadow(locator: Locator) {
  const result = await locator.evaluate((element) => {
    const value = getComputedStyle(element).boxShadow;
    const alphas = [...value.matchAll(/rgba\([^)]*,\s*([0-9.]+)\)/g)].map(
      (match) => Number.parseFloat(match[1] ?? "1"),
    );
    return {
      value,
      visible: value !== "none" && (alphas.length === 0 || alphas.some((a) => a > 0)),
    };
  });
  expect(result.visible, `unexpected visible box shadow: ${result.value}`).toBe(
    false,
  );
}

async function expectForegroundRunWorkspaceShell(page: Page) {
  const workspaceHeader = page.locator("[data-run-workspace-header]");
  const appBar = page.locator("header").filter({
    has: page.locator("[data-slot='sidebar-trigger']"),
  });

  await expect(page.locator("[data-run-page]")).toHaveCount(1);
  await expect(workspaceHeader).toHaveCount(1);
  await expect(
    page
      .locator("[data-run-navigation]")
      .getByRole("link", { name: "Back to lecture" }),
  ).toBeVisible();
  await expect(page.locator("[data-slot='sidebar']")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
  await expect(appBar).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Page actions" }),
  ).toHaveCount(0);
}

async function expectSavedRunShell(page: Page) {
  const appBar = page.locator("header").filter({
    has: page.locator("[data-slot='sidebar-trigger']"),
  });

  await expect(page.locator("[data-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-course-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-run-workspace-header]")).toHaveCount(0);
  await expect(page.locator("[data-run-navigation]")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(1);
  await expect(appBar).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Repair a broken nginx service",
    }),
  ).toBeVisible();
  await expect(page.locator("[data-run-back]")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Page actions" }),
  ).toHaveCount((page.viewportSize()?.width ?? 0) < 640 ? 1 : 0);

}

async function expectShutdownRunShell(page: Page) {
  await expect(page.locator("[data-run-page]")).toHaveCount(1);
  await expect(page.locator("[data-run-shutdown-sequence]")).toBeVisible();
  await expect(page.locator("[data-run-workspace-header]")).toHaveCount(1);
  await expect(page.locator("[data-run-back]")).toBeVisible();
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(page.locator("[data-run-learning-panel]")).toBeVisible();
  } else {
    await expect(page.locator("[data-run-learning-panel]")).toBeHidden();
    await expect(
      page.locator("[data-run-learning-panel-trigger]"),
    ).toBeVisible();
  }
}

test("keyboard-only landing navigation keeps focus visible", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      const rect = active.getBoundingClientRect();
      const outlineVisible =
        style.outlineStyle !== "none" &&
        Number.parseFloat(style.outlineWidth) >= 1;
      const shadowVisible = style.boxShadow !== "none";
      return {
        label:
          active.getAttribute("aria-label") ??
          active.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
          active.tagName,
        tag: active.tagName,
        focusVisible: active.matches(":focus-visible"),
        indicatorVisible: outlineVisible || shadowVisible,
        visible: rect.width > 0 && rect.height > 0,
      };
    });

    expect(focus, `Tab stop ${index + 1} must exist`).not.toBeNull();
    expect(
      focus?.tag,
      `Tab stop ${index + 1} must not leave focus on the document body`,
    ).not.toMatch(/^(BODY|HTML)$/);
    expect(
      focus?.focusVisible,
      `Tab stop ${index + 1} (${focus?.label}) must match :focus-visible`,
    ).toBe(true);
    expect(
      focus?.indicatorVisible,
      `Tab stop ${index + 1} (${focus?.label}) must render an outline or focus ring`,
    ).toBe(true);
    expect(focus?.visible, `Tab stop ${index + 1} must be visible`).toBe(true);
    expect(
      focus?.label,
      `Tab stop ${index + 1} must not be the static sign-up spots line`,
    ).not.toMatch(/spots? (left|are taken)|Sign-ups are closed/i);
  }
});

test("main menu links Discord under Support", async ({ page, ui }) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  await expect(page.getByText("Support", { exact: true })).toBeVisible();
  const discord = page.getByRole("link", {
    name: "Discord (opens in a new tab)",
  });
  await expect(discord).toBeVisible();
  await expect(discord).toHaveAttribute(
    "href",
    "https://discord.gg/BgknKxJKa",
  );
  await expect(discord).toHaveAttribute("target", "_blank");
  await expect(discord).toHaveAttribute("rel", "noopener noreferrer");
});

test("organization courses use their own path instead of a tab query", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  await expect(page.getByRole("tab", { name: "Courses" })).toHaveCount(0);
  await page
    .locator("main")
    .getByRole("link", { name: "Courses", exact: true })
    .click();
  await expect(page).toHaveURL("/organizations/org-platform/courses");
  expect(new URL(page.url()).searchParams.has("tab")).toBe(false);
});

test("organization course breadcrumbs stay inside the learner frame", async ({
  page,
  ui,
}) => {
  await ui.open({
    path: "/organizations/org-platform/courses",
    sessionRole: "owner",
    theme: "light",
  });
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);

  await page.getByRole("link", { name: /Linux operations/i }).click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/public/operations",
  );
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "All organization courses" }),
  ).toHaveAttribute("href", "/organizations/org-platform/courses");

  await page
    .getByRole("link", { name: /Repair a broken nginx service.*Resume/i })
    .click();
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
  const publicBreadcrumb = page.getByRole("navigation", {
    name: "Breadcrumb",
  });
  await expect(
    publicBreadcrumb.getByRole("link", { name: "Courses" }),
  ).toHaveAttribute("href", "/organizations/org-platform/courses");
  await expect(
    publicBreadcrumb.getByRole("link", { name: "Linux operations" }),
  ).toHaveAttribute(
    "href",
    "/organizations/org-platform/courses/public/operations",
  );

  await publicBreadcrumb.getByRole("link", { name: "Courses" }).click();
  await page.getByRole("link", { name: /Platform repair sequence/i }).click();
  await expect(
    page.getByRole("link", { name: "All courses", exact: true }),
  ).toHaveAttribute("href", "/courses");
  await page.getByRole("link", { name: /Private service context.*Read/i }).click();
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
  const privateBreadcrumb = page.getByRole("navigation", {
    name: "Breadcrumb",
  });
  await expect(
    privateBreadcrumb.getByRole("link", { name: "Courses" }),
  ).toHaveAttribute("href", "/courses");
  await expect(
    privateBreadcrumb.getByRole("link", { name: "Platform repair sequence" }),
  ).toHaveAttribute(
    "href",
    "/organizations/org-platform/courses/private/platform-repair",
  );
});

test("legacy organization scenario tab falls back to Overview", async ({
  page,
  ui,
}) => {
  const route = routeCase("organization-detail");
  await ui.open({
    ...route,
    path: `${route.path}?tab=scenarios`,
    theme: "light",
  });

  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Courses" })).toHaveCount(0);
});

test("course search carries into lecture drill-down", async ({ page, ui }) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  const search = page.getByLabel("Search courses and lectures");
  await search.fill("DNS");
  const course = page.getByRole("link", { name: /Linux operations/i });
  await expect(course).toContainText("Open course");
  await course.click();

  await expect(page).toHaveURL(/\/courses\/operations\?q=DNS/);
  await expect(
    page.getByText("Trace an intermittent DNS failure", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Repair a broken nginx service", { exact: true }),
  ).toBeHidden();
});

test("course breadcrumbs keep one content frame and authored headings", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);

  await page.getByRole("link", { name: /Linux operations/i }).click();
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "How to use this course" }),
  ).toBeVisible();

  await page
    .getByRole("link", {
      name: /Repair a broken nginx service.*Resume/i,
    })
    .click();
  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "Service recovery" }),
  ).toBeVisible();
});

test("strict courses link only to the required lecture", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await page.getByRole("link", { name: /Linux operations/i }).click();

  await expect(
    page.getByText("Trace an intermittent DNS failure", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Trace an intermittent DNS failure/i }),
  ).toHaveCount(0);
  const locked = page.locator('[data-lecture-state="locked"]');
  await expect(locked).toContainText(
    /Complete “Repair a broken nginx service” first/,
  );
  await expect(
    locked.getByRole("link", { name: /Repair a broken nginx service/i }),
  ).toHaveAttribute(
    "href",
    "/courses/operations/lectures/02-repair-nginx",
  );
});

test("a direct locked lecture route keeps its body sealed", async ({ page, ui }) => {
  await ui.open({
    path: "/courses/operations/lectures/03-trace-dns",
    sessionRole: "learner",
    theme: "light",
  });

  await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);

  await expect(
    page.getByRole("heading", { name: "This lecture is locked" }),
  ).toBeVisible();
  await expect(page.getByText("Resolver paths", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open required lecture" }),
  ).toHaveAttribute(
    "href",
    "/courses/operations/lectures/02-repair-nginx",
  );
  const currentOutlineItem = page.locator(
    '[data-course-outline-rail] [data-current="true"][data-lecture-state="locked"]',
  );
  await expect(currentOutlineItem).toBeVisible();
  await expect(currentOutlineItem.getByRole("link")).toHaveCount(0);
});

test("a theory-only lecture completes and exposes the next unit", async ({
  page,
  ui,
}) => {
  ui.configure({ sessionRole: "learner" });
  const course = ui.server.state.courseCatalog[0]!;
  const theory = course.lectures[0]!;
  const next = course.lectures[1]!;
  theory.state = "available";
  next.state = "locked";
  next.blockedBy = {
    courseId: course.courseId,
    lectureId: theory.lectureId,
    title: theory.title,
  };

  await page.goto(
    `/courses/${course.courseId}/lectures/${theory.lectureId}`,
    { waitUntil: "domcontentloaded" },
  );
  await ui.settle();
  await expect(
    page.getByRole("heading", { name: "Observe first" }),
  ).toBeVisible();
  await expect(
    page.getByText("Lecture 1 of 3 · 0 complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: theory.title, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: `${course.title} lectures` }),
  ).toBeVisible();
  await expect(
    page.getByText("Lecture only", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Complete lecture" }).click();

  await expect(
    page.getByRole("link", { name: `Continue to ${next.title}` }),
  ).toBeVisible();
  expect(ui.server.requests).toContain(
    `POST /api/courses/${course.courseId}/lectures/${theory.lectureId}/complete`,
  );
});

test("course browsing shows available CPU and memory allocation", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  await expect(page.getByRole("meter", { name: "CPU", exact: true })).toHaveAttribute("aria-valuenow", "65.625");
  await expect(page.getByRole("meter", { name: "Memory", exact: true })).toHaveAttribute("aria-valuenow", "62.5");
  await expect(page.getByText("5.25 / 8 vCPUs", { exact: true })).toBeVisible();
  await expect(page.getByText("10 / 16 GiB", { exact: true })).toBeVisible();
});

test("course filters sit in the bar and announce their result", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  await expect(page.getByRole("button", { name: "Easy" })).toBeVisible();
  await page.getByLabel("Filter lectures by category").click();
  await page.getByRole("option", { name: "Linux services" }).click();
  await expect(
    page
      .locator('p[aria-live="polite"]')
      .filter({ hasText: /^Showing \d+ of \d+ courses?\.$/ }),
  ).toHaveCount(1);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("category"))
    .toBe("Linux services");
  await expect(
    page.getByRole("link", { name: /Systems concepts/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "operations" })
    .click();
  await expect(
    page.getByRole("button", { name: "Tags, 1 selected" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      JSON.parse(
        new URL(page.url()).searchParams.get("tags") ?? "[]",
      ) as string[],
    )
    .toContain("operations");
  await expectNoHorizontalOverflow(page);
});

test("organization assignments point to the required lecture", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  await page.getByRole("tab", { name: "Assignments" }).click();

  await expect(
    page.getByRole("link", { name: /Private service context/i }),
  ).toHaveAttribute(
    "href",
    "/organizations/org-platform/courses/private/platform-repair/lectures/01-private-context",
  );
  await expect(page.getByText(/Complete “Private service context” first/)).toBeVisible();
});

test("course API exposes lectures and no standalone scenario collection", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const catalog = (await page.evaluate(async () => {
    const response = await fetch("/api/courses");
    return response.json();
  })) as {
    courses: Array<{ lectures: Array<{ lectureId: string }> }>;
    scenarios?: unknown;
  };

  expect(catalog).toHaveProperty("courses");
  expect(catalog).not.toHaveProperty("scenarios");
  expect(catalog.courses[0]?.lectures[0]).toHaveProperty("lectureId");
  await expect(page.getByText("General practice", { exact: true })).toHaveCount(0);
});

test("destructive dialog traps focus and restores it", async ({ page, ui }) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  await page.getByRole("tab", { name: "Settings" }).click();
  const trigger = page
    .getByRole("button", { name: "Delete organization" })
    .first();
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) =>
        Boolean(
          document.activeElement && element.contains(document.activeElement),
        ),
      ),
    )
    .toBe(true);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(0);
    const focusState = await dialog.evaluate((element) => {
      const active = document.activeElement as HTMLElement | null;
      const backgroundControl = active?.matches(
        "a[href], button, input, select, textarea, [role='button'], [role='tab']",
      );
      const inside = Boolean(active && element.contains(active));
      const guard = Boolean(active?.hasAttribute("data-base-ui-focus-guard"));
      return {
        safe: inside || guard || !backgroundControl,
        active: active?.outerHTML.slice(0, 240) ?? "none",
      };
    });
    expect(
      focusState.safe,
      `focus must not reach background controls; active=${focusState.active}`,
    ).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("SSH key removal asks again in place", async ({ page, ui }) => {
  await ui.open({ ...routeCase("profile"), theme: "light" });
  // Motion on: the confirm cross-fades over its trigger, and focus must
  // survive real transitions (ui.open emulates reduced motion).
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const rows = page.locator("[data-ssh-key-id]");
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  const trigger = row.getByRole("button", { name: /^Remove the .+ key$/ });
  const keep = row.getByRole("button", { name: "Keep" });
  const confirm = row.getByRole("button", { name: "Remove key" });

  await trigger.click();
  await expect(keep).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await page.getByRole("heading", { name: "SSH keys" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  // A failed removal keeps the question open and focus on its button.
  await page.route(
    (url) => /^\/api\/profile\/ssh-keys\/[^/]+$/.test(url.pathname),
    (route) => {
      ui.server.expectedUnavailable += 1;
      return route.fulfill({
        status: 503,
        json: { error: "Key storage is unavailable." },
      });
    },
    { times: 1 },
  );
  await trigger.click();
  await confirm.click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "The Training laptop key couldn't be removed. Try again.",
    }),
  ).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(rows).toHaveCount(1);

  // The retry removes the key: a drawn check and "Removed", then the row
  // folds away, the notice is announced, and focus lands on the empty state
  // instead of the page.
  await confirm.click();
  await expect(row.getByRole("button", { name: "Removed" })).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Training laptop key removed." }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.locator("#ssh-keys-empty")).toBeFocused();
});

test("the sidebar's raised pill glides to the page you pick and a ghost follows the mouse", async ({ page, ui }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Count the pill's glides: it moves rows by a Web Animation, not CSS.
  await page.evaluate(() => {
    const glides: unknown[] = [];
    Object.assign(window, { __glides: glides });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (
      this: Element,
      ...args: Parameters<Element["animate"]>
    ) {
      if (this.matches("[data-nav-pill]")) glides.push(args[0]);
      return animate.apply(this, args);
    };
  });
  const nav = page.locator('[data-sidebar="content"]');
  const ghost = nav.locator("[data-nav-ghost]");
  const pillRow = () =>
    nav.evaluate(
      (list) =>
        list.querySelector("[data-nav-pill]")?.closest<HTMLElement>("[data-nav-row]")
          ?.dataset.navRow ?? null,
    );
  const ghostOffset = (rowId: string) =>
    nav.evaluate((list, id) => {
      const a = list.querySelector("[data-nav-ghost]")!.getBoundingClientRect();
      const b = list
        .querySelector(`[data-nav-row="${id}"] [data-sidebar="menu-button"]`)!
        .getBoundingClientRect();
      return Math.round(Math.abs(a.top - b.top) + Math.abs(a.left - b.left) + Math.abs(a.height - b.height));
    }, rowId);
  const row = (id: string) =>
    nav.locator(`[data-nav-row="${id}"] [data-sidebar="menu-button"]`);

  await expect.poll(pillRow).toBe("courses");

  // The ghost appears under the mouse, glides between rows, steps aside on
  // the current page and fades when the mouse leaves.
  await row("runs").hover();
  await expect(ghost).toHaveAttribute("data-on", "");
  await expect.poll(() => ghostOffset("runs")).toBe(0);
  await row("organizations").hover();
  await expect.poll(() => ghostOffset("organizations")).toBe(0);
  await row("courses").hover();
  await expect(ghost).not.toHaveAttribute("data-on");
  await page.mouse.move(900, 500);
  await expect(ghost).not.toHaveAttribute("data-on");

  // Picking a page moves the one pill there with a single glide.
  await row("runs").click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect.poll(pillRow).toBe("runs");
  expect(
    await page.evaluate(() => (window as unknown as { __glides: unknown[] }).__glides.length),
  ).toBe(1);
  await expect(row("runs")).toHaveAttribute("aria-current", "page");
});

test("the navigation drawer shows its close button and closes after a choice", async ({ page, ui }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close" })).toBeVisible();
  await drawer.getByRole("link", { name: /^My runs/ }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(drawer).toBeHidden();
});

test("the startup rail carries on from the start screen instead of loading again", async ({ page, ui }) => {
  const course = ui.server.state.courseCatalog[0]!;
  const lecture = course.lectures[1]!;
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route("**/api/scenarios/*/start", async (route) => {
    await startGate;
    ui.server.setRunState("launching");
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        runId: "run-active",
        scenarioId: "repair-nginx",
        acceptedAt: Date.now(),
        reused: false,
        run: ui.server.state.run,
      }),
    });
  });
  await ui.open({
    path: `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
    sessionRole: "learner",
    theme: "dark",
    runState: "archived",
  });
  // Motion on, so the hand-off and the sweep really play.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    const sweeps: string[] = [];
    Object.assign(window, { __sweeps: sweeps });
    document.addEventListener(
      "animationstart",
      (event) => {
        if (event.animationName === "intar-sweep") sweeps.push(event.animationName);
      },
      true,
    );
  });
  const sweeps = () =>
    page.evaluate(() => (window as unknown as { __sweeps: string[] }).__sweeps.length);
  const position = page.locator("[data-run-sequence-position]");
  const track = page.locator("[data-run-sequence-track] > span");

  await page.getByRole("link", { name: "Run again" }).click();
  try {
    await expect(page).toHaveURL(/\/runs\/start\/repair-nginx/);
    await expect(position).toHaveText("Stage 1 of 4");
    await expect(track).toHaveCount(4);
  } finally {
    releaseStart?.();
  }

  // The run page takes over the same four stages: the first finishes (its
  // check draws) and only the stage that just started sweeps, once.
  await expect(page).toHaveURL(/\/runs\/run-active/);
  await expect(position).toHaveText("Stage 2 of 4");
  await expect(track).toHaveCount(4);
  await expect(
    page.locator('[data-run-sequence-step][data-state="done"] .draw-check'),
  ).toHaveCount(1);
  await expect.poll(sweeps).toBe(1);
  await page.waitForTimeout(1_000);
  expect(await sweeps(), "the rail swept again").toBe(1);
});

test("the outline's raised card follows the current lecture", async ({ page, ui }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ui.open({ ...routeCase("lecture"), theme: "light" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const rail = page.locator("[data-course-outline-rail]");
  const misalignment = () =>
    rail.evaluate((element) => {
      const pill = element.querySelector("[data-outline-pill]");
      const row = element.querySelector("li[data-current] > *");
      if (!pill || !row) return Number.POSITIVE_INFINITY;
      const a = pill.getBoundingClientRect();
      const b = row.getBoundingClientRect();
      return Math.round(Math.abs(a.top - b.top) + Math.abs(a.height - b.height));
    });
  await expect.poll(misalignment).toBe(0);

  // The ghost follows the mouse over other lectures and steps aside on the
  // current one instead of staying on the last row it visited.
  const ghost = rail.locator("[data-outline-ghost]");
  const other = rail.locator("li[data-lecture-state]:not([data-current]) > a").first();
  await other.hover();
  await expect(ghost).toHaveAttribute("data-on", "");
  await rail.locator("li[data-current] > *").hover();
  await expect(ghost).not.toHaveAttribute("data-on");

  const items = rail.locator("li[data-lecture-state]");
  const index = await items.evaluateAll((lis) =>
    lis.findIndex(
      (li) => !li.hasAttribute("data-current") && li.querySelector(":scope > a"),
    ),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const item = items.nth(index);
  await item.locator(":scope > a").click();
  await expect(item).toHaveAttribute("data-current", "true");
  await expect.poll(misalignment).toBe(0);
});

test("reduced motion removes movement but keeps fades", async ({ page, ui }) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });
  await expectForegroundRunWorkspaceShell(page);
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);

  // Keep every animation that starts, so one that ends before the sample is
  // still checked.
  await page.evaluate(() => {
    const started = new Set<Animation>();
    Object.assign(window, { __started: started });
    document.addEventListener(
      "animationstart",
      (event) => {
        const target = event.target as Element;
        for (const animation of target.getAnimations({ subtree: true })) {
          started.add(animation);
        }
      },
      true,
    );
  });

  // A hint reveal rolls a count and raises the hint; the solution dialog
  // fades in.
  const panel = page.locator("[data-run-learning-panel]");
  await panel.getByRole("button", { name: "Reveal", exact: true }).first().click();
  await expect(
    panel.getByText("Inspect the service boundary", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText("1/2 used", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reveal the full solution" }).click();
  await expect(
    page.getByRole("dialog", { name: "Reveal the full solution?" }),
  ).toBeVisible();

  // Pose each animation at its start, middle and end: nothing may loop, and
  // nothing may move, grow or turn, but opacity may change. Transitions are
  // instant under reduced motion, so only animations count.
  const { fades, offenders } = await page.evaluate(() => {
    const started = (window as unknown as { __started: Set<Animation> })
      .__started;
    let fades = 0;
    const offenders: { name: string; problems: string[] }[] = [];
    for (const animation of new Set([...started, ...document.getAnimations()])) {
      const effect = animation.effect;
      if (animation instanceof CSSTransition) continue;
      if (!(effect instanceof KeyframeEffect) || !effect.target) continue;
      const { target, pseudoElement } = effect;
      const timing = effect.getComputedTiming();
      const { currentTime, playState } = animation;
      const delay = Number(timing.delay ?? 0);
      const duration = Number(timing.duration ?? 0);
      animation.pause();
      const poses = [0, 0.5, 0.99].map((at) => {
        animation.currentTime = delay + duration * at;
        const style = getComputedStyle(target, pseudoElement);
        return {
          move: [style.transform, style.translate, style.scale, style.rotate].join(" "),
          opacity: style.opacity,
        };
      });
      if (currentTime !== null) animation.currentTime = currentTime;
      if (playState === "running") animation.play();
      if (new Set(poses.map((pose) => pose.opacity)).size > 1) fades += 1;
      const moves = new Set(poses.map((pose) => pose.move));
      const problems = [
        ...(timing.iterations === Number.POSITIVE_INFINITY ? ["loops"] : []),
        ...(moves.size > 1 ? [`moves: ${[...moves].join(" → ")}`] : []),
      ];
      if (problems.length) {
        offenders.push({ name: (animation as CSSAnimation).animationName, problems });
      }
    }
    return { fades, offenders };
  });
  expect(offenders, "moving or looping animation under reduced motion").toEqual([]);
  expect(fades, "fades still play under reduced motion").toBeGreaterThan(0);

  const guidancePanel = page.locator("[data-run-learning-panel]");
  await expect(guidancePanel).toBeVisible();
  await expect(page.locator("[data-run-learning-panel-trigger]")).toBeHidden();
  await expectNoVisibleBoxShadow(guidancePanel);
  await expect(
    guidancePanel.getByText("Hints", { exact: true }),
  ).toBeVisible();

  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "ending",
  });
  await expectShutdownRunShell(page);
  const savingSteps = page.getByRole("list", { name: "Saving steps" });
  await expect(savingSteps).toBeVisible();
  await expect(savingSteps.locator("[data-run-sequence-step]")).toHaveCount(5);
  await expect(
    savingSteps.locator('[aria-current="step"]'),
  ).toHaveText(/Save requested/);
  // The marker and the stage track keep their colour fades but nothing that
  // moves: no stretch, no transform, no size.
  const FADES = new Set([
    "none",
    "color",
    "background-color",
    "border-color",
    "box-shadow",
    "opacity",
  ]);
  for (const target of [
    savingSteps.locator("[data-run-sequence-marker]").first(),
    page.locator("[data-run-sequence-track] > span").first(),
  ]) {
    const properties = await target.evaluate((element) =>
      getComputedStyle(element)
        .transitionProperty.split(",")
        .map((entry) => entry.trim()),
    );
    expect(
      properties.filter((property) => !FADES.has(property)),
      "saving-step transitions may only fade under reduced motion",
    ).toEqual([]);
  }
});

test("archived course run stays in the learner frame", async ({ page, ui }) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });

  await expectSavedRunShell(page);
  await expect(
    page.getByRole("button", { name: "Delete run…" }),
  ).toBeVisible();
});

test.describe("wide operational density", () => {
  test.use({ viewport: { width: 2048, height: 944 } });

  test("empty dashboard sections stay compact and evenly spaced", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("admin-overview"),
      theme: "dark",
      variant: "empty",
    });

    const liveSection = page
      .getByRole("heading", { name: "Live scenario runs" })
      .locator("xpath=ancestor::section");
    const archiveSection = page
      .getByRole("heading", { name: "Run archive" })
      .locator("xpath=ancestor::section");
    const [liveBox, archiveBox] = await Promise.all([
      liveSection.boundingBox(),
      archiveSection.boundingBox(),
    ]);

    expect(liveBox).not.toBeNull();
    expect(archiveBox).not.toBeNull();
    // The empty state is the design system's raised StateCard (icon, title,
    // description) rather than a muted note, so a section holds one card.
    expect(liveBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(280);
    expect(
      (archiveBox?.y ?? 0) -
        ((liveBox?.y ?? 0) + (liveBox?.height ?? Number.POSITIVE_INFINITY)),
    ).toBe(16);
  });
});

test.describe("lecture reading flow", () => {
  test("start action switches to the focused startup sequence before acceptance", async ({
    page,
    ui,
  }) => {
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    lecture.scenarioReady = true;
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route("**/api/scenarios/*/start", async (route) => {
      await startGate;
      ui.server.setRunState("launching");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          runId: "run-active",
          scenarioId: "repair-nginx",
          acceptedAt: Date.now(),
          reused: false,
          run: ui.server.state.run,
        }),
      });
    });

    await page.goto(
      `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
      { waitUntil: "domcontentloaded" },
    );
    await ui.settle();
    await page.getByRole("link", { name: "Run again" }).click();

    try {
      await expect(page).toHaveURL(/\/runs\/start\/repair-nginx/);
      await expect(page.locator("[data-run-start-sequence]")).toBeVisible();
      await expect(page.locator("[data-run-learning-panel]")).toBeVisible();
      await expect(
        page.getByText("Checks will appear when the run is created."),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Preparing your workspace" }),
      ).toBeVisible();
      // The same four stages the run page carries on with.
      const startupSteps = page
        .getByRole("list", { name: "Startup steps" })
        .getByRole("listitem");
      await expect(startupSteps).toHaveCount(4);
      await expect(startupSteps.first()).toContainText("Creating your run");
      await expect(startupSteps.first()).toHaveAttribute("aria-current", "step");
      await expect(page.locator("[data-slot='sidebar']")).toHaveCount(0);
      await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Lecture content" })).toHaveCount(
        0,
      );
    } finally {
      releaseStart?.();
    }

    await expect(page).toHaveURL("/runs/run-active");
    await expect(page.locator("[data-run-start-sequence]")).toHaveCount(0);
    await expect(page.locator("[data-run-workspace]")).toBeVisible();
  });

  test("completed scenarios are easy to run again", async ({ page, ui }) => {
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    lecture.scenarioReady = true;

    await page.goto("/courses", { waitUntil: "domcontentloaded" });
    await ui.settle();
    await page.getByRole("link", { name: /Linux operations/i }).click();
    const courseAction = page.getByRole("link", {
      name: /Repair a broken nginx service.*Run again/i,
    });
    await expect(courseAction).toBeVisible();
    await expect(
      courseAction.getByText("Scenario", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Operating model.*Lecture only/i }),
    ).toBeVisible();
    await courseAction.click();

    const theory = page.getByRole("heading", { name: "Service recovery" });
    const rerun = page.getByRole("link", { name: "Run again" });
    await expect(theory).toBeVisible();
    await expect(rerun).toBeVisible();
    await expect(page.getByText("Review runs", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Trace an intermittent DNS failure", { exact: true }),
    ).toBeVisible();
    const outline = page.getByRole("navigation", {
      name: `${course.title} lectures`,
    });
    const nextLecture = outline.getByRole("link", {
      name: course.lectures[2]!.title,
    });
    const previousLecture = outline.getByRole("link", {
      name: course.lectures[0]!.title,
    });
    await expect(previousLecture).toHaveAttribute(
      "href",
      "/courses/operations/lectures/01-operating-model",
    );
    await expect(
      page.getByText("Lecture 2 of 3 · 2 complete", { exact: true }),
    ).toBeVisible();
    await expect(nextLecture).toBeVisible();
    await expect(nextLecture).toBeVisible();
    await expect(rerun).toHaveClass(/border-border/);
    const completedActionText = await page
      .getByRole("region", { name: "Scenario complete" })
      .textContent();
    expect(completedActionText).not.toContain("Next lecture");
    const theoryBox = await theory.boundingBox();
    const rerunBox = await rerun.boundingBox();
    expect(theoryBox).not.toBeNull();
    expect(rerunBox).not.toBeNull();
    expect(theoryBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
      rerunBox?.y ?? Number.NEGATIVE_INFINITY,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await rerun.scrollIntoViewIfNeeded();
    await expect(rerun).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await rerun.click();
    await expect(page).toHaveURL("/runs/run-active");
    expect(ui.server.requests).toContain(
      "POST /api/scenarios/repair-nginx/start",
    );
  });

  test("a completed lecture resumes its active rerun", async ({ page, ui }) => {
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    lecture.scenarioReady = true;
    lecture.activeRunId = "run-active";

    await page.goto(`/courses/${course.courseId}`, {
      waitUntil: "domcontentloaded",
    });
    await ui.settle();
    const courseResume = page.getByRole("link", {
      name: /Repair a broken nginx service.*Resume/i,
    });
    await expect(courseResume).toBeVisible();
    await courseResume.click();

    await expect(
      page.getByRole("heading", { name: "Continue your scenario" }),
    ).toBeVisible();
    const resume = page.getByRole("link", { name: "Resume scenario" });
    await expect(resume).toBeVisible();
    await expect(page.getByRole("link", { name: "Run again" })).toHaveCount(0);
    await resume.click();
    await expect(page).toHaveURL("/runs/run-active");
  });

  test("long next lecture titles stay outside stable action labels", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    const next = course.lectures[2]!;
    const longTitle =
      "Trace an intermittent DNS failure across a deliberately long production service boundary";
    lecture.scenarioReady = true;
    lecture.category =
      "platform-observability-with-a-deliberately-long-category-name";
    next.title = longTitle;

    await page.goto(
      `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
      { waitUntil: "domcontentloaded" },
    );
    await ui.settle();

    await expect(page.getByRole("link", { name: "Run again" })).toBeVisible();
    await page.getByRole("button", { name: /Course outline, lecture/ }).click();
    const nextAction = page.getByRole("link", { name: longTitle });
    await expect(nextAction).toBeVisible();
    await expect(
      page.locator('[data-page-variant="page"]'),
    ).toHaveCSS("max-width", "none");
    await expectNoHorizontalOverflow(page);
  });

  test("course outline navigation works with the keyboard", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });

    const previousLecture = page.getByRole("link", { name: "Operating model" });
    await previousLecture.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(
      "/courses/operations/lectures/01-operating-model",
    );
    await expect(
      page.getByRole("heading", { name: "Observe first" }),
    ).toBeVisible();
  });

  test("the final lecture gives a clear course exit", async ({ page, ui }) => {
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures.at(-1)!;
    lecture.state = "completed";
    lecture.scenarioReady = true;
    lecture.activeRunId = null;

    await page.goto(
      `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
      { waitUntil: "domcontentloaded" },
    );
    await ui.settle();

    await expect(page.getByText("Course complete", { exact: true })).toBeVisible();
    await expect(page.getByText("Lecture 3 of 3 · 3 complete", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Repair a broken nginx service" })).toHaveAttribute(
      "href",
      "/courses/operations/lectures/02-repair-nginx",
    );
    await expect(
      page.getByRole("link", { name: "Back to course" }),
    ).toHaveAttribute("href", `/courses/${course.courseId}`);
    await expect(page.getByRole("link", { name: "Run again" })).toBeVisible();
  });

  test("a completed lecture explains when rerun is preparing", async ({
    page,
    ui,
  }) => {
    ui.configure({ sessionRole: "learner", runState: "archived" });
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    lecture.scenarioReady = false;
    await page.goto(
      `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
      { waitUntil: "domcontentloaded" },
    );
    await ui.settle();

    await expect(
      page.getByRole("button", { name: "Scenario preparing" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("status").filter({
        hasText: "Run again will become available when the scenario image is ready.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Run again" })).toHaveCount(0);
  });

  test("mobile keeps theory before the scenario action", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });

    const theory = page.getByRole("heading", { name: "Service recovery" });
    const action = page.getByRole("link", { name: "Resume scenario" });
    await expect(theory).toBeVisible();
    await expect(
      page.getByText(/A web service depends on process state/i),
    ).toBeVisible();
    await expect(action).toBeVisible();

    const theoryBox = await theory.boundingBox();
    const actionBox = await action.boundingBox();
    expect(theoryBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(theoryBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
      actionBox?.y ?? Number.NEGATIVE_INFINITY,
    );
    await expectNoHorizontalOverflow(page);
  });

  test("uses Lecture while lecture data loads", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      variant: "loading",
    });

    await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lecture");
  });

  test("uses learner-safe copy when a lecture cannot load", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      variant: "error",
    });

    await expect(page.locator('[data-page-variant="page"]')).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Could not load this lecture" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("500");
    await expect(page.locator("main")).not.toContainText("scenarioId");
  });

  for (const viewport of [
    { id: "small", width: 320, height: 700 },
    { id: "mobile", width: 390, height: 844 },
    { id: "landscape", width: 667, height: 375 },
    { id: "tablet", width: 768, height: 1024 },
    { id: "wide tablet", width: 1100, height: 800 },
    { id: "desktop", width: 1440, height: 900 },
    { id: "wide", width: 2048, height: 944 },
  ]) {
    test(`${viewport.id} keeps lecture content within the page`, async ({
      page,
      ui,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await ui.open({ ...routeCase("lecture"), theme: "light" });

      await expect(
        page.getByRole("heading", { name: "Service recovery" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Resume scenario" }),
      ).toBeVisible();
      await expect(
        page.locator('[data-page-variant="page"]'),
      ).toHaveCSS("max-width", "none");
      // The rail needs 58rem of page panel (a container query on the inset),
      // so the sidebar's width counts: 1100px leaves a 844px panel and keeps
      // the outline trigger; 1440px leaves 1184px and shows the rail.
      if (viewport.width >= 1280) {
        await expect(page.locator("[data-course-outline-rail]")).toBeVisible();
        await expect(
          page.getByRole("button", { name: /Course outline, lecture/ }),
        ).toBeHidden();
      } else {
        await expect(page.locator("[data-course-outline-rail]")).toBeHidden();
        await expect(
          page.getByRole("button", { name: /Course outline, lecture/ }),
        ).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
    });
  }

  test("200% text keeps theory and the next action available", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(100);

    const action = page.getByRole("link", { name: "Resume scenario" });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Service recovery" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("coarse pointer and mobile overflow", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  for (const route of ROUTE_CASES) {
    test(`${route.id} controls preserve 44px coarse-pointer targets`, async ({
      page,
      ui,
    }) => {
      await ui.open({ ...route, theme: "light" });
      expect(
        await coarsePointerTargetViolations(page),
        `${route.id} coarse-pointer controls smaller than 44px`,
      ).toEqual([]);
    });
  }

  test("long labels do not force horizontal page scroll", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("organization-detail"),
      theme: "light",
      variant: "long",
    });
    await expectNoHorizontalOverflow(page);
  });

  test("replay stays inside the mobile recap", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    ui.server.state.run = makeMultiReplayRun();
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await expectSavedRunShell(page);

    await page.getByRole("button", { name: "Watch replay" }).click();
    const carousel = page.locator("[data-run-replay-carousel]");
    const next = carousel.getByRole("button", { name: "Next replay part" });
    await expect(carousel).toBeVisible();
    await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
      "Part 1 of 3 · web",
    );
    await expect(page.locator(".run-artifact-player")).toBeVisible();
    const recapReplay = page.locator("[data-run-recap-replay-surface]");
    await expect(recapReplay).toBeVisible();
    // The learner replay has its own controls: the player's bar and its
    // start overlay are off, and its text layer is not a second tab stop.
    await expect(recapReplay.locator(".ap-control-bar")).toHaveCount(0);
    await expect(recapReplay.locator(".ap-overlay-start")).toBeHidden();
    await expect(recapReplay.locator(".ap-term-text")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    const playbackButton = recapReplay.getByRole("button", {
      name: "Play replay",
    });
    await expect(playbackButton).toBeEnabled();
    const playerControlSizes = await recapReplay
      .locator(".replay-bar button, .replay-bar input")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
      );
    expect(playerControlSizes.length).toBeGreaterThan(0);
    expect(
      playerControlSizes.every(
        ({ width, height }) => width >= 44 && height >= 44,
      ),
      "learner replay controls must be at least 44px in each direction",
    ).toBe(true);
    expect(
      await recapReplay.evaluate((surface) => {
        const screen = surface.querySelector<HTMLElement>(".replay-screen");
        const controls = surface.querySelector<HTMLElement>(".replay-bar");
        if (!screen || !controls) return Number.POSITIVE_INFINITY;
        return Math.max(
          0,
          screen.getBoundingClientRect().bottom -
            controls.getBoundingClientRect().top,
        );
      }),
      "learner replay controls must not cover terminal rows",
    ).toBeLessThanOrEqual(0.5);
    // Set keyboard modality before focusing the control, so focus-visible
    // matches the state reached by Tab.
    await page.keyboard.press("Tab");
    await playbackButton.focus();
    await expect(playbackButton).toBeFocused();
    expect(
      await playbackButton.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.outlineStyle !== "none" &&
          Number.parseFloat(style.outlineWidth) >= 2
        );
      }),
      "the focused replay control must have a visible outline",
    ).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await next.press("Space");
    await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
      "Part 2 of 3 · web",
    );
    await expect(next).toBeFocused();
    expect(
      await coarsePointerTargetViolations(page),
      "expanded inline replay coarse-pointer controls smaller than 44px",
    ).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});

test("200% text remains operable without page overflow", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: /Linux operations/ }).click();
  await expect(
    page.getByRole("heading", { name: "Linux operations" }),
  ).toBeVisible();
  await expect(
    page.getByText("Repair a broken nginx service", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("replay carousel remains ordered at 200% text", async ({ page, ui }) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "replay",
  });
  ui.server.state.run = makeMultiReplayRun();
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();
  await expectSavedRunShell(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });

  await page.getByRole("button", { name: "Watch replay" }).click();
  const carousel = page.locator("[data-run-replay-carousel]");
  await expect(carousel).toBeVisible();
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 1 of 3 · web",
  );
  await expect(
    carousel.getByRole("button", { name: "Previous replay part" }),
  ).toBeDisabled();
  await expect(
    carousel.getByRole("button", { name: "Next replay part" }),
  ).toBeEnabled();
  await expectNoHorizontalOverflow(page);
});

test("organization courses remain operable at 200% text", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
  await page
    .locator("main")
    .getByRole("link", { name: "Courses", exact: true })
    .click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  const courseButton = page.getByRole("link", {
    name: /Platform repair sequence/,
  });
  await courseButton.scrollIntoViewIfNeeded();
  await expect(courseButton).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await courseButton.click();
  await expect(
    page.getByRole("heading", { name: "Platform repair sequence" }),
  ).toBeVisible();
  await expect(
    page.getByText("Private service context", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("unknown route has a designed recovery path", async ({ page, ui }) => {
  await ui.open({
    path: "/this-route-does-not-exist",
    sessionRole: "anonymous",
    theme: "light",
  });
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /not found|not in the manual|lost|unknown/i,
  );
  await expect(
    page
      .getByRole("link", { name: /home|courses/i })
      .or(page.getByRole("button", { name: /home|courses/i }))
      .first(),
  ).toBeVisible();
});

for (const legacyPath of [
  "/fleet",
  "/scenarios",
  "/scenarios/repair-nginx",
] as const) {
  test(`legacy learner route ${legacyPath} is removed without redirecting`, async ({
    page,
    ui,
  }) => {
    await ui.open({
      path: legacyPath,
      sessionRole: "learner",
      theme: "light",
    });

    await expect(page).toHaveURL(new RegExp(`${legacyPath}$`));
    await expect(page.getByText("That route is not in the manual")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Browse courses" }),
    ).toHaveAttribute("href", "/courses");
  });
}

test("legacy one-segment course scenario path is not redirected", async ({
  page,
  ui,
}) => {
  await ui.open({
    path: "/courses/repair-nginx",
    sessionRole: "learner",
    theme: "light",
  });

  await expect(page).toHaveURL(/\/courses\/repair-nginx$/);
  await expect(
    page.getByRole("heading", { name: "Course not available" }),
  ).toBeVisible();
});

test("IBM Plex Mono keeps terminal cell geometry stable", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });

  await expect
    .poll(() =>
      page.evaluate(async (font) => {
        const faces = await document.fonts.load(
          font,
          "Mi0W ",
        );
        return faces.filter((face) => face.status === "loaded").length;
      }, REPLAY_TERMINAL_FONT_LOAD),
    )
    .toBeGreaterThan(0);

  const metrics = await page.evaluate(async (font) => {
    const faces = await document.fonts.load(
      font,
      "Mi0W ",
    );
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context unavailable");
    context.font = font;
    const glyphs = ["M", "i", "0", "W", " "];
    const widths = glyphs.map((glyph) => context.measureText(glyph).width);
    return {
      loaded: document.fonts.check(font),
      faceCount: faces.length,
      widths,
    };
  }, REPLAY_TERMINAL_FONT_LOAD);

  expect(metrics.loaded).toBe(true);
  expect(metrics.faceCount).toBeGreaterThan(0);
  const [firstWidth, ...otherWidths] = metrics.widths;
  expect(firstWidth).toBeDefined();
  for (const width of otherWidths) {
    expect(Math.abs(width - (firstWidth ?? 0))).toBeLessThan(0.01);
  }
  // Hinting can shift the absolute advance slightly across browser/CPU
  // builds; the loaded face must stay monospaced and within the expected
  // terminal-cell envelope.
  expect(firstWidth).toBeGreaterThan(7.5);
  expect(firstWidth).toBeLessThan(9);

  const terminalFontSize = 14;
  expect(REPLAY_TERMINAL_COLS).toBe(120);
  expect(REPLAY_TERMINAL_ROWS).toBe(30);
  expect(REPLAY_TERMINAL_COLS * (firstWidth ?? 0)).toBeGreaterThan(900);
  expect(REPLAY_TERMINAL_COLS * (firstWidth ?? 0)).toBeLessThan(1080);
  expect(
    REPLAY_TERMINAL_ROWS * terminalFontSize * REPLAY_TERMINAL_LINE_HEIGHT,
  ).toBe(567);
});
