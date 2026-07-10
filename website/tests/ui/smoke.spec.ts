import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("public workshop entry keeps sign in focused and sponsors prominent", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });
  await expect(
    page.getByRole("button", { name: /Sign in with GitHub/i }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /Request access/i })
      .or(page.getByRole("button", { name: /Request access/i })),
  ).toHaveCount(0);

  const sponsorRow = page.locator(
    'aside[aria-labelledby="landing-sponsors-heading"]',
  );
  const heading = page.getByRole("heading", { level: 1 });
  await expect(sponsorRow).toBeVisible();
  const hetznerLogo = page
    .getByRole("link", { name: "Hetzner" })
    .locator("img");
  const namespaceLogo = page
    .getByRole("link", { name: "namespace" })
    .locator("img");
  await expect(hetznerLogo).toBeVisible();
  await expect(namespaceLogo).toBeVisible();

  const [sponsorBox, headingBox, hetznerBox, namespaceBox] = await Promise.all([
    sponsorRow.boundingBox(),
    heading.boundingBox(),
    hetznerLogo.boundingBox(),
    namespaceLogo.boundingBox(),
  ]);
  expect(sponsorBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(hetznerBox).not.toBeNull();
  expect(namespaceBox).not.toBeNull();
  expect(sponsorBox!.y).toBeLessThan(headingBox!.y);
  expect(hetznerBox!.height).toBeGreaterThanOrEqual(48);
  expect(namespaceBox!.height).toBeGreaterThanOrEqual(40);
});

test("transactional access request submits deterministically", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("request-access"), theme: "light" });
  await page.getByLabel("GitHub username").fill("newoperator");
  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByRole("heading", { name: /Request received/i })).toBeVisible();
});

test("learner discovery filters the catalog", async ({ page, ui }) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  const search = page.getByLabel(/Search scenarios/i);
  await search.fill("DNS");
  await expect(page.getByRole("heading", { name: /Trace an intermittent DNS failure/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Repair a broken nginx service/i })).toBeHidden();
});

test("run workspace opens a deterministic terminal transport", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(page.getByText(/Status:\s*connected/i)).toBeVisible();
});

test("team workspace keeps the active tab in the URL", async ({ page, ui }) => {
  await ui.open({ ...routeCase("team-detail"), theme: "light" });
  await page.getByRole("tab", { name: "Assignments" }).click();
  await expect(page).toHaveURL(/tab=assignments/);
  await expect(page.getByRole("heading", { name: "Assignments" })).toBeVisible();
});

test("admin operations expose URL-backed people views", async ({ page, ui }) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });
  await page.getByRole("tab", { name: "Users" }).click();
  await expect(page).toHaveURL(/tab=users/);
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
});

test("authoring editor validates with the browser WASM shell", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-authoring"), theme: "dark" });
  const editor = page.locator(".cm-content");
  await editor.fill('scenario "broken" {');
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByLabel("Validation results")).toContainText(
    /validation error|validator error|failed/i,
  );
});
