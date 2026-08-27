import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import {
  makeMultiReplayRun,
  paginatedScenarioFixtures,
} from "./fixtures/data";
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
import type { ScenarioCatalogWireResponse } from "../../src/lib/scenario-runs";

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
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });

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
  const scenarioLinks = page.locator(
    'a[href^="/courses/general-practice/paging-scenario-"]',
  );
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  await expect(page).toHaveURL("/courses/general-practice");
  expectNoLegacyCourseSearch(page.url());
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

  await page.getByText("Filter course").click();
  await page.getByRole("textbox", { name: "Search this course" }).fill("Paging");
  await expect(pagination).toContainText("1–9 of 19 scenarios");
  await expect(scenarioLinks).toHaveCount(9);
});

test("course drill-down uses a course path and keeps filter-only search", async ({
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
  await expect(courseButton).toHaveCSS("cursor", "pointer");
  await courseButton.click();
  await expect(
    page
      .locator('section[data-course-id="paging-course-10"]')
      .getByRole("heading", { name: "Paging course 10", level: 3 }),
  ).toBeVisible();
  await expect(page).toHaveURL("/courses/paging-course-10");

  await page.goBack();
  await expect(pagination).toContainText("1–9 of 10 courses");
  await expect(page).toHaveURL("/courses");

  const search = page.getByRole("textbox", {
    name: "Search courses and scenarios",
  });
  await search.fill("Paging course");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("Paging course");
  await expect(search).toBeFocused();
});

test("a long course opens on the page containing the next step", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  const scenarios = paginatedScenarioFixtures(12).map((scenario, index) => ({
    ...scenario,
    progress: {
      ...scenario.progress,
      status:
        index < 9 ? ("completed" as const) : index === 9 ? ("in_progress" as const) : ("new" as const),
      activeRunId: index === 9 ? "run-active" : null,
      completedCount: index < 9 ? 1 : 0,
    },
  }));
  ui.server.state.scenarios = scenarios;
  ui.server.state.courses = [
    {
      courseId: "long-course",
      organizationId: null,
      title: "Long operations course",
      description: "A long curriculum with active work beyond the first page.",
      scenarioIds: scenarios.map((scenario) => scenario.scenarioId),
    },
  ];
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page
    .getByRole("button", { name: "Long operations course" })
    .click();

  const pagination = page.getByRole("navigation", {
    name: "scenarios pagination",
  });
  await expect(page).toHaveURL("/courses/long-course");
  await expect(pagination).toContainText("10–12 of 12 scenarios");
  await expect(
    page.getByRole("heading", { name: "Paging scenario 10" }),
  ).toBeVisible();
  await expect(page.getByText("Next step")).toBeVisible();
  await expect(
    pagination.getByRole("button", { name: "Page 2" }),
  ).toHaveAttribute("aria-current", "page");
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
  await expect(page).toHaveURL("/courses/operations");
  expectNoLegacyCourseSearch(page.url());
  await expect(courseLinks.nth(0)).toHaveAttribute(
    "href",
    "/courses/operations/repair-nginx",
  );
  await expect(courseLinks.nth(1)).toHaveAttribute(
    "href",
    "/courses/operations/repair-dns",
  );
  await expect(
    courseDetail.getByRole("heading", { name: "Linux operations" }),
  ).toBeVisible();

  await courseDetail.getByRole("button", { name: "All courses" }).click();
  await expect(
    course.getByRole("button", { name: "Linux operations" }),
  ).toBeVisible();
  const generalPracticeIndex = page.locator(
    'li[data-course-id="general-practice"][data-course-scope="generated"]',
  );
  await generalPracticeIndex
    .getByRole("button", { name: "General practice" })
    .click();
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  const postgres = generalPractice.getByRole("link", {
    name: /Recover a read-only PostgreSQL node/i,
  });
  await expect(postgres).toBeVisible();
  const postgresHref = await postgres.getAttribute("href");
  const postgresUrl = new URL(postgresHref ?? "", page.url());
  expect(postgresUrl.pathname).toBe(
    "/courses/general-practice/recover-postgres",
  );
  expect(postgresUrl.searchParams.get("q")).toBeNull();
  await expect(generalPractice).toContainText("Open practice");
});

