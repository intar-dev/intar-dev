import { expect, test } from "./fixtures/test";
import { paginatedScenarioFixtures } from "./fixtures/data";
import { ROUTE_CASES, routeCase } from "./routes";
import {
  coarsePointerTargetViolations,
  expectNoHorizontalOverflow,
  expectTimelineMarkerTitleAlignment,
  expectTimelineSurfaceWidths,
} from "./support/layout";
import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_ROWS,
} from "../../src/lib/replay/config";
import type { ScenarioCatalogWireResponse } from "../../src/lib/scenario-runs";

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

test("organization tabs support keyboard navigation and update the URL", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  const overview = page.getByRole("tab", { name: "Overview" });
  const courses = page.getByRole("tab", { name: "Courses" });

  await overview.focus();
  await expect(overview).toBeFocused();
  await page.keyboard.press("ArrowRight");

  await expect(courses).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(courses).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=courses/);
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
  await expect(page.getByRole("tab", { name: "Courses" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

test("large card collections paginate without repeating items", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  ui.server.state.scenarios = paginatedScenarioFixtures();
  ui.server.state.courses = [];
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page.getByRole("button", { name: "General practice" }).click();
  const pagination = page.getByRole("navigation", {
    name: "scenarios pagination",
  });
  const scenarioLinks = page.locator('a[href^="/courses/paging-scenario-"]');
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  expect(new URL(page.url()).searchParams.get("course")).toBe(
    "general-practice",
  );
  await expect(pagination).toContainText("1–9 of 19 scenarios");
  await expect(scenarioLinks).toHaveCount(9);
  await expect(generalPractice).toContainText("19 scenarios");
  const firstPageHrefs = await scenarioLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );

  await pagination.getByRole("button", { name: /^Next/ }).click();
  await expect(pagination).toContainText("10–18 of 19 scenarios");
  await expect(scenarioLinks).toHaveCount(9);
  await expect(generalPractice).toContainText("19 scenarios");
  const secondPageHrefs = await scenarioLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(secondPageHrefs).not.toEqual(firstPageHrefs);
  expect(secondPageHrefs.some((href) => firstPageHrefs.includes(href))).toBe(
    false,
  );

  await pagination.getByRole("button", { name: "Page 3" }).click();
  await expect(pagination).toContainText("19–19 of 19 scenarios");
  await expect(scenarioLinks).toHaveCount(1);
  await expect(generalPractice).toContainText("19 scenarios");
  await expect(
    pagination.getByRole("button", { name: "Page 3" }),
  ).toHaveAttribute("aria-current", "page");

  await page
    .getByRole("textbox", { name: "Search courses and scenarios" })
    .fill("Paging");
  await expect(pagination).toContainText("1–9 of 19 scenarios");
  await expect(scenarioLinks).toHaveCount(9);
});

test("course drill-down returns to the originating catalog page", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  ui.server.state.scenarios = paginatedScenarioFixtures().slice(0, 10);
  ui.server.state.courses = ui.server.state.scenarios.map(
    (scenario, index) => ({
      courseId: `paging-course-${index + 1}`,
      organizationId: null,
      title: `Paging course ${index + 1}`,
      description: "A compact curriculum used to verify course navigation.",
      scenarioIds: [scenario.scenarioId],
    }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  const pagination = page.getByRole("navigation", {
    name: "courses pagination",
  });
  await pagination.getByRole("button", { name: /^Next/ }).click();
  await expect(pagination).toContainText("10–10 of 10 courses");

  const courseButton = page.getByRole("button", {
    name: "Paging course 10",
  });
  await courseButton.click();
  await expect(
    page.getByRole("heading", { name: "Paging course 10" }),
  ).toBeFocused();

  await page.goBack();
  await expect(pagination).toContainText("10–10 of 10 courses");
  await expect(courseButton).toBeFocused();

  await courseButton.click();
  await page.getByRole("button", { name: "All courses" }).click();
  await expect(pagination).toContainText("10–10 of 10 courses");
  await expect(courseButton).toBeFocused();

  const search = page.getByRole("textbox", {
    name: "Search courses and scenarios",
  });
  await search.fill("Paging course");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("Paging course");
  await expect(search).toBeFocused();
});

test("public courses preserve curriculum order and place standalone work in General practice", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Courses");
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Choose your next course",
    }),
  ).toBeVisible();

  const course = page.locator(
    'li[data-course-id="operations"][data-course-scope="public"]',
  );
  await expect(
    course.getByRole("heading", { name: "Linux operations" }),
  ).toBeVisible();
  await expect(course).toContainText("2 scenarios");
  await expect(course).toContainText("~95 min total");
  await expect(course.locator('a[href^="/courses/"]')).toHaveCount(0);
  await course.getByRole("button", { name: "Linux operations" }).click();

  const courseDetail = page.locator(
    'section[data-course-id="operations"][data-course-scope="public"][data-course-view="detail"]',
  );
  const courseLinks = courseDetail.locator('a[href^="/courses/"]');
  await expect(courseLinks).toHaveCount(2);
  expect(new URL(page.url()).searchParams.get("course")).toBe(
    "public:operations",
  );
  await expect(courseLinks.nth(0)).toHaveAttribute(
    "href",
    "/courses/repair-nginx",
  );
  await expect(courseLinks.nth(1)).toHaveAttribute(
    "href",
    "/courses/repair-dns",
  );
  await expect(
    courseDetail.getByRole("heading", { name: "Linux operations" }),
  ).toBeFocused();

  await courseDetail.getByRole("button", { name: "All courses" }).click();
  await expect(
    course.getByRole("button", { name: "Linux operations" }),
  ).toBeFocused();
  const generalPracticeIndex = page.locator(
    'li[data-course-id="general-practice"][data-course-scope="generated"]',
  );
  await generalPracticeIndex
    .getByRole("button", { name: "General practice" })
    .click();
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  await expect(
    generalPractice.locator('a[href="/courses/recover-postgres"]'),
  ).toBeVisible();
  await expect(generalPractice).toContainText("Open practice");
});

