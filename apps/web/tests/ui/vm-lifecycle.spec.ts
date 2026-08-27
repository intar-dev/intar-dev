import { expect, test } from "./fixtures/test";
import { makeMultiReplayRun } from "./fixtures/data";
import { routeCase } from "./routes";

test("the boot screen keeps the work order reachable and does not steal focus when the shell opens", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "booting",
  });

  await expect(
    page.getByRole("heading", { name: "Preparing your workspace" }),
  ).toBeVisible();
  await expect(page.getByText(/Review the work order while/i)).toBeVisible();
  const startupSteps = page.getByRole("list", { name: "Startup steps" });
  await expect(startupSteps.locator("[data-run-sequence-step]")).toHaveCount(4);
  await expect(startupSteps.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(page.locator("[data-run-sequence-position]")).toHaveText(
    "Stage 2 of 4",
  );
  const leaseCountdown = page.locator("[data-run-lease-countdown]");
  await expect(leaseCountdown).toHaveText("1:25:00 left");
  await expect(leaseCountdown).toBeVisible();
  const leaseCountdownBox = await leaseCountdown.boundingBox();
  expect(leaseCountdownBox).not.toBeNull();
  expect(leaseCountdownBox!.x + leaseCountdownBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const learningChromeBox = await page
    .locator("[data-run-learning-chrome]")
    .boundingBox();
  expect(learningChromeBox).not.toBeNull();
  expect(leaseCountdownBox!.x + leaseCountdownBox!.width).toBeLessThanOrEqual(
    learningChromeBox!.x,
  );

  const trigger = page.getByRole("button", {
    name: "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
  });
  await expect(trigger).toContainText("Hints 0/2");

  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator("[data-run-learning-panel-content]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Work order" })).toBeVisible();
  await expect(
    panel
      .locator('section[aria-labelledby="run-learning-work-order-heading"]')
      .getByText("Start the web server"),
  ).toBeVisible();
  const sequenceBox = await page
    .locator("[data-run-sequence-screen]")
    .boundingBox();
  const guidanceBox = await page
    .locator("[data-run-guidance-rail]")
    .boundingBox();
  expect(sequenceBox).not.toBeNull();
  expect(guidanceBox).not.toBeNull();
  expect(sequenceBox!.x + sequenceBox!.width).toBeLessThanOrEqual(
    guidanceBox!.x - 16,
  );
  await expect(panel.getByText("nginx-listening")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  const focusTarget = page.getByRole("link", { name: "Courses" }).first();
  await focusTarget.focus();
  ui.server.setRunState("running");

  await expect(page.locator(".xterm")).toBeVisible({ timeout: 1_000 });
  await expect(
    page.getByRole("button", {
      name: "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    }),
  ).toBeVisible();
  await expect(focusTarget).toBeFocused();
});

test("the desktop guidance rail keeps progressive hints and solution help learner-safe", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  const trigger = page.getByRole("button", {
    name: "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
  });
  await expect(trigger).toContainText("Hints 0/2");
  const indicators = page.locator("[data-run-check-indicator]");
  await expect(indicators).toHaveCount(2);
  await expect(indicators.first()).toHaveAttribute(
    "data-status",
    "needs_repair",
  );
  await expect(indicators.nth(1)).toHaveAttribute("data-status", "checking");
  await expect(page.getByRole("complementary", { name: "Run console" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("group", { name: "Machines" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Reconnect terminal/i }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Maximize/i })).toHaveCount(0);
  await expect(page.getByText("Run timeline", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Technical details", { exact: true })).toHaveCount(0);

  await trigger.click();
  const panel = page.locator("[data-run-learning-panel-content]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Hints and guidance" })).toBeVisible();
  await expect(panel.getByText("0/2 verified", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("Inspect the service boundary")).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Reveal", exact: true }),
  ).toHaveCount(2);

  for (const forbidden of [
    "nginx-listening",
    "health-endpoint",
    "tcp_connect",
    "http_request",
    "127.0.0.1",
    "repair-nginx-web-7f3a",
    "ssh-ed25519",
    "SHA-256",
    "SSH target",
  ]) {
    await expect(panel).not.toContainText(forbidden);
  }

  const revealResponse = page.waitForResponse(
    (response) =>
      /\/api\/scenarios\/runs\/run-active\/hints\/reveal$/.test(
        new URL(response.url()).pathname,
      ) && response.status() === 200,
  );
  await panel
    .getByRole("button", { name: "Reveal", exact: true })
    .first()
    .click();
  await revealResponse;
  await expect(panel.getByText("Inspect the service boundary")).toBeVisible();
  await expect(panel.getByText("systemctl status nginx")).toBeVisible();

  await panel
    .getByRole("button", { name: "Reveal the full solution" })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Reveal the full solution?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Reveal solution" }).click();
  await expect(
    panel.getByText("You used the full solution for this run."),
  ).toBeVisible();
  await expect(
    panel.getByText("Validate the nginx configuration, restore the unit, and restart it."),
  ).toBeVisible();
});

test("compact status polls cannot hide a newly revealed hint", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  await page
    .getByRole("button", {
      name: "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    })
    .click();
  const panel = page.locator("[data-run-learning-panel-content]");
  const revealResponse = page.waitForResponse(
    (response) =>
      /\/api\/scenarios\/runs\/run-active\/hints\/reveal$/.test(
        new URL(response.url()).pathname,
      ) && response.status() === 200,
  );
  await panel
    .getByRole("button", { name: "Reveal", exact: true })
    .first()
    .click();
  await revealResponse;
  await expect(panel.getByText("Inspect the service boundary")).toBeVisible();

  await expect
    .poll(
      () =>
        ui.server.requests.filter(
          (request) =>
            request === "GET /api/scenarios/runs/run-active/status",
        ).length,
    )
    .toBeGreaterThan(1);
  await expect(panel.getByText("Inspect the service boundary")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open lab guidance. 1 of 2 hints revealed. 0 of 2 checks verified.",
    }),
  ).toBeVisible();
});

