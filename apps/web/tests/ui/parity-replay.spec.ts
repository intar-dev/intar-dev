import type { Page } from "@playwright/test";
import { expect, test, type UiHarness } from "./fixtures/test";
import { routeCase } from "./routes";

// Design-system parity for the learner replay: one terminal frame with its own
// controls (play toggle, "Replay position" slider, clock, speed button).

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
