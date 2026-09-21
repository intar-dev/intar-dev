import type { Page } from "@playwright/test";
import type { MyServersResponse } from "../../src/components/app/pages/MyServers";
import { FIXED_NOW } from "./fixtures/data";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

const api = "/api/organizations/org-platform/servers";
const token = "organization-enrollment-secret";
const server = (id = "shared-host"): MyServersResponse["servers"][number] => ({
  id,
  name: id,
  status: "ready",
  message: "Ready for organization runs.",
  repairAction: null,
  connected: true,
  createdAt: FIXED_NOW - 86_400_000,
  lastSeenAt: FIXED_NOW - 15_000,
  capacity: { total: 8, available: 6 },
  activeRuns: 1,
});
const serverData = (
  overrides: Partial<MyServersResponse> = {},
): MyServersResponse => ({
  placement: "organization",
  registrationOpen: true,
  installerCommand: "curl -fsSL https://intar.dev/install.sh | sudo sh",
  servers: [server()],
  enrollments: [],
  ...overrides,
});
const section = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "Organization servers",
      exact: true,
    }),
  });
const organizationRoute = (role: "owner" | "admin" | "member" = "owner") => ({
  ...routeCase("organization-detail"),
  path: "/organizations/org-platform?tab=servers",
  organizationRole: role,
});

async function mockServers(page: Page, data: MyServersResponse) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route(`**${api}{,/**}`, async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    requests.push({ method, path, body });
    if (method === "GET" && path === api) {
      await route.fulfill({ json: data });
    } else if (method === "POST" && path === `${api}/enrollments`) {
      data.enrollments.push({
        id: "new-host",
        name: body.name,
        expiresAt: FIXED_NOW + 60_000,
      });
      await route.fulfill({
        status: 201,
        json: {
          hostId: "new-host",
          enrollmentToken: token,
          expiresAt: FIXED_NOW + 60_000,
        },
      });
    } else if (method === "DELETE" && path === `${api}/enrollments/new-host`) {
      data.enrollments = [];
      await route.fulfill({ json: { canceled: true } });
    } else if (method === "PATCH") {
      const host = data.servers.find((item) => path === `${api}/${item.id}`);
      if (!host) throw new Error(`Unknown server ${path}`);
      if (body.name) host.name = body.name;
      if (typeof body.paused === "boolean")
        host.status = body.paused ? "paused" : "ready";
      await route.fulfill({ json: { updated: true } });
    } else if (
      method === "DELETE" &&
      data.servers.some((item) => path === `${api}/${item.id}`)
    ) {
      if (data.servers.length === 1)
        expect(body.confirmReturnToCloud).toBe(true);
      data.servers = data.servers.filter(
        (item) => path !== `${api}/${item.id}`,
      );
      if (!data.servers.length) data.placement = "platform";
      await route.fulfill({
        status: 202,
        json: {
          removed: true,
          placement: data.placement,
          physicalCleanup: "unconfirmed",
        },
      });
    } else throw new Error(`Unexpected request ${method} ${path}`);
  });
  return requests;
}

