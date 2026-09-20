import type { Page } from "@playwright/test";
import type { MyServersResponse } from "../../src/components/app/pages/MyServers";
import { FIXED_NOW } from "./fixtures/data";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

const installerCommand = "curl -fsSL https://intar.dev/install.sh | sudo sh";
const enrollmentToken = "test-only-secret-enrollment-token";
function makeServer(
  overrides: Partial<MyServersResponse["servers"][number]> = {},
): MyServersResponse["servers"][number] {
  return {
    id: "home-server",
    name: "Home server",
    status: "ready",
    message: "Ready for your runs.",
    repairAction: null,
    connected: true,
    createdAt: FIXED_NOW - 86_400_000,
    lastSeenAt: FIXED_NOW - 15_000,
    capacity: { total: 8, available: 6 },
    activeRuns: 1,
    ...overrides,
  };
}
function serverData(
  overrides: Partial<MyServersResponse> = {},
): MyServersResponse {
  return {
    placement: "personal",
    registrationOpen: true,
    installerCommand,
    servers: [makeServer()],
    enrollments: [],
    ...overrides,
  };
}
async function mockServers(
  page: Page,
  data: MyServersResponse,
  cleanup: "confirmed" | "unconfirmed" = "confirmed",
) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/servers{,/**}", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as {
      name?: string;
      paused?: boolean;
      confirmReturnToCloud?: boolean;
    } | null;
    requests.push({ method, path, body });
    if (method === "GET" && path === "/api/servers") {
      await route.fulfill({ json: data });
    } else if (method === "POST" && path === "/api/servers/enrollments") {
      data.enrollments.push({
        id: "enrolled-server",
        name: body?.name ?? "",
        expiresAt: FIXED_NOW + 60_000,
      });
      await route.fulfill({
        status: 201,
        json: {
          hostId: "enrolled-server",
          enrollmentToken,
          expiresAt: FIXED_NOW + 60_000,
        },
      });
    } else if (method === "PATCH") {
      const server = data.servers.find(
        (entry) => path === `/api/servers/${entry.id}`,
      );
      if (!server) throw new Error(`Unknown server: ${path}`);
      if (body?.name) server.name = body.name;
      if (typeof body?.paused === "boolean")
        server.status = body.paused ? "paused" : "ready";
      await route.fulfill({ json: { updated: true } });
    } else if (method === "DELETE" && path.includes("/enrollments/")) {
      data.enrollments = data.enrollments.filter(
        (entry) => path !== `/api/servers/enrollments/${entry.id}`,
      );
      await route.fulfill({ json: { canceled: true } });
    } else if (method === "DELETE") {
      data.servers = data.servers.filter(
        (server) => path !== `/api/servers/${server.id}`,
      );
      if (!data.servers.length) data.placement = "platform";
      await route.fulfill({
        status: cleanup === "unconfirmed" ? 202 : 200,
        json: {
          removed: true,
          placement: data.placement,
          physicalCleanup: cleanup,
        },
      });
    } else throw new Error(`Unhandled server request: ${method} ${path}`);
  });
  return requests;
}
function section(page: Page) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: "My servers", exact: true }),
  });
}
async function createToken(page: Page) {
  await section(page)
    .getByRole("button", { name: "Add server", exact: true })
    .click();
  await page.getByLabel("Server name", { exact: true }).fill("Home server");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reveal token" }),
  ).toBeVisible();
}

test("profile shows cloud placement and a closed registration gate", async ({
  page,
  ui,
}) => {
  await mockServers(
    page,
    serverData({ placement: "platform", servers: [], registrationOpen: false }),
  );
  await ui.open(routeCase("profile"));
  await expect(section(page)).toContainText("Your runs use the cloud.");
  await expect(section(page)).toContainText(
    "When your first server is Ready, all new runs use your servers.",
  );
  await expect(section(page)).toContainText("including organization courses");
  await expect(section(page)).toContainText(
    "No personal servers connected yet.",
  );
  await expect(section(page)).toContainText(
    "New server registration is not available yet.",
  );
  await expect(
    section(page).getByRole("button", { name: "Add server" }),
  ).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`server states and repairs · ${viewport.width} · ${theme}`, async ({
      page,
      ui,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const states = [
        "setting_up",
        "ready",
        "paused",
        "offline",
        "needs_attention",
      ] as const;
      await mockServers(
        page,
        serverData({
          servers: states.map((status, index) =>
            makeServer({
              id: `server-${index}`,
              name: `${status} server with a long name to check narrow screens`,
              status,
              message:
                status === "ready"
                  ? "The server is full. Wait for a run to finish."
                  : "Server status details.",
              repairAction:
                status === "needs_attention"
                  ? "Run sudo intar-host doctor on this server."
                  : null,
              connected: status !== "offline",
              capacity: status === "ready" ? { total: 8, available: 0 } : null,
              lastSeenAt: status === "setting_up" ? null : FIXED_NOW - 15_000,
            }),
          ),
        }),
      );
      await ui.open({ ...routeCase("profile"), theme });
      const servers = section(page);
      for (const status of [
        "Setting up",
        "Ready",
        "Paused",
        "Offline",
        "Needs attention",
      ]) {
        await expect(servers.getByText(status, { exact: true })).toBeVisible();
      }
      await expect(servers).toContainText(
        "Runs stay on your personal servers. They do not move to the cloud.",
      );
      await expect(servers).toContainText("0 of 8 vCPUs available · Full");
      await expect(servers).toContainText(
        "Next step: Run sudo intar-host doctor on this server.",
      );
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, testInfo);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`servers-${viewport.width}-${theme}.png`),
      });
    });
  }
}

test("enrollment keeps secrets out of storage and the command, supports reveal and copy, and clears on close", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(
    page,
    serverData({ placement: "platform", servers: [] }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string[] }).copied.push(value);
        },
      },
    });
    (window as unknown as { copied: string[] }).copied = [];
  });
  await ui.open(routeCase("profile"));
  await createToken(page);
  await expect(section(page)).toContainText(
    "Ubuntu 24.04 (x86_64) with KVM. At least 2 logical CPUs and 4 GiB RAM.",
  );
  await expect(section(page)).toContainText("110 GiB free to create its own 100 GiB storage file");
  await expect(section(page)).toContainText(
    "If you lost an unused token, cancel its pending setup",
  );
  expect(requests.find((request) => request.method === "POST")?.body).toEqual({
    name: "Home server",
  });
  await expect(section(page)).not.toContainText(enrollmentToken);
  await expect(section(page).locator("pre")).toHaveText(installerCommand);
  await expect(section(page)).toContainText("Single use. Expires");
  await expect(section(page)).toContainText("Waiting for installation");
  await page.getByRole("button", { name: "Copy installer command" }).click();
  await page.getByRole("button", { name: "Copy token", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { copied: string[] }).copied,
    ),
  ).toEqual([installerCommand, enrollmentToken]);
  await page.getByRole("button", { name: "Reveal token" }).click();
  await expect(section(page)).toContainText(enrollmentToken);
  await page.getByRole("button", { name: "Hide token" }).click();
  await expect(section(page)).not.toContainText(enrollmentToken);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      }),
    ),
  ).not.toContain(enrollmentToken);
  expect(page.url()).not.toContain(enrollmentToken);
  expect(JSON.stringify(requests)).not.toContain(enrollmentToken);
  await page.getByRole("button", { name: "Clear token and close" }).click();
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reveal token" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Create token", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(section(page)).toContainText("Waiting for installation");
  await expect(section(page)).not.toContainText(enrollmentToken);
});

test("token expires while the form is open", async ({ page, ui }) => {
  await mockServers(page, serverData({ placement: "platform", servers: [] }));
  await ui.open(routeCase("profile"));
  await page.clock.install({ time: FIXED_NOW });
  await createToken(page);
  await page.getByRole("button", { name: "Reveal token" }).click();
  await page.clock.fastForward(60_001);
  await expect(section(page)).toContainText(
    "Token expired. Create a new token to continue.",
  );
  await expect(section(page)).not.toContainText(enrollmentToken);
  await expect(
    page.getByRole("button", { name: "Copy token", exact: true }),
  ).toHaveCount(0);
});

test("successful connection clears the token during a refresh", async ({
  page,
  ui,
}) => {
  const data = serverData({ placement: "platform", servers: [] });
  await mockServers(page, data);
  await ui.open(routeCase("profile"));
  await page.clock.install({ time: FIXED_NOW });
  await createToken(page);
  data.placement = "personal";
  data.servers = [makeServer({ id: "enrolled-server" })];
  data.enrollments = [];
  await page.clock.fastForward(15_001);
  await expect(section(page)).toContainText(
    "Server connected. The token has been cleared from this page.",
  );
  await expect(
    page.getByRole("button", { name: "Copy token", exact: true }),
  ).toHaveCount(0);
});

test("cancel setup revokes the pending enrollment and clears its token", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(
    page,
    serverData({ placement: "platform", servers: [] }),
  );
  await ui.open(routeCase("profile"));
  await createToken(page);
  await page.getByRole("button", { name: "Reveal token" }).click();
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(section(page)).toContainText(
    "Setup canceled. The token has been cleared from this page.",
  );
  await expect(section(page)).not.toContainText(enrollmentToken);
  await expect(
    page.getByRole("heading", { name: "Waiting for installation" }),
  ).toHaveCount(0);
  expect(requests.find((request) => request.method === "DELETE")?.path).toBe(
    "/api/servers/enrollments/enrolled-server",
  );
});

test("rename, pause, and resume send only the requested change", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(page, serverData());
  await ui.open(routeCase("profile"));
  await section(page)
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await page
    .getByLabel("New server name", { exact: true })
    .fill("  Lab server  ");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(
    section(page).getByRole("heading", { name: "Lab server" }),
  ).toBeVisible();
  await section(page)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Current runs stay on this server.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(
    1,
  );
  await section(page)
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Pause server" }).click();
  await expect(
    section(page).getByText("Paused", { exact: true }),
  ).toBeVisible();
  await section(page)
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Resume server" }).click();
  await expect(section(page).getByText("Ready", { exact: true })).toBeVisible();
  expect(
    requests
      .filter((request) => request.method === "PATCH")
      .map((request) => request.body),
  ).toEqual([{ name: "Lab server" }, { paused: true }, { paused: false }]);
});

test("last server removal needs explicit cloud consent and reports unconfirmed cleanup", async ({
  page,
  ui,
}, testInfo) => {
  const requests = await mockServers(page, serverData(), "unconfirmed");
  await ui.open(routeCase("profile"));
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Remove Home server?" });
  const remove = dialog.getByRole("button", { name: "Remove server" });
  await expect(remove).toBeDisabled();
  await expect(dialog).toContainText("1 active run on this server.");
  await dialog.getByRole("checkbox").check();
  await expect(remove).toBeEnabled();
  await expectNoAxeViolations(page, testInfo);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(remove).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await remove.click();
  await expect(section(page)).toContainText("Your runs use the cloud.");
  await expect(section(page)).toContainText(
    "Cleanup on the server could not be confirmed.",
  );
  expect(requests.find((request) => request.method === "DELETE")?.body).toEqual(
    { confirmReturnToCloud: true },
  );
});

test("removing one of several servers keeps personal placement", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(
    page,
    serverData({
      servers: [
        makeServer(),
        makeServer({ id: "spare", name: "Spare server" }),
      ],
    }),
  );
  await ui.open(routeCase("profile"));
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog).toContainText(
    "New runs will still use your other personal servers.",
  );
  await dialog.getByRole("button", { name: "Remove server" }).click();
  await expect(section(page)).toContainText(
    "Cleanup on the server is confirmed.",
  );
  await expect(section(page)).toContainText(
    "Your runs use your personal servers.",
  );
  expect(requests.find((request) => request.method === "DELETE")?.body).toEqual(
    { confirmReturnToCloud: false },
  );
});

test("load errors allow retry and failed cleanup keeps the removal panel without polling", async ({
  page,
  ui,
}) => {
  let failing = true;
  const requests = await mockServers(page, serverData());
  await page.route("**/api/servers{,/**}", async (route) => {
    if (failing)
      await route.fulfill({
        status: 503,
        json: { error: "Access revoked. Cleanup is pending. Try again." },
      });
    else await route.fallback();
  });
  await ui.open({ ...routeCase("profile"), variant: "error" });
  await expect(section(page).getByRole("alert")).toContainText(
    "Could not refresh servers.",
  );
  failing = false;
  await section(page).getByRole("button", { name: "Try again" }).click();
  await expect(section(page).getByText("Ready", { exact: true })).toBeVisible();
  await page.clock.install({ time: FIXED_NOW });
  failing = true;
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Remove server" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Cleanup is pending.");
  const reads = requests.filter((request) => request.method === "GET").length;
  failing = false;
  await page.clock.fastForward(45_000);
  expect(requests.filter((request) => request.method === "GET")).toHaveLength(
    reads,
  );
  await expect(dialog).toBeVisible();
  await expect(
    page.locator("h3").filter({ hasText: /^Home server$/ }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Remove server" }).click();
  await expect(dialog).toHaveCount(0);
});

test("polls at 15 seconds only while the profile page is visible and mounted", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(page, serverData());
  await ui.open(routeCase("profile"));
  await page.clock.install({ time: FIXED_NOW });
  const reads = () =>
    requests.filter((request) => request.method === "GET").length;
  const initial = reads();
  await page.clock.fastForward(14_000);
  expect(reads()).toBe(initial);
  await page.clock.fastForward(1_001);
  await expect.poll(reads).toBe(initial + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(45_000);
  expect(reads()).toBe(initial + 1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(reads).toBe(initial + 2);
  await page
    .getByRole("link", { name: "Courses", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(section(page)).toHaveCount(0);
  const afterLeaving = reads();
  await page.clock.fastForward(45_000);
  expect(reads()).toBe(afterLeaving);
});

test("removal can recover when another tab removes the other server", async ({ page, ui }) => {
  const data = serverData({ servers: [makeServer(), makeServer({ id: "second", name: "Second server" })] });
  const requests = await mockServers(page, data);
  let conflict = true;
  await page.route("**/api/servers/home-server", async route => {
    if (route.request().method() === "DELETE" && conflict) {
      conflict = false;
      data.servers = [makeServer()];
      ui.server.expectedNativeSshNoProfileConflicts += 1;
      await route.fulfill({ status: 409, json: {
        code: "last_server_confirmation_required",
        error: "This is your last server. Confirm removal to use cloud for new runs.",
      } });
    } else await route.fallback();
  });
  await ui.open(routeCase("profile"));
  const home = section(page).getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Home server", exact: true }) });
  await home.getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove server", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests.find(request => request.method === "DELETE")?.body).toEqual({ confirmReturnToCloud: true });
});

