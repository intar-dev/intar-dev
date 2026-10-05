import { sessionFor } from "./fixtures/sessions";
import {
  openShare,
  shareHistory,
  shareMission,
} from "./fixtures/share-live";
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

test("a session that lost access can sign out from the landing page", async ({
  page,
  ui,
}) => {
  let session = sessionFor("learner");
  await page.route("**/api/app/bootstrap", (route) =>
    route.fulfill({ json: { session, access: "inactive" } }),
  );
  await page.route("**/api/auth/sign-out", (route) => {
    session = null;
    return route.fulfill({ json: { success: true } });
  });
  await ui.open({
    ...routeCase("landing"),
    path: "/?error=access_revoked",
    theme: "light",
  });

  await expect(page.getByText("This session can no longer be used.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse courses" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Sign in with GitHub" }),
  ).toBeVisible();
  // Signing out answered the refusal that brought the session here.
  await expect(page.getByText("This account no longer has access.")).toHaveCount(0);
  await expect(page).not.toHaveURL(/error=/u);
});

test("the consent page doesn't offer a stranded session a choice", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("oauth-consent"), theme: "light" });
  await page.route("**/api/app/bootstrap", (route) =>
    route.fulfill({
      json: { session: sessionFor("learner"), access: "inactive" },
    }),
  );
  await page.reload();

  await expect(page.getByText("Session required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny access" })).toBeDisabled();
  await expect(page.getByText("Signed in as")).toHaveCount(0);
});

