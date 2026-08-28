import { expect, test } from "./fixtures/test";
import { FIXED_NOW } from "./fixtures/data";
import { routeCase } from "./routes";

test("public workshop entry keeps sign in focused and sponsors prominent", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });
  await expect(
    page.getByRole("button", { name: /Sign in with GitHub/i }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /Request access/i })
      .or(page.getByRole("button", { name: /Request access/i })),
  ).toHaveCount(0);

  const sponsorRow = page.locator(
    'aside[aria-labelledby="landing-sponsors-heading"]',
  );
  const heading = page.getByRole("heading", { level: 1 });
  await expect(sponsorRow).toBeVisible();
  const hetznerLogo = page
    .getByRole("link", { name: "Hetzner" })
    .locator("img");
  const namespaceLogo = page
    .getByRole("link", { name: "namespace" })
    .locator("img");
  await expect(hetznerLogo).toBeVisible();
  await expect(namespaceLogo).toBeVisible();

  const [sponsorBox, headingBox, hetznerBox, namespaceBox] = await Promise.all([
    sponsorRow.boundingBox(),
    heading.boundingBox(),
    hetznerLogo.boundingBox(),
    namespaceLogo.boundingBox(),
  ]);
  expect(sponsorBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(hetznerBox).not.toBeNull();
  expect(namespaceBox).not.toBeNull();
  expect(sponsorBox!.y).toBeLessThan(headingBox!.y);
  expect(Math.round(hetznerBox!.height)).toBeGreaterThanOrEqual(48);
  expect(Math.round(namespaceBox!.height)).toBeGreaterThanOrEqual(40);
});

for (const viewport of [
  { id: "desktop", width: 1440, height: 900 },
  { id: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`landing ${viewport.id}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("fits without vertical page scrolling", async ({ page, ui }) => {
      await ui.open({ ...routeCase("landing"), theme: "light" });

      const metrics = await page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        return {
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
        };
      });

      expect(
        metrics.scrollHeight - metrics.clientHeight,
        `landing overflow metrics=${JSON.stringify(metrics)}`,
      ).toBeLessThanOrEqual(1);
    });
  });
}

test("beta invite fragment is scrubbed before the claim is inspected", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("join-beta"), theme: "light" });

  expect(new URL(page.url()).hash).toBe("");
  await expect(
    page.getByRole("heading", { name: "Join the intar.dev beta" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    /This single-use link is ready/i,
  );
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  expect(ui.server.requests).toContain("POST /api/access-invites/exchange");
  expect(ui.server.requests).toContain("GET /api/access-invites/current");
  expect(ui.server.requests.join("\n")).not.toContain("intar_beta_");
});

test("admin can copy a new beta link again from the list", async ({
  page,
  ui,
}) => {
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });
    Object.defineProperty(window, "__testClipboardWrites", {
      configurable: true,
      value: writes,
    });
  });
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  await page.getByRole("button", { name: "Create invite" }).click();

  const rawLink = `http://127.0.0.1:4330/join#invite=intar_beta_${"C".repeat(43)}`;
  const inviteRow = page
    .getByRole("row")
    .filter({ hasText: "intar_beta_CCCCCCCC" });
  const listCopyButton = inviteRow.getByRole("button", { name: "Copy" });
  await expect(listCopyButton).toBeVisible();
  await listCopyButton.click();
  await listCopyButton.click();
  await expect(page.getByRole("status")).toHaveText(
    "intar_beta_CCCCCCCC… copied.",
  );
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __testClipboardWrites: string[];
          }
        ).__testClipboardWrites,
    ),
  ).toEqual([rawLink, rawLink]);
  expect(ui.server.requests).toContain("POST /api/admin/access-invites");
  expect(
    ui.server.requests.filter(
      (request) =>
        request ===
        "POST /api/admin/access-invites/invite-created-3/copy",
    ),
  ).toHaveLength(2);
});

