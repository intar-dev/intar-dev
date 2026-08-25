import type { Locator, Page } from "@playwright/test";
import { buildTemporaryNativeSshCommand } from "@/lib/native-ssh";
import { expect, test } from "./fixtures/test";
import { makeMultiReplayRun } from "./fixtures/data";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

const TEMPORARY_RUN_SSH_COMMAND = buildTemporaryNativeSshCommand({
  username: "route-test-only",
  host: "stargate.example.test",
  port: 2222,
  knownHostsLine:
    "[stargate.example.test]:2222 ssh-ed25519 test-only-host-key",
  keyFilename: "intar-route-test-only.key",
});

const TECHNICAL_LEARNER_RUN_COPY = [
  "nginx-listening",
  "health-endpoint",
  "tcp_connect",
  "http_request",
  "connection refused on 127.0.0.1:80",
  "debian-13",
  "10.40.0.18",
  "run-active",
  "SHA-256",
  "SSH target",
  "Run timeline",
  "Transcript",
  "Command log",
] as const;

function runLearningTrigger(page: Page): Locator {
  return page.locator("[data-run-learning-panel-trigger]");
}

function runLearningPanel(page: Page): Locator {
  return page.locator("[data-run-learning-panel-content]");
}

async function expectOnlyAppBarHeading(page: Page, title: string) {
  const headings = page.locator("h1");
  await expect(headings).toHaveCount(1);
  await expect(page.locator("header").first().getByRole("heading", { level: 1 })).toHaveText(
    title,
  );
  await expect(headings).toHaveText(title);
}

async function expectMinimumTarget(control: Locator, description: string) {
  const bounds = await control.boundingBox();
  expect(bounds, `${description} must be visible`).not.toBeNull();
  expect(bounds!.width, `${description} must be at least 44px wide`).toBeGreaterThanOrEqual(
    44,
  );
  expect(bounds!.height, `${description} must be at least 44px tall`).toBeGreaterThanOrEqual(
    44,
  );
}