test("a Connect GitHub that outlived its session explains itself", async ({
  page,
  ui,
}) => {
  // GitHub returns to Profile after the session ended; the signed-in guard
  // passes the code on to the landing page.
  await ui.open({
    ...routeCase("landing"),
    path: "/profile?error=link_session_ended",
    theme: "light",
  });

  await expect(
    page.getByText("You were signed out before the connection finished.", {
      exact: false,
    }),
  ).toBeVisible();
  // The landing page keeps the message and drops the code from its URL.
  await expect(page).toHaveURL(/\/$/u);
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
  await expect(dialog).toContainText(
    "You can restore access later from their page.",
  );
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

test("a revoke whose cleanup didn't finish hands over to Finish cleanup", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  // The revocation commits, then its cleanup fails.
  await page.route("**/api/admin/users/user-learner/revoke", async (route) => {
    const learner = ui.server.state.users.find((entry) => entry.id === "user-learner");
    if (learner) {
      Object.assign(learner, {
        access: "revoked",
        revokedAt: Date.parse("2026-07-10T09:00:00Z"),
        cleanupCompletedAt: null,
        revocationId: "revocation-user-learner",
      });
    }
    ui.server.expectedUnavailable += 1;
    await route.fulfill({
      status: 503,
      json: {
        error: "Access is revoked, but cleanup didn't finish. Finish the cleanup to retry it.",
        code: "access_cleanup_incomplete",
      },
    });
  });

  await page.getByRole("button", { name: "Revoke access" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Revoke access?" });
  await dialog.getByRole("button", { name: "Revoke access" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Finish the cleanup to retry it.", { exact: false })).toBeVisible();

  const finish = page.getByRole("button", { name: "Finish cleanup" });
  await expect(finish).toBeVisible();
  const cleanupRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/admin/users/user-learner/revocation-cleanup"),
  );
  await finish.click();
  expect((await cleanupRequest).postDataJSON()).toEqual({
    revocationId: "revocation-user-learner",
  });
  await expect(page.getByText("Cleanup finished for Mina Learner.")).toBeVisible();
  await expect(finish).toBeHidden();
});

test("admin restores a revoked user's access from their details", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "light" });
  await expect(
    page.getByText("signed up through Platform Repair Crew", { exact: false }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Blake Blocked" }).click();
  await expect(page).toHaveURL(/\/admin\/people\/user-blocked$/);
  await expect(page.locator("h1").first()).toHaveText("Blake Blocked");
  await expect(page.getByRole("link", { name: "People" }).first()).toHaveAttribute(
    "href",
    "/admin/people",
  );
  await expect(page.getByText("Platform Repair Crew's identity provider")).toBeVisible();
  await expect(page.getByText("The organization removed them.", { exact: false })).toBeVisible();
  await expect(page.getByText("Connected after access was revoked.").first()).toBeVisible();

  await page.getByRole("button", { name: "Restore access" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore access?" });
  await expect(dialog).toContainText("Will work again");
  await expect(dialog).toContainText("Still won't work");
  await expect(dialog).toContainText("Check that it's theirs.");
  await expect(dialog).toContainText("Their SSH key is removed.");
  await expect(dialog).toContainText("They leave Platform Repair Crew.");
  const restoreRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith("/api/admin/users/user-blocked/restore"),
  );
  await dialog.getByRole("button", { name: "Restore access" }).click();
  expect((await restoreRequest).postDataJSON()).toEqual({
    revocationId: "revocation-user-blocked",
  });

  await expect(page.getByText("Access restored.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Revoke access" })).toBeVisible();
  await expect(page.getByText("Access restored", { exact: true }).first()).toBeVisible();
  expect(ui.server.state.signups.taken).toBe(39);
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

test("a shared run's public page mirrors the learner's terminals", async ({
  page,
  ui,
}) => {
  await openShare(page, ui, { theme: "dark", history: shareHistory });

  await expect(
    page.getByRole("heading", { level: 1, name: shareMission.title }),
  ).toBeVisible();
  const tabs = page
    .getByRole("tablist", { name: "Terminal sessions" })
    .getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toContainText("web · 1");
  await expect(tabs.nth(1)).toContainText("web · 2");
  // The running session is in front, drawn at 16pt.
  const screen = page.locator(".xterm-rows");
  await expect(screen).toContainText("nginx.service: failed");
  await expect(screen).toHaveCSS("font-size", "21px");
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

for (const { action, sessionRole, status } of [
  { action: "delete", sessionRole: "owner", status: 404 },
  { action: "leave", sessionRole: "organization-member", status: 403 },
] as const) {
  test(`after an organization ${action}, the list opens without re-reading the organization`, async ({
    page,
    ui,
  }) => {
    await ui.open({ path: "/organizations", sessionRole, theme: "light" });
    const listReads = () =>
      ui.server.requests.filter((request) => request === "GET /api/organizations")
        .length;
    await expect.poll(listReads).toBe(1);
    await page.getByText("Platform Repair Crew", { exact: true }).click();
    await expect(page).toHaveURL(/\/organizations\/org-platform/);
    // Once the request lands, every read of this organization is refused, as
    // it is in production.
    let done = false;
    const refusedReads: string[] = [];
    await page.route("**/api/organizations/org-platform**", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") {
        done = true;
      } else if (done) {
        refusedReads.push(new URL(request.url()).pathname);
        await route.fulfill({ status, json: { error: "Organization unavailable" } });
        return;
      }
      await route.fallback();
    });
    await page.getByRole("tab", { name: "Settings" }).click();
    if (action === "delete") {
      await page.getByRole("button", { name: "Delete organization" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("textbox", { name: "Organization name confirmation" })
        .fill("Platform Repair Crew");
      await dialog.getByRole("button", { name: "Delete organization" }).click();
    } else {
      // Leaving asks first, in a dialog that names the consequence.
      await page.getByRole("button", { name: "Leave organization" }).click();
      await page
        .getByRole("dialog", { name: "Leave Platform Repair Crew?" })
        .getByRole("button", { name: "Leave organization" })
        .click();
    }

    // The old hang retried refused reads for about 7s.
    await expect(page).toHaveURL(/\/organizations$/, { timeout: 4_000 });
    // The cached list is read again rather than showing the old membership.
    await expect.poll(listReads).toBe(2);
    expect(refusedReads).toEqual([]);
  });
}

test("a refused organization read shows its error without retrying", async ({
  page,
  ui,
}) => {
  await ui.open({ path: "/organizations", sessionRole: "owner", theme: "light" });
  // The organization was deleted after the list loaded.
  let reads = 0;
  ui.server.expectedNotFound = 1;
  await page.route("**/api/organizations/org-platform", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads += 1;
    await route.fulfill({
      status: 404,
      json: { error: "This organization no longer exists." },
    });
  });
  await page.getByText("Platform Repair Crew", { exact: true }).click();

  // Retrying with backoff held the skeleton for about seven seconds.
  await expect(
    page.getByRole("heading", { name: "Organization not found" }),
  ).toBeVisible({ timeout: 3_000 });
  // A missing organization cannot be fixed by retrying.
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  // Past the first retry delay: still the one read.
  await page.waitForTimeout(1_500);
  expect(reads).toBe(1);
});

test("the app bar offers a reload once a new version is deployed", async ({
  page,
  ui,
}) => {
  await page.route("**/version.json", (route) =>
    route.fulfill({ json: { version: "next-release" } }),
  );
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });
  const update = page.getByRole("button", {
    name: "New version available, reload to update",
  });
  await expect(update).toBeVisible();

  await page.evaluate(() => {
    (window as Window & { beforeUpdate?: boolean }).beforeUpdate = true;
  });
  await update.click();
  // The reload drops everything this document held.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { beforeUpdate?: boolean }).beforeUpdate,
      ),
    )
    .toBeUndefined();
});

test("the app bar stays quiet while the tab runs the deployed version", async ({
  page,
  ui,
}) => {
  let checks = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/version.json") checks += 1;
  });
  await ui.open({ ...routeCase("course-catalog"), theme: "light" });

  await expect.poll(() => checks).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: /New version/ })).toHaveCount(0);
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
  await dialog.getByRole("button", { name: "Grant admin" }).click();

  expect((await roleRequest).postDataJSON()).toEqual({ role: "admin" });
  expect(ui.server.requests).toContain(
    "POST /api/admin/users/user-learner/role",
  );
  await expect(
    page.getByRole("button", { name: "Make user" }).first(),
  ).toBeVisible();
});

test("a refused role change explains itself in its dialog", async ({
  page,
  ui,
}) => {
  await ui.open({ ...routeCase("admin-people"), theme: "dark" });
  await page.route("**/api/admin/users/user-learner/role", async (route) => {
    ui.server.expectedConflicts += 1;
    await route.fulfill({
      status: 409,
      json: {
        error:
          "Platform admins sign in with GitHub. Ask them to connect GitHub from their profile first.",
        code: "admin_sign_in_required",
      },
    });
  });

  await page.getByRole("button", { name: "Make admin" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Grant admin access?" });
  await expect(dialog).toContainText("They're signed out now");
  await dialog.getByRole("button", { name: "Grant admin" }).click();
  await expect(dialog).toContainText(
    "Ask them to connect GitHub from their profile first.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Ask them to connect GitHub")).toHaveCount(0);
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
