import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

// Design-system parity for the run's startup, saving and recap screens, the
// completion bar and the landing preview.

const ARRIVAL_ANIMATIONS = ["intar-rise", "intar-pop", "intar-live"];

test.describe("terminal region", () => {
  test("is named by its machine, since the embedded terminal has no header chip", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expect(page.getByRole("region", { name: "web terminal" })).toBeVisible();
  });
});

test.describe("completion bar", () => {
  test("a run that loads solved shows the bar still", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    const bar = page.locator("[data-run-completion-bar]");
    await expect(bar).toBeVisible();
    const arrivals = await bar.evaluate((element, names) =>
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation instanceof CSSAnimation &&
            names.includes(animation.animationName),
        ).length,
      ARRIVAL_ANIMATIONS,
    );
    expect(arrivals).toBe(0);
  });

  test("the bar waits for the closing line, then rises and pops its check", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await expect(page.locator("[data-run-completion-bar]")).toHaveCount(0);

    ui.server.setRunState("solved");
    const bar = page.locator("[data-run-completion-bar]");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveCSS("animation-delay", "0.65s");
    await expect(bar.locator("svg").first()).toHaveCSS(
      "animation-delay",
      "0.77s",
    );
  });

  test("the busy button keeps focus and its width", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    ui.server.state.variant = "error";
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/api/scenarios/runs/run-active/destroy",
      async (route) => {
        await held;
        await route.fulfill({ status: 503, json: { error: "unavailable" } });
      },
    );

    // Its name follows the label, so find it by its marker while it is busy.
    const finish = page.locator("[data-run-finish-and-save]");
    await expect(finish).toHaveAccessibleName("Finish and save");
    const before = await finish.boundingBox();
    await finish.focus();
    await finish.click();
    try {
      await expect(finish).toHaveAttribute("aria-busy", "true");
      await expect(finish).toBeFocused();
      const after = await finish.boundingBox();
      expect(Math.round(after?.width ?? 0)).toBe(
        Math.round(before?.width ?? 0),
      );
    } finally {
      release();
    }
  });
});

test.describe("startup sequence", () => {
  test("the card stops at 36rem and the state words share one box", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    const card = page.locator("[data-run-sequence-screen]");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(576 + 1);

    const widths = await page
      .locator("[data-run-sequence-status]")
      .evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
      );
    expect(widths.length).toBeGreaterThan(1);
    expect(new Set(widths).size).toBe(1);

    // Only the current word is visible; the others are hidden from everyone.
    const visibleWords = await page
      .locator("[data-run-sequence-step]")
      .first()
      .locator("[data-run-sequence-status] > *")
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) => getComputedStyle(node).visibility === "visible")
            .length,
      );
    expect(visibleWords).toBe(1);
  });

  test("only the working stage unfolds its detail", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });

    const folds = page.locator("[data-run-sequence-detail]");
    expect(await folds.count()).toBe(4);
    await expect(
      page.locator("[data-run-sequence-detail][data-open]"),
    ).toHaveCount(1);
    const hidden = await folds.evaluateAll((nodes) =>
      nodes
        .filter((node) => !node.hasAttribute("data-open"))
        .map((node) => getComputedStyle(node.firstElementChild!).visibility),
    );
    expect(hidden.every((visibility) => visibility === "hidden")).toBe(true);
  });

  test("waiting stages are drawn at 70% border-strong", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });

    const pending = page
      .locator("[data-run-sequence-track] > span")
      .last();
    const background = await pending.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    // color-mix at 70% resolves to an alpha of 0.7.
    expect(background).toMatch(/0\.7\)?$|\/ 0\.7\)/);
  });
});

test.describe("recap", () => {
  test("a saved run opens still: no rise, no pops, no ring", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });

    const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
    await expect(recap.getByRole("heading", { name: "Solved" })).toBeVisible();
    const arrivals = await recap.evaluate((element, names) =>
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation instanceof CSSAnimation &&
            names.includes(animation.animationName),
        ).length,
      ARRIVAL_ANIMATIONS,
    );
    expect(arrivals).toBe(0);
  });

  test("a recap with every check verified draws its bar closed", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });

    const bar = page.locator("[data-run-recap-progress]");
    await expect(bar).toHaveAttribute("aria-hidden", "true");
    await expect(bar).toHaveAttribute("data-closed", "true");
    await expect(bar).toHaveCSS("column-gap", "0px");
  });

  test("the replay row stands alone, without a hairline", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });

    const row = page.locator(
      'section[aria-labelledby="run-recap-replay-heading"]',
    );
    await expect(row).toBeVisible();
    await expect(row).toHaveCSS("border-top-width", "0px");
  });
});

test.describe("landing", () => {
  test("the payoff is set in the italic", async ({ page, ui }) => {
    await ui.open({ ...routeCase("landing"), theme: "light" });

    const payoff = page.getByText("Prove the fix.");
    await expect(payoff).toHaveCSS("font-style", "italic");
    await expect(payoff).toHaveCSS("font-weight", "400");
  });

  test("the hero renders still on load", async ({ page, ui }) => {
    await ui.open({ ...routeCase("landing"), theme: "light" });

    const hero = page.locator("main section").first();
    const rises = await hero.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation instanceof CSSAnimation &&
            animation.animationName === "intar-rise",
        ).length,
    );
    expect(rises).toBe(0);
  });

  test("the preview shows its Checks panel from 60rem", async ({ page, ui }) => {
    await ui.open({ ...routeCase("landing"), theme: "light" });
    await page.setViewportSize({ width: 980, height: 900 });

    await expect(page.locator("figure h2", { hasText: /^Lecture$/ })).toBeVisible();
  });
});