test("course progress tracks keep one measure across responsive layouts", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });

  const tracks = page.getByRole("progressbar");
  await expect(tracks).toHaveCount(2);

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const metrics = await tracks.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          borderRadius: getComputedStyle(element).borderRadius,
        };
      }),
    );
    const widths = metrics.map((metric) => metric.width);

    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5);
    expect(metrics.every((metric) => metric.height === 4)).toBe(true);
    expect(metrics.every((metric) => metric.borderRadius === "0px")).toBe(
      true,
    );
    if (viewport.width >= 1280) {
      const factsAligned = await page
        .locator("[data-course-facts]")
        .evaluateAll((rails) =>
          rails.every((rail) => {
            const metrics = rail.querySelector("[data-course-metrics]");
            const action = rail.querySelector("[data-course-action]");
            if (!metrics || !action) return false;
            return (
              getComputedStyle(rail).display === "grid" &&
              Math.abs(
                metrics.getBoundingClientRect().top -
                  action.getBoundingClientRect().top,
              ) <= 1
            );
          }),
        );
      expect(factsAligned).toBe(true);
    }
    await expectNoHorizontalOverflow(page);
  }
});

test("course scenarios return to the selected filtered public course", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("scenario-catalog"),
    path: "/courses?q=nginx&difficulty=medium",
    theme: "light",
  });

  const course = page.locator(
    'li[data-course-id="operations"][data-course-scope="public"]',
  );
  await course.getByRole("button", { name: "Linux operations" }).click();

  const expectedSearch = { q: "nginx", difficulty: "medium" };
  await expect.poll(() => {
    const url = new URL(page.url());
    const search = url.searchParams;
    return {
      pathname: url.pathname,
      q: search.get("q"),
      difficulty: search.get("difficulty"),
      legacy: legacyCourseSearch(url),
    };
  }).toEqual({
    pathname: "/courses/operations",
    ...expectedSearch,
    legacy: [null, null, null, null],
  });

  const courseDetail = page.locator(
    'section[data-course-id="operations"][data-course-scope="public"][data-course-view="detail"]',
  );
  const scenario = courseDetail.getByRole("link", {
    name: /Repair a broken nginx service/i,
  });
  await expect(scenario).toBeVisible();
  await scenario.click();

  const backToCourse = page.getByRole("link", { name: "Back to course" });
  await expect(backToCourse).toBeVisible();
  await expect(page.getByText("step 1 of 2")).toBeVisible();
  await expect.poll(() => {
    const url = new URL(page.url());
    const search = url.searchParams;
    return {
      pathname: url.pathname,
      q: search.get("q"),
      difficulty: search.get("difficulty"),
      legacy: legacyCourseSearch(url),
    };
  }).toEqual({
    pathname: "/courses/operations/repair-nginx",
    ...expectedSearch,
    legacy: [null, null, null, null],
  });

  await backToCourse.click();
  await expect(courseDetail).toBeVisible();
  await expect(page.getByText("Filters active")).toBeVisible();
  await page.getByText("Filter course").click();
  await expect(page.getByRole("textbox", {
    name: "Search this course",
  })).toHaveValue("nginx");
  await expect(page.getByRole("button", { name: "medium" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => {
    const url = new URL(page.url());
    const search = url.searchParams;
    return {
      pathname: url.pathname,
      q: search.get("q"),
      difficulty: search.get("difficulty"),
      legacy: legacyCourseSearch(url),
    };
  }).toEqual({
    pathname: "/courses/operations",
    ...expectedSearch,
    legacy: [null, null, null, null],
  });
});

test("private assignments return to the organization course library", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });

  await page
    .getByRole("link", {
      name: /Repair a broken nginx service Assigned by Platform Repair Crew/i,
    })
    .click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations/repair-nginx",
  );

  const backToCourse = page.getByRole("link", { name: "Back to course" });
  await expect(backToCourse).toBeVisible();
  await backToCourse.click();

  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations",
  );
  await expect(
    page.getByRole("heading", { name: "Platform repair sequence" }).first(),
  ).toBeVisible();
});

test("an assignment without a current course still stays in its organization", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  ui.server.state.assignments[0]!.courseLocation = null;
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page
    .getByRole("link", {
      name: /Repair a broken nginx service Assigned by Platform Repair Crew/i,
    })
    .click();
  await expect(page).toHaveURL("/organizations/org-platform/courses");
});

