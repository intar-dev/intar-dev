import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/test";

test.setTimeout(120_000);

type DeferredModule = "terminal" | "nativeSsh" | "artifactViewer";

const DEFERRED_MODULE_PATHS: Record<DeferredModule, string> = {
  terminal: "/src/components/remote-access/WebSshTerminal.tsx",
  nativeSsh: "/src/components/remote-access/NativeSshDialogButton.tsx",
  artifactViewer: "/src/components/app/RunArtifactViewer.tsx",
};

function deferredModuleRequests(page: Page) {
  const requests = new Map<DeferredModule, string[]>(
    (Object.keys(DEFERRED_MODULE_PATHS) as DeferredModule[]).map((key) => [
      key,
      [],
    ]),
  );
  const onRequest = (request: Request) => {
    const url = request.url();
    for (const [key, pathname] of Object.entries(DEFERRED_MODULE_PATHS) as [
      DeferredModule,
      string,
    ][]) {
      if (url.includes(pathname)) requests.get(key)?.push(url);
    }
  };
  page.on("request", onRequest);

  return {
    count(key: DeferredModule) {
      return requests.get(key)?.length ?? 0;
    },
    dispose() {
      page.off("request", onRequest);
    },
  };
}

function requestCount(requests: readonly string[], signature: string) {
  return requests.filter((request) => request === signature).length;
}

function archiveCard(page: Page) {
  return page.locator("article").filter({ hasText: "repair-nginx-web-5c91" });
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object",
      )
    : [];
}

function addRichArchivePage(state: { hostRuns: Record<string, unknown> }) {
  const [template] = records(state.hostRuns.archivedRuns);
  if (!template) throw new Error("archive fixture is missing its rich run");

  state.hostRuns.archivedRuns = Array.from({ length: 9 }, (_, index) => {
    const run = structuredClone(template);
    if (index === 0) return run;
    run.id = `run-archived-${index + 1}`;
    run.vmName = `repair-nginx-web-archive-${index + 1}`;
    run.events = records(run.events).map((event, eventIndex) => ({
      ...event,
      id: `event-${index + 1}-${eventIndex + 1}`,
    }));
    run.artifacts = records(run.artifacts).map((artifact, artifactIndex) => ({
      ...artifact,
      id: `artifact-${index + 1}-${artifactIndex + 1}`,
    }));
    return run;
  });
}

function sidebarLink(page: Page, label: string) {
  return page
    .locator('a[data-sidebar="menu-button"]')
    .filter({ hasText: label });
}

test("courses share one bootstrap request and the sidebar uses its bounded summary", async ({
  page,
  ui,
}) => {
  await ui.open({
    path: "/courses",
    sessionRole: "learner",
    theme: "light",
  });

  expect(requestCount(ui.server.requests, "GET /api/app/bootstrap")).toBe(1);
  expect(ui.server.requests).not.toContain("GET /api/auth/get-session");
  expect(ui.server.requests).not.toContain(
    "GET /api/access-invites/current",
  );
  await expect(
    page.getByRole("link", { name: /My runs.*1 ongoing run/i }),
  ).toBeVisible();
  expect(
    requestCount(ui.server.requests, "GET /api/scenarios/runs/summary"),
  ).toBeGreaterThan(0);
});

test("the sidebar does not fetch the full run archive just to draw its badge", async ({
  ui,
}) => {
  await ui.open({
    path: "/workshops",
    sessionRole: "learner",
    theme: "light",
  });

  expect(
    requestCount(ui.server.requests, "GET /api/scenarios/runs/summary"),
  ).toBeGreaterThan(0);
  expect(ui.server.requests).not.toContain("GET /api/scenarios/runs");
});