test("a refreshed page keeps pending removal available for retry", async ({ page, ui }) => {
  const requests = await mockServers(page, serverData({ placement: "platform", servers: [makeServer({
    status: "removing", connected: false, capacity: null,
    message: "Access is revoked. Retry removal to finish closing sessions.",
  })] }), "unconfirmed");
  await ui.open(routeCase("profile"));
  await expect(section(page).getByText("Removal pending", { exact: true })).toBeVisible();
  await expect(section(page).getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
  await section(page).getByRole("button", { name: "Retry removal", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests.find(request => request.method === "DELETE")?.body).toEqual({ confirmReturnToCloud: false });
});

test("the owner can confirm cloud placement after the last server is revoked", async ({ page, ui }) => {
  const requests = await mockServers(page, serverData({ servers: [makeServer({
    status: "revoked", connected: false, capacity: null,
    message: "Server access was revoked. Remove this server, then register it again to use it.",
  })] }), "unconfirmed");
  await ui.open(routeCase("profile"));
  await expect(section(page)).toContainText("Your runs use your personal servers.");
  await expect(section(page).getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await section(page).getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Remove server", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(section(page)).toContainText("All new runs use the cloud.");
  expect(requests.find(request => request.method === "DELETE")?.body).toEqual({ confirmReturnToCloud: true });
});
