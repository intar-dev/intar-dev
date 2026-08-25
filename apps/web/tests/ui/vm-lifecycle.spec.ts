import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("startup keeps the workspace useful and replaces milestones with the shell", async ({
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
  await expect(
    page.getByText("Review the work order while the VM starts."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Work order/ })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  const focusTarget = page.getByRole("link", { name: "Courses" }).first();
  await focusTarget.focus();
  ui.server.setRunState("running");

  await expect(page.locator(".xterm")).toBeVisible({ timeout: 1_000 });
  await expect(focusTarget).toBeFocused();
});

test("a solved run gives the learner a concise resolution", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "solved",
  });

  await page
    .getByRole("button", { name: /Objectives.*2\/2 verified/ })
    .click();
  const objectives = page.getByRole("dialog", { name: "Objectives" });
  await expect(objectives.getByText("Resolved", { exact: true })).toBeVisible();
  await expect(
    objectives.getByRole("heading", {
      name: "Repair a broken nginx service",
    }),
  ).toBeVisible();
  await expect(
    objectives.getByText(
      "All objectives are verified. Finish the run to save your replay.",
    ),
  ).toBeVisible();
  await expect(objectives.getByText(/repair-nginx/)).toHaveCount(0);
});

test("a healthy single-machine run keeps terminal controls and status concise", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  await expect(
    page.getByRole("button", { name: /Objectives.*0\/2 verified/ }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Machines" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Reconnect terminal/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Maximize/i }),
  ).toHaveCount(0);
  await expect(
    page.getByTitle("Time remaining before this sandbox is torn down"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("status").filter({ hasText: "Running" }),
  ).toHaveCount(1);

  await page
    .getByRole("button", { name: /Objectives.*0\/2 verified/ })
    .click();
  const objectives = page.getByRole("dialog", { name: "Objectives" });
  const progress = objectives.getByRole("region", { name: "Objectives" });
  await expect(progress.getByText("0/2 verified", { exact: true })).toBeVisible();
  await expect(
    progress.getByText("Needs repair", { exact: true }),
  ).toHaveCount(2);
  await expect(
    objectives.getByText(/Verification .*unavailable/i),
  ).toHaveCount(0);
  await expect(
    progress.getByText(/Checking|Retrying|Recheck/),
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

test("end acceptance stays on one timeline through saved replay", async ({
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
  const heading = page.getByRole("heading", { name: "Run timeline" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole("list", { name: "Run timeline" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Shutting down workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preparing terminal recordings" }),
  ).toBeVisible();
  await expect(
    page.getByText("Bring the service back online").first(),
  ).toBeVisible();

  const headingHandle = await heading.elementHandle();
  expect(headingHandle).not.toBeNull();

  ui.server.setRunState("rendering");
  await expect(
    page.getByRole("heading", { name: "Saving run history" }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByRole("heading", { name: "Building terminal session history" }),
  ).toBeVisible();

  ui.server.setRunState("replay");
  await expect(page.getByRole("heading", { name: "Run saved" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    page.getByRole("heading", { name: "Terminal session" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preparing terminal recordings" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Building terminal session history" }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await headingHandle?.evaluate((element) => element.isConnected)).toBe(
    true,
  );

  expect(
    ui.server.requests.some((request) =>
      request.includes("/artifacts/run-vm-web:0/content"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
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
  await expect(page.locator(".run-artifact-player")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(
    ui.server.requests.some((request) =>
      request.includes("/sessions/1/transcript"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect
    .poll(() =>
      ui.server.requests.some((request) =>
        request.includes("/sessions/1/transcript"),
      ),
    )
    .toBe(true);
  await expect(page.locator(".cm-content").last()).toContainText(
    "systemctl status nginx",
  );

  await page.getByRole("button", { name: /Command log/ }).click();
  await expect(
    page.locator("pre").filter({ hasText: "systemctl status nginx" }),
  ).toBeVisible();
});

test("a rejected shutdown stays in the confirmation dialog", async ({
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
  await expect(dialog.getByText("Run could not be ended")).toBeVisible();
  await expect(dialog).toContainText(
    "Workspace shutdown could not be accepted.",
  );
  await expect(page).toHaveURL(/\/runs\/run-active$/);
  await expect(page.getByRole("heading", { name: "Run timeline" })).toHaveCount(
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

test("a saved run gives a course return and its verified next lab", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "archived",
  });

  await expect(
    page.getByRole("link", { name: "Back to Linux operations" }),
  ).toHaveAttribute("href", "/courses/operations");
  await expect(
    page.getByRole("link", {
      name: "Next: Trace an intermittent DNS failure",
    }),
  ).toHaveAttribute("href", "/courses/operations/repair-dns");
  await expect(
    page.locator(
      'section[aria-labelledby="run-timeline-heading"] .text-eyebrow',
    ),
  ).toHaveText("Repair a broken nginx service");
});

test("a saved run without current course context still has a safe exit", async ({
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
  await expect(page.getByRole("link", { name: /^Next:/ })).toHaveCount(0);
});

for (const terminalCase of [
  {
    state: "archived",
    status: "Run saved",
    recording: "No terminal sessions recorded",
  },
  {
    state: "replay-failed",
    status: "Run saved",
    recording: "Replay unavailable",
  },
  {
    state: "failed",
    status: "Run ended with an error",
    recording: "No terminal sessions recorded",
  },
] as const) {
  test(`direct ${terminalCase.state} visits use the final timeline`, async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "dark",
      runState: terminalCase.state,
    });

    await expect(
      page.getByRole("heading", { name: "Run timeline" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: terminalCase.status }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: terminalCase.recording }),
    ).toBeVisible();
    await expect(
      page.locator('ol[aria-label="Run timeline"] li[aria-current="step"]'),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("replay, transcript, and command failures stay inline", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "replay",
  });
  await page.route("**/artifacts/run-vm-web:0/content", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "Fixture replay failure" },
    });
  });
  await page.route("**/sessions/1/transcript", async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "Fixture transcript failure" },
    });
  });
  ui.server.state.variant = "error";

  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByText(/Replay could not be loaded/)).toContainText(
    "Fixture replay failure",
  );
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByText(/Transcript could not be loaded/)).toContainText(
    "Fixture transcript failure",
  );
  await page.getByRole("button", { name: /Command log/ }).click();
  await expect(page.getByText(/Command log could not be loaded/)).toContainText(
    "Fixture replay failure",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
