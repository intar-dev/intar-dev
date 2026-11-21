import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

const api = "/api/organizations/org-platform/scenario-source";
const disconnected = (disconnectReason: string) => ({
  repository: "acme/labs",
  defaultBranch: "main",
  mode: "push",
  imageProducer: "builder",
  allowSelfHostedRunners: false,
  promotion: "manual",
  pausedAt: null,
  pauseReason: null,
  disconnectedAt: 1,
  disconnectReason,
  liveSha: null,
  liveAt: null,
  commit: null,
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

test("a pull source is offered its way to push, in the order that works", async ({ page, ui }) => {
  let source = { ...disconnected("admin"), disconnectedAt: null, disconnectReason: null, mode: "pull" };
  const changes: unknown[] = [];
  await page.route(`**${api}`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: { enabled: true, appSlug: null, source } });
      return;
    }
    changes.push(request.postDataJSON());
    source = { ...source, mode: "push" };
    await route.fulfill({ json: { source } });
  });
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=settings",
    organizationRole: "owner",
  });

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Scenario source" }) });
  await expect(card.getByText("Delivery mode")).toHaveCount(0);
  await expect(card.getByText("switch to push first, then commit the workflow file")).toBeVisible();
  await expect(card.getByText("Built by Intar's builder")).toBeVisible();
  await expect(card.getByText("An administrator promotes each lab")).toBeVisible();
  await expect(card.getByRole("link", { name: "Builds" })).toBeVisible();
  if (process.env.SOURCE_CARD_SHOTS) await card.screenshot({ path: `${process.env.SOURCE_CARD_SHOTS}/pull.png` });
  await card.getByRole("button", { name: "Switch to push" }).click();

  expect(changes).toEqual([{ action: "mode", mode: "push" }]);
  await expect(card.getByRole("button", { name: "Switch to push" })).toBeHidden();
  await expect(card.getByText("Waiting for the first workflow run")).toBeVisible();
  if (process.env.SOURCE_CARD_SHOTS) await card.screenshot({ path: `${process.env.SOURCE_CARD_SHOTS}/push.png` });
});
