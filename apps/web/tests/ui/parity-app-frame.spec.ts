import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("the collapsed sidebar is remembered across a reload", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("runs"), theme: "light" });

  const sidebar = page.locator('[data-slot="sidebar"]').first();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");

  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
    "data-state",
    "collapsed",
  );
});

test("the drawer takes over below 64rem, the sidebar from it", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await ui.open({ ...routeCase("runs"), theme: "light" });
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect(page.locator('[data-mobile="true"]')).toBeVisible();
});

test("the page content stops at app-max on a very wide screen", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 3000, height: 1000 });
  await ui.open({ ...routeCase("runs"), theme: "light" });
  const column = page.locator('[data-page-variant] > div').first();
  const box = await column.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(2048);
});