test("admin can revoke an active invite into history", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  const inviteRow = page
    .getByRole("row")
    .filter({ hasText: "intar_beta_AAAAAAAA" });

  await inviteRow.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Revoke this invite?",
  });
  await expect(dialog).toContainText("stops working immediately");
  const revokeRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(
        "/api/admin/access-invites/invite-pending/revoke",
      ),
  );
  await dialog.getByRole("button", { name: "Revoke invite" }).click();
  expect((await revokeRequest).postDataJSON()).toEqual({ expectedVersion: 1 });

  await expect(inviteRow).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Invite revoked.");
  await page.locator("details > summary").filter({ hasText: "History" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "intar_beta_AAAAAAAA" }),
  ).toContainText("Revoked");
  expect(ui.server.requests).toContain(
    "POST /api/admin/access-invites/invite-pending/revoke",
  );
});

test("learner discovery filters the catalog", async ({ page, ui }) => {
  await ui.open({ ...routeCase("scenario-catalog"), theme: "light" });
  const search = page.getByLabel(/Search courses and scenarios/i);
  await search.fill("DNS");
  await expect(
    page.getByRole("heading", { name: "Linux operations" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Linux operations" }).click();
  await expect(
    page.getByRole("heading", { name: /Trace an intermittent DNS failure/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Repair a broken nginx service/i }),
  ).toBeHidden();
});

test("scenario briefing is nested beneath its catalog course breadcrumb", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-briefing"), theme: "light" });
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Linux operations" }),
  ).toHaveAttribute("href", "/courses/operations");
  await expect(page).toHaveURL("/courses/operations/repair-nginx");
});

test("learner enters the live workshop and can raise a hand", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("workshops"), theme: "light" });
  await page
    .getByRole("link", { name: /Platform Engineering · July cohort/i })
    .click();
  await expect(page).toHaveURL(/\/workshops\/workshop-live$/);
  await expect(
    page.getByRole("heading", { name: "Talos and Cilium foundations" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Shared slide")).toBeVisible();
  await expect(
    page.getByText(/boot the cluster and prove which layer owns pod networking/i),
  ).toBeVisible();
  await page
    .getByLabel("What are you stuck on?")
    .fill("Cilium reports one failed DNS path.");
  await page.getByRole("button", { name: "Raise hand" }).click();
  await expect(page.getByText("In the queue")).toBeVisible();

  ui.server.state.sshKeys = [];
  await page.getByRole("button", { name: "Native SSH" }).click();
  const nativeSshDialog = page.getByRole("dialog");
  await expect(
    nativeSshDialog.getByRole("heading", {
      name: "Native SSH for platform-workshop",
    }),
  ).toBeVisible();
  await expect(
    nativeSshDialog.getByRole("button", {
      name: "Create temporary SSH key",
    }),
  ).toBeVisible();
  await nativeSshDialog
    .getByRole("button", { name: "Create temporary SSH key" })
    .click();
  await expect(
    nativeSshDialog.getByRole("button", { name: "Download temporary key" }),
  ).toBeVisible();
  await expect(nativeSshDialog.getByLabel("SSH command")).toHaveValue(
    /ssh -i "\$key_path"[\s\S]*workshop-route-test-only-native@stargate\.example\.test/,
  );
  const issuedRequest = ui.server.nativeSshRequests.at(-1);
  expect(issuedRequest?.pathname).toBe(
    "/api/workshops/workshop-live/terminal",
  );
  expect(issuedRequest?.body).toMatchObject({
    mode: "native",
    clientPublicKeyOpenssh: expect.stringMatching(/^ssh-ed25519 /),
  });
  expect(JSON.stringify(issuedRequest?.body)).not.toContain(
    "OPENSSH PRIVATE KEY",
  );
  const issuedPublicKey = issuedRequest?.body.clientPublicKeyOpenssh;

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Native SSH" }).click();
  await expect(
    nativeSshDialog.getByRole("button", { name: "Download temporary key" }),
  ).toBeVisible();
  expect(
    ui.server.nativeSshRequests.at(-1)?.body.clientPublicKeyOpenssh,
  ).toBe(issuedPublicKey);

  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();
  await page.getByRole("button", { name: "Native SSH" }).click();
  await expect(
    nativeSshDialog.getByRole("button", { name: "Download temporary key" }),
  ).toBeVisible();
  expect(
    ui.server.nativeSshRequests.at(-1)?.body.clientPublicKeyOpenssh,
  ).toBe(issuedPublicKey);
});

test("facilitator advances the native presenter deck with the keyboard", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("workshop-presenter"), theme: "dark" });
  await expect(
    page.getByRole("heading", { name: "Talos and Cilium foundations" }),
  ).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("heading", { name: "Gitea and Argo CD" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Release module" }).click();
  await page.getByRole("button", { name: "Focus activity" }).click();
  await page.getByRole("button", { name: "Reveal solution" }).click();
  await page.getByRole("button", { name: "Pause timer" }).click();
  await expect(
    page.getByRole("button", { name: "Resume timer" }),
  ).toBeVisible();
  expect(ui.server.requests).toContain(
    "POST /api/workshops/workshop-live/actions",
  );
});

