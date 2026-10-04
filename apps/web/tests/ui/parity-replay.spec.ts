import type { Page } from "@playwright/test";
import { expect, test, type UiHarness } from "./fixtures/test";
import { routeCase } from "./routes";

// Design-system parity for the learner replay: one terminal frame with its own
// controls (play toggle, "Replay position" slider, clock, speed button).

// The fixture cast lasts 0.2 s, too short to hold a position. This one runs
// 11.3412 s, which is off the scrub track's 0.01 s step grid.
const LONG_CAST = [
  '{"version":2,"width":120,"height":30,"timestamp":1783670400,"env":{"TERM":"xterm-256color"}}',
  ...Array.from({ length: 11 }, (_, index) => `[${index + 1},"o","line ${index + 1}\\r\\n"]`),
  '[11.3412,"o","done\\r\\n"]',
].join("\n");

async function useLongCast(page: Page) {
  await page.route("**/api/runs/*/artifacts/*/content", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: LONG_CAST,
    }),
  );
}

async function openReplay(page: Page, ui: UiHarness) {
  await ui.open({
    ...routeCase("run-workspace"),
    theme: "light",
    runState: "replay",
  });
  await page.getByRole("button", { name: "Watch replay" }).click();
  const replay = page.locator("[data-run-recap-replay-surface]");
  await expect(replay.locator(".replay-bar")).toBeVisible();
  return replay;
}

test.describe("learner replay", () => {
  test("uses its own controls, never the player's bar or shortcuts", async ({
    page,
    ui,
  }) => {
    const replay = await openReplay(page, ui);

    // One frame, always dark in the light theme, with the player's own bar,
    // start overlay and text-layer tab stop gone.
    await expect(replay.locator(".replay-frame")).toHaveCSS(
      "background-color",
      "rgb(15, 17, 20)",
    );
    await expect(replay.locator(".ap-control-bar")).toHaveCount(0);
    await expect(replay.locator(".ap-overlay-start")).toBeHidden();
    await expect(replay.locator(".ap-term-text")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expect(replay.locator('[role="group"]').first()).toHaveAttribute(
      "aria-label",
      /^Terminal replay/,
    );

    // Keys pressed on the screen do not reach the player's shortcuts.
    await replay.locator(".ap-term").click();
    await page.keyboard.press("f");
    await page.keyboard.press("?");
    await page.keyboard.press("Space");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(replay.locator(".ap-overlay-help")).toHaveCount(0);
    await expect(
      replay.getByRole("button", { name: "Play replay" }),
    ).toBeVisible();
  });

  test("the track is a named slider with value text and a 2 second key step", async ({
    page,
    ui,
  }) => {
    const replay = await openReplay(page, ui);
    const slider = replay.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeEnabled();
    // A native range input: its min is the slider's lower bound for
    // assistive technology, so no aria-valuemin is repeated on it.
    await expect(slider).toHaveAttribute("min", "0");
    await expect(slider).toHaveAttribute("aria-valuetext", /^\d+:\d\d of \d+:\d\d$/);

    await slider.focus();
    await page.keyboard.press("End");
    // At the end the toggle becomes the replay arrow.
    await expect(
      replay.getByRole("button", { name: "Replay from the start" }),
    ).toBeVisible();
    await page.keyboard.press("Home");
    await expect(
      replay.getByRole("button", { name: "Play replay" }),
    ).toBeVisible();
  });

  test("the toggle names its state and the speed button cycles 1, 2, 4", async ({
    page,
    ui,
  }) => {
    const replay = await openReplay(page, ui);
    const speed = replay.getByRole("button", { name: /^Playback speed: / });

    await expect(speed).toHaveAttribute("aria-label", "Playback speed: 1×");
    await speed.click();
    await expect(speed).toHaveAttribute("aria-label", "Playback speed: 2×");
    await speed.click();
    await expect(speed).toHaveAttribute("aria-label", "Playback speed: 4×");
    await speed.click();
    await expect(speed).toHaveAttribute("aria-label", "Playback speed: 1×");

    await expect(replay.locator(".replay-time")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(replay.locator(".replay-time")).toHaveText(
      /^\d+:\d\d \/ \d+:\d\d$/,
    );
  });

  test("crossing bp-md keeps the position instead of restarting the replay", async ({
    page,
    ui,
  }) => {
    await useLongCast(page);
    const replay = await openReplay(page, ui);
    const slider = replay.getByRole("slider", { name: "Replay position" });
    const clock = replay.locator(".replay-time");
    await expect(slider).toBeEnabled();
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(clock).toHaveText(/^0:02 \//);

    // The cast fits another way below bp-md, so the player is created again.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(replay.locator(".ap-player")).toHaveCSS("font-size", "13px");
    await expect(slider).toBeEnabled();
    await expect(clock).toHaveText(/^0:02 \//);
    await expect(
      replay.getByRole("button", { name: "Play replay" }),
    ).toBeVisible();
  });

  test("dragging the thumb to the far end reaches the end of the cast", async ({
    page,
    ui,
  }) => {
    await useLongCast(page);
    const replay = await openReplay(page, ui);
    const control = replay.locator(".replay-scrub__control");
    await expect(
      replay.getByRole("slider", { name: "Replay position" }),
    ).toBeEnabled();
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    const y = box!.y + box!.height / 2;
    await page.mouse.move(box!.x + box!.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width + 40, y, { steps: 4 });
    await page.mouse.up();

    await expect(
      replay.getByRole("button", { name: "Replay from the start" }),
    ).toBeVisible();
  });

  test("on a phone the screen scrolls sideways and takes a keyboard stop", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const replay = await openReplay(page, ui);
    const screen = replay.locator(".replay-screen");

    await expect(screen).toHaveAttribute("role", "region");
    await expect(screen).toHaveAttribute("tabindex", "0");
    await expect(screen).toHaveCSS("overflow-x", "auto");
    // The recorded grid keeps a 13px cell instead of shrinking to fit.
    await expect(replay.locator(".ap-player")).toHaveCSS("font-size", "13px");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});
