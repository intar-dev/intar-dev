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
