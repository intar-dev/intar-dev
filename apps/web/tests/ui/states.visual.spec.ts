import { expect, test } from "./fixtures/test";
import { makeMultiReplayRun } from "./fixtures/data";
import { routeCase } from "./routes";
import { expectRouteScreenshot } from "./support/screenshot";

async function expectRunTimer(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  const timer = page.locator("[data-run-lease-countdown]");
  await expect(timer).toBeVisible();
  const timerText = timer.locator("[data-run-lease-countdown-text]");
  await expect(timerText).toBeVisible();
  await expect(timerText).toHaveText(/\d/);
  const box = await timer.boundingBox();
  const textBox = await timerText.boundingBox();
  expect(box).not.toBeNull();
  expect(textBox).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
}

async function expectConnectedTerminal(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  await expect(
    page.getByRole("status").filter({ hasText: /Terminal status:/i }),
  ).toHaveText(/Terminal status:\s*connected/i);
}

async function expectForegroundRunWorkspace(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  await expect(page.locator("[data-run-page]")).toBeVisible();
  await expect(page.locator("[data-run-back]")).toBeVisible();
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
}

async function expectStandardRunShell(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  await expect(page.locator("[data-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-course-run-page]")).toHaveCount(0);
  await expect(page.locator("[data-run-back]")).toBeVisible();
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(1);
}

async function expectShutdownRunShell(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  await expect(page.locator("[data-run-page]")).toBeVisible();
  await expect(page.locator("[data-run-shutdown-sequence]")).toBeVisible();
  await expect(page.locator("[data-run-back]")).toBeVisible();
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
}

async function expectDesktopMissionPane(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  const panel = page.locator("[data-run-learning-panel]");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: /^Lecture theory/ }),
  ).toBeVisible();
  await expect(
    page.locator("[data-run-learning-panel-trigger]"),
  ).not.toBeVisible();
  return panel;
}

async function openMobileMissionAndHints(
  page: Parameters<typeof expectRouteScreenshot>[0],
) {
  const trigger = page.locator("[data-run-learning-panel-trigger]");
  await expect(trigger).toBeVisible();
  await expect(page.locator("[data-run-learning-panel]")).not.toBeVisible();
  await trigger.click();
  const sheet = page.locator("[data-run-learning-mobile-sheet]");
  await expect(sheet).toBeVisible();
  return sheet;
}