test("facilitator roster exposes present, stale, and absent state accessibly", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("workshop-control-room"), theme: "light" });

  await expect(page.getByLabel("Mina Learner presence: Present")).toBeVisible();
  await expect(page.getByLabel("Owen Owner presence: Stale")).toBeVisible();
  await expect(
    page.getByLabel("Inez Instructor presence: Absent"),
  ).toBeVisible();
  await expect.poll(() =>
    ui.server.requests.filter(
      (request) =>
        request === "POST /api/workshops/workshop-live/presence",
    ).length,
  ).toBe(1);
});

test("assigned helper opens only the learner-consented browser terminal", async ({
  page,
  ui,
}) => {
  ui.configure({ sessionRole: "instructor" });
  const roster = ui.server.state.workshopSession.roster as Array<
    Record<string, unknown>
  >;
  const learner = roster.find((member) => member.userId === "user-learner");
  if (!learner) throw new Error("workshop learner fixture missing");
  Object.assign(learner, {
    helpState: "claimed",
    helpAssignedToViewer: true,
    assistGrant: {
      id: "assist-mina",
      workspaceId: "workspace-mina",
      expiresAt: Date.now() + 15 * 60 * 1_000,
    },
  });
  await page.goto("/workshops/workshop-live");

  await page.getByRole("button", { name: "Open terminal" }).click();
  const terminalDialog = page.getByRole("dialog");
  await expect(terminalDialog.getByText(/assisting Mina Learner/i)).toBeVisible();
  const terminalStatus = terminalDialog
    .getByRole("status")
    .filter({ hasText: /Terminal status:/i });
  await expect(terminalStatus).toHaveText(/Terminal status:\s*connected/i);

  // Closing the old socket during a manual reconnect must not let its delayed
  // close event overwrite the replacement connection.
  const terminalRequest = "POST /api/workshops/workshop-live/terminal";
  const requestCountBeforeReconnect = ui.server.requests.filter(
    (request) => request === terminalRequest,
  ).length;
  await terminalDialog.getByRole("button", { name: "Reconnect" }).click();
  await expect
    .poll(
      () =>
        ui.server.requests.filter((request) => request === terminalRequest)
          .length,
    )
    .toBe(requestCountBeforeReconnect + 1);
  await expect(terminalStatus).toHaveText(/Terminal status:\s*connected/i);
  await page.waitForTimeout(100);
  await expect(terminalStatus).toHaveText(/Terminal status:\s*connected/i);
  expect(ui.server.requests).toContain(terminalRequest);
});

test("presenter can synchronize the first slide from an empty deck state", async ({
  page,
  ui,
}) => {
  ui.configure({ sessionRole: "instructor" });
  ui.server.state.workshopSession.currentSlideId = null;
  ui.server.state.workshopSession.currentSlideOrdinal = 0;
  await page.goto("/workshops/workshop-live/present");

  const showSlide = page.getByRole("button", { name: "Show slide" });
  await expect(showSlide).toBeVisible();
  await showSlide.click();
  await expect(showSlide).toHaveCount(0);
  expect(ui.server.requests).toContain(
    "POST /api/workshops/workshop-live/actions",
  );
});