test("the Broken Nginx contract exposes three outcomes and five progressive hints", async ({
  page,
  ui,
}) => {
  const route = routeCase("run-workspace");
  ui.configure({
    sessionRole: route.sessionRole,
    runState: "running",
  });
  const run = ui.server.state.run as {
    objectives: Array<Record<string, unknown>>;
    hints: Array<Record<string, unknown>>;
    scenarioProbes: Array<Record<string, unknown>>;
    vms: Array<{ scenarioProbes: Array<Record<string, unknown>> }>;
  };
  const thirdProbe = {
    id: "default-site-enabled",
    label: "hidden internal path check",
    kind: "file_exists",
    phase: "scenario",
    status: "fail",
    error: "hidden /etc/nginx/sites-enabled/default detail",
    value: { path: "/etc/nginx/sites-enabled/default" },
  };
  run.objectives = [
    ...run.objectives,
    {
      probeName: "default-site-enabled",
      vmName: "web",
      label: "hidden internal label",
      title: "Restore the default site",
      bodyMarkdown: "hidden technical objective body",
      hintCount: 1,
    },
  ];
  run.scenarioProbes.push(thirdProbe);
  run.vms[0]?.scenarioProbes.push(thirdProbe);
  run.hints.push(
    {
      key: "scenario:hint-2",
      scope: "scenario",
      probeName: null,
      id: "hint-2",
      title: null,
      revealed: false,
      unlocked: false,
      bodyMarkdown: null,
    },
    {
      key: "probe:health-endpoint:hint-1",
      scope: "probe",
      probeName: "health-endpoint",
      id: "hint-health-1",
      title: null,
      revealed: false,
      unlocked: true,
      bodyMarkdown: null,
    },
    {
      key: "probe:default-site-enabled:hint-1",
      scope: "probe",
      probeName: "default-site-enabled",
      id: "hint-site-1",
      title: null,
      revealed: false,
      unlocked: true,
      bodyMarkdown: null,
    },
  );

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await ui.settle();

  const trigger = page.getByRole("button", {
    name: "Open lab guidance. 0 of 5 hints revealed. 0 of 3 checks verified.",
  });
  await expect(trigger).toContainText("Hints 0/5");
  const indicators = page.locator("[data-run-check-indicator]");
  await expect(indicators).toHaveCount(3);
  await expect(indicators.nth(0)).toHaveAccessibleName(
    "Open lab guidance. Start the web server. Needs repair.",
  );
  await expect(indicators.nth(1)).toHaveAccessibleName(
    "Open lab guidance. Make the site reachable. Checking.",
  );
  await expect(indicators.nth(2)).toHaveAccessibleName(
    "Open lab guidance. Restore the default site. Needs repair.",
  );
  await trigger.click();
  const panel = page.locator("[data-run-learning-panel-content]");
  await expect(
    panel.locator('section[aria-labelledby="run-learning-checks-heading"]'),
  ).toHaveCount(0);
  await expect(panel.getByText("0/5 used", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("/etc/nginx/sites-enabled/default");
  await expect(panel).not.toContainText("hidden technical objective body");
});

test("hint and solution failures use generic learner-safe messages", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });
  ui.server.state.variant = "error";
  await page.route(
    "**/api/scenarios/runs/run-active/hints/reveal",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: { error: "worker-19 rejected POST /hints/reveal" },
      });
    },
  );
  await page.route(
    "**/api/scenarios/runs/run-active/solution/reveal",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: { error: "control-plane task 7c02c91 failed" },
      });
    },
  );

  await page
    .getByRole("button", {
      name: "Open lab guidance. 0 of 2 hints revealed. 0 of 2 checks verified.",
    })
    .click();
  const panel = page.locator("[data-run-learning-panel-content]");

  await panel
    .getByRole("button", { name: "Reveal", exact: true })
    .first()
    .click();
  await expect(
    panel.getByRole("alert").filter({
      hasText: "Could not reveal this hint. Try again.",
    }),
  ).toBeVisible();
  await expect(panel).not.toContainText("worker-19");
  await expect(panel).not.toContainText("POST /hints/reveal");

  await panel
    .getByRole("button", { name: "Reveal the full solution" })
    .click();
  await page
    .getByRole("dialog", { name: "Reveal the full solution?" })
    .getByRole("button", { name: "Reveal solution" })
    .click();
  await expect(
    panel.getByRole("alert").filter({
      hasText: "Could not reveal the solution. Try again.",
    }),
  ).toBeVisible();
  await expect(panel).not.toContainText("control-plane task 7c02c91");
});

