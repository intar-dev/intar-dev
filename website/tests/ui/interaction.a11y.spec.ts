import { expect, test } from "./fixtures/test";
import { paginatedScenarioFixtures } from "./fixtures/data";
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
  const scenarios = page.getByRole("tab", { name: "Scenarios" });

  await overview.focus();
  await expect(overview).toBeFocused();
  await page.keyboard.press("ArrowRight");

  await expect(scenarios).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(scenarios).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=scenarios/);
});

test("large card collections paginate without repeating items", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  ui.server.state.scenarios = paginatedScenarioFixtures();
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  const pagination = page.getByRole("navigation", {
    name: "scenarios pagination",
  });
  const scenarioLinks = page.locator('a[href^="/scenarios/paging-scenario-"]');
  await expect(pagination).toContainText("1–6 of 13 scenarios");
  await expect(scenarioLinks).toHaveCount(6);
  const firstPageHrefs = await scenarioLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );

  await pagination.getByRole("button", { name: /^Next/ }).click();
  await expect(pagination).toContainText("7–12 of 13 scenarios");
  await expect(scenarioLinks).toHaveCount(6);
  const secondPageHrefs = await scenarioLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(secondPageHrefs).not.toEqual(firstPageHrefs);
  expect(secondPageHrefs.some((href) => firstPageHrefs.includes(href))).toBe(
    false,
  );

  await pagination.getByRole("button", { name: "Page 3" }).click();
  await expect(pagination).toContainText("13–13 of 13 scenarios");
  await expect(scenarioLinks).toHaveCount(1);
  await expect(
    pagination.getByRole("button", { name: "Page 3" }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByRole("textbox", { name: "Search scenarios" }).fill("Paging");
  await expect(pagination).toContainText("1–6 of 13 scenarios");
  await expect(scenarioLinks).toHaveCount(6);
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
      .getByRole("link", { name: /home|scenarios|workshop/i })
      .or(page.getByRole("button", { name: /home|scenarios|workshop/i }))
      .first(),
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