test("projector is a chrome-free identity-safe display", async ({ page, ui }) => {
  await ui.open({ ...routeCase("workshop-projector"), theme: "dark" });

  await expect(
    page.getByRole("heading", { name: "Talos and Cilium foundations" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Boot a Talos cluster and prove that Cilium owns pod networking.",
    ),
  ).toBeVisible();
  await expect(page.locator("[data-slot='sidebar']")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-inset']")).toHaveCount(0);
  await expect(page.locator("[data-slot='sidebar-trigger']")).toHaveCount(0);
  await expect(page.getByText("Mina Learner")).toHaveCount(0);
  await expect(page.getByText("minalearns@example.test")).toHaveCount(0);
});

test("organization owner schedules an explicit workshop roster", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-workshops"), theme: "light" });
  await page.getByText("Revision history (3)").click();
  await expect(
    page.getByRole("list", { name: "Platform Engineering Workshop revisions" }),
  ).toContainText("r3");
  await page.getByRole("button", { name: "Schedule" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Schedule a workshop" }),
  ).toBeVisible();
  await dialog
    .getByLabel("Template revision")
    .selectOption("revision-platform-engineering-2");
  await dialog.getByLabel("Role for Mina Learner").selectOption("participant");
  await dialog.getByRole("button", { name: "Schedule workshop" }).click();
  await expect(page).toHaveURL(/\/workshops\/workshop-new$/);
});

test("organization owner edits a versioned draft workshop roster", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-workshops"), theme: "light" });
  await page.getByRole("button", { name: "Edit roster" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Edit the draft roster" }),
  ).toBeVisible();
  await dialog
    .getByLabel("Role for Inez Instructor")
    .selectOption("participant");
  await dialog.getByLabel("Role for Mina Learner").selectOption("helper");
  await dialog.getByRole("button", { name: "Save roster" }).click();
  await expect(dialog).toHaveCount(0);
  expect(ui.server.requests).toContain(
    "POST /api/workshops/workshop-upcoming/actions",
  );
});

test("organization owner creates and revokes a workshop publisher token", async ({
  page,
  ui,
}) => {
  const token = `intar_ws_${"d".repeat(64)}`;
  const tokenPrefix = token.slice(0, "intar_ws_".length + 10);

  await ui.open({ ...routeCase("organization-workshops"), theme: "light" });
  await expect(
    page.getByRole("heading", { name: "Publisher access" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create publisher token" })
    .click();

  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Token name").fill("Pilot publisher");
  await createDialog.getByLabel("Expires after").selectOption("30");
  await createDialog
    .getByRole("button", { name: "Create publisher token" })
    .click();

  await expect(
    createDialog.getByRole("heading", { name: "Copy this token now" }),
  ).toBeVisible();
  await expect(createDialog.getByText(token, { exact: true })).toBeVisible();
  await expect(
    createDialog.getByRole("button", { name: "Copy token" }),
  ).toBeVisible();
  await createDialog
    .getByRole("button", { name: "I have stored it" })
    .click();

  await expect(page.getByText(token, { exact: true })).toHaveCount(0);
  await expect(page.getByText(tokenPrefix, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();

  const revokeDialog = page.getByRole("dialog");
  await expect(
    revokeDialog.getByRole("heading", { name: "Revoke publisher token" }),
  ).toBeVisible();
  await revokeDialog.getByRole("button", { name: "Revoke token" }).click();
  await expect(revokeDialog).toHaveCount(0);

  expect(ui.server.requests).toContain(
    "POST /api/organizations/org-platform/workshops/tokens",
  );
  expect(ui.server.requests).toContain(
    "DELETE /api/organizations/org-platform/workshops/tokens/workshop-registry-token-created",
  );
});

test("organization admins cannot see or request workshop publisher tokens", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("organization-workshops"),
    organizationRole: "admin",
    theme: "light",
  });

  await expect(
    page.getByRole("heading", { name: "Publisher access" }),
  ).toHaveCount(0);
  expect(
    ui.server.requests.some((request) =>
      request.includes("/workshops/tokens"),
    ),
  ).toBe(false);
});

test("workshop publisher token status updates at its expiry", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-workshops"), theme: "light" });
  ui.server.state.workshopRegistryTokens = [
    {
      id: "workshop-registry-token-expiring",
      name: "Expiry test",
      tokenPrefix: "intar_ws_1234567890",
      lastUsedAt: null,
      expiresAt: FIXED_NOW + 1_000,
      revokedAt: null,
      createdAt: FIXED_NOW,
    },
  ];

  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  const tokenCard = page.getByRole("article").filter({ hasText: "Expiry test" });
  await expect(tokenCard.getByText("Active", { exact: true })).toBeVisible();
  await page.clock.setFixedTime(FIXED_NOW + 1_100);
  await page.clock.fastForward(1_100);
  await expect(tokenCard.getByText("Expired", { exact: true })).toBeVisible();
  await expect(
    tokenCard.getByRole("button", { name: "Revoke", exact: true }),
  ).toHaveCount(0);
});

test("workshop list teaches empty and recovery states", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("workshops"),
    theme: "light",
    variant: "empty",
  });
  await expect(
    page.getByRole("heading", { name: "No workshop sessions yet" }),
  ).toBeVisible();

  await ui.open({
    ...routeCase("workshops"),
    theme: "light",
    variant: "error",
  });
  await expect(
    page.getByRole("heading", { name: "Could not load workshops" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("run workspace opens a deterministic terminal transport", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });
  const workspaceHeader = page.locator("[data-run-workspace-header]");
  const actions = page.getByRole("group", { name: "Run actions" });
  await expect(
    workspaceHeader.getByRole("heading", {
      level: 1,
      name: "Repair a broken nginx service",
    }),
  ).toBeVisible();
  await expect(actions).toBeVisible();
  await expect(
    actions.getByRole("button", { name: "SSH command" }),
  ).toBeEnabled();
  await expect(
    actions.getByRole("button", { name: /End run/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Page actions" }),
  ).toHaveCount(0);
  await expect(page.locator(".xterm")).toBeVisible();
  // The transport live region is sr-only while healthy — assert content, not
  // visibility.
  await expect(
    page.getByRole("status").filter({ hasText: /Terminal status:/i }),
  ).toHaveText(/Terminal status:\s*connected/i);
  await expect
    .poll(() => page.locator(".xterm").textContent())
    .toContain("intar workshop shell");
  await expect
    .poll(() => page.locator(".xterm").textContent())
    .not.toContain("[intar]");
  await expect(
    page.getByRole("button", { name: "Reconnect terminal" }),
  ).toHaveCount(0);
});

test("organization workspace keeps the active tab in the URL", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  await page.getByRole("tab", { name: "Assignments" }).click();
  await expect(page).toHaveURL(/tab=assignments/);
  await expect(
    page.getByRole("heading", { name: "Assignments" }),
  ).toBeVisible();
});

test("admin operations expose URL-backed people views", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });
  await page.getByRole("tab", { name: "Users" }).click();
  await expect(page).toHaveURL(/tab=users/);
  await expect(
    page.getByRole("heading", { name: "Users", exact: true }),
  ).toBeVisible();
});