for (const role of ["owner", "admin"] as const) {
  test(`${role} can enroll, cancel, rename, pause, resume, and remove shared servers`, async ({
    page,
    ui,
  }) => {
    const requests = await mockServers(page, serverData());
    await ui.open(organizationRoute(role));
    await expect(
      page.getByRole("tab", { name: "Servers", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await section(page)
      .getByRole("button", { name: "Add server", exact: true })
      .click();
    await expect(
      section(page).getByRole("heading", {
        name: "Add an organization server",
      }),
    ).toBeVisible();
    await page
      .getByLabel("Server name", { exact: true })
      .fill("  Team server  ");
    await page
      .getByRole("button", { name: "Create token", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Reveal token" }),
    ).toBeVisible();
    await expect(section(page)).not.toContainText(token);
    await expect(section(page).locator("pre")).not.toContainText(token);
    await page.getByRole("button", { name: "Reveal token" }).click();
    await expect(section(page)).toContainText(token);
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain(token);
    await page.getByRole("button", { name: "Cancel setup" }).click();
    await expect(section(page)).toContainText(
      "Setup canceled. The token has been cleared",
    );
    await expect(section(page)).not.toContainText(token);
    await page.getByRole("button", { name: "Close setup" }).click();
    await section(page)
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    await page
      .getByLabel("New server name", { exact: true })
      .fill("  Team host  ");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(
      section(page).getByRole("heading", { name: "Team host", exact: true }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog");
    for (const action of ["Pause", "Resume"] as const) {
      await section(page)
        .getByRole("button", { name: action, exact: true })
        .click();
      await dialog
        .getByRole("button", { name: `${action} server`, exact: true })
        .click();
      await expect(
        section(page).getByText(action === "Pause" ? "Paused" : "Ready", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await section(page)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Users with personal servers keep using their own servers.",
    );
    await expect(
      dialog.getByRole("button", { name: "Remove server", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await section(page)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Remove server", exact: true })
      .click();
    await expect(section(page)).toContainText(
      "New organization runs use the cloud. Users with personal servers keep using their own servers.",
    );
    await expect(section(page)).toContainText(
      "Cleanup on the server could not be confirmed.",
    );
    expect(requests.filter((item) => item.method !== "GET")).toEqual([
      {
        method: "POST",
        path: `${api}/enrollments`,
        body: { name: "Team server" },
      },
      { method: "DELETE", path: `${api}/enrollments/new-host`, body: null },
      {
        method: "PATCH",
        path: `${api}/shared-host`,
        body: { name: "Team host" },
      },
      { method: "PATCH", path: `${api}/shared-host`, body: { paused: true } },
      { method: "PATCH", path: `${api}/shared-host`, body: { paused: false } },
      {
        method: "DELETE",
        path: `${api}/shared-host`,
        body: { confirmReturnToCloud: true },
      },
    ]);
    expect(
      ui.server.requests.some((item) => item.includes("/api/servers")),
    ).toBe(false);
  });
}

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`members can read all shared server states without controls · ${width} · ${theme}`, async ({
      page,
      ui,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const states = [
        "setting_up",
        "ready",
        "paused",
        "offline",
        "needs_attention",
        "removing",
        "revoked",
      ] as const;
      const requests = await mockServers(
        page,
        serverData({
          servers: states.map((status) => ({
            ...server(status),
            status,
            name: `${status} shared server with a long name for narrow screens`,
            capacity: status === "ready" ? { total: 8, available: 0 } : null,
            connected: status !== "offline",
            message:
              status === "ready"
                ? "The server is full. Wait for a run to finish."
                : "Server status details.",
            repairAction:
              status === "needs_attention"
                ? "Run sudo intar-host doctor on this server."
                : null,
          })),
          enrollments: [
            {
              id: "pending",
              name: "Pending shared server",
              expiresAt: FIXED_NOW + 60_000,
            },
          ],
        }),
      );
      await ui.open({
        ...organizationRoute("member"),
        sessionRole: "organization-member",
        theme,
      });
      await expect(section(page)).toContainText(
        "Shared servers are used only for this organization's runs.",
      );
      await expect(section(page)).toContainText(
        "Users with personal servers always use their own servers.",
      );
      await expect(section(page)).toContainText(
        "If shared servers are offline, paused, or full",
      );
      await expect(section(page)).toContainText(
        "They do not move to the cloud.",
      );
      for (const state of [
        "Setting up",
        "Ready",
        "Paused",
        "Offline",
        "Needs attention",
        "Removal pending",
        "Access revoked",
      ]) {
        await expect(
          section(page).getByText(state, { exact: true }),
        ).toBeVisible();
      }
      await expect(section(page)).toContainText(
        "0 of 8 vCPUs available · Full",
      );
      await expect(section(page)).toContainText("Run sudo intar-host doctor");
      await expect(section(page)).toContainText("Waiting for installation");
      await expect(section(page).getByRole("button")).toHaveCount(0);
      expect(requests.every((item) => item.method === "GET")).toBe(true);
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, testInfo);
      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`organization-servers-${width}-${theme}.png`),
      });
    });
  }
}

test("first ready server activates organization placement and clears the enrollment token", async ({
  page,
  ui,
}) => {
  const data = serverData({ placement: "platform", servers: [] });
  await mockServers(page, data);
  await ui.open(organizationRoute());
  await page.clock.install({ time: FIXED_NOW });
  await expect(section(page)).toContainText(
    "Organization runs use the cloud unless the user has personal servers.",
  );
  await expect(section(page)).toContainText(
    "When the first shared server is Ready",
  );
  await section(page)
    .getByRole("button", { name: "Add server", exact: true })
    .click();
  await page.getByLabel("Server name", { exact: true }).fill("Team host");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reveal token" }),
  ).toBeVisible();
  data.placement = "organization";
  data.servers = [server("new-host")];
  data.enrollments = [];
  await page.clock.fastForward(15_001);
  await expect(section(page)).toContainText(
    "Organization runs use shared servers unless the user has personal servers.",
  );
  await expect(section(page)).toContainText(
    "Server connected. The token has been cleared",
  );
  await expect(page.getByRole("button", { name: "Reveal token" })).toHaveCount(
    0,
  );
});

test("removal keeps shared placement until the last server and handles concurrent removal", async ({
  page,
  ui,
}) => {
  const data = serverData({
    servers: [server(), server("spare"), server("third")],
  });
  const requests = await mockServers(page, data);
  await ui.open(organizationRoute());
  const dialog = page.getByRole("dialog");
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog).toContainText(
    "New organization runs will still use the other shared servers.",
  );
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(section(page)).toContainText(
    "Organization runs still use shared servers unless the user has personal servers.",
  );
  expect(requests.find((item) => item.method === "DELETE")?.body).toEqual({
    confirmReturnToCloud: false,
  });
  let conflict = true;
  await page.route(`**${api}/spare`, async (route) => {
    if (route.request().method() === "DELETE" && conflict) {
      conflict = false;
      data.servers = [server("spare")];
      ui.server.expectedNativeSshNoProfileConflicts += 1;
      await route.fulfill({
        status: 409,
        json: {
          code: "last_server_confirmation_required",
          error: "Confirm removal to use the cloud for new organization runs.",
        },
      });
    } else await route.fallback();
  });
  await section(page)
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(dialog.getByRole("checkbox")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Remove server", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Remove server", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(section(page)).toContainText(
    "Organization runs use the cloud unless the user has personal servers.",
  );
});

test("closed registration and a failed load keep retry available to members", async ({
  page,
  ui,
}) => {
  await mockServers(
    page,
    serverData({ placement: "platform", servers: [], registrationOpen: false }),
  );
  let fail = true;
  await page.route(`**${api}`, async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: "Service unavailable." },
      });
    else await route.fallback();
  });
  await page.route("**/api/organizations/org-platform", (route) =>
    route.fulfill({
      json: { organization: ui.server.state.organizationDetail },
    }),
  );
  await ui.open({ ...organizationRoute("member"), variant: "error" });
  await expect(section(page).getByRole("alert")).toContainText(
    "Could not refresh servers.",
  );
  fail = false;
  await section(page).getByRole("button", { name: "Try again" }).click();
  await expect(section(page)).toContainText(
    "No organization servers connected yet.",
  );
  await expect(section(page)).toContainText(
    "New server registration is not available yet.",
  );
  await expect(section(page).getByRole("button")).toHaveCount(0);
});