test("catalog API exposes scenarios only inside nested courses", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });

  const catalog = (await page.evaluate(async () => {
    const response = await fetch("/api/scenarios");
    return response.json();
  })) as ScenarioCatalogWireResponse;

  expect(catalog).not.toHaveProperty("scenarios");
  expect(catalog.courses.map((course: { kind: string }) => course.kind)).toEqual(
    ["authored", "general-practice"],
  );
  expect(catalog.courses[0]).not.toHaveProperty("scenarioIds");
  expect(catalog.courses[0]?.scenarios[0]).toHaveProperty("progress");
  expect(catalog.courses[1]).toMatchObject({
    courseId: null,
    organizationId: null,
    title: "General practice",
  });
});

test("matching the General practice title reveals all eligible members", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  await page
    .getByRole("textbox", { name: "Search courses and scenarios" })
    .fill("General practice");

  await page.getByRole("button", { name: "General practice" }).click();
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  await expect(
    generalPractice.locator('a[href="/courses/recover-postgres"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Linux operations" }),
  ).toHaveCount(0);
});

test("partially available courses remain visible", async ({ page, ui }) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  ui.server.state.scenarios = ui.server.state.scenarios.filter(
    (scenario) => scenario.scenarioId !== "repair-dns",
  );
  const publicCourse = ui.server.state.courses[0];
  if (publicCourse) publicCourse.scenarioIds = ["repair-nginx"];
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  const course = page.locator(
    'li[data-course-id="operations"][data-course-scope="public"]',
  );
  await expect(course).toContainText("1 scenario");
  await course.getByRole("button", { name: "Linux operations" }).click();
  const courseDetail = page.locator(
    'section[data-course-id="operations"][data-course-scope="public"][data-course-view="detail"]',
  );
  await expect(
    courseDetail.locator('a[href="/courses/repair-nginx"]'),
  ).toBeVisible();
  await expect(
    courseDetail.locator('a[href="/courses/repair-dns"]'),
  ).toHaveCount(0);
});

