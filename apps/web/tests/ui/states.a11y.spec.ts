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
      await page
        .locator("main")
        .getByRole("button", { name: "Courses", exact: true })
        .click();

      await expect(
        page.getByRole("heading", { name: "Platform repair sequence" }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: /Platform repair sequence/ })
        .click();
      await expect(
        page.getByRole("heading", { name: "Repair a broken nginx service" }),
      ).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
    });
  }

  test("expanded admin verification stays binary and hides raw failures", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("admin-overview"), theme: "light" });
    const hostRuns = ui.server.state.hostRuns as {
      liveVms: Array<Record<string, unknown>>;
    };
    const vm = hostRuns.liveVms[0];
    if (!vm) throw new Error("admin host fixture is missing its live VM");
    vm.probe_state = {
      collection_state: "error",
      collection_error: "RAW_COLLECTOR_FAILURE_MUST_NOT_RENDER",
      generated_at: "2026-08-24T12:00:00Z",
      updated_at: "2026-08-24T12:00:00Z",
      summary: { total: 2, pass: 1, fail: 0, unknown: 1 },
      probes: [
        {
          id: "raw-passing-probe-id",
          kind: "command_json_path",
          status: "pass",
          every_seconds: 5,
          last_attempt_at: null,
          last_success_at: null,
          last_duration_ms: 5,
          error: null,
          value: null,
        },
        {
          id: "raw-error-probe-id",
          kind: "command_json_path",
          status: "error",
          every_seconds: 5,
          last_attempt_at: null,
          last_success_at: null,
          last_duration_ms: 5,
          error: "RAW_PROBE_FAILURE_MUST_NOT_RENDER",
          value: null,
        },
      ],
    };
    vm.scenario_meta = {
      scenarioName: "repair-nginx",
      scenarioDescription: "Repair the service.",
      scenarioVmName: "web",
      hostname: "web",
      probePhaseMap: {
        "raw-passing-probe-id": "scenario",
        "raw-error-probe-id": "scenario",
      },
      checkLabelMap: {
        "raw-passing-probe-id": "Restore the service",
        "raw-error-probe-id": "Verify the repair",
      },
    };
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: vm.name as string }) });
    await card.getByRole("button", { name: "Details" }).click();
    await expect(card).toContainText("1 Verified");
    await expect(card).toContainText("1 Needs repair");
    await expect(card).toContainText("Verification unavailable");
    await expect(card).toContainText("Restore the service");
    await expect(card).toContainText("Verify the repair");
    await expect(card).not.toContainText(/Checking|Retrying|Recheck/);
    await expect(card).not.toContainText("RAW_COLLECTOR_FAILURE_MUST_NOT_RENDER");
    await expect(card).not.toContainText("RAW_PROBE_FAILURE_MUST_NOT_RENDER");
    await expect(card).not.toContainText("raw-passing-probe-id");
    await expect(card).not.toContainText("raw-error-probe-id");
    await expectNoAxeViolations(page, testInfo);
  });

  test("workshop learner probes use safe binary indicators", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("workshop-room"), theme: "light" });

    const verification = page
      .getByText("Live verification", { exact: true })
      .locator("xpath=parent::div/parent::div");
    await expect(verification).toContainText("1 Verified");
    await expect(verification).toContainText("1 Needs repair");
    await expect(verification).toContainText("Verification objective 1");
    await expect(verification).toContainText("Verification objective 2");
    await expect(verification).not.toContainText("talos-members");
    await expect(verification).not.toContainText("cilium-connectivity");
    await expect(verification).not.toContainText("3/3 members ready");
    await expect(verification).not.toContainText("DNS egress policy");
    await expectNoAxeViolations(page, testInfo);
  });

  test("facilitator probe rows stay binary when verification is unavailable", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("workshop-control-room"), theme: "light" });
    const session = ui.server.state.workshopSession as {
      roster: Array<{
        userId: string;
        progress: Array<Record<string, unknown>>;
      }>;
    };
    const learner = session.roster.find(
      (member) => member.userId === "user-learner",
    );
    const activeProgress = learner?.progress.find(
      (progress) => progress.moduleId === "01",
    );
    if (!activeProgress) throw new Error("workshop probe fixture is missing");
    activeProgress.verificationUnavailable = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    const probeLists = page.locator('ul[aria-label$=" probe status"]');
    const probeText = (await probeLists.allTextContents()).join(" ");
    expect(probeText).toContain("Verification objective 1");
    expect(probeText).toContain("Verified");
    expect(probeText).toContain("Needs repair");
    expect(probeText).not.toMatch(
      /workspace-ready|talos-members|cilium-connectivity|\bpass\b|\bfail\b|\bpending\b|\bunknown\b/i,
    );
    await expect(page.getByText("Verification unavailable").first()).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("beta invite ready announcement", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("join-beta"), theme: "light" });

    const status = page.getByRole("status");
    await expect(
      page.getByRole("heading", { name: "Join the intar.dev beta" }),
    ).toBeVisible();
    await expect(status).toContainText(/This single-use link is ready/i);
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeVisible();
    await expect(
      page.getByText("Recover an existing OIDC account"),
    ).toHaveCount(0);
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

  test("host removal confirmation", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("admin-hosts"), theme: "light" });
    await expect(
      page.getByRole("heading", { name: "workshop-eu-1" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Host actions" }).click();
    await page.getByRole("menuitem", { name: "Remove host" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove this host?" }),
    ).toBeVisible();
    await expect(dialog).toContainText("Its run history remains available.");
    await expectNoAxeViolations(page, testInfo);

    await dialog
      .getByLabel("Type workshop-eu-1 to confirm")
      .fill("workshop-eu-1");
    await dialog.getByRole("button", { name: "Remove host" }).click();

    await expect(
      page.getByRole("heading", { name: "workshop-eu-1" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "No hosts yet" }),
    ).toBeVisible();
  });

  test("user deletion confirmation", async ({ page, ui }, testInfo) => {
    await ui.open({ ...routeCase("admin-people"), theme: "light" });
    await page.getByRole("tab", { name: "Users" }).click();
    await page.getByRole("button", { name: "Delete" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Delete this user?" });
    await expect(dialog).toContainText("anonymous user record");
    await expect(
      dialog.getByRole("button", { name: "Delete user" }),
    ).toBeVisible();
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

  test("disconnected terminal recovers after reconnecting", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "disconnected",
    });

    const recoveryNotice = page.getByText(
      "The terminal session ended. Reconnect to continue.",
      { exact: true },
    );
    const reconnect = page.getByRole("button", {
      name: "Reconnect terminal",
    });
    await expect(recoveryNotice).toBeVisible();
    await expect(reconnect).toBeVisible();
    const reconnectBounds = await reconnect.boundingBox();
    expect(reconnectBounds).not.toBeNull();
    expect(reconnectBounds!.height).toBeGreaterThanOrEqual(44);

    ui.server.state.terminalMode = "connected";
    const reconnectRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        /\/api\/scenarios\/runs\/run-active\/ssh$/.test(
          new URL(request.url()).pathname,
        ),
    );
    await reconnect.click();
    await reconnectRequest;

    await expect(
      page.getByRole("status").filter({ hasText: /Terminal status:/i }),
    ).toHaveText(/Terminal status:\s*connected/i);
    await expect(recoveryNotice).toHaveCount(0);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("focused mobile state accessibility", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("objectives sheet", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    const trigger = page.getByRole("button", {
      name: /^Objectives\b/i,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const sheet = page.getByRole("dialog");
    await expect(
      sheet.getByRole("heading", { name: "Objectives" }),
    ).toBeVisible();
    expect(
      await coarsePointerTargetViolations(page),
      "open objectives sheet coarse-pointer controls smaller than 44px",
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
      name: /^Work order\b/i,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();

    await expect(
      page.getByRole("dialog").locator('[data-slot="sheet-title"]'),
    ).toHaveText("Work order");
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

test.describe("run console content width", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("uses the dock below the rail width and a rail above it", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const dock = page.getByRole("button", { name: /^Objectives\b/i });
    const rail = page.getByRole("complementary", { name: "Run console" });
    await expect(dock).toBeVisible();
    await expect(rail).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(rail).toBeVisible();
    await expect(dock).toHaveCount(0);

    const hintDisclosure = rail.getByRole("button", { name: /Need a hint?/i });
    await hintDisclosure.focus();
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(dock).toBeVisible();
    await expect(dock).toBeFocused();

    await dock.click();
    const detailsDisclosure = page
      .getByRole("dialog", { name: "Objectives" })
      .getByRole("button", { name: /Run details/i });
    await detailsDisclosure.focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(rail).toBeVisible();
    await expect(rail).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("short run workspace", () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true });

  test("keeps the objectives dock reachable in landscape", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const dock = page.getByRole("button", { name: /^Objectives\b/i });
    await expect(dock).toBeVisible();
    const bounds = await dock.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(600);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("small-screen access management", () => {
  test.use({ viewport: { width: 320, height: 844 }, hasTouch: true });

  test("keeps active invite actions on screen", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("admin-people"), theme: "light" });

    const copy = page.getByRole("button", {
      name: /^Copy intar_beta_AAAAAAAA invite$/,
    });
    const revoke = page.getByRole("button", {
      name: /^Revoke intar_beta_AAAAAAAA invite$/,
    });
    await expect(copy).toBeVisible();
    await expect(revoke).toBeVisible();
    for (const control of [copy, revoke]) {
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps user deletion available without a ban control", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("admin-people"), theme: "light" });
    await page.getByRole("tab", { name: "Users" }).click();

    const remove = page.getByRole("button", { name: "Delete" }).first();
    await expect(remove).toBeVisible();
    await expect(page.getByRole("button", { name: "Ban" })).toHaveCount(0);
    const bounds = await remove.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});