test("organization course scenarios return to the selected private course", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
  await page
    .locator("main")
    .getByRole("button", { name: "Courses", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Platform repair sequence" })
    .click();
  await page
    .getByRole("link", { name: /Repair a broken nginx service/i })
    .click();

  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations/repair-nginx",
  );
  await page.getByRole("link", { name: "Back to course" }).click();

  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations",
  );
  await expect(
    page.locator(
      'section[data-course-id="operations"][data-course-scope="org-platform"][data-course-view="detail"]',
    ),
  ).toBeVisible();
});

test("direct organization public and General practice briefing paths resolve", async ({
  page,
  ui,
}) => {
  await ui.open({
    path: "/organizations/org-platform/courses/public/operations/repair-dns",
    sessionRole: "owner",
    theme: "light",
  });
  await expect(page.getByText("step 1 of 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to course" })).toHaveAttribute(
    "href",
    "/organizations/org-platform/courses/public/operations",
  );

  await ui.open({
    path: "/organizations/org-platform/courses/general-practice/recover-postgres",
    sessionRole: "owner",
    theme: "light",
  });
  await expect(page.getByRole("link", { name: "Back to course" })).toHaveAttribute(
    "href",
    "/organizations/org-platform/courses/general-practice",
  );
});

test("a scenario outside the stated course is rejected", async ({ page, ui }) => {
  await ui.open({
    path: "/courses/operations/recover-postgres",
    sessionRole: "learner",
    theme: "light",
  });

  await expect(
    page.getByRole("heading", { name: "Scenario is not in this course" }),
  ).toBeVisible();
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
  const postgres = generalPractice.getByRole("link", {
    name: /Recover a read-only PostgreSQL node/i,
  });
  await expect(postgres).toBeVisible();
  const postgresHref = await postgres.getAttribute("href");
  const postgresUrl = new URL(postgresHref ?? "", page.url());
  expect(postgresUrl.pathname).toBe(
    "/courses/general-practice/recover-postgres",
  );
  expect(postgresUrl.searchParams.get("q")).toBe("General practice");
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
    courseDetail.locator('a[href="/courses/operations/repair-nginx"]'),
  ).toBeVisible();
  await expect(
    courseDetail.locator('a[href="/courses/operations/repair-dns"]'),
  ).toHaveCount(0);
});

