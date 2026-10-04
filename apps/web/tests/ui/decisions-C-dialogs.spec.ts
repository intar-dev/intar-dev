import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

// Decision 6: dialogs are for confirmations. Forms and tools open in a
// full-height side sheet from the right with its own header and close.

async function expectRightSheet(page: Page, sheet: Locator) {
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-slot", "sheet-content");
  await expect(sheet).toHaveAttribute("data-side", "right");
  // Full height, against the right edge.
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) return false;
      return (
        Math.abs(box.y) <= 1 &&
        Math.abs(box.height - viewport.height) <= 1 &&
        Math.abs(box.x + box.width - viewport.width) <= 1
      );
    })
    .toBe(true);
}

test("creating an organization opens a side sheet with the name focused", async ({
  page,
  ui,
}) => {
  await ui.open(routeCase("organizations"));
  ui.server.state.organizationCreation = { enabled: true, reason: null };
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();

  const trigger = page.getByRole("button", { name: "New organization" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Create an organization" });
  await expectRightSheet(page, sheet);
  const name = sheet.getByLabel("Organization name");
  await expect(name).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await sheet.getByRole("button", { name: "Create" }).click();
  await expect(sheet).toContainText("Enter a name of 2 to 60 characters.");
  await name.fill("Night shift");
  await sheet.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/organizations\/org-new$/);
  await expect(sheet).toHaveCount(0);
});

test("an organization's sign-in controls open in a side sheet", async ({
  page,
  ui,
}) => {
  await page.route(
    "**/api/admin/organizations/org-platform/removed-members",
    (route) => route.fulfill({ json: { removedMembers: [] } }),
  );
  await ui.open({
    ...routeCase("admin-people"),
    path: "/admin/people?tab=organizations",
  });

  const trigger = page.getByRole("button", { name: /^Manage sign-in for / });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: /sign-in$/ });
  await expectRightSheet(page, sheet);
  await expect(sheet).toContainText("Nobody is removed.");
  // Close is the first stop, so a keyboard user lands on it.
  await expect(
    sheet.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("native SSH setup on the run page opens in a side sheet", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  const trigger = page
    .getByRole("group", { name: "Run actions" })
    .getByRole("button", { name: "SSH command" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Native SSH for web" });
  await expectRightSheet(page, sheet);

  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the admin dashboard's web and native SSH tools open in side sheets", async ({
  page,
  ui,
}) => {
  await ui.open({ path: "/admin", sessionRole: "global-admin", theme: "light" });

  const native = page.getByRole("button", { name: "Native SSH" }).first();
  await native.click();
  const nativeSheet = page.getByRole("dialog", { name: /^Native SSH for / });
  await expectRightSheet(page, nativeSheet);
  await page.keyboard.press("Escape");
  await expect(nativeSheet).toHaveCount(0);
  await expect(native).toBeFocused();

  const web = page.getByRole("button", { name: "Open web SSH" }).first();
  await web.click();
  const terminal = page.getByRole("dialog", { name: /^Web SSH · / });
  await expectRightSheet(page, terminal);
  await expect(terminal).toHaveAttribute("data-terminal-status", /.+/);
  await terminal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(terminal).toHaveCount(0);
});

test("confirmations stay dialogs", async ({ page, ui }) => {
  await ui.open({ path: "/admin", sessionRole: "global-admin", theme: "light" });

  await page.getByRole("button", { name: "End run" }).first().click();
  const confirm = page.getByRole("dialog", { name: "End this run?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("data-slot", "dialog-content");
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
});