test("a solved lab makes finishing the first learner action", async ({ page, ui }) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "solved",
  });

  const trigger = page.getByRole("button", {
    name: "Open lab guidance. 0 of 2 hints revealed. 2 of 2 checks verified.",
  });
  await expect(trigger).toContainText("Hints 0/2");
  const finish = page.getByRole("button", { name: "Finish and save" });
  await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
  await expect(finish).toBeVisible();
  await trigger.click();

  const panel = page.locator("[data-run-learning-panel-content]");
  await expect(panel.getByRole("heading", { name: "Lab solved" })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Finish and save" }),
  ).toHaveCount(0);
  await expect(page.locator('[data-run-check-indicator][data-status="verified"]')).toHaveCount(2);
  const text = await panel.innerText();

  for (const forbidden of [
    "nginx-listening",
    "health-endpoint",
    "tcp_connect",
    "http_request",
    "connection refused",
    "repair-nginx-web-7f3a",
    "10.40.0.18",
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

test("a failed solved-run save stays beside the visible action", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "solved",
  });
  ui.server.state.variant = "error";
  await page.route("**/api/scenarios/runs/run-active/destroy", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "host-17 teardown queue rejected run-vm-web" },
    });
  });

  const completionBar = page.locator("[data-run-completion-bar]");
  await completionBar
    .getByRole("button", { name: "Finish and save" })
    .click();
  await expect(completionBar.getByRole("alert")).toHaveText(
    "We could not save this run. Your work is still open. Try again.",
  );
  await expect(completionBar).not.toContainText("host-17");
  await expect(completionBar).not.toContainText("run-vm-web");
  await expect(
    completionBar.getByRole("button", { name: "Finish and save" }),
  ).toBeEnabled();
});

test("the final check transition uses one useful live announcement", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  ui.server.setRunState("solved");
  const completion = page
    .locator('[aria-live="polite"]')
    .filter({ hasText: "All 2 checks are verified." });
  await expect(completion).toHaveCount(1);
  await expect(completion).toHaveText("All 2 checks are verified.");
  await expect(page.locator("[data-run-completion-bar]")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish and save" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Solved" }),
  ).toHaveCount(0);
});