test("admin role changes use the app-owned user endpoint", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });
  await page.getByRole("tab", { name: "Users" }).click();

  await page.getByRole("button", { name: "Make admin" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Grant admin access?" });
  await expect(dialog).toContainText("Mina Learner");
  const roleRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/admin/users/user-learner/role"),
  );
  await dialog.getByRole("button", { name: "Confirm change" }).click();

  expect((await roleRequest).postDataJSON()).toEqual({ role: "admin" });
  expect(ui.server.requests).toContain(
    "POST /api/admin/users/user-learner/role",
  );
  await expect(
    page.getByRole("button", { name: "Make user" }).first(),
  ).toBeVisible();
});

test("admin deletes a user instead of banning them", async ({ page, ui }) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });
  await page.getByRole("tab", { name: "Users" }).click();

  await expect(page.getByRole("button", { name: "Ban" })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Delete this user?" });
  await expect(dialog).toContainText("Mina Learner");
  await expect(dialog).toContainText("anonymous user record");
  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      request.url().endsWith("/api/admin/users/user-learner"),
  );
  await dialog.getByRole("button", { name: "Delete user" }).click();
  await deleteRequest;

  await expect(page.getByText("Mina Learner", { exact: true })).toHaveCount(0);
  expect(ui.server.requests).toContain("DELETE /api/admin/users/user-learner");
});

test("authoring editor validates with the browser WASM shell", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-authoring"), theme: "dark" });
  const editor = page.getByLabel("Scenario HCL source");
  await editor.fill('scenario "broken" {');
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByLabel("Validation results")).toContainText(
    /validation error|validator error|failed/i,
  );
});