test("organization catalogs render public courses before scoped courses", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
  await page.getByRole("tab", { name: "Courses" }).click();

  const courses = page.locator(
    'li[data-course-id="operations"][data-course-view="index"]',
  );
  await expect(courses).toHaveCount(2);
  await expect(courses.nth(0)).toHaveAttribute("data-course-scope", "public");
  await expect(courses.nth(1)).toHaveAttribute(
    "data-course-scope",
    "org-platform",
  );
  await expect(courses.locator('a[href*="repair-dns"]')).toHaveCount(0);
  await courses.nth(0).getByRole("button").click();
  let selectedCourse = page.locator(
    'section[data-course-view="detail"][data-course-scope="public"]',
  );
  await expect(selectedCourse.locator('a[href*="repair-dns"]')).toHaveCount(1);
  await expect(selectedCourse.locator('a[href*="repair-nginx"]')).toHaveCount(
    0,
  );
  await selectedCourse.getByRole("button", { name: "All courses" }).click();

  const organizationCourse = page.locator(
    'li[data-course-id="operations"][data-course-scope="org-platform"]',
  );
  await organizationCourse.getByRole("button").click();
  selectedCourse = page.locator(
    'section[data-course-view="detail"][data-course-scope="org-platform"]',
  );
  await expect(selectedCourse.locator('a[href*="repair-nginx"]')).toHaveCount(
    1,
  );
  await expect(
    selectedCourse.locator('a[href*="platform-logrotate"]'),
  ).toHaveCount(1);
  await selectedCourse.getByRole("button", { name: "All courses" }).click();

  await page
    .locator('li[data-course-scope="generated"]')
    .getByRole("button", { name: "General practice" })
    .click();
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  await expect(
    generalPractice.locator('a[href*="recover-postgres"]'),
  ).toHaveCount(1);
  await expect(
    generalPractice.locator('a[href*="platform-firewall"]'),
  ).toHaveCount(1);

  const catalog = (await page.evaluate(async () => {
    const response = await fetch("/api/organizations/org-platform/scenarios");
    return response.json();
  })) as ScenarioCatalogWireResponse;
  const scenarioIds = catalog.courses.flatMap(
    (course: { scenarios: Array<{ scenarioId: string }> }) =>
      course.scenarios.map((scenario) => scenario.scenarioId),
  );
  expect(catalog.courses.map((course: { kind: string }) => course.kind)).toEqual(
    ["authored", "authored", "general-practice"],
  );
  expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  expect(scenarioIds).toEqual([
    "repair-dns",
    "repair-nginx",
    "platform-logrotate",
    "recover-postgres",
    "platform-firewall",
  ]);
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
    expect(liveBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(160);
    expect(
      (archiveBox?.y ?? 0) -
        ((liveBox?.y ?? 0) + (liveBox?.height ?? Number.POSITIVE_INFINITY)),
    ).toBe(16);
  });
});

test.describe("timeline marker and title alignment", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test("markers center on their event titles", async ({ page, ui }) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        variant: "long",
        runState: "ending",
      });

      await expectTimelineMarkerTitleAlignment(page);
    });

    test("structured event content shares one width", async ({ page, ui }) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        runState: "replay",
      });

      await expectTimelineSurfaceWidths(page);
    });
  });

  test.describe("mobile", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    test("markers center on titles below mobile timestamps", async ({
      page,
      ui,
    }) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        variant: "long",
        runState: "ending",
      });

      await expectTimelineMarkerTitleAlignment(page);
    });
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

  test("inline replay stays inside the mobile timeline", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });

    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await expect(page.locator(".run-artifact-player")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectTimelineSurfaceWidths(page);
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
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Linux operations" }).click();
  await expect(
    page.getByRole("heading", { name: "Repair a broken nginx service" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("organization courses remain operable at 200% text", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
  await page.getByRole("tab", { name: "Courses" }).click();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  const course = page.locator(
    'li[data-course-id="operations"][data-course-scope="org-platform"]',
  );
  const courseButton = course.getByRole("button", {
    name: "Platform repair sequence",
  });
  await courseButton.scrollIntoViewIfNeeded();
  await expect(courseButton).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await courseButton.click();
  await expect(
    page.getByRole("heading", { name: "Repair a broken nginx service" }),
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

for (const legacyPath of ["/scenarios", "/scenarios/repair-nginx"] as const) {
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
