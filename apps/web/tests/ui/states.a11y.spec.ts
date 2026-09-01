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
  knownHostsLine: "[stargate.example.test]:2222 ssh-ed25519 test-only-host-key",
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

const FINE_POINTER_DEFAULT_CONTROL_HEIGHT = 40;
const FINE_POINTER_COMPACT_CONTROL_HEIGHT = 36;
const COARSE_POINTER_TARGET_SIZE = 44;

async function expectNoVisibleBoxShadow(locator: Locator) {
  const result = await locator.evaluate((element) => {
    const value = getComputedStyle(element).boxShadow;
    const alphas = [...value.matchAll(/rgba\([^)]*,\s*([0-9.]+)\)/g)].map(
      (match) => Number.parseFloat(match[1] ?? "1"),
    );
    return {
      value,
      visible:
        value !== "none" && (alphas.length === 0 || alphas.some((a) => a > 0)),
    };
  });
  expect(result.visible, `unexpected visible box shadow: ${result.value}`).toBe(
    false,
  );
}

function runLearningTrigger(page: Page): Locator {
  return page.locator("[data-run-learning-panel-trigger]");
}

function runLearningPanel(page: Page): Locator {
  return page.locator("[data-run-learning-panel]");
}

function runLearningContent(scope: Locator): Locator {
  return scope.locator("[data-run-learning-panel-content]");
}

function runSshButton(page: Page): Locator {
  return page.getByRole("button", { name: "SSH command", exact: true });
}

function runLearningSheet(page: Page): Locator {
  return page.getByRole("dialog", { name: "Lecture theory and hints" });
}

async function openRunSshDialog(page: Page) {
  await runSshButton(page).click();
}

async function expectRunWorkspaceHeader(page: Page, title: string) {
  const header = page.locator("[data-run-workspace-header]");
  await expect(header).toHaveCount(1);
  await expect(header.locator("h1")).toHaveCount(1);
  await expect(
    header.getByRole("heading", { level: 1, name: title, exact: true }),
  ).toHaveCount(1);

  const back = page
    .locator("[data-run-navigation]")
    .getByRole("link", { name: "Back to My runs" });
  await expect(back).toBeVisible();
  await expect(back).toHaveText("Back");
  await expect(back).toHaveAttribute("href", "/runs");
}

async function expectRunWorkspaceChrome(page: Page) {
  await expect(page.locator("[data-slot='sidebar']")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Page actions" })).toHaveCount(
    0,
  );
}

async function expectStandardRunChrome(
  page: Page,
  title: string,
  options: {
    status?: string;
    hasDeleteAction?: boolean;
  } = {},
) {
  const appBar = page.locator("header").filter({
    has: page.getByRole("heading", { level: 1, name: title, exact: true }),
  });
  const viewport = page.viewportSize();

  await expect(page.locator("[data-slot='sidebar-wrapper']")).toHaveCount(1);
  await expect(page.locator("[data-slot='sidebar-inset']")).toHaveCount(1);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(1);
  if (viewport && viewport.width >= 1024) {
    await expect(page.locator("[data-slot='sidebar']")).toHaveCount(1);
  }
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveCount(1);
  await expect(appBar).toHaveCount(1);
  await expect(
    appBar.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
  await expect(page.locator("[data-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-run-navigation]")).toHaveCount(0);
  await expect(page.locator("[data-run-back]")).toHaveCount(0);
  await expect(page.locator("[data-run-workspace-header]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Page actions" })).toHaveCount(
    0,
  );

  if (options.status) {
    await expect(appBar).toContainText(options.status);
  }
  const deleteRun = appBar.getByRole("button", {
    name: "Delete run…",
    exact: true,
  });
  const allDeleteRunActions = page.getByRole("button", {
    name: "Delete run…",
    exact: true,
  });
  if (options.hasDeleteAction) {
    await expect(allDeleteRunActions).toHaveCount(1);
    await expect(deleteRun).toBeVisible();
  } else {
    await expect(allDeleteRunActions).toHaveCount(0);
  }
}

async function expectFinePointerControlHeight(
  control: Locator,
  expectedHeight: number,
  description: string,
) {
  const bounds = await control.boundingBox();
  expect(bounds, `${description} must be visible`).not.toBeNull();
  expect(
    bounds!.height,
    `${description} must be ${expectedHeight}px tall for a fine pointer`,
  ).toBeCloseTo(expectedHeight, 0);
}

