import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

const api = "/api/organizations/org-platform/scenario-source";
const disconnected = (disconnectReason: string) => ({
  repository: "acme/labs",
  defaultBranch: "main",
  mode: "pull",
  pausedAt: null,
  pauseReason: null,
  disconnectedAt: 1,
  disconnectReason,
  liveSha: null,
  liveAt: null,
  activeRuns: 0,
  commit: null,
  builds: [],
});

test("an owner deletes what a disconnected repository published", async ({ page, ui }) => {
  let source: ReturnType<typeof disconnected> | null = disconnected("admin");
  const purges: unknown[] = [];
  await page.route(`**${api}`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { enabled: true, appSlug: null, source } });
      return;
    }
    purges.push(request.postDataJSON());
    // The first request leaves runs for a second one.
    source = purges.length === 1 ? disconnected("purging") : null;
    await route.fulfill({ json: { source } });
  });
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=settings",
    organizationRole: "owner",
  });

  await page.getByRole("button", { name: "Delete courses and scenarios" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Delete everything" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Repository name confirmation").fill("acme/lab");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Repository name confirmation").fill("acme/labs");
  await confirm.click();

  await expect(dialog).toBeHidden();
  expect(purges).toEqual([{ action: "purge" }, { action: "purge" }]);
  await expect(page.getByRole("button", { name: "Delete courses and scenarios" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Connect repository" })).toBeVisible();
});
