import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("the run checks panel heads its lecture with a plain Lecture label", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "light",
    runState: "running",
  });
  const heading = page.getByRole("heading", { name: "Lecture", exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByText("Lecture theory")).toHaveCount(0);
});

test("landing sections keep 4rem between them", async ({ page, ui }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await ui.open({ ...routeCase("landing"), theme: "light" });

  const rem = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  const loop = page.locator('section[aria-labelledby="landing-loop-heading"]');
  const sponsors = page.locator('aside[aria-labelledby="landing-sponsors-heading"]');
  expect(
    await loop.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingTop)),
  ).toBe(4 * rem);
  const sponsorPadding = await sponsors.evaluate((el) => {
    const style = getComputedStyle(el);
    return [style.paddingTop, style.paddingBottom].map(Number.parseFloat);
  });
  expect(sponsorPadding).toEqual([4 * rem, 4 * rem]);
});

test("organizations list is one divided card of link rows", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organizations"), theme: "light" });

  const list = page.locator("main ul.divide-y");
  await expect(list).toHaveCount(1);
  const row = list.locator("li > a", { hasText: "Platform Repair Crew" });
  await expect(row).toHaveAttribute("href", "/organizations/org-platform");
  // The rows share the list's frame: no card per organization.
  await expect(page.locator('main [data-slot="card"]')).toHaveCount(0);
  await row.click();
  await expect(page).toHaveURL(/\/organizations\/org-platform$/);
});

test("organization overview metrics are DS stat tiles", async ({ page, ui }) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });

  const tile = page.locator("main div.rounded-xl", {
    has: page.getByText("Members", { exact: true }),
  }).filter({ has: page.getByRole("button", { name: "Review access" }) });
  await expect(tile).toBeVisible();
  const label = tile.getByText("Members", { exact: true });
  const value = label.locator("xpath=following-sibling::p[1]");
  expect(
    await label.evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe("12px");
  expect(
    await value.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.fontSize, style.fontWeight];
    }),
  ).toEqual(["13px", "600"]);
  await tile.getByRole("button", { name: "Review access" }).click();
  await expect(page).toHaveURL(/tab=people/);
});

test("admin tab panels stay mounted so work survives a tab switch", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });

  const panels = page.locator('[data-slot="tabs-content"]');
  await expect(panels).toHaveCount(3);
  await expect(panels.locator(":scope:visible")).toHaveCount(1);

  const search = page.getByRole("searchbox", { name: "Search users" });
  await search.fill("mina");
  await expect(page.getByRole("link", { name: "Mina Learner" })).toBeVisible();

  await page.getByRole("tab", { name: "Sign-ups" }).click();
  await expect(page.getByRole("tab", { name: "Sign-ups" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panels).toHaveCount(3);
  await page.getByRole("tab", { name: "Users" }).click();
  await expect(page.getByRole("searchbox", { name: "Search users" })).toHaveValue(
    "mina",
  );
});

test("a failed scenario toggle reports inside its row, named after it", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-scenarios"), theme: "light" });
  await page.route("**/api/admin/scenarios/repair-dns/enabled", (route) => {
    ui.server.expectedUnavailable += 1;
    return route.fulfill({
      status: 503,
      json: { error: "The registry is read-only right now." },
    });
  });

  const row = page
    .locator("div.py-3")
    .filter({ hasText: "Trace an intermittent DNS failure" })
    .filter({ has: page.getByRole("button", { name: /(En|Dis)able scenario/ }) });
  await row.getByRole("button", { name: "Enable scenario" }).click();

  const alert = row.getByRole("alert");
  await expect(alert).toContainText(
    "Could not enable Trace an intermittent DNS failure",
  );
  await expect(alert).toContainText("The registry is read-only right now.");
  // Only that row shows it.
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test("a failed host refresh reports inside its host row", async ({ page, ui }) => {
  await ui.open({ ...routeCase("admin-hosts"), theme: "light" });
  const card = page.locator("article", { hasText: "agent-eu-1" });
  await expect(card).toBeVisible();

  // The next fleet read fails, so Refresh reports it.
  let failures = 0;
  await page.route("**/api/admin/fleet-snapshot**", (route) => {
    failures += 1;
    ui.server.expectedUnavailable += 1;
    return route.fulfill({
      status: 503,
      json: { error: "The fleet is unreachable." },
    });
  });
  await card.getByRole("button", { name: "Host actions" }).click();
  await page.getByRole("menuitem", { name: "Refresh" }).click();

  await expect(card.getByRole("alert")).toContainText(
    "Could not refresh agent-eu-1: The fleet is unreachable.",
  );
  expect(failures).toBeGreaterThan(0);
});

test("a revisit to the hosts page shows cached rows and refreshes quietly", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-hosts"), theme: "light" });
  await expect(page.locator("article", { hasText: "agent-eu-1" })).toBeVisible();

  await page.getByRole("link", { name: "Scenarios", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/scenarios$/);

  // The refresh is slow: the cached rows must not wait for it.
  let refreshRequests = 0;
  await page.route("**/api/admin/fleet-snapshot**", async (route) => {
    refreshRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });
  await page.getByRole("link", { name: "Hosts", exact: true }).click();

  const card = page.locator("article", { hasText: "agent-eu-1" });
  await expect(card).toBeVisible({ timeout: 1000 });
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => refreshRequests).toBeGreaterThan(0);
});