test("admin uses a separate bounded archive API and keeps collapsed details out of the DOM", async ({
  page,
  ui,
}) => {
  await ui.open({ path: "/admin", sessionRole: "global-admin", theme: "light" });
  addRichArchivePage(ui.server.state);
  expect(records(ui.server.state.hostRuns.archivedRuns)).toHaveLength(9);
  ui.server.requests.length = 0;
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  expect(
    requestCount(ui.server.requests, "GET /api/admin/fleet-snapshot"),
  ).toBeGreaterThan(0);
  expect(requestCount(ui.server.requests, "GET /api/admin/runs")).toBe(1);
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect
    .poll(() => requestCount(ui.server.requests, "GET /api/admin/runs"))
    .toBe(2);
  expect(
    ui.server.requests.filter((request) =>
      request.startsWith("GET /api/agent/hosts"),
    ),
  ).toEqual([]);

  const archiveCards = page.locator("[data-archive-run]");
  await expect(page.getByText("9 retained", { exact: true })).toBeVisible();
  await expect(archiveCards).toHaveCount(6);
  await expect(page.getByText("Milestones", { exact: true })).toHaveCount(0);
  await expect(page.getByText("run.log", { exact: true })).toHaveCount(0);
  // Search and outcome controls add a small fixed cost; archive detail trees
  // must still remain outside this bounded collapsed DOM.
  expect(await page.locator("*").count()).toBeLessThan(550);

  const card = archiveCard(page);
  await expect(card).toHaveCount(1);
  await expect(card.getByText("@minalearns", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Details" }).click();
  await expect(card.getByText("Milestones", { exact: true })).toBeVisible();
  expect(
    requestCount(
      ui.server.requests,
      "GET /api/admin/runs/run-archived",
    ),
  ).toBe(1);
});

test("the Hosts page does not fetch the global run archive", async ({ ui }) => {
  await ui.open({
    path: "/admin/hosts",
    sessionRole: "global-admin",
    theme: "light",
  });

  expect(ui.server.requests).not.toContain("GET /api/admin/runs");
  expect(
    requestCount(ui.server.requests, "GET /api/admin/fleet-snapshot"),
  ).toBeGreaterThan(0);
});

test("dashboard fetches the browser terminal module only after Web SSH opens", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/admin",
      sessionRole: "global-admin",
      theme: "light",
    });
    expect(modules.count("terminal")).toBe(0);

    await page.getByRole("button", { name: "Open Web SSH" }).click();
    await expect.poll(() => modules.count("terminal")).toBeGreaterThan(0);
  } finally {
    modules.dispose();
  }
});

test("dashboard fetches the native SSH module only after its dialog opens", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/admin",
      sessionRole: "global-admin",
      theme: "light",
    });
    expect(modules.count("nativeSsh")).toBe(0);

    await page.getByRole("button", { name: "Native SSH" }).click();
    await expect.poll(() => modules.count("nativeSsh")).toBeGreaterThan(0);
  } finally {
    modules.dispose();
  }
});

test("workshop remote-access modules stay deferred until a workshop control opens them", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/workshops/workshop-live",
      sessionRole: "learner",
      theme: "light",
    });
    expect(modules.count("terminal")).toBe(0);
    expect(modules.count("nativeSsh")).toBe(0);

    await page.getByRole("button", { name: "Open terminal" }).click();
    await expect.poll(() => modules.count("terminal")).toBeGreaterThan(0);
  } finally {
    modules.dispose();
  }
});

test("run workspace only fetches the terminal after live status makes a VM ready", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/runs/run-active",
      sessionRole: "learner",
      runState: "booting",
      theme: "light",
    });
    await expect(page.locator("[data-run-workspace]")).toBeVisible();
    expect(modules.count("terminal")).toBe(0);

    ui.server.setRunState("running");
    await expect.poll(() => modules.count("terminal")).toBeGreaterThan(0);
  } finally {
    modules.dispose();
  }
});

test("dashboard fetches the artifact viewer only after an artifact is selected", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/admin",
      sessionRole: "global-admin",
      theme: "light",
    });
    expect(modules.count("artifactViewer")).toBe(0);

    const card = archiveCard(page);
    await card.getByRole("button", { name: "Details" }).click();
    await expect(card.getByText("Milestones", { exact: true })).toBeVisible();
    expect(modules.count("artifactViewer")).toBe(0);

    await card.locator("button").filter({ hasText: "run.log" }).click();
    await expect.poll(() => modules.count("artifactViewer")).toBeGreaterThan(0);
    expect(ui.server.requests).toContain(
      "GET /api/admin/runs/run-archived/artifacts/artifact-log-1/content",
    );
  } finally {
    modules.dispose();
  }
});

