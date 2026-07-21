import { DENSE_ROUTE_CASES } from "./routes";
import { test } from "./fixtures/test";
import { expectRouteScreenshot } from "./support/screenshot";

const themes = ["light", "dark"] as const;

if (DENSE_ROUTE_CASES.length * themes.length !== 20) {
  throw new Error("Dense tablet visual matrix must contain exactly 20 cases");
}

test.describe("dense tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  for (const theme of themes) {
    for (const route of DENSE_ROUTE_CASES) {
      test(`${route.id} · ${theme}`, async ({ page, ui }) => {
        await ui.open({ ...route, theme });
        await expectRouteScreenshot(page, `${route.id}-${theme}-tablet`);
      });
    }
  }
});