test.describe("focused visual states", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("course detail · desktop", async ({ page, ui }) => {
    await ui.open({
      path: "/courses/operations",
      sessionRole: "learner",
      theme: "light",
    });
    await expect(
      page.getByRole("heading", { name: "Course lectures" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "course-detail-light-desktop");
  });

  test("course detail · mobile", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({
      path: "/courses/operations",
      sessionRole: "learner",
      theme: "light",
    });
    await expect(
      page.getByRole("heading", { name: "Course lectures" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "course-detail-light-mobile");
  });

  test("course filters · mobile disclosure", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    await page.locator("summary").filter({ hasText: "Filters" }).click();
    await expect(page.getByRole("button", { name: "Easy" })).toBeVisible();
    await expectRouteScreenshot(page, "course-filters-open-light-mobile");
  });

  test("lecture · completed scenario actions", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      runState: "archived",
    });
    const lecture = ui.server.state.courseCatalog[0]!.lectures[1]!;
    lecture.scenarioReady = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await expect(page.getByText("Review runs", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Trace an intermittent DNS failure" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Run again" }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "lecture-completed-scenario-actions-light-desktop",
    );
  });

  test("lecture · completed scenario actions · mobile", async ({ page, ui }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      runState: "archived",
    });
    const lecture = ui.server.state.courseCatalog[0]!.lectures[1]!;
    lecture.scenarioReady = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await expect(
      page.getByRole("button", { name: /Open course outline/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
    await expectRouteScreenshot(
      page,
      "lecture-completed-scenario-actions-light-mobile",
    );
  });

  test("lecture · long next action at tablet width", async ({ page, ui }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await ui.open({
      ...routeCase("lecture"),
      theme: "light",
      runState: "archived",
    });
    const course = ui.server.state.courseCatalog[0]!;
    course.lectures[1]!.scenarioReady = true;
    course.lectures[1]!.category =
      "platform-observability-with-a-deliberately-long-category-name";
    course.lectures[2]!.title =
      "Trace an intermittent DNS failure across a deliberately long production service boundary";
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();

    await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
    await page.getByRole("button", { name: /Open course outline/ }).click();
    await expect(
      page.getByRole("link", {
        name: /Trace an intermittent DNS failure across a deliberately long production service boundary/,
      }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "lecture-completed-long-next-light-tablet",
    );
  });

  test("lecture · focused scenario start", async ({ page, ui }) => {
    const course = ui.server.state.courseCatalog[0]!;
    const lecture = course.lectures[1]!;
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route("**/api/scenarios/*/start", async (route) => {
      await startGate;
      ui.server.setRunState("launching");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: true,
          runId: "run-active",
          scenarioId: "repair-nginx",
          acceptedAt: Date.now(),
          reused: false,
          run: ui.server.state.run,
        }),
      });
    });
    await ui.open({
      path: `/courses/${course.courseId}/lectures/${lecture.lectureId}`,
      sessionRole: "learner",
      theme: "dark",
      runState: "archived",
    });
    await page.getByRole("button", { name: "Run again" }).click();

    try {
      await expect(page).toHaveURL(/\/runs\/start\/repair-nginx/);
      await expect(page.locator("[data-run-start-sequence]")).toBeVisible();
      await expectRouteScreenshot(page, "lecture-starting-scenario-dark-desktop");
    } finally {
      releaseStart?.();
    }
  });

  test("run · running mission pane", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    const panel = await expectDesktopMissionPane(page);
    await expect(panel.getByText("0/2 used", { exact: true })).toBeVisible();
    await expectRouteScreenshot(page, "run-running-guidance-dark-desktop");
  });

  test("run · check list in mission pane", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    const panel = await expectDesktopMissionPane(page);
    await expect(
      panel.getByText("Checks", { exact: true }),
    ).toBeVisible();
    await expect(
      panel
        .getByLabel("Checks", { exact: true })
        .getByText("Start the web server", { exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-check-list-dark-desktop");
  });

  test("run · booting mission pane", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expect(
      page.getByRole("heading", { name: "Preparing your workspace" }),
    ).toBeVisible();
    const panel = await expectDesktopMissionPane(page);
    await expect(
      panel.getByText("Work order", { exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-booting-guidance-dark-desktop");
  });

  test("run · solved workspace action", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    await expect(
      page.locator("[data-run-completion-bar]"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Finish and save" }),
    ).toBeVisible();
    const panel = await expectDesktopMissionPane(page);
    await expect(
      panel.getByText("Full solution", { exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-solved-workspace-action-dark-desktop");
  });

  test("run · shutdown sequence", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Saving your run…" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-saving-recap-dark-desktop");
  });

  test("run · shutdown sequence · light", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Saving your run…" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-saving-recap-light-desktop");
  });

  test("run · every saving milestone", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    const currentStep = page
      .getByRole("list", { name: "Saving steps" })
      .locator('[aria-current="step"]');
    for (const [stage, label, snapshot] of [
      ["save_requested", "Save requested", "save-requested"],
      ["closing_workspace", "Closing workspace", "closing-workspace"],
      ["saving_files", "Saving files", "saving-files"],
      ["preparing_replay", "Preparing replay", "preparing-replay"],
      ["finalizing_recap", "Finalizing recap", "finalizing-recap"],
    ] as const) {
      ui.server.state.run.savingStage = stage;
      ui.server.scenarioRunStatusRevision += 1;
      await expect(currentStep).toContainText(label);
      await expectRouteScreenshot(
        page,
        `run-saving-${snapshot}-dark-desktop`,
      );
    }
  });

  test("run · settled recap", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "archived",
    });
    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Solved" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Final checks" }),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Final checks progress" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-settled-recap-dark-desktop");
  });

  test("run · settled recap · light", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "archived",
    });
    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Solved" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Final checks" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-settled-recap-light-desktop");
  });

  test("run · dense checks and hints", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      variant: "long",
      runState: "running",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    const panel = await expectDesktopMissionPane(page);
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

  test("run · replay carousel", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    await expectStandardRunShell(page);
    ui.server.state.run = makeMultiReplayRun();
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Final checks progress" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Watch replay" }).click();
    const carousel = page.locator("[data-run-replay-carousel]");
    await carousel.getByRole("button", { name: "Next replay part" }).click();
    await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
      "Part 2 of 3 · web",
    );
    await expect(page.locator(".run-artifact-player .ap-player")).toBeVisible();
    await expectRouteScreenshot(page, "run-replay-carousel-dark-desktop");
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
        ...routeCase("course-catalog"),
        theme: "light",
        variant,
      });
      if (variant === "error") {
        const loadError = page.getByText("Could not load courses", {
          exact: true,
        });
        await expect(loadError).toBeVisible({ timeout: 15_000 });
        await expectRouteScreenshot(page, "catalog-error-light-desktop");
        return;
      }
      if (variant === "loading") {
        await expect(
          page.getByText("Loading courses…", { exact: true }),
        ).toHaveCount(1);
        await expect(
          page.getByRole("link", {
            name: "Discord (opens in a new tab)",
          }),
        ).toBeVisible();
        const screenshot = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          fullPage: false,
          scale: "css",
        });
        expect(screenshot).toMatchSnapshot(
          `catalog-${variant}-light-desktop.png`,
          { maxDiffPixelRatio: 0.001 },
        );
        return;
      }
      await expectRouteScreenshot(page, `catalog-${variant}-light-desktop`);
    });
  }

  test("sidebar · Discord support link", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("course-catalog"),
      theme: "light",
    });
    await expect(page.getByText("Support", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Discord (opens in a new tab)" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "sidebar-support-discord-light-desktop");
  });

  test("catalog · authored course", async ({ page, ui }) => {
    await ui.open({ ...routeCase("course-catalog"), theme: "light" });
    await page.getByRole("link", { name: /Linux operations/ }).click();
    await expect(
      page.getByRole("heading", { name: "Linux operations" }),
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
        .getByRole("link", { name: /Resume run/i })
        .or(page.getByRole("button", { name: /Resume run/i }))
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

});

test.describe("focused mobile workspace", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("running mission and hints sheet", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "running",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    const sheet = await openMobileMissionAndHints(page);
    await expect(
      sheet.getByRole("heading", { name: /^Lecture theory:/ }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-running-guidance-dark-mobile");
  });

  test("booting mission and hints sheet", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expect(
      page.getByRole("heading", { name: "Preparing your workspace" }),
    ).toBeVisible();
    const sheet = await openMobileMissionAndHints(page);
    await expect(
      sheet.getByText("Work order", { exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-booting-guidance-dark-mobile");
  });

  test("failed recap progress", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "failed",
    });
    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Could not finish" }),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Final checks progress" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-failed-recap-light-mobile");
  });

  test("solved workspace action", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Finish and save" }),
    ).toBeVisible();
    await expectRouteScreenshot(page, "run-solved-workspace-action-dark-mobile");
  });

  test("shutdown sequence progress", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    await expect(page.getByRole("list", { name: "Saving steps" })).toBeVisible();
    await expect(page.locator("[data-run-lease-countdown]")).not.toBeVisible();
    await expectRouteScreenshot(page, "run-saving-recap-dark-mobile");
  });

  test("replay carousel", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "replay",
    });
    await expectStandardRunShell(page);
    ui.server.state.run = makeMultiReplayRun();
    await page.reload({ waitUntil: "domcontentloaded" });
    await ui.settle();
    await page.getByRole("button", { name: "Watch replay" }).click();
    const carousel = page.locator("[data-run-replay-carousel]");
    await expect(carousel).toBeVisible();
    await carousel.getByRole("button", { name: "Next replay part" }).click();
    await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
      "Part 2 of 3 · web",
    );
    await expect(page.locator(".run-artifact-player .ap-player")).toBeVisible();
    await expectRouteScreenshot(page, "run-replay-carousel-dark-mobile");
  });
});

