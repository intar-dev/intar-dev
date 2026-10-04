import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test.describe("overlays", () => {
  test("a phone's bottom sheet leads with a handle that closes it on a tap", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.getByRole("button", { name: /Course outline, lecture/ }).click();
    const sheet = page.locator("[data-course-outline-sheet]");
    await expect(sheet).toBeVisible();
    const handle = sheet.locator('[data-slot="sheet-handle"]');
    await expect(handle).toBeVisible();
    await handle.click();
    await expect(sheet).toBeHidden();
  });

  test("the theme trigger is named for what a press does, without 'click'", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("landing"), theme: "light" });
    const trigger = page.getByRole("button", { name: /^Switch to .+ theme$/ });
    await expect(trigger).toBeVisible();
  });
});