test("personal and organization server caches stay separate across navigation", async ({
  page,
  ui,
}) => {
  const requests = await mockServers(page, serverData());
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: serverData({
        placement: "personal",
        servers: [{ ...server("personal"), name: "My home server" }],
      }),
    }),
  );
  await ui.open(organizationRoute());
  await page
    .getByRole("button", {
      name: "owenowns owenowns@example.test",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
  const personal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "My servers", exact: true }),
  });
  await expect(personal).toContainText("My home server");
  await expect(personal).toContainText("Your runs use your personal servers.");
  await expect(personal).not.toContainText("shared-host");
  await page.goBack();
  await expect(section(page)).toContainText("shared-host");
  await expect(section(page)).not.toContainText("My home server");
  expect(requests.every((item) => item.method === "GET")).toBe(true);
});

test("switching organizations clears the enrollment token and uses the new organization endpoint", async ({
  page,
  ui,
}) => {
  await mockServers(page, serverData());
  const otherApi = "/api/organizations/org-other/servers";
  const otherRequests: string[] = [];
  await page.route("**/api/organizations/org-other", (route) =>
    route.fulfill({
      json: {
        organization: {
          ...ui.server.state.organizationDetail,
          id: "org-other",
          name: "Other organization",
        },
      },
    }),
  );
  await page.route(`**${otherApi}{,/**}`, async (route) => {
    otherRequests.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    await route.fulfill({
      json: serverData({ servers: [server("other-host")] }),
    });
  });
  await ui.open(organizationRoute());
  await section(page)
    .getByRole("button", { name: "Add server", exact: true })
    .click();
  await page.getByLabel("Server name", { exact: true }).fill("Team host");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.getByRole("button", { name: "Reveal token" }).click();
  await expect(section(page)).toContainText(token);
  // Change the route within the mounted app, without a document reload.
  await page.evaluate(() => {
    history.pushState(null, "", "/organizations/org-other?tab=servers");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(section(page)).toContainText("other-host");
  await expect(section(page)).not.toContainText(token);
  await expect(page.getByRole("button", { name: "Reveal token" })).toHaveCount(
    0,
  );
  await section(page)
    .getByRole("button", { name: "Add server", exact: true })
    .click();
  await expect(page.getByLabel("Server name", { exact: true })).toHaveValue("");
  expect(otherRequests).toEqual([`GET ${otherApi}`]);
});
