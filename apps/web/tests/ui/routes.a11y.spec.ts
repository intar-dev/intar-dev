import { ROUTE_CASES } from "./routes";
import { expect, test } from "./fixtures/test";
import { expectNoAxeViolations } from "./support/axe";

const themes = ["light", "dark"] as const;

test.describe("all-route accessibility", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of themes) {
    for (const route of ROUTE_CASES) {
      test(`${route.id} · ${theme}`, async ({ page, ui }, testInfo) => {
        await ui.open({ ...route, theme });

        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.locator("h1")).toHaveCount(1);
        await expect(page).toHaveTitle(/intar/i);

        if (route.id === "run-workspace") {
          const workspaceHeader = page.locator("[data-run-workspace-header]");
          const workspace = page.locator("[data-run-page]");
          const back = page
            .locator("[data-run-navigation]")
            .getByRole("link", { name: "Back to lecture" });

          await expect(workspace).toBeVisible();
          await expect(workspaceHeader).toHaveCount(1);
          await expect(
            workspaceHeader.getByRole("heading", {
              level: 1,
              name: "Repair a broken nginx service",
            }),
          ).toBeVisible();
          await expect(back).toHaveText("Lecture");
          await expect(back).toHaveAttribute(
            "href",
            "/courses/operations/lectures/02-repair-nginx",
          );
          await expect(page.locator("header")).toHaveCount(1);
          await expect(page.locator("[data-slot='sidebar']")).toHaveCount(0);
          // The shell keeps its inert inset mounted so the run can move to its
          // normal saving/recap chrome without remounting the page.
          await expect(
            page.locator("[data-slot='sidebar-inset']"),
          ).toHaveCount(1);
          await expect(
            page.locator("[data-slot='sidebar-trigger']"),
          ).toHaveCount(0);
          await expect(
            page.getByRole("navigation", { name: "Breadcrumb" }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Page actions" }),
          ).toHaveCount(0);
        }

        await expectNoAxeViolations(page, testInfo);
      });
    }
  }
});
