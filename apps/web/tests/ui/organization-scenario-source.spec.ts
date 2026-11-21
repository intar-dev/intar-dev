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
      await route.fulfill({ json: { enabled: true, appSlug: null, workflowRef: "scenario-publish-v1", pipelineWorkflowRef: null, source } });
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
      await route.fulfill({ json: { enabled: true, appSlug: null, workflowRef: "scenario-publish-v1", pipelineWorkflowRef: null, source } });
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

test("a platform administrator switches the platform source's settings on its card", async ({ page, ui }) => {
  let source = { ...disconnected("admin"), disconnectedAt: null, disconnectReason: null };
  const changes: unknown[] = [];
  await page.route("**/api/admin/scenario-source", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: {
        enabled: true, pipelineImages: true, configured: true, appSlug: null, workflowRef: "scenario-publish-v1",
        pipelineWorkflowRef: null, settings: { platform: true, automaticPromotion: true }, source,
      } });
      return;
    }
    const change = request.postDataJSON() as {
      action: string; promotion?: string; producer?: string; allow_self_hosted?: boolean; mode?: string;
    };
    changes.push(change);
    if (change.action === "promotion") source = { ...source, promotion: change.promotion! };
    if (change.action === "image_producer") source = { ...source, imageProducer: change.producer! };
    if (change.action === "runner_policy") source = { ...source, allowSelfHostedRunners: change.allow_self_hosted! };
    if (change.action === "mode") source = { ...source, mode: change.mode! };
    await route.fulfill({ json: { source } });
  });
  await ui.open(routeCase("admin-scenarios"));

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Scenario source" }) });
  await expect(card.getByRole("heading", { name: "Platform settings" })).toBeVisible();
  if (process.env.SOURCE_CARD_SHOTS) await card.screenshot({ path: `${process.env.SOURCE_CARD_SHOTS}/platform.png` });

  // Going automatic asks first, and says what it hands over.
  await card.getByRole("button", { name: "Go live automatically" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("The commit that is the head now stays as it is, unless its workflow is run again.")).toBeVisible();
  expect(changes).toEqual([]);
  await dialog.getByRole("button", { name: "Go live automatically" }).click();
  await expect(dialog).toBeHidden();
  expect(changes).toEqual([{ action: "promotion", promotion: "automatic" }]);
  await expect(card.getByRole("button", { name: "Promote by hand" })).toBeVisible();

  // Going back to by-hand asks too: it ends checks that are running.
  await card.getByRole("button", { name: "Promote by hand" }).click();
  await expect(dialog.getByText("Checks of the latest commit that are running stop")).toBeVisible();
  await dialog.getByRole("button", { name: "Promote by hand" }).click();
  await expect(dialog).toBeHidden();
  expect(changes.at(-1)).toEqual({ action: "promotion", promotion: "manual" });

  // Images and runners switch at once.
  await card.getByRole("button", { name: "Allow self-hosted runners" }).click();
  await expect(card.getByRole("button", { name: "Allow GitHub-hosted runners only" })).toBeVisible();
  expect(changes.at(-1)).toEqual({ action: "runner_policy", allow_self_hosted: true });
  await card.getByRole("button", { name: "Use the repository's pipeline" }).click();
  await expect(card.getByRole("button", { name: "Use Intar's builder" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Switch to pull" })).toBeDisabled();
  expect(changes.at(-1)).toEqual({ action: "image_producer", producer: "pipeline" });

  // Back on the builder, the way to pull asks first.
  await card.getByRole("button", { name: "Use Intar's builder" }).click();
  await card.getByRole("button", { name: "Switch to pull" }).click();
  await expect(dialog.getByText("The repository's publish workflow is refused from then on")).toBeVisible();
  await dialog.getByRole("button", { name: "Switch to pull" }).click();
  await expect(dialog).toBeHidden();
  expect(changes.at(-1)).toEqual({ action: "mode", mode: "pull" });
  await expect(card.getByRole("button", { name: "Switch to push" })).toBeVisible();
});

test("an organization's owner switches its own source's settings", async ({ page, ui }) => {
  let source = { ...disconnected("admin"), disconnectedAt: null, disconnectReason: null };
  const changes: unknown[] = [];
  await page.route(`**${api}`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: {
        enabled: true, pipelineImages: true, appSlug: null, workflowRef: "scenario-publish-v1",
        pipelineWorkflowRef: "scenario-publish-v2",
        settings: { platform: false, automaticPromotion: true }, source,
      } });
      return;
    }
    const change = request.postDataJSON() as { action: string; promotion?: string; producer?: string };
    changes.push(change);
    if (change.action === "promotion") source = { ...source, promotion: change.promotion! };
    if (change.action === "image_producer") source = { ...source, imageProducer: change.producer! };
    await route.fulfill({ json: { source } });
  });
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=settings",
    organizationRole: "owner",
  });

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Scenario source" }) });
  await expect(card.getByRole("heading", { name: "Source settings" })).toBeVisible();
  await expect(card.getByRole("link", { name: "Scenarios" })).toHaveAttribute("href", "/admin/scenarios");
  await expect(card.getByRole("button", { name: "Switch to pull" })).toHaveCount(0);

  await card.getByRole("button", { name: "Use the repository's pipeline" }).click();
  expect(changes).toEqual([{ action: "image_producer", producer: "pipeline" }]);
  // On its pipeline: no way back to the builder here, and no builds page to link.
  await expect(card.getByText("This repository's pipeline builds them")).toBeVisible();
  await expect(card.getByRole("button", { name: "Use Intar's builder" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Builds" })).toHaveCount(0);

  await card.getByRole("button", { name: "Go live automatically" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Go live automatically" }).click();
  expect(changes.at(-1)).toEqual({ action: "promotion", promotion: "automatic" });

  // The setup text names the files the compiler reads, and the pipeline's workflow with its runner.
  await card.getByText("Repository setup").click();
  await expect(card.getByText("intar.hcl")).toBeVisible();
  await expect(card.getByText("scenario-publish.yml@scenario-publish-v2")).toBeVisible();
  await expect(card.getByText("runner: your-kvm-runner")).toBeVisible();
  if (process.env.SOURCE_CARD_SHOTS) await card.screenshot({ path: `${process.env.SOURCE_CARD_SHOTS}/organization.png` });
});

test("an organization's owner reads its pipeline's usage and forgets a recorded image", async ({ page, ui }) => {
  const GIB = 1024 ** 3;
  const source = { ...disconnected("admin"), disconnectedAt: null, disconnectReason: null, imageProducer: "pipeline" };
  let images = [{
    buildKey: `sha256:${"a".repeat(64)}`, architecture: "amd64", imageDigest: `sha256:${"b".repeat(64)}`,
    sizeBytes: 2 * GIB, counted: true, githubRepository: "acme/labs", sha: "c".repeat(40), runId: "42", runAttempt: 1,
    runnerEnvironment: "github-hosted", createdAt: 1,
  }];
  const changes: unknown[] = [];
  await page.route(`**${api}`, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ json: {
        enabled: true, pipelineImages: true, appSlug: null, workflowRef: "scenario-publish-v1",
        pipelineWorkflowRef: "scenario-publish-v2",
        settings: { platform: false, automaticPromotion: true },
        usage: {
          openSessions: { used: 0, limit: 8 }, sessions: { used: 3, limit: 200 },
          uploadedBytes: { used: 4 * GIB, limit: 100 * GIB },
          countedBytes: { used: images.length * 2 * GIB, limit: 50 * GIB },
          images, imageCount: images.length,
        },
        source,
      } });
      return;
    }
    changes.push(request.postDataJSON());
    images = [];
    await route.fulfill({ json: { source } });
  });
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=settings",
    organizationRole: "owner",
  });

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Scenario source" }) });
  await expect(card.getByRole("heading", { name: "Pipeline usage" })).toBeVisible();
  await expect(card.getByText("2.0 GiB of 50.0 GiB")).toBeVisible();
  await expect(card.getByText("4.0 GiB of 100.0 GiB")).toBeVisible();
  await card.getByText("Recorded images (1)").click();
  await expect(card.getByRole("link", { name: "run 42" })).toHaveAttribute(
    "href", "https://github.com/acme/labs/actions/runs/42/attempts/1",
  );
  if (process.env.SOURCE_CARD_SHOTS) await card.screenshot({ path: `${process.env.SOURCE_CARD_SHOTS}/usage.png` });

  await card.getByRole("button", { name: /^Forget the amd64 image/ }).click();
  expect(changes).toEqual([]);
  await expect(page.getByRole("dialog")).toContainText("Revisions that already name the image keep it");
  await page.getByRole("dialog").getByRole("button", { name: "Forget" }).click();
  await expect(card.getByText("Recorded images")).toHaveCount(0);
  expect(changes).toEqual([{ action: "forget_image", build_key: `sha256:${"a".repeat(64)}`, architecture: "amd64" }]);
  await expect(card.getByText("0 B of 50.0 GiB")).toBeVisible();
});