async function expectFinePointerControlMinimumHeight(
  control: Locator,
  minimumHeight: number,
  description: string,
) {
  const bounds = await control.boundingBox();
  expect(bounds, `${description} must be visible`).not.toBeNull();
  expect(
    bounds!.height,
    `${description} must be at least ${minimumHeight}px tall for a fine pointer`,
  ).toBeGreaterThanOrEqual(minimumHeight);
}

async function expectFinePointerIconControlSize(
  control: Locator,
  expectedSize: number,
  description: string,
) {
  const bounds = await control.boundingBox();
  expect(bounds, `${description} must be visible`).not.toBeNull();
  expect(
    bounds!.width,
    `${description} must be ${expectedSize}px wide for a fine pointer`,
  ).toBeCloseTo(expectedSize, 0);
  expect(
    bounds!.height,
    `${description} must be ${expectedSize}px tall for a fine pointer`,
  ).toBeCloseTo(expectedSize, 0);
}

async function expectCoarsePointerTarget(
  control: Locator,
  description: string,
) {
  const bounds = await control.boundingBox();
  expect(bounds, `${description} must be visible`).not.toBeNull();
  expect(
    bounds!.width,
    `${description} must be at least ${COARSE_POINTER_TARGET_SIZE}px wide`,
  ).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_SIZE);
  expect(
    bounds!.height,
    `${description} must be at least ${COARSE_POINTER_TARGET_SIZE}px tall`,
  ).toBeGreaterThanOrEqual(COARSE_POINTER_TARGET_SIZE);
}

async function expectDesktopCompactRunControls(page: Page) {
  const back = page
    .locator("[data-run-navigation]")
    .getByRole("link", { name: "Back to My runs" });
  await expectFinePointerControlHeight(
    back,
    FINE_POINTER_DEFAULT_CONTROL_HEIGHT,
    "Back to My runs link",
  );
  await expectFinePointerControlHeight(
    runSshButton(page),
    FINE_POINTER_COMPACT_CONTROL_HEIGHT,
    "SSH command action",
  );
  await expectFinePointerControlHeight(
    page.getByRole("button", { name: /^End run/ }),
    FINE_POINTER_COMPACT_CONTROL_HEIGHT,
    "End run action",
  );
}