test("a delayed old terminal connection cannot replace a newer VM connection", async ({
  page,
  ui,
}) => {
  const route = routeCase("run-workspace");
  ui.configure({
    sessionRole: route.sessionRole,
    runState: "running",
  });
  const run = ui.server.state.run as {
    vms: Array<Record<string, unknown>>;
  };
  const firstVm = run.vms[0];
  if (!firstVm) throw new Error("run VM fixture missing");
  run.vms = [
    firstVm,
    {
      ...structuredClone(firstVm),
      id: "run-vm-worker",
      ordinal: 2,
      scenarioVmId: "scenario-vm-worker",
      scenarioVmName: "worker",
      runtimeVmName: "run-active-worker",
      hostname: "worker.intar.test",
    },
  ];
  ui.server.state.terminalMode = "delayed-first-ready";

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  const machines = page.getByRole("group", { name: "Machines" });
  await expect(machines).toBeVisible();
  await machines.getByRole("button", { name: /worker/i }).click();

  const terminalStatus = page
    .getByRole("status")
    .filter({ hasText: /Terminal status:/i });
  await expect(terminalStatus).toHaveText(/Terminal status:\s*connected/i);
  await page.waitForTimeout(1_200);
  await expect(terminalStatus).toHaveText(/Terminal status:\s*connected/i);
  await expect(
    page.getByRole("button", { name: "Reconnect terminal" }),
  ).toHaveCount(0);
});

test("ending a lab moves from a calm saving state to a learner recap and replay", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "End run…" }).click();
  const dialog = page.getByRole("dialog");
  const destroyResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scenarios/runs/run-active/destroy") &&
      response.status() === 202,
  );
  await dialog.getByRole("button", { name: "End run" }).click();
  await destroyResponse;

  await expect(page).toHaveURL(/\/runs\/run-active$/);
  await expect(dialog).toBeHidden();
  const savingHeading = page.getByRole("heading", { name: "Saving your run…" });
  await expect(savingHeading).toBeVisible();
  await expect(savingHeading).toBeFocused();
  await expect(page.locator("[data-run-lease-countdown]")).toHaveText(
    "1:25:00 left",
  );
  await expect(
    page.getByText("Your recap will be ready in a moment."),
  ).toBeVisible();
  const savingSteps = page.getByRole("list", { name: "Saving steps" });
  await expect(savingSteps).toBeVisible();
  await expect(savingSteps.locator("[data-run-sequence-step]")).toHaveCount(5);
  await expect(
    page.locator('section[aria-labelledby="run-recap-heading"]'),
  ).not.toHaveAttribute("aria-busy");
  for (const forbidden of [
    "Run timeline",
    "Shutting down workspace",
    "Preparing terminal recordings",
    "Building terminal session history",
    "Transcript",
    "Command log",
  ]) {
    await expect(page.getByText(forbidden, { exact: true })).toHaveCount(0);
  }

  ui.server.setRunState("rendering");
  ui.server.state.run.outcome = "succeeded";
  await expect(savingHeading).toBeVisible({ timeout: 5_000 });
  await expect(savingSteps).toBeVisible();
  await expect(page.locator("header")).toContainText("Saving");
  await expect(page.locator("header")).not.toContainText("Solved");

  ui.server.setRunState("replay");
  const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
  const settledHeading = recap.getByRole("heading", { name: "Solved" });
  await expect(settledHeading).toBeVisible({
    timeout: 5_000,
  });
  await expect(settledHeading).toBeFocused();
  await expect(recap.getByRole("heading", { name: "Final checks" })).toBeVisible();
  await expect(savingSteps).toHaveCount(0);
  await expect(recap).not.toHaveAttribute("aria-busy");
  await expect(recap.getByText("2/2 verified", { exact: true })).toBeVisible();
  const progress = recap.getByRole("progressbar", {
    name: "Final checks progress",
  });
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  await expect(progress).toHaveAttribute("aria-valuemax", "2");
  await expect(progress).toHaveAttribute(
    "aria-valuetext",
    "2 of 2 final checks verified",
  );
  await expect(recap.getByText("Hints used", { exact: true })).toBeVisible();
  await expect(recap.getByText("Full solution", { exact: true })).toBeVisible();
  await expect(recap.getByRole("button", { name: "Watch replay" })).toHaveCount(1);

  expect(
    ui.server.requests.some((request) =>
      request.includes("/artifacts/run-vm-web:0/content"),
    ),
  ).toBe(false);
  await recap.getByRole("button", { name: "Watch replay" }).click();
  await expect(recap.locator("[data-run-replay-carousel]")).toHaveCount(0);
  await expect
    .poll(() =>
      ui.server.requests.some((request) =>
        request.includes("/artifacts/run-vm-web:0/content"),
      ),
    )
    .toBe(true);
  expect(
    ui.server.requests.some((request) => request.includes("%3A")),
  ).toBe(false);
  await expect(recap.locator(".run-artifact-player")).toBeVisible();
  await expect(recap.getByText("Transcript", { exact: true })).toHaveCount(0);
  await expect(recap.getByText("Command log", { exact: true })).toHaveCount(0);
  expect(
    ui.server.requests.some((request) => request.includes("/transcript")),
  ).toBe(false);
});

