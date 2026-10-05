import type { Page } from "@playwright/test";
import { expect, test, type UiHarness } from "./fixtures/test";
import { shareFixtureUrl } from "./fixtures/mock-api";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";

// The owner's side of sharing a run: the entry in the run's actions, the
// dialog that turns it on and off, and the badge the header carries meanwhile.

const EXPLANATION =
  "Anyone with the link can watch this run's terminals (web and SSH) and read the mission. Typed input appears where the terminal echoes it.";

/** The run page with sharing offered; the fixture offers none by default. */
async function openRun(
  page: Page,
  ui: UiHarness,
  runState: Parameters<UiHarness["open"]>[0]["runState"] = "running",
  run: Record<string, unknown> = { canShare: true },
) {
  await ui.open({ ...routeCase("run-workspace"), theme: "light", runState });
  Object.assign(ui.server.state.run, run);
  await page.reload({ waitUntil: "domcontentloaded" });
  await ui.settle();
}

const actions = (page: Page) => page.getByRole("group", { name: "Run actions" });
const dialog = (page: Page) => page.getByRole("dialog");
const badge = (page: Page) => page.getByText("Live · shared");

test.describe("sharing a run", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("offers nothing until the server says sharing is available", async ({
    page,
    ui,
  }) => {
    await ui.open({
      ...routeCase("run-workspace"),
      theme: "light",
      runState: "running",
    });

    await expect(actions(page)).toBeVisible();
    await expect(
      actions(page).getByRole("button", { name: "Share" }),
    ).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
  });

  test("shares the run on request, shows the link, and stops again", async ({
    page,
    ui,
  }, testInfo) => {
    await openRun(page, ui);
    // The page's own policy forbids reading the clipboard, so what is written
    // to it is recorded instead.
    await page.evaluate(() => {
      const copied: string[] = [];
      Object.assign(window, { copied });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
    });

    const share = actions(page).getByRole("button", { name: "Share" });
    await expect(share).toBeVisible();
    await expect(share).toHaveAttribute("aria-haspopup", "dialog");
    await share.click();

    // Off by default: the dialog explains, and shares nothing until asked.
    await expect(dialog(page)).toBeVisible();
    await expect(
      dialog(page).getByRole("heading", { name: "Share this run" }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText(EXPLANATION);
    await expect(dialog(page).getByRole("textbox")).toHaveCount(0);
    expect(ui.server.requests).not.toContain(
      "POST /api/scenarios/runs/run-active/share",
    );
    await expectNoAxeViolations(page, testInfo);

    const posted = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request.url().endsWith("/api/scenarios/runs/run-active/share"),
    );
    await dialog(page).getByRole("button", { name: "Share", exact: true }).click();
    expect((await posted).postDataJSON()).toEqual({ enabled: true });

    // On: the link to copy, a way to open it, and a way to stop.
    const link = dialog(page).getByRole("textbox", { name: "Public link" });
    const first = shareFixtureUrl("http://127.0.0.1:4330", 1);
    await expect(link).toHaveValue(first);
    await expect(link).toHaveAttribute("readonly", "");
    await expect(link).toBeFocused();
    await expect(
      dialog(page).getByRole("heading", { name: "This run is shared" }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText(
      "Stopping ends the link for everyone watching. Sharing again creates a new link.",
    );
    const open = dialog(page).getByRole("link", { name: /^Open/ });
    await expect(open).toHaveAttribute("href", first);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", /noopener/);
    await expect(
      dialog(page).getByRole("button", { name: "Stop sharing" }),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);

    await dialog(page)
      .getByRole("button", { name: "Copy the public link" })
      .click();
    await expect(dialog(page).getByText("Copied").first()).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { copied: string[] }).copied),
    ).toEqual([first]);

    // The header says it is shared while the dialog is closed, too.
    await dialog(page).getByRole("button", { name: "Done" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(badge(page)).toBeVisible();
    await expect(share).toBeFocused();

    // Stopping ends it; sharing again is a different link.
    await share.click();
    await expect(link).toHaveValue(first);
    const stopped = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request.url().endsWith("/api/scenarios/runs/run-active/share") &&
        request.postDataJSON().enabled === false,
    );
    await dialog(page).getByRole("button", { name: "Stop sharing" }).click();
    await stopped;
    await expect(
      dialog(page).getByRole("heading", { name: "Share this run" }),
    ).toBeVisible();
    await expect(dialog(page).getByRole("textbox")).toHaveCount(0);
    await expect(
      dialog(page).getByRole("button", { name: "Share", exact: true }),
    ).toBeFocused();
    await expect(badge(page)).toHaveCount(0);

    await dialog(page).getByRole("button", { name: "Share", exact: true }).click();
    await expect(link).toHaveValue(shareFixtureUrl("http://127.0.0.1:4330", 2));
    await expect(badge(page)).toBeVisible();

    // The run refetch confirms what the server holds.
    expect(ui.server.state.run.share).toEqual({
      url: shareFixtureUrl("http://127.0.0.1:4330", 2),
    });
  });

  test("keeps the dialog open and says what failed when the server refuses", async ({
    page,
    ui,
  }) => {
    await openRun(page, ui);
    await page.route("**/api/scenarios/runs/*/share", (route) => {
      ui.server.expectedUnavailable += 1;
      return route.fulfill({
        status: 503,
        json: { error: "Sharing is paused for maintenance." },
      });
    });

    await actions(page).getByRole("button", { name: "Share" }).click();
    await dialog(page).getByRole("button", { name: "Share", exact: true }).click();

    const alert = dialog(page).getByRole("alert");
    await expect(alert).toContainText("Could not share this run");
    await expect(alert).toContainText("Sharing is paused for maintenance.");
    await expect(dialog(page).getByRole("textbox")).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
    // Try again is the same button, and a closed dialog forgets the failure.
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await actions(page).getByRole("button", { name: "Share" }).click();
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  });

  test("falls back to selecting the link when the clipboard refuses", async ({
    page,
    ui,
  }) => {
    await openRun(page, ui, "running", {
      canShare: false,
      share: { url: shareFixtureUrl("http://127.0.0.1:4330", 7) },
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error("no clipboard here")),
        },
      });
    });

    await actions(page).getByRole("button", { name: "Share" }).click();
    await dialog(page)
      .getByRole("button", { name: "Copy the public link" })
      .click();

    await expect(dialog(page)).toContainText("Could not copy automatically");
    const link = dialog(page).getByRole("textbox", { name: "Public link" });
    await expect(link).toBeFocused();
    expect(
      await link.evaluate((input: HTMLInputElement) =>
        input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
      ),
    ).toBe(shareFixtureUrl("http://127.0.0.1:4330", 7));
  });

  test("lets a finished run that is still shared be stopped", async ({
    page,
    ui,
  }) => {
    await openRun(page, ui, "archived", {
      canShare: false,
      share: { url: shareFixtureUrl("http://127.0.0.1:4330", 3) },
    });

    // The finished run is on the normal page, so Share sits in the app bar.
    await expect(badge(page)).toBeVisible();
    const share = page.getByRole("button", { name: "Share", exact: true });
    await expect(share).toBeVisible();
    await share.click();
    await expect(
      dialog(page).getByRole("textbox", { name: "Public link" }),
    ).toHaveValue(shareFixtureUrl("http://127.0.0.1:4330", 3));
    await dialog(page).getByRole("button", { name: "Stop sharing" }).click();
    await expect(dialog(page).getByRole("textbox")).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
    expect(ui.server.state.run.share).toBeNull();
  });

  test("offers nothing on a finished run that is not shared", async ({
    page,
    ui,
  }) => {
    await openRun(page, ui, "archived", { canShare: true, share: null });

    await expect(
      page.getByRole("button", { name: "Delete run…" }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
  });

  test("keeps Share through a hint that replaces the run record", async ({
    page,
    ui,
  }) => {
    let runReads = 0;
    await page.route("**/api/scenarios/runs/run-active", async (route) => {
      if (route.request().method() === "GET") runReads += 1;
      await route.fallback();
    });
    await openRun(page, ui);
    const share = actions(page).getByRole("button", { name: "Share" });
    await expect(share).toBeVisible();
    const readsBefore = runReads;

    // The hint's response is a record that does not say whether sharing is
    // offered (only the run view does): the last answer stands, so Share does
    // not leave and the run is not read again to ask.
    const panel = page.locator("[data-run-learning-panel]");
    await panel.getByRole("button", { name: "Reveal", exact: true }).first().click();
    await expect(
      panel.getByText("Inspect the service boundary", { exact: true }),
    ).toBeVisible();
    await expect(share).toBeVisible();
    await page.waitForTimeout(300);
    await expect(share).toBeVisible();
    expect(runReads).toBe(readsBefore);
  });

  test("asks the run view once when the start's record has not been asked", async ({
    page,
    ui,
  }) => {
    ui.configure({ sessionRole: "learner", runState: "running" });
    Object.assign(ui.server.state.run, { canShare: true });
    let runReads = 0;
    await page.route("**/api/scenarios/runs/run-active", async (route) => {
      if (route.request().method() === "GET") runReads += 1;
      await route.fallback();
    });

    // The start's response is the record without the answer; the run page
    // asks for the full record once and then offers Share.
    await page.goto("/runs/start/repair-nginx", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL("/runs/run-active");
    await expect(
      actions(page).getByRole("button", { name: "Share" }),
    ).toBeVisible();
    expect(runReads).toBe(1);
  });
});

test.describe("sharing a run on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("folds Share into the run's menu so the status line keeps its room", async ({
    page,
    ui,
  }) => {
    await openRun(page, ui);

    // SSH, Share and End would cover the status line, so they share one menu.
    await expect(
      actions(page).getByRole("button", { name: "Share" }),
    ).toHaveCount(0);
    const more = actions(page).getByRole("button", { name: "More run actions" });
    await more.click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "SSH command",
      "Share",
      "End run…",
    ]);
    await page.getByRole("menuitem", { name: "Share" }).click();
    await expect(dialog(page)).toContainText(EXPLANATION);
    await dialog(page).getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      dialog(page).getByRole("textbox", { name: "Public link" }),
    ).toBeVisible();
    await dialog(page).getByRole("button", { name: "Done" }).click();

    // Shared: the badge sits with the status, and nothing covers it.
    await expect(badge(page)).toBeVisible();
    const header = page.locator("[data-run-workspace-header]");
    const status = await header.getByText("In progress").boundingBox();
    const menu = await more.boundingBox();
    expect(status!.x + status!.width).toBeLessThanOrEqual(menu!.x);
    const badgeBox = await badge(page).boundingBox();
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(menu!.x);
  });

  test("folds Share into the menu on a phone on its side too", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 800, height: 420 });
    await openRun(page, ui);

    await actions(page)
      .getByRole("button", { name: "More run actions" })
      .click();
    await page.getByRole("menuitem", { name: "Share" }).click();
    await expect(dialog(page)).toContainText(EXPLANATION);
  });

  test("keeps two actions as icon buttons that carry their names", async ({
    page,
    ui,
  }) => {
    // A solved run has no End run, so SSH and Share fit as icons.
    await openRun(page, ui, "solved");

    const share = actions(page).getByRole("button", { name: "Share" });
    await expect(share).toBeVisible();
    await expect(
      actions(page).getByRole("button", { name: "More run actions" }),
    ).toHaveCount(0);
    await share.click();
    await expect(dialog(page)).toContainText(EXPLANATION);
  });
});
