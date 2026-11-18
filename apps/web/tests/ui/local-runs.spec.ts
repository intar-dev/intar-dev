import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

// A local run's machines are on the learner's computer, in the desktop app
// (#399). The website shows its progress and never offers a terminal.

test("a local run's page shows progress and points to the desktop app", async ({ page, ui }) => {
  ui.configure({ ...routeCase("run-workspace"), runState: "running" });
  ui.server.state.run.local = true;
  await page.goto("/runs/run-active", { waitUntil: "domcontentloaded" });
  await ui.settle();

  await expect(page.getByText("Running in the desktop app")).toBeVisible();
  await expect(page.locator("[data-scenario-terminal-ready]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /SSH command/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /End run/ })).toBeVisible();
  await expect(page.getByText("Startup steps")).toHaveCount(0);
  // The lecture and its checks stay beside it.
  await expect(page.getByRole("heading", { name: "Lecture", exact: true })).toBeVisible();
  // No terminal session and no status stream is asked for.
  expect(ui.server.requests.filter((request) => /\/ssh\b|status\/stream/.test(request))).toEqual([]);
});

test("the run history marks a local run", async ({ page, ui }) => {
  ui.configure(routeCase("runs"));
  for (const run of ui.server.state.runs) run.local = true;
  await page.goto("/runs", { waitUntil: "domcontentloaded" });
  await ui.settle();

  // The active run's card and the latest settled attempt both say so.
  await expect(page.getByText("Local run", { exact: true })).toHaveCount(2);
});

test("the instructor's grid marks a cell solved only on local runs", async ({ page, ui }) => {
  ui.configure({ ...routeCase("organization-detail"), organizationRole: "owner" });
  const progress = ui.server.state.progress as { rows: Array<{ cells: Array<{ status: string; local?: boolean }> }> };
  progress.rows.flatMap((row) => row.cells).find((cell) => cell.status === "solved")!.local = true;
  await page.goto(routeCase("organization-detail").path, { waitUntil: "domcontentloaded" });
  await ui.settle();
  await page.getByRole("tab", { name: "Progress" }).click();

  await expect(page.getByText(/Local run/)).toHaveCount(1);
});
