import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import {
  coarsePointerTargetViolations,
  expectNoHorizontalOverflow,
} from "./support/layout";

test.describe("focused state accessibility", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const variant of ["empty", "error", "long"] as const) {
    test(`catalog · ${variant}`, async ({ page, ui }, testInfo) => {
      await ui.open({
        ...routeCase("scenario-catalog"),
        theme: "light",
        variant,
      });

      await expectNoAxeViolations(page, testInfo);
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`organization course catalog · ${theme}`, async ({
      page,
      ui,
    }, testInfo) => {
      await ui.open({ ...routeCase("organization-detail"), theme });
      await page.getByRole("tab", { name: "Scenarios" }).click();

      await expect(
        page.getByRole("heading", { name: "Platform repair sequence" }),
      ).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
    });
  }

  test("request access success announcement", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("request-access"), theme: "light" });
    await page.getByLabel("GitHub username").fill("newoperator");
    await page.getByRole("button", { name: "Request access" }).click();

    const status = page.getByRole("status");
    await expect(
      page.getByRole("heading", { name: "Request received" }),
    ).toBeVisible();
    await expect(status).toContainText(/Review can begin/i);
    await expect(status.locator("..")).toBeFocused();
    await expectNoAxeViolations(page, testInfo);
  });

  test("organization delete confirmation", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("organization-detail"), theme: "dark" });
    await page.getByRole("tab", { name: "Settings" }).click();
    await page
      .getByRole("button", { name: "Delete organization" })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: /Delete Platform Repair Crew/ }),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("organization member permission fallback", async ({
    page,
    ui,
  }, testInfo) => {
    const route = routeCase("organization-detail");
    await ui.open({
      ...route,
      path: `${route.path}?tab=progress`,
      sessionRole: "organization-member",
      theme: "light",
    });

    await expect(page).not.toHaveURL(/tab=progress/);
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectNoAxeViolations(page, testInfo);
  });

  test("host onboarding panel", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("admin-hosts"), theme: "light" });
    await page.getByRole("button", { name: "Add host" }).first().click();

    await expect(
      page.getByRole("heading", { name: "Bridge config" }),
    ).toBeVisible();
    await expect(page.getByRole("group", { name: "Host role" })).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("build details", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("admin-builds"), theme: "dark" });
    await page.getByRole("button", { name: "Details" }).first().click();

    await expect(page.getByText("Content hash").first()).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("authoring invalid validation", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("admin-authoring"), theme: "dark" });
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await editor.fill('scenario "broken" {');
    await page.getByRole("button", { name: "Validate" }).click();

    await expect(page.getByLabel("Validation results")).toContainText(
      /validation error|validator error|failed/i,
    );
    await expectNoAxeViolations(page, testInfo);
  });

  test("native SSH credentials", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Native SSH for web" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("SSH command")).toContainText(
      "stargate.example.test",
    );
    await expectNoAxeViolations(page, testInfo);
  });

  test("startup milestones expose one current ordered step", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });

    const currentStep = page.locator('ol li[aria-current="step"]');
    await expect(currentStep).toHaveCount(1);
    await expect(currentStep).toContainText("Starting the VM");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expectNoAxeViolations(page, testInfo);
  });

  for (const runState of [
    "ending",
    "rendering",
    "replay-failed",
    "replay",
  ] as const) {
    test(`run timeline · ${runState}`, async ({ page, ui }, testInfo) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        runState,
      });

      await expect(
        page.getByRole("heading", { name: "Run timeline" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.locator('ol[aria-label="Run timeline"] li[aria-current="step"]'),
      ).toHaveCount(runState === "ending" || runState === "rendering" ? 1 : 0);
      await expectNoAxeViolations(page, testInfo);
    });
  }
});

test.describe("focused mobile state accessibility", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("run checks sheet", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    const trigger = page.getByRole("button", {
      name: /Run checks and assistance/i,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const sheet = page.getByRole("dialog");
    await expect(
      sheet.getByRole("heading", { name: "Run checks and assistance" }),
    ).toBeVisible();
    expect(
      await coarsePointerTargetViolations(page),
      "open run checks sheet coarse-pointer controls smaller than 44px",
    ).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("startup work order sheet", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    const trigger = page.getByRole("button", {
      name: /Work order and briefing/i,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    await expect(
      page.getByRole("heading", { name: "Work order and briefing" }),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("run ending timeline", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });

    await expect(
      page.getByRole("heading", { name: "Run timeline" }),
    ).toBeVisible();
    await expect(
      page.locator('ol[aria-label="Run timeline"] li[aria-current="step"]'),
    ).toHaveCount(1);
    await expectNoAxeViolations(page, testInfo);
  });
});
