import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test.describe("course outline sheet", () => {
  test("a phone gets a bottom sheet whose tab stops are all visible", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.getByRole("button", { name: /Course outline, lecture/ }).click();
    const sheet = page.locator("[data-course-outline-sheet]");
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toBeVisible();
    }
  });

  test("a tablet gets a right sheet that closes when a lecture is chosen", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.getByRole("button", { name: /Course outline, lecture/ }).click();
    const sheet = page.locator("[data-course-outline-sheet]");
    await expect(sheet).toHaveAttribute("data-side", "right");
    await sheet.getByRole("link").first().click();
    await expect(sheet).toBeHidden();
  });
});

test.describe("one pulse", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const animationName = (page: import("@playwright/test").Page) =>
    page
      .locator('[data-pulse="yields"]')
      .first()
      .evaluate((node) => getComputedStyle(node).animationName);

  test("the current lecture's dot yields to a live run's pulse", async ({
    page,
    ui,
  }) => {
    // The sidebar badge's dot is the live run's pulse.
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(
      page.getByRole("link", { name: /My runs.*ongoing run/i }),
    ).toBeVisible();
    await expect(page.locator('[data-pulse="live"]').first()).toBeVisible();
    expect(await animationName(page)).toBe("none");
  });

  test("with no live run it is the one that breathes", async ({ page, ui }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    ui.server.state.runs = [];
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator('[data-pulse="yields"]').first()).toBeVisible();
    await expect(page.locator('[data-pulse="live"]')).toHaveCount(0);
    expect(await animationName(page)).toBe("intar-live");
  });
});
