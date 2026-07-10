import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectRouteScreenshot } from "./support/screenshot";

const runStates = [
  "launching",
  "booting",
  "waiting",
  "running",
  "disconnected",
  "solved",
  "failed",
  "ending",
  "archived",
  "replay",
] as const;

test.describe("focused visual states", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const runState of runStates) {
    test(`run · ${runState}`, async ({ page, ui }) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        runState,
      });
      await expectRouteScreenshot(page, `run-${runState}-dark-desktop`);
    });
  }

  for (const variant of ["empty", "loading", "error", "long"] as const) {
    test(`catalog · ${variant}`, async ({ page, ui }) => {
      await ui.open({
        ...routeCase("scenario-catalog"),
        theme: "light",
        variant,
      });
      await expectRouteScreenshot(page, `catalog-${variant}-light-desktop`);
    });
  }

  test("request access success", async ({ page, ui }) => {
    await ui.open({ ...routeCase("request-access"), theme: "light" });
    await page.getByLabel("GitHub username").fill("newoperator");
    await page
      .getByLabel(/How will you use the workshop/i)
      .fill("Preparing for an on-call rotation.");
    await page.getByRole("button", { name: "Request access" }).click();
    await expect(page.getByRole("heading", { name: /Request received/i })).toBeVisible();
    await expectRouteScreenshot(page, "request-access-success-light-desktop");
  });

  test("landing returning learner", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("landing"),
      sessionRole: "learner",
      theme: "light",
      runState: "running",
    });
    await expect(
      page
        .getByRole("link", { name: /Resume lab/i })
        .or(page.getByRole("button", { name: /Resume lab/i }))
        .first(),
    ).toBeVisible();
    await expectRouteScreenshot(page, "landing-returning-learner-light-desktop");
  });

  test("team instructor people tab", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("team-detail"),
      sessionRole: "instructor",
      theme: "light",
    });
    await page.getByRole("tab", { name: "People" }).click();
    await expect(page).toHaveURL(/tab=people/);
    await expectRouteScreenshot(page, "team-instructor-people-light-desktop");
  });

  test("team owner destructive confirmation", async ({ page, ui }) => {
    await ui.open({ ...routeCase("team-detail"), theme: "dark" });
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Delete team" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectRouteScreenshot(page, "team-delete-dialog-dark-desktop");
  });

  test("team member cannot force progress tab", async ({ page, ui }) => {
    const route = routeCase("team-detail");
    await ui.open({
      ...route,
      path: `${route.path}?tab=progress`,
      sessionRole: "team-member",
      theme: "light",
    });
    await expect(page).not.toHaveURL(/tab=progress/);
    await expectRouteScreenshot(page, "team-member-tab-fallback-light-desktop");
  });

  test("build master detail", async ({ page, ui }) => {
    await ui.open({ ...routeCase("admin-builds"), theme: "dark" });
    await page.getByRole("button", { name: "Details" }).first().click();
    await expect(page.getByText("Content hash").first()).toBeVisible();
    await expectRouteScreenshot(page, "build-detail-dark-desktop");
  });

  for (const tab of ["Users", "Teams"] as const) {
    test(`people · ${tab.toLowerCase()} tab`, async ({ page, ui }) => {
      await ui.open({ ...routeCase("admin-people"), theme: "light" });
      await page.getByRole("tab", { name: tab }).click();
      await expect(page).toHaveURL(new RegExp(`tab=${tab.toLowerCase()}`));
      await expectRouteScreenshot(
        page,
        `people-${tab.toLowerCase()}-light-desktop`,
      );
    });
  }

  test("people access mutation", async ({ page, ui }) => {
    await ui.open({ ...routeCase("admin-people"), theme: "light" });
    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText("No pending requests right now.")).toBeVisible();
    await expectRouteScreenshot(page, "people-access-approved-light-desktop");
  });

  test("authoring validation result", async ({ page, ui }) => {
    await ui.open({ ...routeCase("admin-authoring"), theme: "dark" });
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await editor.fill('scenario "broken" {');
    await page.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByLabel("Validation results")).toContainText(
      /validation error|validator error|failed/i,
    );
    await expectRouteScreenshot(page, "authoring-invalid-dark-desktop");
  });
});

test.describe("focused mobile workspace", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("run status dock", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    const statusAction = page.getByRole("button", {
      name: /checks|status|run details/i,
    });
    await expect(statusAction.first()).toBeVisible();
    await statusAction.first().click();
    await expectRouteScreenshot(page, "run-status-dock-dark-mobile");
  });
});
