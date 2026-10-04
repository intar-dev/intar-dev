import { expect, test, type UiHarness } from "./fixtures/test";
import { routeCase } from "./routes";

// Design-system parity for the run workspace on phones, tablets and landscape.

async function openRun(ui: UiHarness, runState: "running" | "solved" = "running") {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState,
  });
}

test.describe("phone, portrait", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the dock opens the run sheet at peek, and the handle toggles full", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    const dock = page.locator("[data-run-dock]");
    await expect(dock).toBeVisible();
    await expect(page.locator("[data-run-learning-panel]")).toBeHidden();

    await dock.getByRole("button", { name: /^Checks/ }).click();
    const sheet = page.locator("[data-run-learning-mobile-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(sheet).toHaveAttribute("data-detent", "peek");

    await sheet.getByRole("button", { name: "Expand panel" }).click();
    await expect(sheet).toHaveAttribute("data-detent", "full");
    await sheet.getByRole("button", { name: "Shrink panel" }).click();
    await expect(sheet).toHaveAttribute("data-detent", "peek");

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("the run bar is one slim row with an icon-only back link", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    const back = page.locator("[data-run-back]");
    await expect(back).toBeVisible();
    await expect(back).toHaveAccessibleName(/^Back to/);
    // The words are screen-reader only below bp-md.
    const box = await back.boundingBox();
    expect(box!.width).toBeLessThan(70);

    const heading = page.getByRole("heading", { level: 1 });
    const status = page.locator("[data-run-workspace-header]");
    const [headingBox, backBox] = await Promise.all([
      heading.boundingBox(),
      back.boundingBox(),
    ]);
    // Back and title share the first row.
    expect(Math.abs(headingBox!.y - backBox!.y)).toBeLessThan(24);
    await expect(status.getByText("In progress")).toBeVisible();
  });

  test("the terminal is 13px on phones", async ({ page, ui }) => {
    await openRun(ui);
    await expect(page.locator("[data-run-terminal] .xterm-rows")).toHaveCSS(
      "font-size",
      "13px",
    );
  });

  test("a solved run that loads solved shows its completion still", async ({
    page,
    ui,
  }) => {
    await openRun(ui, "solved");
    const bar = page.locator("[data-run-completion-bar]");
    await expect(bar).toBeVisible();
    expect(
      await bar.evaluate((node) => getComputedStyle(node).animationName),
    ).toBe("none");
  });
});

test.describe("phone, landscape", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test("the dock moves into the bar and the panel is a side sheet", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    await expect(page.locator("[data-run-dock]")).toHaveCount(0);
    const checks = page.getByRole("button", { name: "Checks", exact: true });
    await expect(checks).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Lecture and hints" }),
    ).toBeVisible();

    await checks.click();
    // The open sheet is modal, so the bar behind it leaves the accessibility
    // tree; read the trigger's state by its attribute instead.
    await expect(
      page.locator("[data-run-workspace-header] [data-run-learning-panel-trigger]"),
    ).toHaveAttribute("aria-expanded", "true");
    const sheet = page.locator("[data-run-learning-mobile-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "right");
    const box = await sheet.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.width / viewport.width).toBeGreaterThan(0.4);
    expect(box!.width / viewport.width).toBeLessThan(0.5);
  });
});

test.describe("tablet, portrait", () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test("the panel docks under the terminal, three to two", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    const panel = page.locator("[data-run-learning-panel]");
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-run-learning-panel-trigger]")).toBeHidden();
    await expect(page.locator("[data-run-dock]")).toHaveCount(0);

    const [workArea, panelBox] = await Promise.all([
      page.locator("[data-run-work-area]").boundingBox(),
      panel.boundingBox(),
    ]);
    // Over, not beside.
    expect(panelBox!.y).toBeGreaterThanOrEqual(
      workArea!.y + workArea!.height - 1,
    );
    expect(workArea!.height / panelBox!.height).toBeGreaterThan(1.2);
  });
});

test.describe("laptop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("terminal and panel sit side by side, two to one, with no key row", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    const [workArea, panel] = await Promise.all([
      page.locator("[data-run-work-area]").boundingBox(),
      page.locator("[data-run-learning-panel]").boundingBox(),
    ]);
    expect(panel!.x).toBeGreaterThanOrEqual(workArea!.x + workArea!.width - 1);
    expect(workArea!.width / panel!.width).toBeGreaterThan(1.8);
    await expect(page.locator("[data-terminal-key-row]")).toHaveCount(0);
  });

  test("the terminal edge warms toward the brand while it has focus", async ({
    page,
    ui,
  }) => {
    await openRun(ui);

    const frame = page.locator("[data-run-terminal]");
    // The terminal may take focus by itself once it connects, so settle it
    // unfocused first and measure the idle edge after its fade has finished.
    await expect(page.locator('[data-terminal-status="connected"]')).toBeVisible();
    await frame.locator("textarea").evaluate((n) => (n as HTMLElement).blur());
    const idle = await frame.evaluate(async (n) => {
      await Promise.all(n.getAnimations().map((a) => a.finished));
      return getComputedStyle(n).borderTopColor;
    });
    await frame.locator("textarea").focus();
    await expect
      .poll(() => frame.evaluate((n) => getComputedStyle(n).borderTopColor))
      .not.toBe(idle);
  });
});
