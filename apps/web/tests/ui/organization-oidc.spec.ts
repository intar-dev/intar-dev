import { FIXED_NOW } from "./fixtures/data";
import { sessionFor } from "./fixtures/sessions";
import { day } from "./fixtures/data/shared";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

const settings = {
  ...routeCase("organization-detail"),
  path: "/organizations/org-platform?tab=settings",
};
const startEndpoint = "**/api/account-links/sso/start";

for (const viewport of ["desktop", "mobile"] as const) {
  test(`owners can test sign-in from ${viewport} settings`, async ({
    page,
    ui,
  }, testInfo) => {
    await page.setViewportSize(
      viewport === "desktop"
        ? { width: 1440, height: 1000 }
        : { width: 390, height: 844 },
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let body: unknown;
    await page.route(startEndpoint, async (route) => {
      body = route.request().postDataJSON();
      await pending;
      await route.fulfill({
        json: { redirectUrl: "https://id.platform.example/authorize" },
      });
    });
    await page.route("https://id.platform.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Identity provider</h1>",
      }),
    );
    await ui.open({
      ...settings,
      theme: viewport === "desktop" ? "light" : "dark",
    });
    const button = page.getByRole("button", {
      name: "Test sign-in",
      exact: true,
    });
    await expect(button).toBeEnabled();
    await expect(
      page.getByText("PKCE S256 · No client secret", { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, testInfo);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport}.png`),
      fullPage: true,
    });
    await button.click();
    await expect(
      page.getByRole("button", { name: "Opening provider…" }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Opening your identity provider…" }),
    ).toBeVisible();
    release();
    await expect(page).toHaveURL("https://id.platform.example/authorize");
    expect(body).toEqual({
      organizationSlug: "platform-repair-crew",
      test: true,
    });
    await page.goto(`${settings.path}&oidcTest=passed`);
    await expect(
      page.getByRole("status").filter({ hasText: "PKCE S256 sign-in passed." }),
    ).toBeVisible();
  });
}

test("failed callbacks and start errors allow another test", async ({
  page,
  ui,
}) => {
  await page.route("**/api/organizations/org-platform", (route) =>
    route.fulfill({ json: { organization: ui.server.state.organizationDetail } }),
  );
  await page.route("**/api/organizations/org-platform/sso", (route) =>
    route.fulfill({ json: { provider: ui.server.state.organizationOidc } }),
  );
  await page.route(startEndpoint, (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Sign in again to test organization access." },
    }),
  );
  await ui.open({
    ...settings,
    path: "/organizations/org-platform?error=oidc_sign_in_failed",
    variant: "error",
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Sign-in test failed." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Test sign-in", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Sign in again to test organization access." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test sign-in", exact: true }),
  ).toBeEnabled();
});

test("owners must verify DNS first", async ({ page, ui }) => {
  await page.route("**/api/organizations/org-platform/sso", (route) =>
    route.fulfill({
      json: {
        provider: {
          ...ui.server.state.organizationOidc,
          domainVerified: false,
        },
      },
    }),
  );
  await ui.open(settings);
  await expect(
    page.getByRole("button", { name: "Test sign-in", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Verify DNS before testing sign-in."),
  ).toBeVisible();
});

test("admins do not see the owner test action", async ({ page, ui }) => {
  await ui.open({ ...settings, organizationRole: "admin" });
  await expect(
    page.getByRole("heading", { name: "Organization OIDC" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Test sign-in", exact: true }),
  ).toHaveCount(0);
});

test("signed-out visitors continue to their organization's provider", async ({
  page,
  ui,
}) => {
  let body: unknown;
  await page.route("**/api/organization-sign-in/start", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: { redirectUrl: "https://id.platform.example/authorize" },
    });
  });
  await page.route("https://id.platform.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Identity provider</h1>",
    }),
  );
  await ui.open({
    ...routeCase("organization-sign-in"),
    path: "/organizations/platform-repair-crew/sign-in",
  });
  await expect(
    page.getByRole("heading", { name: "Continue with your organization" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue with organization", exact: true })
    .click();
  await expect(page).toHaveURL("https://id.platform.example/authorize");
  expect(body).toEqual({ organizationSlug: "platform-repair-crew" });
});

test("sign-in refusals show the message for their code only", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("organization-sign-in"),
    path: "/organizations/platform-repair-crew/sign-in?error=sso_email_in_use&error_description=Call%20attacker%20support",
  });
  await expect(
    page.getByText("An Intar account already uses this email.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("Call attacker support")).toHaveCount(0);
});

test("an organization sign-in error clears once the person tries again", async ({
  page,
  ui,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/organization-sign-in/start", async (route) => {
    await pending;
    await route.fulfill({
      json: { redirectUrl: "https://id.platform.example/authorize" },
    });
  });
  await page.route("https://id.platform.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Identity provider</h1>",
    }),
  );
  await ui.open({
    ...routeCase("organization-sign-in"),
    path: "/organizations/platform-repair-crew/sign-in?error=sso_email_domain_not_allowed",
  });
  const refusal = page.getByText(
    "only creates accounts for emails on its verified domain",
    { exact: false },
  );
  await expect(refusal).toBeVisible();
  // The code leaves the URL, so a reload shows no stale failure.
  await expect(page).not.toHaveURL(/error=/u);

  await page
    .getByRole("button", { name: "Continue with organization" })
    .click();
  await expect(refusal).toHaveCount(0);
  release();
  await expect(page).toHaveURL("https://id.platform.example/authorize");
});

test("a session that lost access signs out before organization sign-in", async ({
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
    ...routeCase("organization-sign-in"),
    path: "/organizations/platform-repair-crew/sign-in",
  });

  await expect(
    page.getByText("This session can no longer be used.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect organization" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with organization" }),
  ).toBeVisible();
});

test("platform admins approve other email domains for a provider", async ({
  page,
  ui,
}) => {
  await ui.open({ ...settings, sessionRole: "global-admin" });
  await expect(page.getByText("Sign-ups are limited to emails on platform.example.")).toBeVisible();
  await page
    .getByRole("button", { name: "Allow other email domains", exact: true })
    .click();
  await expect(
    page.getByText("Sign-ups may use any email the identity provider verified, not only platform.example."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Limit to platform.example" }),
  ).toBeVisible();
});

test("admins confirm before removing the identity provider", async ({
  page,
  ui,
}) => {
  let removals = 0;
  await page.route("**/api/organizations/org-platform/sso", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    removals += 1;
    return route.fulfill({ status: 204 });
  });
  await ui.open(settings);

  await page.getByRole("button", { name: "Remove provider" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remove the identity provider?",
  });
  await expect(dialog).toContainText("signed out everywhere");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(removals).toBe(0);

  await page.getByRole("button", { name: "Remove provider" }).click();
  await dialog.getByRole("button", { name: "Remove provider" }).click();
  await expect(dialog).toHaveCount(0);
  expect(removals).toBe(1);
});

test("organization owners see the sign-up policy without changing it", async ({
  page,
  ui,
}) => {
  await ui.open(settings);
  await expect(page.getByText("Sign-ups are limited to emails on platform.example.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Allow other email domains" }),
  ).toHaveCount(0);
});

test("admins confirm removals and restore removed people", async ({
  page,
  ui,
}) => {
  let restored = false;
  await page.route("**/api/organizations/org-platform", (route) =>
    route.fulfill({
      json: {
        organization: {
          ...ui.server.state.organizationDetail,
          removedMembers: restored
            ? []
            : [
                {
                  userId: "user-removed",
                  name: "Rita Removed",
                  email: "rita@platform.example",
                  githubUsername: null,
                  removedAt: FIXED_NOW - day,
                },
              ],
        },
      },
    }),
  );
  await page.route(
    "**/api/organizations/org-platform/removed-members/user-removed",
    (route) => {
      restored = true;
      return route.fulfill({ status: 204 });
    },
  );
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=people",
  });
  await expect(page.getByText("Rita Removed")).toBeVisible();

  await page.getByRole("button", { name: "Remove", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toContainText(
    "can't sign in through its identity provider",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Restore access" }).click();
  await expect(page.getByText("Rita Removed")).toHaveCount(0);
});

const organizationIdentity = {
  providerId: "org-provider-1",
  kind: "organization",
  organization: { name: "Platform Repair Crew", slug: "platform-repair-crew" },
  linkedAt: FIXED_NOW - day,
  usable: true,
  removed: false,
};
const githubIdentity = {
  providerId: "github",
  kind: "github",
  organization: null,
  linkedAt: FIXED_NOW - 30 * day,
  usable: true,
  removed: false,
};

test("profile names organization sign-ins and connects GitHub", async ({
  page,
  ui,
}) => {
  await page.route("**/api/account-links", (route) =>
    route.fulfill({ json: { identities: [organizationIdentity] } }),
  );
  let linkBody: unknown;
  await page.route("**/api/auth/link-social", async (route) => {
    linkBody = route.request().postDataJSON();
    await route.fulfill({ json: { redirect: false, url: "/profile" } });
  });
  await ui.open(routeCase("profile"));
  await expect(
    page.getByText("Platform Repair Crew", { exact: true }),
  ).toBeVisible();
  // The only way to sign in stays until another one is connected.
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await expect.poll(() => linkBody).toMatchObject({ provider: "github" });
});

test("profile disconnects an organization after confirmation", async ({
  page,
  ui,
}) => {
  let identities = [githubIdentity, organizationIdentity];
  await page.route("**/api/account-links", (route) =>
    route.fulfill({ json: { identities } }),
  );
  let disconnected: string | null = null;
  await page.route("**/api/account-links/org-provider-1", async (route) => {
    disconnected = new URL(route.request().url()).pathname;
    identities = [githubIdentity];
    await route.fulfill({ status: 204 });
  });
  await ui.open(routeCase("profile"));

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("can no longer sign in as you");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Platform Repair Crew", { exact: true })).toHaveCount(0);
  expect(disconnected).toBe("/api/account-links/org-provider-1");
});

test("profile explains a refused disconnect in its dialog", async ({
  page,
  ui,
}) => {
  await page.route("**/api/account-links", (route) =>
    route.fulfill({ json: { identities: [githubIdentity, organizationIdentity] } }),
  );
  // Another tab disconnected GitHub first.
  await page.route("**/api/account-links/org-provider-1", async (route) => {
    ui.server.expectedConflicts += 1;
    await route.fulfill({
      status: 409,
      json: {
        error: "connect another way to sign in before disconnecting this one",
        code: "last_sign_in_method",
      },
    });
  });
  await ui.open(routeCase("profile"));

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toContainText(
    "This is your last way to sign in. Connect another one before disconnecting it.",
  );
});

test("profile disconnects GitHub while an organization can still sign in", async ({
  page,
  ui,
}) => {
  let identities = [githubIdentity, organizationIdentity];
  await page.route("**/api/account-links", (route) =>
    route.fulfill({ json: { identities } }),
  );
  let disconnected = false;
  await page.route("**/api/account-links/github", async (route) => {
    disconnected = route.request().method() === "DELETE";
    identities = [organizationIdentity];
    await route.fulfill({ status: 204 });
  });
  await ui.open(routeCase("profile"));

  await page.getByRole("button", { name: "Disconnect GitHub" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Disconnect GitHub?");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(disconnected).toBe(true);
  // The organization is now the only way in.
  await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeDisabled();
});

test("profile keeps an organization sign-in its admins removed", async ({
  page,
  ui,
}) => {
  await page.route("**/api/account-links", (route) =>
    route.fulfill({
      json: {
        identities: [
          githubIdentity,
          { ...organizationIdentity, usable: false, removed: true },
        ],
      },
    }),
  );
  await ui.open(routeCase("profile"));

  await expect(page.getByText("an admin removed you")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeDisabled();
  // GitHub is the only usable way in, so it stays too.
  await expect(page.getByRole("button", { name: "Disconnect GitHub" })).toHaveCount(0);
});

test("profile says when its sign-in methods can't load", async ({ page, ui }) => {
  await page.route("**/api/account-links", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  // The error variant expects the failed request's console error.
  await ui.open({ ...routeCase("profile"), variant: "error" });

  // The query retries three times before it reports the failure.
  await expect(
    page.getByText("Your sign-in methods couldn't be loaded."),
  ).toBeVisible({ timeout: 15_000 });
});

test("admins can't remove themselves and see a failed removal in the dialog", async ({
  page,
  ui,
}) => {
  await page.route(
    "**/api/organizations/org-platform/members/member-learner",
    (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: "Membership was removed. Run shutdown is pending.",
          code: "organization_run_cleanup_pending",
        },
      }),
  );
  await page.route("**/api/organizations/org-platform", (route) =>
    route.fulfill({ json: { organization: ui.server.state.organizationDetail } }),
  );
  // Inez is one of the organization's admins. The error variant expects the
  // failed removal's console error.
  await ui.open({
    ...routeCase("organization-detail"),
    sessionRole: "instructor",
    path: "/organizations/org-platform?tab=people",
    variant: "error",
  });
  // An admin leaves from Settings instead of removing themselves.
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Inez Instructor" })
      .getByRole("button", { name: "Remove" }),
  ).toHaveCount(0);

  await page
    .getByRole("listitem")
    .filter({ hasText: "Mina Learner" })
    .getByRole("button", { name: "Remove" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Remove member" }).click();
  await expect(dialog).toContainText("Run shutdown is pending");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("platform admins manage an organization's sign-in without membership", async ({
  page,
  ui,
}) => {
  await page.route(
    "**/api/admin/organizations/org-platform/removed-members",
    (route) =>
      route.fulfill({
        json: {
          removedMembers: [
            {
              userId: "user-removed",
              name: "Rita Removed",
              email: "rita@platform.example",
              githubUsername: null,
              removedAt: FIXED_NOW - day,
            },
          ],
        },
      }),
  );
  let restored: string | null = null;
  await page.route(
    "**/api/admin/organizations/org-platform/removed-members/*",
    async (route) => {
      restored = new URL(route.request().url()).pathname.split("/").at(-1)!;
      await route.fulfill({ status: 204 });
    },
  );
  await ui.open({
    ...routeCase("admin-people"),
    path: "/admin/people?tab=organizations",
  });

  await page.getByRole("button", { name: "Manage" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Sign-ups are limited to emails on platform.example.",
  );
  await dialog
    .getByRole("button", { name: "Allow other email domains" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Limit to platform.example" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Restore access" }).click();
  await expect.poll(() => restored).toBe("user-removed");
});
