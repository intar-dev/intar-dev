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
      .getByRole("link", { name: "Back to My runs" }),
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

async function expectSavedRunAppShell(page: Page) {
  const appBar = page.locator("header").filter({
    has: page.locator("[data-slot='sidebar-trigger']"),
  });

  await expect(page.locator("[data-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-run-workspace-header]")).toHaveCount(0);
  await expect(page.locator("[data-run-navigation]")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(1);
  await expect(appBar).toHaveCount(1);
  await expect(
    appBar.getByRole("heading", {
      level: 1,
      name: "Repair a broken nginx service",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Page actions" }),
  ).toHaveCount(0);

  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await expect(page.locator("[data-slot='sidebar']")).toHaveCount(1);
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
    .getByRole("button", { name: "Courses", exact: true })
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
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);

  await page.getByRole("link", { name: /Linux operations/i }).click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/public/operations",
  );
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);

  await page
    .getByRole("link", { name: /Repair a broken nginx service.*Resume/i })
    .click();
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
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
  await page.getByRole("link", { name: /Private service context.*Read/i }).click();
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
  const privateBreadcrumb = page.getByRole("navigation", {
    name: "Breadcrumb",
  });
  await expect(
    privateBreadcrumb.getByRole("link", { name: "Courses" }),
  ).toHaveAttribute("href", "/organizations/org-platform/courses");
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
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);

  await page.getByRole("link", { name: /Linux operations/i }).click();
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
  await expect(
    page.getByRole("heading", { level: 2, name: "How to use this course" }),
  ).toBeVisible();

  await page
    .getByRole("link", {
      name: /Repair a broken nginx service.*Resume/i,
    })
    .click();
  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
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

  await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);

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
  await page.getByRole("button", { name: "Complete lecture" }).click();

  await expect(
    page.getByRole("link", { name: /Next lecture: Repair a broken nginx service/i }),
  ).toBeVisible();
  expect(ui.server.requests).toContain(
    `POST /api/courses/${course.courseId}/lectures/${theory.lectureId}/complete`,
  );
});

test("course capacity reports pool use without promising a launch", async ({
  page,
  ui,
}) => {
  ui.server.state.capacityPressure = 68;
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  await expect(page.getByRole("status")).toContainText("68% pool use");
  await expect(
    page.getByRole("progressbar", { name: "Scenario capacity used" }),
  ).toHaveAttribute("aria-valuenow", "68");
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

test("reduced motion disables authored animation", async ({ page, ui }) => {
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

  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const duration = style.animationDuration
          .split(",")
          .some((entry) => Number.parseFloat(entry) > 0);
        return style.animationName !== "none" && duration;
      })
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        animationName: getComputedStyle(element).animationName,
      })),
  );
  expect(offenders, "animations active under reduced motion").toEqual([]);

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
  await expectSavedRunAppShell(page);
  const savingSteps = page.getByRole("list", { name: "Saving steps" });
  await expect(savingSteps).toBeVisible();
  await expect(savingSteps.locator("[data-run-sequence-step]")).toHaveCount(5);
  await expect(
    savingSteps.locator('[aria-current="step"]'),
  ).toHaveText(/Save requested/);
  expect(
    await savingSteps
      .locator("[data-run-sequence-marker]")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          style.transitionProperty === "none" ||
          style.transitionDuration
            .split(",")
            .every((entry) => Number.parseFloat(entry) === 0)
        );
      }),
    "saving-step transitions must stop under reduced motion",
  ).toBe(true);
});

test("archived run uses the normal app shell", async ({ page, ui }) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });

  await expectSavedRunAppShell(page);
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
    expect(liveBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(170);
    expect(
      (archiveBox?.y ?? 0) -
        ((liveBox?.y ?? 0) + (liveBox?.height ?? Number.POSITIVE_INFINITY)),
    ).toBe(16);
  });
});

test.describe("lecture reading flow", () => {
  test("mobile keeps theory before the scenario action", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });

    const theory = page.getByRole("heading", { name: "Service recovery" });
    const action = page.getByRole("button", { name: "Resume scenario" });
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

    await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lecture");
  });

  test("uses learner-safe copy when a lecture cannot load", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      variant: "error",
    });

    await expect(page.locator('[data-page-width="content"]')).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Could not load this lecture" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("500");
    await expect(page.locator("main")).not.toContainText("scenarioId");
  });

  for (const viewport of [
    { id: "small", width: 320, height: 700 },
    { id: "landscape", width: 667, height: 375 },
    { id: "tablet", width: 1100, height: 800 },
    { id: "desktop", width: 1440, height: 900 },
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
        page.getByRole("button", { name: "Resume scenario" }),
      ).toBeVisible();
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

    const action = page.getByRole("button", { name: "Resume scenario" });
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
    await expectSavedRunAppShell(page);

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
    const playIcon = recapReplay.locator(
      ".ap-overlay-start .ap-play-button svg",
    );
    await expect(playIcon).toHaveCount(1);
    expect(
      await playIcon.evaluate((element) => getComputedStyle(element).filter),
      "learner replay play icon must not have a drop shadow",
    ).toBe("none");
    const playerControlSizes = await recapReplay
      .locator(".ap-control-bar button.ap-button")
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
        const terminal = surface.querySelector<HTMLElement>(".ap-term");
        const controls = surface.querySelector<HTMLElement>(".ap-control-bar");
        if (!terminal || !controls) return Number.POSITIVE_INFINITY;
        const terminalBounds = terminal.getBoundingClientRect();
        const controlBounds = controls.getBoundingClientRect();
        return Math.max(0, terminalBounds.bottom - controlBounds.top);
      }),
      "learner replay controls must not cover terminal rows",
    ).toBeLessThanOrEqual(0.5);
    const playbackButton = recapReplay.locator(
      ".ap-control-bar .ap-playback-button",
    );
    // Set keyboard modality before focusing the vendor control. Its parent
    // must reveal the bar for the same focus-visible state reached by Tab.
    await page.keyboard.press("Tab");
    await playbackButton.focus();
    await expect(playbackButton).toBeFocused();
    await expect(recapReplay.locator(".ap-control-bar")).toHaveCSS(
      "opacity",
      "1",
    );
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
  await expectSavedRunAppShell(page);
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
    .getByRole("button", { name: "Courses", exact: true })
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
      .getByRole("link", { name: /home|courses|workshop/i })
      .or(page.getByRole("button", { name: /home|courses|workshop/i }))
      .first(),
  ).toBeVisible();
});

for (const legacyPath of [
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
      page.getByRole("button", { name: "Browse courses" }),
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

test("Recursive Mono keeps terminal cell geometry stable", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const faces = await document.fonts.load(
          '400 14px "Recursive Mono"',
          "Mi0W ",
        );
        return faces.filter((face) => face.status === "loaded").length;
      }),
    )
    .toBeGreaterThan(0);

  const metrics = await page.evaluate(async () => {
    const faces = await document.fonts.load(
      '400 14px "Recursive Mono"',
      "Mi0W ",
    );
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas context unavailable");
    context.font = '14px "Recursive Mono"';
    const glyphs = ["M", "i", "0", "W", " "];
    const widths = glyphs.map((glyph) => context.measureText(glyph).width);
    return {
      loaded: document.fonts.check('14px "Recursive Mono"'),
      faceCount: faces.length,
      widths,
    };
  });

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