test("saving stages advance from real server state and announce each change once", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "ending",
  });

  const steps = page.getByRole("list", { name: "Saving steps" });
  const announcement = page.locator("[data-run-sequence-announcement]");
  await expect(steps.locator('[aria-current="step"]')).toContainText(
    "Save requested",
  );
  await expect(announcement).toHaveText(
    "Stage 1 of 5: Save requested. In progress.",
  );

  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>(
      "[data-run-sequence-announcement]",
    );
    if (!target) throw new Error("saving announcement region is missing");
    const state = window as typeof window & {
      __runSavingAnnouncements?: string[];
      __runSavingObserver?: MutationObserver;
    };
    state.__runSavingAnnouncements = [];
    state.__runSavingObserver = new MutationObserver(() => {
      const text = target.textContent?.trim() ?? "";
      const entries = state.__runSavingAnnouncements ?? [];
      if (text && entries.at(-1) !== text) entries.push(text);
    });
    state.__runSavingObserver.observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  const changes = [
    ["closing_workspace", "Closing workspace"],
    ["saving_files", "Saving files"],
    ["preparing_replay", "Preparing replay"],
    ["finalizing_recap", "Finalizing recap"],
  ] as const;
  for (const [stage, label] of changes) {
    ui.server.state.run.savingStage = stage;
    ui.server.scenarioRunStatusRevision += 1;
    await expect(steps.locator('[aria-current="step"]')).toContainText(label);
    const stageNumber = changes.findIndex(([candidate]) => candidate === stage) + 2;
    await expect(announcement).toHaveText(
      `Stage ${stageNumber} of 5: ${label}. In progress.`,
    );
  }

  // One unchanged background poll must not repeat the last announcement.
  await page.waitForTimeout(1_200);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & { __runSavingAnnouncements?: string[] }
        ).__runSavingAnnouncements ?? [],
    ),
  ).toEqual(
    changes.map(
      ([, label], index) => `Stage ${index + 2} of 5: ${label}. In progress.`,
    ),
  );
});

test("saving shows a calm reassurance only after one stage stalls", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "ending",
  });

  const reassurance = page.locator("[data-run-saving-stalled]");
  await expect(
    page.getByRole("heading", { name: "Saving your run…" }),
  ).toBeVisible();
  await expect(reassurance).toHaveCount(0);
  await page.clock.fastForward(30_000);
  await expect(reassurance).toHaveText(
    "This is taking longer than usual. Your work is safe, and your recap will appear here.",
  );

  ui.server.state.run.savingStage = "closing_workspace";
  ui.server.scenarioRunStatusRevision += 1;
  await expect(
    page
      .getByRole("list", { name: "Saving steps" })
      .locator('[aria-current="step"]'),
  ).toContainText("Closing workspace");
  await expect(reassurance).toHaveCount(0);
});

