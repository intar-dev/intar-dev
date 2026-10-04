import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("the sidebar is one Main navigation landmark with a single current row", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("admin-hosts"), theme: "light" });
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByRole("link", { name: /^Hosts/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Learn", { exact: true })).toHaveCount(0);
});

test("the menu button names its action and reports its state", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const trigger = page.locator('[data-slot="sidebar-trigger"]');
  await expect(trigger).toHaveAccessibleName("Collapse sidebar");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.click();
  await expect(trigger).toHaveAccessibleName("Expand sidebar");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("a collapsed sidebar is remembered after a reload and the rail is 3rem", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.reload();
  const sidebar = page.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  const box = await page
    .locator('[data-slot="sidebar-container"]')
    .boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(48);
});

test("the navigation drawer is 18rem wide, named, and closes on the current page", async ({
  page,
  ui,
}) => {
  for (const width of [390, 820]) {
    await page.setViewportSize({ width, height: 1000 });
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(288);
    await drawer.getByRole("link", { name: /^Courses/ }).click();
    await expect(drawer).toBeHidden();
  }
});

test("sidebar rows show the lifting outline, not a flush ring", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const row = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^My runs/ });
  await row.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  const outline = await row.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).toEqual({ style: "solid", width: "2px" });
});

test("the My runs row keeps its height when the rail collapses", async ({
  page,
  ui,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const row = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^My runs/ });
  const before = (await row.boundingBox())?.height;
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect.poll(async () => (await row.boundingBox())?.height).toBe(before);
});
