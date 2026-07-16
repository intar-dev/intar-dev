import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test("startup keeps the workspace useful and replaces milestones with the shell", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "booting",
  });

  await expect(
    page.getByRole("heading", { name: "Preparing your workspace" }),
  ).toBeVisible();
  await expect(page.getByText("Review the work order while the VM starts.")).toBeVisible();
  await expect(page.getByText("Repair objectives")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  const focusTarget = page.getByRole("link", { name: "Scenarios" }).first();
  await focusTarget.focus();
  ui.server.setRunState("running");

  await expect(page.locator(".xterm")).toBeVisible({ timeout: 1_000 });
  await expect(focusTarget).toBeFocused();
});

test("end acceptance returns to the catalog with a background notice", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "dark",
    runState: "running",
  });

  await page.getByRole("button", { name: "End run" }).first().click();
  const dialog = page.getByRole("dialog");
  const destroyResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scenarios/runs/run-active/destroy") &&
      response.status() === 202,
  );
  await dialog.getByRole("button", { name: "End run" }).click();
  await destroyResponse;

  await expect(page).toHaveURL(/\/scenarios$/, { timeout: 300 });
  await expect(
    page.getByRole("region", { name: "Run is ending in the background." }),
  ).toContainText("You can choose another lab now.");
});

test("My runs moves cleanup from background into history and announces completion once", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("runs"),
    theme: "light",
    runState: "ending",
  });

  await expect(
    page.getByRole("heading", { name: "Finishing in background" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Run saved. No terminal session was recorded."),
  ).toHaveCount(0);

  ui.server.setRunState("archived");
  await expect(
    page.getByRole("region", {
      name: "Run saved. No terminal session was recorded.",
    }),
  ).toHaveCount(1, { timeout: 2_500 });
  await expect(
    page.getByRole("heading", { name: "Finishing in background" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
});

test("completion notice survives a foreground-to-settled polling jump", async ({
  page,
  ui,
}) => {
  await ui.open({
    ...routeCase("runs"),
    theme: "light",
    runState: "running",
  });

  await expect(page.getByRole("heading", { name: "Active work" })).toBeVisible();
  ui.server.setRunState("archived");

  await expect(
    page.getByRole("region", {
      name: "Run saved. No terminal session was recorded.",
    }),
  ).toHaveCount(1, { timeout: 2_500 });
});