test("a replay carousel keeps learner-facing parts in order", async ({
  page,
  ui,
}) => {
  const route = routeCase("run-workspace");
  ui.configure({
    sessionRole: route.sessionRole,
    runState: "replay",
  });
  ui.server.state.run = makeMultiReplayRun();

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await ui.settle();

  const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
  await expect(recap.getByRole("button", { name: "Watch replay" })).toHaveCount(1);
  await recap.getByRole("button", { name: "Watch replay" }).click();
  const carousel = recap.locator("[data-run-replay-carousel]");
  const previous = carousel.getByRole("button", {
    name: "Previous replay part",
  });
  const next = carousel.getByRole("button", { name: "Next replay part" });
  const order = carousel.locator('ol[aria-label="Replay order"]');
  await expect(carousel).toBeVisible();
  await expect(carousel).toHaveAttribute("aria-roledescription", "carousel");
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 1 of 3 · web",
  );
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect(order.getByRole("button")).toHaveCount(3);
  await expect(order.getByRole("button").nth(0)).toHaveAccessibleName(
    "Show Part 1 of 3, web",
  );
  await expect(order.getByRole("button").nth(1)).toHaveAccessibleName(
    "Show Part 2 of 3, web",
  );
  await expect(order.getByRole("button").nth(2)).toHaveAccessibleName(
    "Show Part 3 of 3, worker",
  );
  await expect
    .poll(() =>
      ui.server.requests.some((request) =>
        request.includes("/artifacts/cast-web-1/content"),
      ),
    )
    .toBe(true);

  await next.focus();
  await next.press("Space");
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 2 of 3 · web",
  );
  await expect(next).toBeFocused();
  await expect(
    carousel.getByRole("status").filter({
      hasText: "Showing Part 2 of 3",
    }),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      ui.server.requests.some((request) =>
        request.includes("/artifacts/cast-web-2/content"),
      ),
    )
    .toBe(true);

  await next.press("Enter");
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 3 of 3 · worker",
  );
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect
    .poll(() =>
      ui.server.requests.some((request) =>
        request.includes("/artifacts/cast-worker-1/content"),
      ),
    )
    .toBe(true);

  await previous.click();
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 2 of 3 · web",
  );
  await order.getByRole("button").nth(0).click();
  await expect(carousel.locator("[data-run-replay-position]")).toHaveText(
    "Part 1 of 3 · web",
  );
  await expect(previous).toBeDisabled();
  await expect(recap.locator(".run-artifact-player")).toBeVisible();

  const text = await recap.innerText();
  for (const forbidden of [
    "hidden-worker-vm-id",
    "hidden-worker-runtime",
    "hidden-worker-host",
    "hidden-web-01.cast",
    "hidden-worker-01.cast",
    "cast-web-1",
    "Transcript",
    "Command log",
    "Exit status",
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

test("a rejected shutdown stays in the confirmation dialog with learner-safe copy", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });
  await page.route(
    "**/api/scenarios/runs/run-active/destroy",
    async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          accepted: false,
          error: "Workspace shutdown could not be accepted.",
        },
      });
    },
  );

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "End run…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "End run" }).click();

  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Run could not be ended", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "The run could not be ended. Your work is still open.",
  );
  await expect(dialog).not.toContainText("Workspace shutdown could not be accepted.");
  await expect(page).toHaveURL(/\/runs\/run-active$/);
  await expect(page.getByRole("heading", { name: "Saving your run…" })).toHaveCount(
    0,
  );
});

test("deleting a private run preserves its organization course context", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });
  ui.server.state.run.scenarioId = "platform-logrotate";
  ui.server.state.run.organizationId = "org-platform";
  ui.server.state.run.courseLocation = {
    courseKind: "authored",
    scope: "organization-private",
    organizationId: "org-platform",
    courseId: "operations",
    courseTitle: "Platform repair sequence",
    step: 2,
    steps: 2,
  };
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete run…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete run" }).click();

  await expect(page).toHaveURL(
    "/organizations/org-platform/courses/private/operations/platform-logrotate",
  );
});

test("a failed saved-run deletion stays generic and recoverable", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });
  ui.server.state.variant = "error";
  await page.route("**/api/scenarios/runs/run-active", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 503,
        json: { error: "D1 delete transaction failed on shard 7" },
      });
      return;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete run…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this run?" });
  await dialog.getByRole("button", { name: "Delete run" }).click();

  await expect(
    dialog.getByText("Run could not be deleted", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "Nothing was removed. Try again when you are ready.",
  );
  await expect(dialog).not.toContainText("D1");
  await expect(dialog).not.toContainText("shard 7");
  await expect(page).toHaveURL(/\/runs\/run-active$/);
});

test("deleting an organization run without a course location returns its catalog", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });
  ui.server.state.run.organizationId = "org-platform";
  ui.server.state.run.courseLocation = null;
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await page.getByRole("button", { name: "Page actions" }).click();
  await page.getByRole("menuitem", { name: "Delete run…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete run" }).click();

  await expect(page).toHaveURL("/organizations/org-platform/courses");
});

test("a saved solved run gives one next learner action without audit details", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });

  const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
  await expect(recap.getByRole("heading", { name: "Solved" })).toBeVisible();
  await expect(
    recap.getByRole("link", {
      name: "Next lab: Trace an intermittent DNS failure",
    }),
  ).toHaveAttribute("href", "/courses/operations/repair-dns");
  await expect(recap.getByText("Lab recap", { exact: true })).toBeVisible();
  await expect(recap.getByText("Run timeline", { exact: true })).toHaveCount(0);
  await expect(recap.getByText("Transcript", { exact: true })).toHaveCount(0);
  await expect(recap.getByText("Command log", { exact: true })).toHaveCount(0);
});

