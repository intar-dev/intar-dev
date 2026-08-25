import { expect, test } from "./fixtures/test";
import { paginatedScenarioFixtures } from "./fixtures/data";
import { routeCase } from "./routes";
import { expectRouteScreenshot } from "./support/screenshot";

test.describe("focused visual states", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("run · running guidance popover", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await page.locator("[data-run-learning-panel-trigger]").click();
    const panel = page.locator("[data-run-learning-panel-content]");
    await expect(
      panel.getByRole("heading", { name: "Checks and guidance" }),
    ).toBeVisible();
    await expect(panel.getByText("0/2 verified", { exact: true })).toBeVisible();
    await expectRouteScreenshot(page, "run-running-guidance-dark-desktop");
  });

  test("run · booting guidance panel", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expect(
      page.getByRole("heading", { name: "Preparing your workspace" }),
    ).toBeVisible();
    await page.locator("[data-run-learning-panel-trigger]").click();
    await expect(
      page
        .locator("[data-run-learning-panel-content]")
        .getByRole("heading", { name: "Work order" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-booting-guidance-dark-desktop");
  });

  test("run · solved guidance panel", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });
    await page.locator("[data-run-learning-panel-trigger]").click();
    const panel = page.locator("[data-run-learning-panel-content]");
    await expect(
      panel.getByRole("heading", { name: "Lab solved" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Finish and save" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-solved-guidance-dark-desktop");
  });

  test("run · saving recap", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expect(
      page.getByRole("heading", { name: "Saving your run…" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-saving-recap-dark-desktop");
  });

  test("run · settled recap", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "archived",
    });
    await expect(
      page.getByRole("heading", { name: "Solved" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Final checks" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-settled-recap-dark-desktop");
  });

  test("run · dense checks and hints", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      variant: "long",
      runState: "running",
    });
    await page.locator("[data-run-learning-panel-trigger]").click();
    const panel = page.locator("[data-run-learning-panel-content]");
    await expect(panel.getByText("Hints", { exact: true })).toBeVisible();
    await panel
      .getByRole("button", { name: "Reveal", exact: true })
      .first()
      .click();
    await expect(
      panel.getByText("Inspect the service boundary", { exact: true }),
    ).toHaveCount(1);
    await panel
      .getByRole("button", { name: "Reveal", exact: true })
      .click();
    await expect(
      panel.getByText("Inspect the service boundary", { exact: true }),
    ).toHaveCount(2);
    await expect(panel.getByText("2/2 used", { exact: true })).toBeVisible();
    await expectRouteScreenshot(page, "run-dense-checks-hints-dark-desktop");
  });

  test("run · replay recap", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
    await page.getByRole("button", { name: "Watch replay" }).click();
    await expect(page.locator(".run-artifact-player .ap-player")).toBeVisible();
    await expectRouteScreenshot(page, "run-replay-recap-dark-desktop");
  });

  test("runs · finishing in background", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("runs"),
      theme: "light",
      runState: "ending",
    });
    await expect(
      page.getByRole("heading", { name: "Finishing in background" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "runs-finishing-light-desktop");
  });

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

  test("catalog · paginated", async ({ page, ui }) => {
    await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
    ui.server.state.scenarios = paginatedScenarioFixtures();
    ui.server.state.courses = [];
    ui.server.state.assignments = [];
    ui.server.state.runs = [];
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await page.getByRole("button", { name: "General practice" }).click();
    await expect(
      page.getByRole("navigation", { name: "scenarios pagination" }),
    ).toContainText("1–9 of 19 scenarios");
    await expectRouteScreenshot(page, "catalog-paginated-light-desktop");
  });

  test("catalog · authored course", async ({ page, ui }) => {
    await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
    await page.getByRole("button", { name: "Linux operations" }).click();
    await expect(
      page.locator(
        'section[data-course-id="operations"][data-course-view="detail"]',
      ),
    ).toBeVisible();
    await expectRouteScreenshot(page, "catalog-authored-light-desktop");
  });

  test("beta invite ready", async ({ page, ui }) => {
    await ui.open({ ...routeCase("join-beta"), theme: "light" });
    await expect(
      page.getByRole("heading", { name: "Join the intar.dev beta" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "join-beta-ready-light-desktop");
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
    await expectRouteScreenshot(
      page,
      "landing-returning-learner-light-desktop",
    );
  });

  test("organization admin members tab", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("organization-detail"),
      sessionRole: "instructor",
      theme: "light",
    });
    await page.getByRole("tab", { name: "Members" }).click();
    await expect(page).toHaveURL(/tab=people/);
    await expectRouteScreenshot(
      page,
      "organization-admin-members-light-desktop",
    );
  });

  test("organization owner destructive confirmation", async ({ page, ui }) => {
    await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
    await page.getByRole("tab", { name: "Settings" }).click();
    await page
      .getByRole("button", { name: "Delete organization" })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectRouteScreenshot(
      page,
      "organization-delete-dialog-dark-desktop",
    );
  });

  test("organization member cannot force progress tab", async ({
    page,
    ui,
  }) => {
    const route = routeCase("organization-detail");
    await ui.open({
      ...route,
      path: `${route.path}?tab=progress`,
      sessionRole: "organization-member",
      theme: "light",
    });
    await expect(page).not.toHaveURL(/tab=progress/);
    await expectRouteScreenshot(
      page,
      "organization-member-tab-fallback-light-desktop",
    );
  });

  test("build master detail", async ({ page, ui }) => {
    await ui.open({ ...routeCase("admin-builds"), theme: "dark" });
    await page.getByRole("button", { name: "Details" }).first().click();
    await expect(page.getByText("Content hash").first()).toBeVisible();
    await expectRouteScreenshot(page, "build-detail-dark-desktop");
  });

  for (const tab of ["Users", "Organizations"] as const) {
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

  test("people invite revocation", async ({ page, ui }) => {
    await ui.open({ ...routeCase("admin-people"), theme: "light" });
    const inviteRow = page
      .getByRole("row")
      .filter({ hasText: "intar_beta_AAAAAAAA" });
    await inviteRow.getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke this invite?" });
    await dialog.getByRole("button", { name: "Revoke invite" }).click();
    await page.locator("details > summary").filter({ hasText: "History" }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "intar_beta_AAAAAAAA" }),
    ).toContainText("Revoked");
    await expectRouteScreenshot(page, "people-invite-revoked-light-desktop");
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

  test("running guidance sheet", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await page.locator("[data-run-learning-panel-trigger]").click();
    await expect(
      page
        .locator("[data-run-learning-panel-content]")
        .getByRole("heading", { name: "Checks and guidance" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-running-guidance-dark-mobile");
  });

  test("booting guidance sheet", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expect(
      page.getByRole("heading", { name: "Preparing your workspace" }),
    ).toBeVisible();
    await page.locator("[data-run-learning-panel-trigger]").click();
    await expect(
      page
        .locator("[data-run-learning-panel-content]")
        .getByRole("heading", { name: "Work order" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-booting-guidance-dark-mobile");
  });
});

for (const viewport of [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`organization courses · ${viewport.id}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const theme of ["light", "dark"] as const) {
      test(`${theme}`, async ({ page, ui }) => {
        await ui.open({ ...routeCase("organization-detail"), theme });
        await page
          .locator("main")
          .getByRole("button", { name: "Courses", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Platform repair sequence" }),
        ).toBeVisible();
        await expectRouteScreenshot(
          page,
          `organization-courses-${theme}-${viewport.id}`,
        );
      });

      test(`${theme} · combined General practice`, async ({ page, ui }) => {
        await ui.open({ ...routeCase("organization-detail"), theme });
        await page
          .locator("main")
          .getByRole("button", { name: "Courses", exact: true })
          .click();
        await page
          .locator('section[data-course-scope="generated"]')
          .getByRole("link", { name: /General practice/ })
          .click();
        const generalPractice = page.locator(
          'section[data-course-scope="generated"][data-course-view="detail"]',
        );
        await generalPractice.scrollIntoViewIfNeeded();
        await expect(
          generalPractice.locator('a[href*="recover-postgres"]'),
        ).toHaveCount(1);
        await expect(
          generalPractice.locator('a[href*="platform-firewall"]'),
        ).toHaveCount(1);
        await expectRouteScreenshot(
          page,
          `organization-general-practice-${theme}-${viewport.id}`,
        );
      });
    }
  });
}

test.describe("wide operational states", () => {
  test.use({ viewport: { width: 2048, height: 944 } });

  test("admin overview · empty", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("admin-overview"),
      theme: "dark",
      variant: "empty",
    });
    await expect(
      page.getByRole("heading", { name: "No active scenario runs" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "admin-overview-empty-dark-wide");
  });
});