test("settled run fetches the replay viewer only after Watch replay opens", async ({
  page,
  ui,
}) => {
  const modules = deferredModuleRequests(page);
  try {
    await ui.open({
      path: "/runs/run-active",
      sessionRole: "learner",
      runState: "replay",
      theme: "light",
    });

    // A settled run returns to the ordinary app shell. Only the foreground
    // terminal workspace may take over the viewport.
    await expect(page.locator("[data-run-page]")).toHaveCount(0);
    await expect(page.locator("[data-slot='sidebar']")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toBeVisible();

    const recap = page.locator('section[aria-labelledby="run-recap-heading"]');
    await expect(recap.getByRole("button", { name: "Watch replay" })).toBeVisible();
    expect(modules.count("artifactViewer")).toBe(0);

    await recap.getByRole("button", { name: "Watch replay" }).click();
    await expect.poll(() => modules.count("artifactViewer")).toBeGreaterThan(0);
    await expect(recap.locator("[data-run-recap-replay-surface]")).toBeVisible();
  } finally {
    modules.dispose();
  }
});

const TIMING_ROUTES = [
  {
    id: "courses",
    path: "/courses",
    sessionRole: "learner",
  },
  {
    id: "admin",
    path: "/admin",
    sessionRole: "global-admin",
  },
  {
    id: "run-active",
    path: "/runs/run-active",
    sessionRole: "learner",
    runState: "booting",
  },
  {
    id: "workshop-live",
    path: "/workshops/workshop-live",
    sessionRole: "learner",
  },
] as const;

type TimingSample = {
  coldMs: number;
  warmMs: number[];
  warmMedianMs: number;
  warmWorstMs: number;
};

function median(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function waitForRouteContent(
  page: Page,
  route: (typeof TIMING_ROUTES)[number],
) {
  if (route.id === "courses") {
    await expect(
      page.getByRole("textbox", { name: "Search courses and scenarios" }),
    ).toBeVisible();
    return;
  }
  if (route.id === "admin") {
    await expect(
      page.getByText("Operational ledger", { exact: true }),
    ).toBeVisible();
    await expect(archiveCard(page)).toHaveCount(1);
    return;
  }
  if (route.id === "run-active") {
    await expect(page.locator("[data-run-workspace]")).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("button", { name: "Open terminal" }),
  ).toBeVisible();
}

async function prepareWarmNavigation(
  page: Page,
  route: (typeof TIMING_ROUTES)[number],
) {
  if (route.id === "courses") {
    await sidebarLink(page, "Workshops").click();
    await expect(
      page.getByRole("link", { name: /Platform Engineering · July cohort/i }),
    ).toBeVisible();
    return;
  }
  if (route.id === "admin") {
    await sidebarLink(page, "Courses").click();
    await expect(
      page.getByRole("textbox", { name: "Search courses and scenarios" }),
    ).toBeVisible();
    return;
  }
  if (route.id === "run-active") {
    await page.getByRole("link", { name: "Back to My runs" }).click();
    await expect(
      page.getByRole("heading", { name: "Active work" }),
    ).toBeVisible();
    return;
  }
  await sidebarLink(page, "Workshops").click();
  await expect(
    page.getByRole("link", { name: /Platform Engineering · July cohort/i }),
  ).toBeVisible();
}

async function activateWarmRoute(
  page: Page,
  route: (typeof TIMING_ROUTES)[number],
) {
  if (route.id === "courses") {
    await sidebarLink(page, "Courses").click();
    return;
  }
  if (route.id === "admin") {
    await sidebarLink(page, "Overview").click();
    return;
  }
  if (route.id === "run-active") {
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    return;
  }
  await page
    .getByRole("link", { name: /Platform Engineering · July cohort/i })
    .click();
}

test("records warm navigation timings for the main app routes", async ({
  page,
  ui,
}, testInfo) => {
  const timings: Record<string, TimingSample> = {};

  for (const route of TIMING_ROUTES) {
    ui.configure({
      sessionRole: route.sessionRole,
      ...("runState" in route ? { runState: route.runState } : {}),
    });
    const coldStartedAt = performance.now();
    await page.goto(route.path, { waitUntil: "domcontentloaded" });
    await waitForRouteContent(page, route);
    const coldMs = performance.now() - coldStartedAt;
    const warmMs: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      await prepareWarmNavigation(page, route);
      const warmStartedAt = performance.now();
      await activateWarmRoute(page, route);
      await waitForRouteContent(page, route);
      warmMs.push(performance.now() - warmStartedAt);
    }
    timings[route.id] = {
      coldMs,
      warmMs,
      warmMedianMs: median(warmMs),
      warmWorstMs: Math.max(...warmMs),
    };
  }

  await testInfo.attach("warm-route-timings", {
    body: Buffer.from(JSON.stringify(timings, null, 2)),
    contentType: "application/json",
  });

  if (process.env.CI_UI_PERF_ASSERT === "1") {
    for (const [route, timing] of Object.entries(timings)) {
      expect(
        timing.warmMedianMs,
        `${route} warm content median exceeded 300ms`,
      ).toBeLessThan(300);
    }
    expect(
      timings.courses!.coldMs,
      "courses cold content exceeded 1000ms",
    ).toBeLessThan(1_000);
    expect(
      timings.admin!.coldMs,
      "admin cold content exceeded 1200ms",
    ).toBeLessThan(1_200);
  }
});
