import { ROUTE_CASES } from "./routes";
import { expect, test } from "./fixtures/test";
import { expectRouteScreenshot } from "./support/screenshot";

const themes = ["light", "dark"] as const;
const viewports = [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const;

if (ROUTE_CASES.length * themes.length * viewports.length !== 96) {
  throw new Error("Primary visual matrix must contain exactly 96 cases");
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
