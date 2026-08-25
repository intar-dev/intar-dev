import { expect, test } from "./fixtures/test";
import { paginatedScenarioFixtures } from "./fixtures/data";
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
  "rendering",
  "archived",
  "replay-failed",
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
      if (runState === "disconnected") {
        await expect(
          page.getByText("The terminal session ended. Reconnect to continue.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Reconnect terminal" }),
        ).toBeVisible();
      }
      await expectRouteScreenshot(page, `run-${runState}-dark-desktop`);
    });
  }

  test("run · ending · light", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "ending",
    });
    await expectRouteScreenshot(page, "run-ending-light-desktop");
  });

  test("run · dense multi-probe history", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      variant: "long",
      runState: "ending",
    });
    await expect(
      page.getByRole("heading", { name: "Needs repair" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Verified" }),
    ).toHaveCount(1);
    await expect(
      page.locator('ol[aria-label="Run timeline"] ul > li'),
    ).toHaveCount(6);
    await expectRouteScreenshot(page, "run-probes-dense-dark-desktop");
  });

  test("run · inline replay", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await expect(page.locator(".run-artifact-player .ap-player")).toBeVisible();
    await expectRouteScreenshot(page, "run-replay-inline-dark-desktop");
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

  test("objectives dock", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    const statusAction = page.getByRole("button", {
      name: /^Objectives\b/i,
    });
    await expect(statusAction.first()).toBeVisible();
    await statusAction.first().click();
    await expectRouteScreenshot(page, "run-status-dock-dark-mobile");
  });

  test("startup work order dock", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expect(
      page.getByRole("heading", { name: "Preparing your workspace" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Work order\b/i })
      .click();
    await expectRouteScreenshot(page, "run-startup-work-order-dark-mobile");
  });

  test("run ending timeline", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectRouteScreenshot(page, "run-ending-dark-mobile");
  });

  test("run dense multi-probe history", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      variant: "long",
      runState: "ending",
    });
    await expect(
      page.getByRole("heading", { name: "Needs repair" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Verified" }),
    ).toHaveCount(1);
    await expect(
      page.locator('ol[aria-label="Run timeline"] ul > li'),
    ).toHaveCount(6);
    await expectRouteScreenshot(page, "run-probes-dense-dark-mobile");
  });

  test("run inline replay", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await expect(page.locator(".run-artifact-player .ap-player")).toBeVisible();
    await expectRouteScreenshot(page, "run-replay-inline-dark-mobile");
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