test("organization catalogs render public courses before scoped courses", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
  await page
    .locator("main")
    .getByRole("button", { name: "Courses", exact: true })
    .click();

  const courses = page.locator(
    'section[data-course-id="operations"][data-course-view="index"]',
  );
  await expect(courses).toHaveCount(2);
  await expect(courses.nth(0)).toHaveAttribute("data-course-scope", "public");
  await expect(courses.nth(1)).toHaveAttribute(
    "data-course-scope",
    "org-platform",
  );
  await expect(courses.locator('a[href*="repair-dns"]')).toHaveCount(0);
  await courses.nth(0).getByRole("link", { name: /Linux operations/ }).click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/public/operations",
  );
  let selectedCourse = page.locator(
    'section[data-course-view="detail"][data-course-scope="public"]',
  );
  await expect(
    selectedCourse.locator(
      'a[href="/organizations/org-platform/courses/public/operations/repair-dns"]',
    ),
  ).toHaveCount(1);
  await expect(selectedCourse.locator('a[href*="repair-nginx"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "All courses" }).click();

  const organizationCourse = page.locator(
    'section[data-course-id="operations"][data-course-scope="org-platform"]',
  );
  await organizationCourse
    .getByRole("link", { name: /Platform repair sequence/ })
    .click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations",
  );
  selectedCourse = page.locator(
    'section[data-course-view="detail"][data-course-scope="org-platform"]',
  );
  await expect(
    selectedCourse.locator(
      'a[href="/organizations/org-platform/courses/private/operations/repair-nginx"]',
    ),
  ).toHaveCount(1);
  await expect(
    selectedCourse.locator(
      'a[href="/organizations/org-platform/courses/private/operations/platform-logrotate"]',
    ),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "All courses" }).click();

  await page
    .locator('section[data-course-scope="generated"]')
    .getByRole("link", { name: /General practice/ })
    .click();
  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/general-practice",
  );
  const generalPractice = page
    .getByRole("heading", { name: "General practice" })
    .locator("xpath=ancestor::section");
  await expect(
    generalPractice.locator(
      'a[href="/organizations/org-platform/courses/general-practice/recover-postgres"]',
    ),
  ).toHaveCount(1);
  await expect(
    generalPractice.locator(
      'a[href="/organizations/org-platform/courses/general-practice/platform-firewall"]',
    ),
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

  await page.locator("[data-run-learning-panel-trigger]").click();
  const rail = page.getByRole("dialog", { name: "Lab guidance" });
  await expect(rail).toBeVisible();
  await expectNoVisibleBoxShadow(rail);
  expect(
    await rail.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.transitionProperty === "none" ||
        style.transitionDuration
          .split(",")
          .every((entry) => Number.parseFloat(entry) === 0)
      );
    }),
    "guidance rail transition must stop under reduced motion",
  ).toBe(true);
  await expect(
    rail.getByRole("heading", { name: "Hints and guidance" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "ending",
  });
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

test.describe("scenario briefing on mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("keeps the learner flow clear and free of platform details", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("scenario-briefing"), theme: "light" });

    const action = page.getByRole("button", {
      name: "Continue lab",
    });
    const task = page.getByRole("heading", { name: "Your task" });
    const outcomes = page.getByRole("heading", { name: "Done when" });
    const guidance = page.getByText("Guidance is available while you work.");
    const progress = page.getByRole("heading", { name: "Lab in progress" });
    await expect(action).toBeVisible();
    await expect(task).toBeVisible();
    await expect(outcomes).toBeVisible();
    await expect(guidance).toBeVisible();
    await expect(progress).toBeVisible();
    await expect(page.getByRole("link", { name: "View all runs" })).toHaveAttribute(
      "href",
      "/runs",
    );

    await expect(page.locator("main")).not.toContainText("Technical details");
    await expect(page.locator("main")).not.toContainText("Linux services");
    await expect(page.locator("main")).not.toContainText(/\b\d+ machines?\b/);
    await expect(page.locator("main")).not.toContainText(/\bhints? available\b/i);
    await expect(page.locator("main")).not.toContainText("Latest attempt");
    await expect(page.locator("main")).not.toContainText(
      "HIDDEN_OBJECTIVE_DETAIL",
    );
    await expect(page.locator("main")).not.toContainText(
      "HIDDEN_OBJECTIVE_PATH",
    );
    await expect(page.locator("main")).not.toContainText("Previous runs");

    const [actionBox, taskBox, outcomesBox, guidanceBox, progressBox] = await Promise.all([
      action.boundingBox(),
      task.boundingBox(),
      outcomes.boundingBox(),
      guidance.boundingBox(),
      progress.boundingBox(),
    ]);
    expect(actionBox).not.toBeNull();
    expect(taskBox).not.toBeNull();
    expect(outcomesBox).not.toBeNull();
    expect(guidanceBox).not.toBeNull();
    expect(progressBox).not.toBeNull();

    const actionBottom = (actionBox?.y ?? Number.POSITIVE_INFINITY) +
      (actionBox?.height ?? 0);
    expect(actionBox?.y ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(0);
    expect(actionBottom).toBeLessThanOrEqual(844);
    expect(actionBottom).toBeLessThanOrEqual(taskBox?.y ?? Number.POSITIVE_INFINITY);
    expect(taskBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      outcomesBox?.y ?? Number.POSITIVE_INFINITY,
    );
    expect(outcomesBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      guidanceBox?.y ?? Number.POSITIVE_INFINITY,
    );
    expect(guidanceBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      progressBox?.y ?? Number.POSITIVE_INFINITY,
    );
  });

  test("uses Lab while briefing data loads", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("scenario-briefing"),
      theme: "light",
      variant: "loading",
    });

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lab");
  });

  test("offers Start lab when no lab is active", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("scenario-briefing"),
      theme: "light",
      runState: "archived",
    });

    await expect(page.getByRole("button", { name: "Start lab" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue lab" }),
    ).toHaveCount(0);
  });

  test("uses learner-safe copy when the briefing cannot load", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("scenario-briefing"),
      theme: "light",
      variant: "error",
    });

    await expect(
      page.getByRole("heading", { name: "Could not load this lab" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(
      page.getByText("Check your connection and try again."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("500");
    await expect(page.locator("main")).not.toContainText("scenarioId");
    await expect(page.locator("main")).not.toContainText(
      "Deterministic fixture failure",
    );
  });
});

test("the Broken Nginx briefing renders its exact learner contract", async ({
  page,
  ui,
}) => {
  const route = routeCase("scenario-briefing");
  ui.configure({
    sessionRole: route.sessionRole,
    runState: "archived",
  });
  const detail = ui.server.state.scenarioDetail as {
    briefing: Record<string, unknown>;
    courseLocation: Record<string, unknown>;
  };
  detail.briefing = {
    ...detail.briefing,
    difficulty: "easy",
    estimatedMinutes: 15,
    objectives: [
      {
        probeName: "nginx-running",
        vmName: "webserver",
        label: "hidden service probe",
        title: "Start the web server",
        bodyMarkdown: "HIDDEN_SERVICE_COMMAND",
        hintCount: 1,
      },
      {
        probeName: "port-80-open",
        vmName: "webserver",
        label: "hidden port probe",
        title: "Make the site reachable",
        bodyMarkdown: "HIDDEN_PORT_PATH",
        hintCount: 1,
      },
      {
        probeName: "default-site-enabled",
        vmName: "webserver",
        label: "hidden file probe",
        title: "Restore the default site",
        bodyMarkdown: "HIDDEN_SITE_PATH",
        hintCount: 1,
      },
    ],
  };
  detail.courseLocation = {
    ...detail.courseLocation,
    step: 1,
    steps: 1,
  };
  const course = ui.server.state.courses[0] as
    | { scenarioIds?: string[] }
    | undefined;
  if (course) course.scenarioIds = ["repair-nginx"];

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await ui.settle();

  await expect(page.getByText("Easy", { exact: true })).toBeVisible();
  await expect(page.getByText("about 15 minutes", { exact: true })).toBeVisible();
  await expect(page.getByText("step 1 of 1", { exact: true })).toBeVisible();
  const outcomes = page
    .getByRole("heading", { name: "Done when" })
    .locator("xpath=ancestor::section");
  await expect(outcomes.getByText("Start the web server")).toBeVisible();
  await expect(outcomes.getByText("Make the site reachable")).toBeVisible();
  await expect(outcomes.getByText("Restore the default site")).toBeVisible();
  await expect(outcomes).not.toContainText("HIDDEN_SERVICE_COMMAND");
  await expect(outcomes).not.toContainText("HIDDEN_PORT_PATH");
  await expect(outcomes).not.toContainText("HIDDEN_SITE_PATH");
});

test.describe("scenario briefing reflow", () => {
  for (const viewport of [
    { id: "small", width: 320, height: 700 },
    { id: "landscape", width: 667, height: 375 },
    { id: "tablet", width: 1100, height: 800 },
    { id: "desktop", width: 1440, height: 900 },
  ]) {
    test(`${viewport.id} keeps the learner flow within the page`, async ({
      page,
      ui,
    }) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await ui.open({ ...routeCase("scenario-briefing"), theme: "light" });

      await expect(
        page.getByRole("button", { name: "Continue lab" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Your task" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test("200% text keeps the next action and guidance available", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("scenario-briefing"), theme: "light" });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.waitForTimeout(100);

    const action = page.getByRole("button", { name: "Continue lab" });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await expect(page.getByText("Guidance is available while you work.")).toBeVisible();
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
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.waitForTimeout(100);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const progressWidths = await page
    .getByRole("progressbar")
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    );
  expect(
    Math.max(...progressWidths) - Math.min(...progressWidths),
  ).toBeLessThanOrEqual(0.5);
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Linux operations" }).click();
  await expect(
    page.getByRole("heading", { name: "Repair a broken nginx service" }),
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
  const course = page.locator(
    'section[data-course-id="operations"][data-course-scope="org-platform"]',
  );
  const courseButton = course.getByRole("link", {
    name: /Platform repair sequence/,
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

function legacyCourseSearch(url: URL): Array<string | null> {
  return [
    url.searchParams.get("course"),
    url.searchParams.get("organizationId"),
    url.searchParams.get("step"),
    url.searchParams.get("steps"),
  ];
}

function expectNoLegacyCourseSearch(url: string): void {
  expect(legacyCourseSearch(new URL(url))).toEqual([null, null, null, null]);
}

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
  await expect(page.getByRole("button", { name: "All courses" })).toBeVisible();
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