test.describe("wide short course recaps", () => {
  test.use({ viewport: { width: 2048, height: 690 } });

  test("ended early", async ({ page, ui }) => {
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

    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Ended early", exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "run-ended-early-recap-dark-wide-short",
    );
  });

  test("failed", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "failed",
    });
    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Could not finish", exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "run-failed-recap-dark-wide-short",
    );
  });

  test("settled", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "archived",
    });
    await expectStandardRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Solved", exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "run-settled-recap-dark-wide-short",
    );
  });

  test("saving", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    await expect(
      page.getByRole("heading", { name: "Saving your run…", exact: true }),
    ).toBeVisible();
    await expectRouteScreenshot(
      page,
      "run-saving-recap-dark-wide-short",
    );
  });
});

test.describe("short landscape run workspace", () => {
  test.use({ viewport: { width: 667, height: 375 }, hasTouch: true });

  test("booting sequence fits", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "booting",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expect(page.getByRole("list", { name: "Startup steps" })).toBeVisible();
    await expectRouteScreenshot(page, "run-booting-sequence-dark-landscape");
  });

  test("solved action keeps terminal space", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "solved",
    });
    await expectForegroundRunWorkspace(page);
    await expectRunTimer(page);
    await expectConnectedTerminal(page);
    await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
    await expect(page.getByRole("region", { name: "Terminal" })).toBeVisible();
    await expectRouteScreenshot(page, "run-solved-workspace-action-dark-landscape");
  });

  test("saving recap progress fits", async ({ page, ui }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: "ending",
    });
    await expectShutdownRunShell(page);
    await expect(page.getByRole("list", { name: "Saving steps" })).toBeVisible();
    await expectRouteScreenshot(page, "run-saving-recap-dark-landscape");
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
          page.getByRole("link", { name: /Platform repair sequence/ }),
        ).toBeVisible();
        if (viewport.id === "desktop") {
          await expect(
            page.getByRole("link", {
              name: "Discord (opens in a new tab)",
            }),
          ).toBeVisible();
        }
        await expectRouteScreenshot(
          page,
          `organization-courses-${theme}-${viewport.id}`,
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

for (const viewport of [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`admin run archive · ${viewport.id}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("compact archive", async ({ page, ui }) => {
      await ui.open({ ...routeCase("admin-overview"), theme: "light" });
      const archive = page
        .getByRole("heading", { name: "Run archive" })
        .locator("xpath=ancestor::section");
      await archive.scrollIntoViewIfNeeded();
      await expect(archive).toHaveScreenshot(
        `admin-run-archive-light-${viewport.id}.png`,
        {
          animations: "disabled",
          caret: "hide",
          scale: "css",
        },
      );
    });

    if (viewport.id === "desktop") {
      test("expanded archive", async ({ page, ui }) => {
        await ui.open({ ...routeCase("admin-overview"), theme: "light" });
        const archive = page
          .getByRole("heading", { name: "Run archive" })
          .locator("xpath=ancestor::section");
        await archive.getByRole("button", { name: "Details" }).click();
        await expect(
          archive.getByRole("button", { name: "Refresh" }),
        ).toBeVisible();
        await expect(
          archive.getByRole("heading", { name: "Artifacts" }),
        ).toBeVisible();
        await expect(archive).toHaveScreenshot(
          "admin-run-archive-expanded-light-desktop.png",
          {
            animations: "disabled",
            caret: "hide",
            scale: "css",
          },
        );
      });
    }
  });
}
