import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectNoHorizontalOverflow } from "./support/layout";

const REM = 16;

test.describe("learning decisions", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("outline rows carry no scenario or lecture-only label", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    const rail = page.locator("[data-course-outline-rail]");
    await expect(rail.getByRole("listitem").first()).toBeVisible();
    await expect(rail.getByText("Lecture only")).toHaveCount(0);
    await expect(rail.getByText("Scenario", { exact: true })).toHaveCount(0);
    // The lecture's own meta line keeps it.
    await expect(
      page.getByRole("article").getByText(/^(Scenario|Lecture only)$/),
    ).toBeVisible();
  });

  test("the outline column is flat: only the current row is raised", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    const rail = page.locator("[data-course-outline-rail]");
    await expect(rail).toBeVisible();
    for (const node of [rail, rail.locator(":scope > div"), rail.locator("ol")]) {
      await expect(node).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(node).toHaveCSS("box-shadow", "none");
    }
    const pill = rail.locator("[data-outline-pill]");
    await expect(pill).not.toHaveCSS("box-shadow", "none");
    const rows = rail.locator("li:not([data-current]) > *");
    for (const row of await rows.all()) {
      await expect(row).toHaveCSS("box-shadow", "none");
      await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
  });

  test("the lecture title and lede stop at 46rem", async ({ page, ui }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    const title = page.getByRole("article").getByRole("heading", { level: 1 });
    await expect(title).toBeVisible();
    await expect(title).toHaveCSS("max-width", `${46 * REM}px`);
    const lede = page.locator("article p.text-lede");
    await expect(lede).toBeVisible();
    await expect(lede).toHaveCSS("max-width", `${46 * REM}px`);
    const box = await lede.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(46 * REM + 1);
  });

  test("catalog filters sit inline from bp-md and need no Filters button", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    await expect(page.getByRole("button", { name: "Easy" })).toBeVisible();
    await expect(page.getByLabel("Filter lectures by category")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters/ })).toHaveCount(0);
  });

  test("on a phone the filters collapse behind a button with an active count", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    const trigger = page.getByRole("button", { name: "Filters", exact: true });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("button", { name: "Easy" })).toHaveCount(0);
    await expect(page.getByLabel("Filter lectures by category")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tags" })).toHaveCount(0);

    await trigger.click();
    const sheet = page.locator("[data-filter-sheet]");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(sheet.getByRole("heading", { name: "Filters" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Easy" })).toBeVisible();
    await expect(sheet.getByLabel("Filter lectures by category")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Tags" })).toBeVisible();

    // The count is announced from inside the sheet, which makes the page's
    // own count inert while it is open.
    await expect(sheet.locator("[aria-live=polite]")).toContainText(/Showing/);
    await sheet.getByRole("button", { name: "Easy" }).click();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Filters, 1 active" }),
    ).toHaveText(/Filters · 1/);
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("clearing from the sheet resets the count", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const sheet = page.locator("[data-filter-sheet]");
    await sheet.getByRole("button", { name: "Easy" }).click();
    await sheet.getByRole("button", { name: "Clear filters" }).click();
    // The page sends focus to its search field; with the sheet open, focus
    // stays inside it.
    await expect(sheet.getByRole("button", { name: "Done" })).toBeFocused();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByRole("button", { name: "Filters", exact: true }),
    ).toBeVisible();
  });
});
