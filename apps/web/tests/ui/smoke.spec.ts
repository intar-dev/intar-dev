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
  expect(hetznerBox!.height).toBeGreaterThanOrEqual(48);
  expect(namespaceBox!.height).toBeGreaterThanOrEqual(40);
});

test("beta invite fragment is scrubbed before the claim is inspected", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("join-beta"), theme: "light" });

  expect(new URL(page.url()).hash).toBe("");
  await expect(
    page.getByRole("heading", { name: "Claim your beta invite" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    /This code is valid/i,
  );
  await expect(
    page.getByRole("button", { name: "Continue with GitHub" }),
  ).toBeVisible();
  expect(ui.server.requests).toContain("POST /api/access-invites/exchange");
  expect(ui.server.requests).toContain("GET /api/access-invites/current");
  expect(ui.server.requests.join("\n")).not.toContain("intar_beta_");
});

test("admin sees a newly created beta link only once", async ({ page, ui }) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  await page.getByRole("button", { name: "Create invite" }).click();

  const createDialog = page.getByRole("dialog", {
    name: "Create beta invite",
  });
  await createDialog.getByLabel(/Label/).fill("September workshop cohort");
  await createDialog
    .getByRole("button", { name: "Create single-use link" })
    .click();

  const oneTimeDialog = page.getByRole("dialog", {
    name: "Copy this link now",
  });
  const linkInput = oneTimeDialog.getByLabel("Beta invite link");
  await expect(linkInput).toHaveValue(/\/join#invite=intar_beta_[A-Za-z0-9_-]+$/);
  const rawLink = await linkInput.inputValue();
  await oneTimeDialog
    .getByRole("button", { name: "Close and forget link" })
    .click();

  await expect(oneTimeDialog).toBeHidden();
  expect(
    await page.locator("input").evaluateAll((inputs) =>
      inputs.some((input) => (input as HTMLInputElement).value === rawLink),
    ),
  ).toBe(false);
  expect(ui.server.requests).toContain("POST /api/admin/access-invites");
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

test("scenario briefing is nested beneath the Courses breadcrumb", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("scenario-briefing"), theme: "light" });
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Courses" }),
  ).toHaveAttribute("href", "/courses");
  await expect(page).toHaveURL(/\/courses\/repair-nginx$/);
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

  await page.getByRole("button", { name: "Native SSH" }).click();
  const nativeSshDialog = page.getByRole("dialog");
  await expect(
    nativeSshDialog.getByRole("heading", {
      name: "Native SSH for platform-workshop",
    }),
  ).toBeVisible();
  await expect(nativeSshDialog.getByLabel("SSH command")).toContainText(
    "workshop-route-test-only-native@stargate.example.test",
  );
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
  await expect(
    page.getByRole("dialog").getByText(/assisting Mina Learner/i),
  ).toBeVisible();
  expect(ui.server.requests).toContain(
    "POST /api/workshops/workshop-live/terminal",
  );
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
  await expect(page.locator(".xterm")).toBeVisible();
  // The transport live region is sr-only while healthy — assert content, not
  // visibility.
  await expect(
    page.getByRole("status").filter({ hasText: /Terminal status:/i }),
  ).toHaveText(/Terminal status:\s*connected/i);
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

test("authoring editor validates with the browser WASM shell", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-authoring"), theme: "dark" });
  const editor = page.locator(".cm-content");
  await editor.fill('scenario "broken" {');
  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByLabel("Validation results")).toContainText(
    /validation error|validator error|failed/i,
  );
});