test("a saved run without course context still has a safe exit", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });
  ui.server.state.run.courseLocation = null;
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  await expect(page.getByRole("link", { name: "Back to My runs" })).toHaveAttribute(
    "href",
    "/runs",
  );
  await expect(page.getByRole("link", { name: /^Next lab:/ })).toHaveCount(0);
});

for (const recapCase of [
  {
    state: "archived",
    title: "Solved",
    replay: null,
  },
  {
    state: "replay-failed",
    title: "Solved",
    replay: "Replay unavailable.",
  },
  {
    state: "failed",
    title: "Could not finish",
    replay: null,
  },
] as const) {
  test(`direct ${recapCase.state} visits use a learner recap`, async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: recapCase.state,
    });

    const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
    await expect(recap.getByRole("heading", { name: recapCase.title })).toBeVisible();
    if (recapCase.replay) {
      await expect(recap.getByText(recapCase.replay, { exact: true })).toBeVisible();
    } else {
      await expect(recap.getByRole("heading", { name: "Watch replay" })).toHaveCount(
        0,
      );
    }
    await expect(recap.getByText("Run timeline", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Transcript", { exact: true })).toHaveCount(0);
    await expect(recap.getByText("Command log", { exact: true })).toHaveCount(0);
  });
}

test("a settled cancelled run tells the learner it ended early", async ({
  page,
  ui,
}) => {
  const route = routeCase("run-workspace");
  ui.configure({
    sessionRole: route.sessionRole,
    runState: "archived",
  });
  const run = ui.server.state.run as Record<string, unknown>;
  run.outcome = "cancelled";
  run.solvedAt = null;
  run.solveDurationMs = null;

  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await ui.settle();

  const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
  await expect(recap.getByRole("heading", { name: "Ended early" })).toBeVisible();
  await expect(
    recap.getByRole("link", { name: "Try this lab again" }),
  ).toHaveAttribute("href", "/courses/operations/repair-nginx");
});

test("a replay failure stays inline and never exposes a server message", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "replay",
  });
  ui.server.state.variant = "error";
  await page.route("**/api/runs/run-active/artifacts/run-vm-web:0/content", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "artifact run-vm-web:0 was not ready on host-eu-1" },
    });
  });

  const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
  await recap.getByRole("button", { name: "Watch replay" }).click();
  await expect(
    recap.getByText("Replay could not be loaded. Try again soon.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(recap).not.toContainText("host-eu-1");
  await expect(recap).not.toContainText("run-vm-web:0");
  await expect(recap.getByText("Transcript", { exact: true })).toHaveCount(0);
  await expect(recap.getByText("Command log", { exact: true })).toHaveCount(0);
});

test("My runs moves cleanup into history without a completion toast", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("runs"),
    theme: "light",
    runState: "ending",
  });

  await expect(
    page.getByRole("heading", { name: "Finishing in background" }),
  ).toBeVisible();
  const listRequestsBefore = ui.server.requests.filter(
    (request) => request === "GET /api/scenarios/runs",
  ).length;

  ui.server.setRunState("archived");
  await expect
    .poll(
      () =>
        ui.server.requests.filter(
          (request) => request === "GET /api/scenarios/runs",
        ).length,
    )
    .toBeGreaterThan(listRequestsBefore);
  await expect(
    page.getByRole("heading", { name: "Finishing in background" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Run saved/i })).toHaveCount(0);
});

test("foreground-to-settled polling updates persistent history without a toast", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("runs"),
    theme: "light",
    runState: "running",
  });

  await expect(
    page.getByRole("heading", { name: "Active work" }),
  ).toBeVisible();
  const listRequestsBefore = ui.server.requests.filter(
    (request) => request === "GET /api/scenarios/runs",
  ).length;
  ui.server.setRunState("archived");

  await expect
    .poll(
      () =>
        ui.server.requests.filter(
          (request) => request === "GET /api/scenarios/runs",
        ).length,
    )
    .toBeGreaterThan(listRequestsBefore);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByRole("region", { name: /Run saved/i })).toHaveCount(0);
});
