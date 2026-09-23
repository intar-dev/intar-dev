import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("landing shows the open sign-up spots and starts GitHub sign-in", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("landing"), theme: "light" });

  await expect(page.getByText("12 of 50 spots left")).toBeVisible();
  expect(ui.server.requests).toContain("GET /api/signups");
  const signIn = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/auth/sign-in/social"),
  );
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  expect((await signIn).postDataJSON()).toMatchObject({ provider: "github" });
});

test("admin saves the sign-up limit and reviews a stale one", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  await page.getByRole("tab", { name: "Sign-ups" }).click();
  await expect(page).toHaveURL(/tab=signups/);

  const limit = page.getByLabel("Sign-up limit");
  await expect(limit).toHaveValue("50");
  await limit.fill("60");
  const saveRequest = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/admin/signups"),
  );
  await page.getByRole("button", { name: "Save" }).click();
  expect((await saveRequest).postDataJSON()).toEqual({
    limit: 60,
    expectedVersion: 3,
  });
  await expect(page.getByText("Sign-up limit saved.")).toBeVisible();
  await expect(page.getByLabel("Sign-up limit")).toHaveValue("60");
  await expect(page.getByText("22", { exact: true })).toBeVisible();

  // Another session saves first; the form reports it and reloads the limit.
  ui.server.state.signups = {
    ...ui.server.state.signups,
    limit: 70,
    version: ui.server.state.signups.version + 1,
  };
  await page.getByLabel("Sign-up limit").fill("65");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(
      "The limit changed in another session. Review it and save again.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Sign-up limit")).toHaveValue("70");
});

test("admin revokes access from the users list", async ({ page, ui }) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  const revokeButtons = page.getByRole("button", { name: "Revoke access" });
  const revokedBadges = page.getByText("Access revoked", { exact: true });
  const activeCount = await revokeButtons.count();
  await expect(revokedBadges).toHaveCount(1);

  await revokeButtons.first().click();
  const dialog = page.getByRole("dialog", { name: "Revoke access?" });
  await expect(dialog).toContainText("Mina Learner is signed out everywhere");
  await expect(dialog).toContainText("Access can't be restored.");
  const revokeRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/admin/users/user-learner/revoke"),
  );
  await dialog.getByRole("button", { name: "Revoke access" }).click();
  await revokeRequest;

  await expect(revokedBadges).toHaveCount(2);
  await expect(revokeButtons).toHaveCount(activeCount - 1);
  expect(ui.server.state.signups.taken).toBe(37);
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
  await expect(
    page.getByRole("heading", { name: "Users", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Sign-ups" }).click();
  await expect(page).toHaveURL(/tab=signups/);
  await expect(
    page.getByRole("heading", { name: "Sign-ups", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Users" }).click();
  await expect(page).not.toHaveURL(/tab=/);
});

test("admin role changes use the app-owned user endpoint", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });

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
