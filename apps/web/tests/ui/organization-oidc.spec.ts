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