async function expectPersistentDesktopLearningPanel(page: Page) {
  const panel = runLearningPanel(page);
  const workArea = page.locator("[data-run-work-area]");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-run-learning-panel-scroll]")).toBeVisible();
  await expect(runLearningTrigger(page)).toBeHidden();
  await expect(runLearningSheet(page)).toHaveCount(0);

  const [panelBox, workAreaBox, viewport, rootFontSize] = await Promise.all([
    panel.boundingBox(),
    workArea.boundingBox(),
    page.viewportSize(),
    page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ]);
  expect(panelBox).not.toBeNull();
  expect(workAreaBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  const maxWidth = Math.min(24 * rootFontSize, viewport!.width * 0.4);
  expect(panelBox!.width).toBeLessThanOrEqual(maxWidth + 1);
  expect(panelBox!.width).toBeCloseTo(maxWidth, 0);
  expect(panelBox!.x).toBeGreaterThanOrEqual(
    workAreaBox!.x + workAreaBox!.width - 1,
  );
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(
    viewport!.width + 1,
  );
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
        ...routeCase("course-catalog"),
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
        page.getByRole("link", { name: /Platform repair sequence/ }),
      ).toBeVisible();
      await page.getByRole("link", { name: /Platform repair sequence/ }).click();
      await expect(
        page.getByRole("heading", { name: "Platform repair sequence" }),
      ).toBeVisible();
      await expect(
        page.getByText("Private service context", { exact: true }),
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
    const roster = page.getByRole("region", {
      name: "Participant roster details",
    });
    await expect(roster).toHaveAttribute("tabindex", "0");
    await roster.focus();
    await expect(roster).toBeFocused();
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
    await expect(
      page.getByText("Verification unavailable").first(),
    ).toBeVisible();
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

  test("admin archive filters and delete action", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({ ...routeCase("admin-overview"), theme: "light" });
    const archive = page
      .getByRole("heading", { name: "Run archive" })
      .locator("xpath=ancestor::section");
    await archive.scrollIntoViewIfNeeded();

    await archive.getByLabel("Search archived runs").fill("missing owner");
    await expect(
      archive.getByRole("heading", { name: "No runs match these filters" }),
    ).toBeVisible();
    await archive.getByRole("button", { name: "Clear filters" }).click();

    const card = archive.locator('[data-archive-run="run-archived"]');
    await expect(card.getByText("@minalearns", { exact: true })).toBeVisible();
    await card
      .getByRole("button", { name: "Actions for repair-nginx" })
      .click();
    await page.getByRole("menuitem", { name: "Delete run…" }).click();

    const dialog = page.getByRole("dialog", { name: "Delete this run?" });
    await expect(dialog).toContainText("run-archived");
    await expectNoAxeViolations(page, testInfo);

    await dialog.locator("#delete-run-confirm").fill("run-archived");
    await dialog.getByRole("button", { name: "Delete run" }).click();
    await expect(card).toHaveCount(0);
    expect(ui.server.requests).toContain("DELETE /api/admin/runs/run-archived");
  });

  test("admin archive can switch between replay artifacts", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("admin-overview"), theme: "light" });
    const hostRuns = ui.server.state.hostRuns as {
      archivedRuns: Array<Record<string, unknown>>;
    };
    const archivedRun = hostRuns.archivedRuns[0];
    if (!archivedRun)
      throw new Error("admin archive fixture is missing its run");
    archivedRun.artifacts = [
      {
        id: "artifact-cast-1",
        ordinal: 1,
        kind: "ssh_recording_segment",
        filename: "session-01.cast",
        contentType: "application/x-asciicast",
        sizeBytes: 512,
        sha256: "a".repeat(64),
        uploadStatus: "uploaded",
        uploadedAt: Date.now(),
      },
      {
        id: "artifact-cast-2",
        ordinal: 2,
        kind: "ssh_recording_segment",
        filename: "session-02.cast",
        contentType: "application/x-asciicast",
        sizeBytes: 1024,
        sha256: "b".repeat(64),
        uploadStatus: "uploaded",
        uploadedAt: Date.now(),
      },
    ];

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    const card = page.locator('[data-archive-run="run-archived"]');
    await card.getByRole("button", { name: "Details" }).click();

    await card.getByRole("button", { name: /session-01\.cast/ }).click();
    await expect(
      card.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();

    await card.getByRole("button", { name: /session-02\.cast/ }).click();
    await expect
      .poll(
        () =>
          ui.server.requests.filter(
            (request) =>
              request ===
              "GET /api/admin/runs/run-archived/artifacts/artifact-cast-2/content",
          ).length,
      )
      .toBe(1);
    await expect(card.locator('[data-slot="card-title"]')).toHaveText(
      "session-02.cast",
    );
    await expect(
      card.getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "This workspace did not load" }),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
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
    const supersededBuild = page.locator('[data-build-id="build-4"]');

    await expect(
      supersededBuild.getByText("Superseded", { exact: true }),
    ).toBeVisible();
    await expect(
      supersededBuild.getByRole("button", { name: "Retry" }),
    ).toBeDisabled();
    const queuePosture = page
      .getByRole("heading", { name: "Queue posture" })
      .locator("../../..");
    await expect(queuePosture).toContainText(/Active\s*1/);
    await expect(queuePosture).toContainText(/Needs attention\s*1/);
    await page.getByRole("button", { name: "Details" }).first().click();

    await expect(page.getByText("Content hash").first()).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test("native SSH credentials", async ({ page, ui }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await openRunSshDialog(page);

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

    await openRunSshDialog(page);

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
    await expect(page.locator("html")).not.toContainText("OPENSSH PRIVATE KEY");
    expect(
      await dialog
        .locator("textarea")
        .evaluateAll((fields) =>
          fields.map((field) => (field as HTMLTextAreaElement).value),
        ),
    ).not.toContain(expect.stringContaining("OPENSSH PRIVATE KEY"));

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await openRunSshDialog(page);
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeEnabled();
    expect(ui.server.nativeSshRequests).toHaveLength(3);
    expect(ui.server.nativeSshRequests[2]?.body.clientPublicKeyOpenssh).toBe(
      issuedPublicKey,
    );

    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await openRunSshDialog(page);
    await expect(
      dialog.getByRole("button", { name: "Download temporary key" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Copy" }).first(),
    ).toBeEnabled();
    expect(ui.server.nativeSshRequests).toHaveLength(4);
    expect(ui.server.nativeSshRequests[3]?.body.clientPublicKeyOpenssh).toBe(
      issuedPublicKey,
    );

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
    await openRunSshDialog(page);
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
    await openRunSshDialog(page);
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
    await page.goto("/runs", { waitUntil: "domcontentloaded" });
    await ui.settle();
    await page.getByRole("button", { name: /minalearns/i }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect
      .poll(() => ui.server.requests)
      .toContain("POST /api/auth/sign-out");
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

  test("loading a run keeps standard app chrome", async ({
    page,
    ui,
  }, testInfo) => {
    const route = routeCase("run-workspace");
    ui.configure({ ...route, runState: "running" });
    let releaseRunResponse: (() => void) | undefined;
    const runResponseGate = new Promise<void>((resolve) => {
      releaseRunResponse = resolve;
    });

    await page.route("**/api/scenarios/runs/run-active", async (request) => {
      await runResponseGate;
      await request.fulfill({ json: { run: ui.server.state.run } });
    });
    await page.goto(route.path, { waitUntil: "domcontentloaded" });

    try {
      await expect(
        page.getByText("Loading your run…", { exact: true }),
      ).toBeVisible();
      await expectStandardRunChrome(page, "Scenario run");
      await expectNoAxeViolations(page, testInfo);
    } finally {
      releaseRunResponse?.();
    }
    await ui.settle();
  });

  test("desktop run controls use the compact fine-pointer scale", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectDesktopCompactRunControls(page);
  });

  test("desktop workspace keeps mission visible beside terminal and actions direct", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    await expectPersistentDesktopLearningPanel(page);
    expect(
      await page.evaluate(() => {
        const shortcut = new KeyboardEvent("keydown", {
          key: "b",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(shortcut);
        return shortcut.defaultPrevented;
      }),
      "the hidden sidebar must not capture the terminal's Ctrl+B input",
    ).toBe(false);

    const panel = runLearningPanel(page);
    const content = runLearningContent(panel);
    const checks = content.getByRole("region", { name: "Checks" });
    await expect(
      content.getByRole("heading", { name: /^Lecture theory/ }),
    ).toBeVisible();
    await expect(checks).toBeVisible();
    await expect(checks).toContainText("Start the web server");
    await expect(checks).toContainText("Needs repair");
    await expect(checks).toContainText("Make the site reachable");
    await expect(checks).toContainText("Checking");
    await expect(content.getByText("Hints", { exact: true })).toBeVisible();
    await expect(
      content.getByText("Full solution", { exact: true }),
    ).toBeVisible();
    await expect(panel).not.toContainText("systemctl status nginx");
    await expectLearnerSafeRunCopy(panel);
    await expect(page.locator("[data-run-check-indicator]")).toHaveCount(0);

    const actions = page.getByRole("group", { name: "Run actions" });
    await expect(actions).toBeVisible();
    const ssh = runSshButton(page);
    await expect(ssh).toBeEnabled();
    const endRun = page.getByRole("button", { name: /^End run/ });
    await expect(endRun).toBeVisible();
    await expect(page.getByRole("button", { name: /^Delete run/ })).toHaveCount(
      0,
    );

    await endRun.click();
    const endRunDialog = page.getByRole("dialog", { name: "End this run?" });
    await expect(endRunDialog).toBeVisible();
    await endRunDialog.getByRole("button", { name: "Keep going" }).click();
    await expect(endRunDialog).toBeHidden();

    await page.getByRole("textbox", { name: "Terminal input" }).click();
    await expect(panel).toBeVisible();

    await content.getByRole("button", { name: "Reveal" }).first().click();
    await expect(panel.getByText("Inspect the service boundary")).toBeVisible();
    await expect(panel).toContainText("systemctl status nginx");
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);

    await content
      .getByRole("button", { name: "Reveal the full solution" })
      .click();
    const solutionDialog = page.getByRole("dialog", {
      name: "Reveal the full solution?",
    });
    await expect(solutionDialog).toBeVisible();
    await expectNoVisibleBoxShadow(solutionDialog);
    await page.keyboard.press("Escape");
    await expect(solutionDialog).toBeHidden();
    await expect(panel).toBeVisible();
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

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    await expectPersistentDesktopLearningPanel(page);
    const panel = runLearningPanel(page);
    const content = runLearningContent(panel);
    await expect(
      content.getByRole("region", { name: "Work order" }),
    ).toBeVisible();
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

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    await expectPersistentDesktopLearningPanel(page);
    const completionBar = page.locator("[data-run-completion-bar]");
    const finish = page.getByRole("button", { name: "Finish and save" });
    await expect(completionBar).toBeVisible();
    await expect(finish).toBeVisible();
    await expectFinePointerControlHeight(
      finish,
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "finish and save action",
    );

    const terminal = page.getByRole("region", { name: "Terminal" });
    const [completionBox, terminalBox] = await Promise.all([
      completionBar.boundingBox(),
      terminal.boundingBox(),
    ]);
    expect(completionBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    const completionGap =
      terminalBox!.y - (completionBox!.y + completionBox!.height);
    expect(completionGap).toBeCloseTo(8, 0);

    const panel = runLearningPanel(page);
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Finish and save" }),
    ).toHaveCount(0);
    await expect(panel.getByText("Hints", { exact: true })).toBeVisible();

    await finish.click();
    await expect(
      page.getByRole("heading", { name: "Saving your run…" }),
    ).toBeVisible();
    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Saving",
    });
    await expect(runLearningPanel(page)).toHaveCount(0);
    await expectLearnerSafeRunCopy(page.locator("main"));
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  for (const recap of [
    {
      runState: "ending",
      title: "Saving your run…",
      replay: null,
      status: "Saving",
      hasDeleteAction: false,
    },
    {
      runState: "rendering",
      title: "Saving your run…",
      replay: null,
      status: "Saving",
      hasDeleteAction: false,
    },
    {
      runState: "failed",
      title: "Could not finish",
      replay: null,
      status: "Failed",
      // A failed VM still needs infrastructure cleanup, so deletion stays
      // unavailable under the existing safety rule.
      hasDeleteAction: false,
    },
    {
      runState: "replay-failed",
      title: "Solved",
      replay: "Replay unavailable.",
      status: "Solved",
      hasDeleteAction: true,
    },
    {
      runState: "replay",
      title: "Solved",
      replay: "Watch replay",
      status: "Solved",
      hasDeleteAction: true,
    },
  ] as const) {
    test(`saved run recap · ${recap.runState}`, async ({
      page,
      ui,
    }, testInfo) => {
      await ui.open({
        ...routeCase("run-workspace"),
        theme: "dark",
        runState: recap.runState,
      });

      await expectStandardRunChrome(page, "Repair a broken nginx service", {
        status: recap.status,
        hasDeleteAction: recap.hasDeleteAction,
      });
      await expect(
        page.getByRole("heading", { name: recap.title, exact: true }),
      ).toBeVisible();
      await expect(runLearningPanel(page)).toHaveCount(0);
      await expect(page.locator('ol[aria-label="Run timeline"]')).toHaveCount(
        0,
      );
      await expect(page.locator("main")).not.toContainText("Run timeline");
      await expect(page.locator("main")).not.toContainText("Command log");
      await expect(page.locator("main")).not.toContainText("Transcript");
      await expectLearnerSafeRunCopy(page.locator("main"));

      if (recap.replay) {
        await expect(
          page.getByText(recap.replay, { exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByText("Watch replay", { exact: true }),
        ).toHaveCount(0);
      }
      if (recap.title === "Saving your run…") {
        await expect(
          page.getByText("Your recap will be ready in a moment."),
        ).toBeVisible();
        const savingSteps = page.getByRole("list", { name: "Saving steps" });
        await expect(savingSteps).toBeVisible();
        await expect(
          savingSteps.locator("[data-run-sequence-step]"),
        ).toHaveCount(5);
        await expect(savingSteps.locator('[aria-current="step"]')).toHaveCount(
          1,
        );
        await expect(
          page.getByRole("heading", { name: "Final checks" }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("progressbar", { name: "Final checks progress" }),
        ).toHaveCount(0);
      } else {
        await expect(
          page.getByRole("heading", { name: "Final checks" }),
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
        await expect(
          page.getByRole("heading", {
            name: /Keep learning|Give it another try/,
          }),
        ).toBeVisible();
      }

      if (recap.runState === "replay") {
        const deleteRun = page.getByRole("button", { name: /^Delete run/ });
        await expect(deleteRun).toBeVisible();
        await expectFinePointerControlHeight(
          deleteRun,
          FINE_POINTER_COMPACT_CONTROL_HEIGHT,
          "Delete run app bar action",
        );
        await deleteRun.click();
        const deleteRunDialog = page.getByRole("dialog", {
          name: "Delete this run?",
        });
        await expect(deleteRunDialog).toBeVisible();
        await deleteRunDialog.getByRole("button", { name: "Keep run" }).click();
        await expect(deleteRunDialog).toBeHidden();
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

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Solved",
      hasDeleteAction: true,
    });
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
    await expect(
      carousel.locator('[aria-roledescription="slide"]'),
    ).toHaveAccessibleName("Part 1 of 3, web");
    await expectFinePointerIconControlSize(
      previous,
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "previous replay part",
    );
    await expectFinePointerIconControlSize(
      next,
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "next replay part",
    );
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

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Ended early",
      hasDeleteAction: true,
    });
    await expect(
      page.getByRole("heading", { name: "Ended early", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Read lecture and try again" }),
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
    await expectFinePointerControlHeight(
      reconnect,
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "Reconnect terminal action",
    );

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
    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    await expectCoarsePointerTarget(
      page
        .locator("[data-run-navigation]")
        .getByRole("link", { name: "Back to My runs" }),
      "mobile Back to My runs link",
    );
    const actions = page.getByRole("group", { name: "Run actions" });
    const ssh = actions.getByRole("button", { name: "SSH command" });
    const endRun = actions.getByRole("button", { name: "End run…" });
    await expect(actions).toBeVisible();
    await expect(ssh).toBeEnabled();
    await expect(endRun).toBeVisible();
    await expectCoarsePointerTarget(ssh, "mobile SSH command action");
    await expectCoarsePointerTarget(endRun, "mobile End run action");
    await endRun.click();
    const endRunDialog = page.getByRole("dialog", { name: "End this run?" });
    await expect(endRunDialog).toBeVisible();
    await endRunDialog.getByRole("button", { name: "Keep going" }).click();
    await expect(endRunDialog).toBeHidden();
    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName(
      "Open lecture theory and hints. 0 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expectCoarsePointerTarget(
      trigger,
      "mobile mission and hints trigger",
    );
    await trigger.focus();
    await page.keyboard.press("Space");

    const sheet = runLearningSheet(page);
    const content = runLearningContent(sheet);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(sheet).toHaveAttribute(
      "data-run-learning-mobile-sheet",
      "true",
    );
    await expect(content).toBeVisible();
    await expect(runLearningPanel(page)).toBeHidden();
    await expectNoVisibleBoxShadow(sheet);
    await expect(content.getByRole("region", { name: "Checks" })).toBeVisible();
    await expectCoarsePointerTarget(
      sheet.getByRole("button", { name: "Close lecture theory and hints" }),
      "mobile mission and hints close button",
    );
    await expectCoarsePointerTarget(
      content.getByRole("button", { name: "Reveal" }).first(),
      "mobile hint reveal button",
    );
    await expectLearnerSafeRunCopy(content);
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
    await openRunSshDialog(page);

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

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Failed",
      hasDeleteAction: false,
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
    await expect(progress.locator('[data-status="needs_repair"]')).toHaveCount(
      2,
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("saving progress stays visible on mobile", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Saving",
    });
    const savingSteps = page.getByRole("list", { name: "Saving steps" });
    await expect(savingSteps).toBeVisible();
    await expect(page.locator("[data-run-lease-countdown]")).not.toBeVisible();
    const bounds = await savingSteps.boundingBox();
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
    await expectCoarsePointerTarget(finish, "mobile finish and save action");
    await expect(finish).toBeVisible();
    await runLearningTrigger(page).click();
    const sheet = runLearningSheet(page);
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(
      sheet.getByRole("button", { name: "Finish and save" }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run workspace at tablet width", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("keeps the mission pane open above the mobile breakpoint", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    await expectPersistentDesktopLearningPanel(page);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("closes solution dialogs when the active guidance surface changes", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const solutionDialog = page.getByRole("dialog", {
      name: "Reveal the full solution?",
    });
    await runLearningContent(runLearningPanel(page))
      .getByRole("button", { name: "Reveal the full solution" })
      .click();
    await expect(solutionDialog).toBeVisible();

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(solutionDialog).toBeHidden();
    await expect(runLearningPanel(page)).toBeHidden();
    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await trigger.click();
    const sheet = runLearningSheet(page);
    await expect(sheet).toBeVisible();
    await runLearningContent(sheet)
      .getByRole("button", { name: "Reveal the full solution" })
      .click();
    await expect(solutionDialog).toBeVisible();

    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(solutionDialog).toBeHidden();
    await expect(sheet).toBeHidden();
    await expectPersistentDesktopLearningPanel(page);
    expect(
      await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        return (
          !active ||
          active === document.body ||
          active === document.documentElement ||
          active.getClientRects().length > 0
        );
      }),
      "focus must not return to a hidden guidance trigger",
    ).toBe(true);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run workspace on a touch tablet", () => {
  test.use({ viewport: { width: 1100, height: 900 }, hasTouch: true });

  test("keeps the full check list available without hover", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    const panel = runLearningPanel(page);
    await expectPersistentDesktopLearningPanel(page);
    const checks = runLearningContent(panel).getByRole("region", {
      name: "Checks",
    });
    await expect(checks.getByText("Start the web server")).toBeVisible();
    await expect(checks.getByText("Make the site reachable")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps the recap next action at the touch target minimum", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });

    const nextAction = page
      .getByRole("heading", { name: "Keep learning" })
      .locator("..")
      .getByRole("link");
    await expect(nextAction).toHaveCount(1);
    await expectCoarsePointerTarget(
      nextAction,
      "touch-tablet recap next action",
    );
  });
});

test.describe("run workspace at a narrow desktop width", () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test("uses mission and hints sheet below the desktop breakpoint", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    const trigger = runLearningTrigger(page);
    await expect(trigger).toBeVisible();
    await expect(runLearningPanel(page)).toBeHidden();
    await trigger.click();
    const sheet = runLearningSheet(page);
    await expect(sheet).toHaveAttribute("data-side", "bottom");
    await expect(
      runLearningContent(sheet).getByRole("region", { name: "Checks" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("long check rows", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  test("keeps all check rows reachable and leaves the total visible", async ({
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
    const probes = Array.from({ length: 12 }, (_, index) => ({
      id: `check-${index + 1}`,
      label: `hidden-check-${index + 1}`,
      kind: "command",
      phase: "scenario",
      status: index === 11 ? "passed" : "fail",
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

    await expectPersistentDesktopLearningPanel(page);
    const panel = runLearningPanel(page);
    const checks = runLearningContent(panel).getByRole("region", {
      name: "Checks",
    });
    await expect(checks.getByRole("listitem")).toHaveCount(12);
    await expect(
      checks.getByText("1/12 verified", { exact: true }),
    ).toBeVisible();
    const lastCheck = checks.getByText("Learner check 12", { exact: true });
    const scroller = panel.locator("[data-run-learning-panel-scroll]");
    const terminal = page.locator(".xterm");
    const [terminalBeforeScroll, pageScrollBefore] = await Promise.all([
      terminal.boundingBox(),
      page.evaluate(() => window.scrollY),
    ]);
    expect(terminalBeforeScroll).not.toBeNull();
    const scrollState = await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
    });
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrollBefore);
    const terminalAfterScroll = await terminal.boundingBox();
    expect(terminalAfterScroll).not.toBeNull();
    expect(terminalAfterScroll!.x).toBeCloseTo(terminalBeforeScroll!.x, 0);
    expect(terminalAfterScroll!.y).toBeCloseTo(terminalBeforeScroll!.y, 0);
    expect(terminalAfterScroll!.width).toBeCloseTo(
      terminalBeforeScroll!.width,
      0,
    );
    await lastCheck.scrollIntoViewIfNeeded();
    await expect(lastCheck).toBeVisible();
    await expect(lastCheck).toHaveText("Learner check 12");

    const terminalRequestsBeforeResize = ui.server.requests.filter(
      (request) => request === "POST /api/scenarios/runs/run-active/ssh",
    ).length;
    await page.setViewportSize({ width: 1000, height: 800 });
    await expectPersistentDesktopLearningPanel(page);
    const terminalAfterResize = await terminal.boundingBox();
    expect(terminalAfterResize).not.toBeNull();
    expect(terminalAfterResize!.width).toBeLessThan(
      terminalBeforeScroll!.width,
    );
    await expect(
      page.getByRole("status").filter({ hasText: /Terminal status:/i }),
    ).toHaveText(/Terminal status:\s*connected/i);
    expect(
      ui.server.requests.filter(
        (request) => request === "POST /api/scenarios/runs/run-active/ssh",
      ),
    ).toHaveLength(terminalRequestsBeforeResize);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("run guidance at 200% text", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps startup progress clear of guidance at 200% text", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });

    await expect(
      page.getByRole("region", { name: "Workspace startup progress" }),
    ).toBeVisible();
    const sequence = page.locator("[data-run-sequence-screen]");
    const guidance = runLearningPanel(page);
    await expect(sequence).toBeVisible();
    await expectPersistentDesktopLearningPanel(page);
    const [sequenceBox, guidanceBox] = await Promise.all([
      sequence.boundingBox(),
      guidance.boundingBox(),
    ]);
    expect(sequenceBox).not.toBeNull();
    expect(guidanceBox).not.toBeNull();
    expect(sequenceBox!.x).toBeGreaterThanOrEqual(0);
    expect(sequenceBox!.x + sequenceBox!.width).toBeLessThanOrEqual(
      guidanceBox!.x + 1,
    );
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps direct header actions and checks operable", async ({
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

    const panel = runLearningPanel(page);
    await expectPersistentDesktopLearningPanel(page);
    await expect(runSshButton(page)).toBeVisible();
    await expectFinePointerControlMinimumHeight(
      runSshButton(page),
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "200% SSH command action",
    );
    await expect(
      runLearningContent(panel).getByRole("region", { name: "Checks" }),
    ).toBeVisible();
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
    await expectFinePointerControlMinimumHeight(
      finish,
      FINE_POINTER_COMPACT_CONTROL_HEIGHT,
      "200% finish and save action",
    );
    await expect(finish).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("short run workspace", () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true });

  test("keeps startup progress inside a short viewport", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });

    const startupProgress = page.getByRole("region", {
      name: "Workspace startup progress",
    });
    const startupSteps = page.getByRole("list", { name: "Startup steps" });
    await expect(startupProgress).toBeVisible();
    await expect(startupSteps).toBeVisible();
    const scroll = await startupProgress.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    });
    expect(scroll).not.toBeNull();
    expect(scroll!.top).toBeGreaterThanOrEqual(0);
    expect(scroll!.bottom).toBeLessThanOrEqual(375);
    expect(scroll!.scrollHeight).toBeGreaterThanOrEqual(scroll!.clientHeight);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps mission and hints sheet scrollable in a short viewport", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    const trigger = runLearningTrigger(page);
    await expectCoarsePointerTarget(
      trigger,
      "landscape mission and hints trigger",
    );
    await trigger.click();

    const sheet = runLearningSheet(page);
    const content = runLearningContent(sheet);
    await expect(sheet).toBeVisible();
    // Sheet enters from below; assert its settled layout, not its 200ms entry transform.
    await page.waitForTimeout(250);
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(375);

    await expect(content.getByRole("region", { name: "Checks" })).toBeVisible();
    const scroller = sheet.locator("[data-run-learning-mobile-scroll]");
    const scroll = await scroller.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("mission and hints sheet needs a scrollable surface");
      }
      const scroller = element;
      scroller.scrollTop = scroller.scrollHeight;
      return {
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      };
    });
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    expect(scroll.scrollTop).toBeGreaterThan(0);
    await expect(
      content.getByRole("button", { name: "Reveal the full solution" }),
    ).toBeVisible();
    const scrolledBack = await scroller.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return -1;
      element.scrollTop = 0;
      return element.scrollTop;
    });
    expect(scrolledBack).toBeGreaterThanOrEqual(0);
    const close = sheet.getByRole("button", {
      name: "Close lecture theory and hints",
    });
    await expectCoarsePointerTarget(
      close,
      "landscape mission and hints close button",
    );
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

  test("keeps saving progress reachable in a short viewport", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Saving",
    });
    const savingSteps = page.getByRole("list", { name: "Saving steps" });
    await savingSteps.scrollIntoViewIfNeeded();
    await expect(savingSteps).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });
});

test.describe("small-screen access management", () => {
  test.use({ viewport: { width: 320, height: 844 }, hasTouch: true });

  test("keeps mission and hints usable at 320px in light mode", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "running",
    });

    await expectRunWorkspaceHeader(page, "Repair a broken nginx service");
    await expectRunWorkspaceChrome(page);
    const trigger = runLearningTrigger(page);
    await expect(trigger).toHaveAccessibleName(
      "Open lecture theory and hints. 0 of 2 hints revealed. 0 of 2 checks verified.",
    );
    await expectCoarsePointerTarget(
      trigger,
      "small-screen mission and hints trigger",
    );
    await trigger.click();

    const sheet = runLearningSheet(page);
    await expect(sheet).toBeVisible();
    await expect(runLearningContent(sheet)).toBeVisible();
    await expectLearnerSafeRunCopy(runLearningContent(sheet));
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
    await expectCoarsePointerTarget(finish, "320px finish and save action");
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

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Saving",
    });
    const savingSteps = page.getByRole("list", { name: "Saving steps" });
    await expect(savingSteps).toBeVisible();
    await expect(page.locator("[data-run-lease-countdown]")).not.toBeVisible();
    const bounds = await savingSteps.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test("keeps the ended-early recap usable at 320px", async ({
    page,
    ui,
  }, testInfo) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "archived",
    });
    ui.server.state.run.outcome = "cancelled";
    ui.server.state.run.solvedAt = null;
    ui.server.state.run.solveDurationMs = null;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await expect(
      page.getByRole("heading", { name: "Ended early", exact: true }),
    ).toBeVisible();
    const nextAction = page.getByRole("link", {
      name: "Read lecture and try again",
    });
    await nextAction.scrollIntoViewIfNeeded();
    await expectCoarsePointerTarget(nextAction, "320px ended-early next action");
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

    await expectStandardRunChrome(page, "Repair a broken nginx service", {
      status: "Solved",
      hasDeleteAction: true,
    });
    await expectCoarsePointerTarget(
      page.getByRole("button", { name: "Delete run…", exact: true }),
      "320px Delete run action",
    );
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
    await expectCoarsePointerTarget(
      carousel.getByRole("button", { name: "Previous replay part" }),
      "320px previous replay part",
    );
    await expectCoarsePointerTarget(
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
