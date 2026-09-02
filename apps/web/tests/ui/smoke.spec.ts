import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

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
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const search = page.getByLabel(/Search courses and lectures/i);
  await search.fill("DNS");
  await expect(
    page.getByRole("link", { name: /Linux operations/i }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Linux operations/i }).click();
  await expect(
    page.getByText("Trace an intermittent DNS failure", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Repair a broken nginx service", { exact: true }),
  ).toBeHidden();
});

test("lecture is nested beneath its catalog course breadcrumb", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("lecture"), theme: "light" });
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(
    breadcrumb.getByRole("link", { name: "Linux operations" }),
  ).toHaveAttribute("href", "/courses/operations");
  await expect(page).toHaveURL("/courses/operations/lectures/02-repair-nginx");
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
    .toContain("intar scenario shell");
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