async function expectGuidanceRailClearOfHeader(page: Page, rail: Locator) {
  await page.waitForTimeout(250);
  const appBar = page.locator("header.sticky.top-0").first();
  const [railBox, appBarBox] = await Promise.all([
    rail.boundingBox(),
    appBar.boundingBox(),
  ]);
  const viewport = page.viewportSize();
  expect(railBox).not.toBeNull();
  expect(appBarBox).not.toBeNull();
  expect(viewport).not.toBeNull();

  const topGap = railBox!.y - (appBarBox!.y + appBarBox!.height);
  const rightGap = viewport!.width - (railBox!.x + railBox!.width);
  const bottomGap = viewport!.height - (railBox!.y + railBox!.height);
  expect(topGap).toBeGreaterThanOrEqual(8);
  expect(Math.abs(topGap - rightGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1);
}

async function expectLearnerSafeRunCopy(scope: Locator) {
  for (const technicalCopy of TECHNICAL_LEARNER_RUN_COPY) {
    await expect(scope).not.toContainText(technicalCopy);
  }
}

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
    const probeState = {
      collection_state: "ready",
      collection_error: null as string | null,
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
    vm.probe_state = probeState;
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
    await expect(card).not.toContainText("Verification unavailable");
    await expect(card).toContainText("Restore the service");
    await expect(card).toContainText("Verify the repair");
    await expect(card).not.toContainText(/Checking|Retrying|Recheck/);
    await expect(card).not.toContainText("RAW_PROBE_FAILURE_MUST_NOT_RENDER");
    await expect(card).not.toContainText("raw-passing-probe-id");
    await expect(card).not.toContainText("raw-error-probe-id");

    probeState.collection_state = "error";
    probeState.collection_error = "RAW_COLLECTOR_FAILURE_MUST_NOT_RENDER";
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    const refreshedCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: vm.name as string }) });
    await refreshedCard.getByRole("button", { name: "Details" }).click();
    await expect(refreshedCard).toContainText("Verification unavailable");
    await expect(refreshedCard).not.toContainText(
      "RAW_COLLECTOR_FAILURE_MUST_NOT_RENDER",
    );
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

  test("temporary native SSH key persists through dialog reopen and refresh", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    ui.server.state.sshKeys = [];

    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Create temporary SSH key" }),
    ).toBeVisible();
    expect(ui.server.nativeSshRequests).toHaveLength(1);
    expect(ui.server.nativeSshRequests[0]?.body).toEqual({
      vmId: "run-vm-web",
      mode: "native",
    });

    ui.server.nativeSshResponseDelayMs = 300;
    await dialog
      .getByRole("button", { name: "Create temporary SSH key" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(sessionStorage).filter((key) =>
            key.startsWith("intar.native-ssh.temporary.v1:"),
          ),
        ),
      )
      .toHaveLength(1);
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    ui.server.nativeSshResponseDelayMs = 0;
    await expect(dialog.getByLabel("SSH command")).toHaveValue(
      TEMPORARY_RUN_SSH_COMMAND,
    );
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeDisabled();
    const downloadPromise = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: "Download temporary key" })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("intar-route-test-only.key");
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeEnabled();

    expect(ui.server.nativeSshRequests).toHaveLength(2);
    const issuedRequest = ui.server.nativeSshRequests[1];
    expect(issuedRequest?.pathname).toBe("/api/scenarios/runs/run-active/ssh");
    expect(issuedRequest?.body).toMatchObject({
      vmId: "run-vm-web",
      mode: "native",
      clientPublicKeyOpenssh: expect.stringMatching(/^ssh-ed25519 /),
    });
    expect(Object.keys(issuedRequest?.body ?? {}).sort()).toEqual([
      "clientPublicKeyOpenssh",
      "mode",
      "vmId",
    ]);
    const issuedPublicKey = issuedRequest?.body.clientPublicKeyOpenssh;
    expect(typeof issuedPublicKey).toBe("string");
    expect(JSON.stringify(issuedRequest?.body)).not.toContain(
      "OPENSSH PRIVATE KEY",
    );
    await expect(page.locator("html")).not.toContainText(
      "OPENSSH PRIVATE KEY",
    );
    expect(
      await dialog.locator("textarea").evaluateAll((fields) =>
        fields.map((field) => (field as HTMLTextAreaElement).value),
      ),
    ).not.toContain(expect.stringContaining("OPENSSH PRIVATE KEY"));

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeEnabled();
    expect(ui.server.nativeSshRequests).toHaveLength(3);
    expect(
      ui.server.nativeSshRequests[2]?.body.clientPublicKeyOpenssh,
    ).toBe(issuedPublicKey);

    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeEnabled();
    expect(ui.server.nativeSshRequests).toHaveLength(4);
    expect(
      ui.server.nativeSshRequests[3]?.body.clientPublicKeyOpenssh,
    ).toBe(issuedPublicKey);

    await page.clock.setFixedTime(Date.parse("2026-07-10T09:15:00.000Z"));
    await page.clock.fastForward(15 * 60_000);
    await expect(
      dialog.getByRole("button", { name: "Create temporary SSH key" }),
    ).toBeVisible();
    expect(ui.server.nativeSshRequests).toHaveLength(5);
    expect(ui.server.nativeSshRequests[4]?.body).toEqual({
      vmId: "run-vm-web",
      mode: "native",
    });
    expect(
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("intar.native-ssh.temporary.v1:"),
        ),
      ),
    ).toEqual([]);
    await expectNoAxeViolations(page, testInfo);
  });

  test("temporary native SSH warns when the browser blocks persistence", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    ui.server.state.sshKeys = [];
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Create temporary SSH key" }),
    ).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(Storage.prototype, "setItem", {
        configurable: true,
        value() {
          throw new DOMException("Storage blocked", "SecurityError");
        },
      });
    });

    await dialog
      .getByRole("button", { name: "Create temporary SSH key" })
      .click();

    await expect(
      dialog.getByText(
        "This browser cannot keep the temporary key after a refresh. Download it now.",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
  });

  test("sign out clears browser-held temporary SSH keys", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    ui.server.state.sshKeys = [];
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Create temporary SSH key" })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith("intar.native-ssh.temporary.v1:"),
        ),
      ),
    ).toHaveLength(1);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /minalearns/i }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect.poll(() => ui.server.requests).toContain(
      "POST /api/auth/sign-out",
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(sessionStorage).filter((key) =>
            key.startsWith("intar.native-ssh.temporary.v1:"),
          ),
        ),
      )
      .toEqual([]);
  });

  test("desktop checks expose safe hover text and guidance slides in from the right", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toContainText("Hints 0/2");
    await expect(trigger).toHaveAccessibleName(
      "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expectMinimumTarget(trigger, "header lab guidance trigger");
    const indicators = page.locator("[data-run-check-indicator]");
    await expect(indicators).toHaveCount(2);
    await expect(page.locator("[data-run-check-count]")).toHaveText("0/2");
    await expect(indicators.first()).toHaveAccessibleName(
      "Open lab guidance. Start the web server. Needs repair.",
    );
    await expect(indicators.nth(1)).toHaveAccessibleName(
      "Open lab guidance. Make the site reachable. Checking.",
    );
    await expectMinimumTarget(indicators.first(), "first check circle");
    await expectMinimumTarget(indicators.nth(1), "second check circle");
    expect(
      await indicators.evaluateAll((controls) =>
        controls.map((control) => getComputedStyle(control).backgroundColor),
      ),
      "idle check targets should leave only the small circle icons visible",
    ).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await indicators.first().hover();
    const checkTooltip = page.locator("[data-run-check-tooltip][data-open]");
    await expect(checkTooltip).toBeVisible();
    await expect(checkTooltip).toContainText("Start the web server");
    await expect(checkTooltip).toContainText("Needs repair");
    await indicators.nth(1).focus();
    await expect(checkTooltip).toContainText("Make the site reachable");
    await page.keyboard.press("Escape");
    await expect(checkTooltip).toBeHidden();
    await expect(indicators.nth(1)).toBeFocused();
    await page.locator("main").hover({ position: { x: 8, y: 8 } });
    await expect(page.getByRole("complementary", { name: "Run console" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: /^Objectives\b/i }),
    ).toHaveCount(0);
    await expect(page.locator('ol[aria-label="Run timeline"]')).toHaveCount(0);

    await indicators.nth(1).focus();
    await page.keyboard.press("Enter");

    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    const panel = runLearningPanel(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "right");
    await expect(panel).toBeVisible();
    expect(
      await indicators.evaluateAll((controls) =>
        controls.map((control) => getComputedStyle(control).backgroundColor),
      ),
      "an open rail should not turn the small check icons into large circles",
    ).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
    await expect(
      panel.getByRole("heading", { name: "Hints and guidance" }),
    ).toBeVisible();
    await expect(panel.locator("#run-learning-checks-heading")).toHaveCount(0);
    await expect(panel.getByText("Hints", { exact: true })).toBeVisible();
    await expect(panel.getByText("Full solution", { exact: true })).toBeVisible();
    await expect(panel).not.toContainText("systemctl status nginx");
    await expectLearnerSafeRunCopy(panel);
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);

    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.width).toBeLessThanOrEqual(322);
    await expectGuidanceRailClearOfHeader(page, sheet);
    const guidanceLabelBox = await panel
      .getByText("Lab guidance", { exact: true })
      .boundingBox();
    expect(guidanceLabelBox).not.toBeNull();
    expect(guidanceLabelBox!.y - sheetBox!.y).toBeGreaterThanOrEqual(16);

    await page.getByRole("textbox", { name: "Terminal input" }).click();
    await expect(sheet).toBeVisible();

    await panel.getByRole("button", { name: "Reveal" }).first().click();
    await expect(panel.getByText("Inspect the service boundary")).toBeVisible();
    await expect(panel).toContainText("systemctl status nginx");
    await expect(trigger).toHaveAccessibleName(
      "Open lab guidance. 1 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);

    await panel
      .getByRole("button", { name: "Reveal the full solution" })
      .click();
    const solutionDialog = page.getByRole("dialog", {
      name: "Reveal the full solution?",
    });
    await expect(solutionDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(solutionDialog).toBeHidden();
    await expect(sheet).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(indicators.nth(1)).toBeFocused();

    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(runLearningPanel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });

  test("booting guidance exposes a work order without infrastructure detail", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toContainText("Hints 0/2");
    await expect(trigger).toHaveAccessibleName(
      "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expectMinimumTarget(trigger, "booting work order trigger");
    await trigger.click();

    const panel = runLearningPanel(page);
    await expect(
      panel.getByRole("heading", { name: "Work order" }),
    ).toBeVisible();
    await expect(panel).toContainText(
      "Checks will appear when the lab is ready.",
    );
    await expect(panel).toContainText("Start the web server");
    await expect(panel).toContainText("Make the site reachable");
    await expectLearnerSafeRunCopy(panel);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("solved workspace exposes finish and save outside guidance", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toContainText("Hints 0/2");
    await expect(trigger).toHaveAccessibleName(
      "Open lab guidance. 0 of 2 hints revealed. 2 of 2 checks verified.",
    );
    const completionBar = page.locator("[data-run-completion-bar]");
    const finish = page.getByRole("button", { name: "Finish and save" });
    await expect(completionBar).toBeVisible();
    await expect(finish).toBeVisible();
    await expectMinimumTarget(finish, "finish and save action");

    const terminal = page.getByRole("region", { name: "Terminal" });
    const [completionBox, terminalBox] = await Promise.all([
      completionBar.boundingBox(),
      terminal.boundingBox(),
    ]);
    expect(completionBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    const completionGap = terminalBox!.y - (
      completionBox!.y + completionBox!.height
    );
    expect(completionGap).toBeGreaterThanOrEqual(12);
    expect(completionGap).toBeLessThanOrEqual(20);

    await trigger.click();

    const panel = runLearningPanel(page);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Finish and save" }),
    ).toHaveCount(0);
    await expect(panel.getByText("Hints", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    await finish.click();
    await expect(
      page.getByRole("heading", { name: "Saving your run…" }),
    ).toBeVisible();
    await expect(runLearningTrigger(page)).toHaveCount(0);
    await expectLearnerSafeRunCopy(page.locator("main"));
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  for (const recap of [
    {
      runState: "ending",
      title: "Saving your run…",
      replay: null,
    },
    {
      runState: "rendering",
      title: "Saving your run…",
      replay: null,
    },
    {
      runState: "failed",
      title: "Could not finish",
      replay: null,
    },
    {
      runState: "replay-failed",
      title: "Solved",
      replay: "Replay unavailable.",
    },
    {
      runState: "replay",
      title: "Solved",
      replay: "Watch replay",
    },
  ] as const) {
    test(`saved run recap · ${recap.runState}`, async ({ page, ui }, testInfo) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        runState: recap.runState,
      });

      await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
      await expect(
        page.getByRole("heading", { name: recap.title, exact: true }),
      ).toBeVisible();
      await expect(runLearningTrigger(page)).toHaveCount(0);
      await expect(page.locator('ol[aria-label="Run timeline"]')).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("Run timeline");
      await expect(page.locator("main")).not.toContainText("Command log");
      await expect(page.locator("main")).not.toContainText("Transcript");
      await expectLearnerSafeRunCopy(page.locator("main"));

      if (recap.replay) {
        await expect(page.getByText(recap.replay, { exact: true })).toBeVisible();
      } else {
        await expect(page.getByText("Watch replay", { exact: true })).toHaveCount(
          0,
        );
      }
      if (recap.title === "Saving your run…") {
        await expect(page.getByText("Your recap will be ready in a moment.")).toBeVisible();
        await expect(page.locator("header")).toContainText("Saving");
        await expect(page.locator("header")).not.toContainText("Ending");
        const savingProgress = page.getByRole("progressbar", {
          name: "Saving your run",
        });
        await expect(savingProgress).toBeVisible();
        await expect(savingProgress).not.toHaveAttribute("aria-valuenow");
        await expect(savingProgress).toHaveAttribute(
          "aria-valuetext",
          "Saving your run. Your recap will be ready in a moment.",
        );
        await expect(page.getByRole("heading", { name: "Final checks" })).toHaveCount(
          0,
        );
        await expect(
          page.getByRole("progressbar", { name: "Final checks progress" }),
        ).toHaveCount(0);
      } else {
        await expect(page.getByRole("heading", { name: "Final checks" })).toBeVisible();
        const progress = page.getByRole("progressbar", {
          name: "Final checks progress",
        });
        await expect(progress).toBeVisible();
        await expect(progress).toHaveAttribute("aria-valuemax", "2");
        await expect(progress).toHaveAttribute(
          "aria-valuetext",
          /\d of 2 final checks verified/,
        );
        await expect(page.getByText("What next?", { exact: true })).toBeVisible();
      }

      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, testInfo);
    });
  }

  test("multi-part replay uses an ordered accessible carousel", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    ui.server.state.run = makeMultiReplayRun();
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await page.getByRole("button", { name: "Watch replay" }).click();
    const carousel = page.locator("[data-run-replay-carousel]");
    const previous = carousel.getByRole("button", {
      name: "Previous replay part",
    });
    const next = carousel.getByRole("button", { name: "Next replay part" });
    await expect(carousel).toBeVisible();
    await expect(carousel).toHaveAttribute("role", "region");
    await expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
    await expect(carousel).toHaveAccessibleName("Replay parts");
    await expect(carousel.locator('[aria-roledescription="slide"]')).toHaveAccessibleName(
      "Part 1 of 3, web",
    );
    await expectMinimumTarget(previous, "previous replay part");
    await expectMinimumTarget(next, "next replay part");
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await expect(
      carousel.locator('ol[aria-label="Replay order"] button'),
    ).toHaveCount(3);
    await expectLearnerSafeRunCopy(page.locator("main"));
    for (const rawReplayValue of [
      "hidden-worker-vm-id",
      "hidden-worker-runtime",
      "hidden-worker-host",
      "hidden-web-01.cast",
      "cast-web-1",
    ]) {
      await expect(page.locator("main")).not.toContainText(rawReplayValue);
    }
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("cancelled runs use the ended-early recap without teardown detail", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "archived",
    });
    ui.server.state.run.outcome = "cancelled";
    ui.server.state.run.solvedAt = null;
    ui.server.state.run.solveDurationMs = null;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    await expect(
      page.getByRole("heading", { name: "Ended early", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Try this lab again" }),
    ).toBeVisible();
    const progress = page.getByRole("progressbar", {
      name: "Final checks progress",
    });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuemax", "2");
    await expect(progress).toHaveAttribute(
      "aria-valuetext",
      /\d of 2 final checks verified/,
    );
    await expectLearnerSafeRunCopy(page.locator("main"));
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

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

  test("guidance opens as a bottom sheet and returns keyboard focus", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await expectMinimumTarget(trigger, "mobile lab guidance trigger");
    await trigger.focus();
    await page.keyboard.press("Space");

    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    const panel = runLearningPanel(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "Checks and guidance" }),
    ).toBeVisible();
    await expectMinimumTarget(
      sheet.getByRole("button", { name: "Close lab guidance" }),
      "mobile guidance close button",
    );
    await expectMinimumTarget(
      panel.getByRole("button", { name: "Reveal" }).first(),
      "mobile hint reveal button",
    );
    await expectLearnerSafeRunCopy(panel);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("native SSH dialog stays reachable on a short phone", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    ui.server.state.sshKeys = [];
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "SSH command" }).click();

    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Create temporary SSH key" })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("macOS/Linux SSH command")).toBeVisible();

    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeLessThanOrEqual(812);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("failed recap shows objective progress without horizontal overflow", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "failed",
    });

    const progress = page.getByRole("progressbar", {
      name: "Final checks progress",
    });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuemin", "0");
    await expect(progress).toHaveAttribute("aria-valuemax", "2");
    await expect(
      progress.locator('[data-run-recap-progress-segment="true"]'),
    ).toHaveCount(2);
    await expect(
      progress.locator('[data-status="needs_repair"]'),
    ).toHaveCount(2);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("saving progress stays visible on mobile", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });

    const progress = page.getByRole("progressbar", { name: "Saving your run" });
    await expect(progress).toBeVisible();
    await expect(progress).not.toHaveAttribute("aria-valuenow");
    const bounds = await progress.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("solved action stays visible outside the mobile guidance sheet", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    const finish = page.getByRole("button", { name: "Finish and save" });
    await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
    await expectMinimumTarget(finish, "mobile finish and save action");
    await expect(finish).toBeVisible();
    await runLearningTrigger(page).click();
    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(
      sheet.getByRole("button", { name: "Finish and save" }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run guidance at tablet width", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("uses the right guidance rail above the mobile breakpoint", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await expectMinimumTarget(trigger, "tablet lab guidance trigger");
    await trigger.click();

    await expect(runLearningPanel(page)).toBeVisible();
    const rail = page.getByRole("dialog", { name: "Lab guidance" });
    await expect(rail).toHaveAttribute("data-side", "right");
    await expectGuidanceRailClearOfHeader(page, rail);
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run guidance on a touch tablet", () => {
  test.use({ viewport: { width: 1100, height: 900 }, hasTouch: true });

  test("opens the full check list instead of relying on hover", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const trigger = runLearningTrigger(page);
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    const panel = runLearningPanel(page);
    await expect(sheet).toHaveAttribute("data-side", "right");
    await expectGuidanceRailClearOfHeader(page, sheet);
    await expect(
      panel.getByRole("heading", { name: "Checks and guidance" }),
    ).toBeVisible();
    const checks = panel.getByRole("region", { name: "Checks" });
    await expect(checks.getByText("Start the web server")).toBeVisible();
    await expect(checks.getByText("Make the site reachable")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe("run guidance at a narrow desktop width", () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test("keeps the title and compact check summary visible", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    await expect(page.locator("[data-run-compact-check-dots]")).toBeVisible();
    await expect(page.locator("[data-run-compact-check-count]")).toHaveText(
      "0/2",
    );
    await expect(page.locator("[data-run-check-indicators]")).toBeHidden();
    const trigger = runLearningTrigger(page);
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(
      runLearningPanel(page).getByRole("heading", {
        name: "Checks and guidance",
      }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("long check rows", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("keeps all circles reachable and leaves the total visible", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    const run = ui.server.state.run as {
      objectives: Array<Record<string, unknown>>;
      scenarioProbes: Array<Record<string, unknown>>;
      vms: Array<{ scenarioProbes: Array<Record<string, unknown>> }>;
    };
    const probes = Array.from({ length: 8 }, (_, index) => ({
      id: `check-${index + 1}`,
      label: `hidden-check-${index + 1}`,
      kind: "command",
      phase: "scenario",
      status: index === 7 ? "passed" : "fail",
      error: null,
      value: null,
    }));
    run.objectives = probes.map((probe, index) => ({
      probeName: probe.id,
      vmName: "web",
      label: probe.label,
      title: `Learner check ${index + 1}`,
      bodyMarkdown: "Hidden objective detail",
      hintCount: 0,
    }));
    run.scenarioProbes = probes;
    if (run.vms[0]) run.vms[0].scenarioProbes = probes;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    const indicators = page.locator("[data-run-check-indicator]");
    await expect(indicators).toHaveCount(8);
    await expect(page.locator("[data-run-check-count]")).toHaveText("1/8");
    await expect(page.locator("[data-run-check-overflow]")).toHaveText("+3");
    await expect(page.locator("[data-run-check-overflow]")).toBeVisible();
    const lastCheck = indicators.last();
    await lastCheck.focus();
    await expect(lastCheck).toBeFocused();
    await expect(lastCheck).toBeInViewport();
    await expect(lastCheck).toHaveAccessibleName(
      "Open lab guidance. Learner check 8. Verified.",
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run guidance at 200% text", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the header control and checks operable", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });

    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await expectMinimumTarget(trigger, "200% lab guidance trigger");
    await trigger.click();
    const panel = runLearningPanel(page);
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-run-check-indicator]")).toHaveCount(2);
    await expect(
      page.getByRole("dialog", { name: "Lab guidance" }),
    ).toHaveAttribute("data-side", "right");
    await expectGuidanceRailClearOfHeader(
      page,
      page.getByRole("dialog", { name: "Lab guidance" }),
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps the solved action outside guidance at 200% text", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });

    const finish = page.getByRole("button", { name: "Finish and save" });
    await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
    await expectMinimumTarget(finish, "200% finish and save action");
    await expect(finish).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("short run workspace", () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true });

  test("keeps check indicators reachable while the guidance sheet scrolls", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expectMinimumTarget(trigger, "landscape lab guidance trigger");
    await trigger.click();

    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    const panel = runLearningPanel(page);
    await expect(sheet).toBeVisible();
    // Sheet enters from below; assert its settled layout, not its 200ms entry transform.
    await page.waitForTimeout(250);
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(375);

    const scroll = await panel.evaluate((content) => {
      const scroller = content.parentElement;
      if (!(scroller instanceof HTMLElement)) {
        throw new Error("guidance panel needs a scrollable parent");
      }
      scroller.scrollTop = scroller.scrollHeight;
      return {
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      };
    });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const stickySummary = sheet.locator(
      "[data-run-learning-sticky-summary]",
    );
    await expect(stickySummary).toBeVisible();
    await expect(stickySummary).toHaveAccessibleName(
      "Show checks. 0 of 2 verified.",
    );
    await expectMinimumTarget(stickySummary, "sticky check summary");
    await stickySummary.focus();
    await expect(stickySummary).toBeFocused();
    await stickySummary.click();
    const scrolledBack = await panel.evaluate((content) => {
      const scroller = content.parentElement;
      return scroller instanceof HTMLElement ? scroller.scrollTop : -1;
    });
    expect(scrolledBack).toBeGreaterThanOrEqual(0);
    expect(scrolledBack).toBeLessThan(scroll.scrollTop);
    const close = sheet.getByRole("button", { name: "Close lab guidance" });
    await expectMinimumTarget(close, "landscape guidance close button");
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
    await close.click();
    await expect(sheet).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("keeps solved action and terminal inside a short viewport", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });

    const completionBar = page.locator("[data-run-completion-bar]");
    const terminal = page.getByRole("region", { name: "Terminal" });
    await expect(completionBar).toBeVisible();
    await expect(terminal).toBeVisible();
    const [completionBox, terminalBox] = await Promise.all([
      completionBar.boundingBox(),
      terminal.boundingBox(),
    ]);
    expect(completionBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    expect(completionBox!.y).toBeGreaterThanOrEqual(48);
    expect(terminalBox!.y + terminalBox!.height).toBeLessThanOrEqual(375);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps saving progress inside a short viewport", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });

    const progress = page.getByRole("progressbar", { name: "Saving your run" });
    await expect(progress).toBeVisible();
    const bounds = await progress.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(48);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(375);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("small-screen access management", () => {
  test.use({ viewport: { width: 320, height: 844 }, hasTouch: true });

  test("keeps lab guidance usable at 320px in light mode", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "running",
    });

    await expectOnlyAppBarHeading(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expect(trigger).toHaveAccessibleName(
      "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expect(page.locator("[data-run-compact-check-dots]")).toBeVisible();
    await expect(page.locator("[data-run-compact-check-count]")).toHaveText(
      "0/2",
    );
    await expectMinimumTarget(trigger, "small-screen lab guidance trigger");
    await trigger.click();

    const sheet = page.getByRole("dialog", { name: "Lab guidance" });
    await expect(sheet).toBeVisible();
    await expect(runLearningPanel(page)).toBeVisible();
    await expectLearnerSafeRunCopy(runLearningPanel(page));
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps the solved action visible at 320px", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "solved",
    });

    const completionBar = page.locator("[data-run-completion-bar]");
    const finish = page.getByRole("button", { name: "Finish and save" });
    await expect(completionBar).toBeVisible();
    await expectMinimumTarget(finish, "320px finish and save action");
    const [barBox, finishBox] = await Promise.all([
      completionBar.boundingBox(),
      finish.boundingBox(),
    ]);
    expect(barBox).not.toBeNull();
    expect(finishBox).not.toBeNull();
    expect(finishBox!.x).toBeGreaterThanOrEqual(barBox!.x);
    expect(finishBox!.x + finishBox!.width).toBeLessThanOrEqual(
      barBox!.x + barBox!.width,
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps saving progress visible at 320px", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "rendering",
    });

    const progress = page.getByRole("progressbar", { name: "Saving your run" });
    await expect(progress).toBeVisible();
    const bounds = await progress.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps ordered replay controls usable at 320px", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    ui.server.state.run = makeMultiReplayRun();
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await page.getByRole("button", { name: "Watch replay" }).click();
    const carousel = page.locator("[data-run-replay-carousel]");
    await carousel.scrollIntoViewIfNeeded();
    await expect(carousel).toBeVisible();
    await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
      "Part 1 of 3 · web",
    );
    await expect(
      carousel.locator('ol[aria-label="Replay order"] button'),
    ).toHaveCount(3);
    await expectMinimumTarget(
      carousel.getByRole("button", { name: "Previous replay part" }),
      "320px previous replay part",
    );
    await expectMinimumTarget(
      carousel.getByRole("button", { name: "Next replay part" }),
      "320px next replay part",
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

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
