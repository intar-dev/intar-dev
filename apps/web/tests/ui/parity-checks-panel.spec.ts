import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

// Design-system parity for the run's Checks, Hints and Solution sections.

test.describe("checks panel", () => {
  test("a run that loads solved shows the closed line without a current", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    const bar = page.locator("[data-run-learning-panel] [data-checks-bar]");
    await expect(bar).toHaveAttribute("data-closed", /.*/);
    await expect(bar).not.toHaveAttribute("data-current", /.*/);
    await expect(bar).toHaveCSS("column-gap", "0px");
  });

  test("the circuit closes and one current runs when the run is solved", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const bar = page.locator("[data-run-learning-panel] [data-checks-bar]");
    await expect(bar).not.toHaveAttribute("data-closed", /.*/);
    await expect(bar).toHaveCSS("column-gap", "4px");

    ui.server.setRunState("solved");
    await expect(bar).toHaveAttribute("data-closed", /.*/);
    await expect(bar).toHaveAttribute("data-current", /.*/);
    await expect(bar).toHaveCSS("column-gap", "0px");
  });

  test("status words share one box, so the title column never reflows", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const words = page.locator(
      "[data-run-learning-panel] [data-check-status] [data-swap='end']",
    );
    expect(await words.count()).toBeGreaterThan(1);
    const widths = await words.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
    );
    expect(new Set(widths).size).toBe(1);
  });
});

test.describe("hints", () => {
  test("a reveal moves focus to the hint and announces it", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const panel = page.locator("[data-run-learning-panel]");
    await panel
      .getByRole("button", { name: "Reveal", exact: true })
      .first()
      .click();

    await expect(
      panel.getByText("Inspect the service boundary", { exact: true }),
    ).toBeVisible();
    const body = panel.locator("[data-hint-state='revealed'] [tabindex='-1']");
    await expect(body.first()).toBeFocused();
    await expect(
      panel.getByRole("status").filter({ hasText: /^Hint 1 revealed:/ }),
    ).toHaveText("Hint 1 revealed: Inspect the service boundary");
  });

  test("hints revealed on load render still", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    const panel = page.locator("[data-run-learning-panel]");
    await expect(panel.locator(".animate-rise")).toHaveCount(0);
    await expect(panel.locator(".hint-unfold[data-just]")).toHaveCount(0);
  });
});
