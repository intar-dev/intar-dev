import { ROUTE_CASES } from "./routes";
import { expect, test } from "./fixtures/test";
import { expectRouteScreenshot } from "./support/screenshot";

const themes = ["light", "dark"] as const;
const viewports = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const;

if (ROUTE_CASES.length * themes.length * viewports.length !== 92) {
  throw new Error("Primary visual matrix must contain exactly 92 cases");
}

for (const viewport of viewports) {
  test.describe(`primary ${viewport.id}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const theme of themes) {
      for (const route of ROUTE_CASES) {
        test(`${route.id} · ${theme}`, async ({ page, ui }) => {
          await ui.open({ ...route, theme });
          if (route.id === "run-workspace") {
            await expect(
              page.locator("[data-run-lease-countdown]"),
            ).toBeVisible();
            await expect(
              page
                .getByRole("status")
                .filter({ hasText: /Terminal status:/i }),
            ).toHaveText(/Terminal status:\s*connected/i);
            if (viewport.id === "desktop") {
              await expect(
                page.locator("[data-run-learning-panel]"),
              ).toBeVisible();
              await expect(
                page.locator("[data-run-learning-panel-trigger]"),
              ).not.toBeVisible();
            } else {
              await expect(
                page.locator("[data-run-learning-panel]"),
              ).not.toBeVisible();
              await expect(
                page.locator("[data-run-learning-panel-trigger]"),
              ).toBeVisible();
            }
          }
          await expectRouteScreenshot(
            page,
            `${route.id}-${theme}-${viewport.id}`,
          );
        });
      }
    }
  });
}
