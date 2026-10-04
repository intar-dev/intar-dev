import type { Page } from "@playwright/test";
import { expect, test, type UiHarness } from "./fixtures/test";
import { routeCase } from "./routes";

// Decisions 1, 35 and 36: the recorder writes each check's first pass into
// the cast as an asciicast "m" event; the learner replay marks them on its
// track, names them in the slider's value text, jumps between them with Page
// Up and Page Down, and announces them as playback passes them. The screen
// fades at the top and keeps a 14px by 16px inset around the player.

// The fixture run's machine has two checks: nginx-listening ("Start the web
// server", check 1) and health-endpoint ("Make the site reachable", check 2).
// A 12 s cast passes them at 0:03 and 0:09; the startup probe's marker at
// 0:05 is not one of the run's checks and stays off the track.
const MARKED_CAST = [
  '{"version":3,"term":{"cols":80,"rows":24},"timestamp":1783670400}',
  ...Array.from({ length: 12 }, (_, index) => {
    const second = index + 1;
    const lines = [`[1.0,"o","line ${second}\\r\\n"]`];
    if (second === 3) lines.push('[0,"m","nginx-listening"]');
    if (second === 5) lines.push('[0,"m","boot-ready"]');
    if (second === 9) lines.push('[0,"m","health-endpoint"]');
    return lines.join("\n");
  }),
].join("\n");

async function useCast(page: Page, body: string) {
  await page.route("**/api/runs/*/artifacts/*/content", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body,
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
  await expect(
    replay.getByRole("slider", { name: "Replay position" }),
  ).toBeEnabled();
  return replay;
}

test.describe("replay check markers", () => {
  test("marks each verified check on the track with an inward-anchored tip", async ({
    page,
    ui,
  }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const marks = replay.locator(".replay-scrub__mark");

    await expect(marks).toHaveCount(2);
    await expect(marks.nth(0)).toHaveAttribute(
      "data-tip",
      "Check 1 verified · 0:03",
    );
    await expect(marks.nth(1)).toHaveAttribute(
      "data-tip",
      "Check 2 verified · 0:09",
    );
    // A quarter of the way in, the tip anchors to the start; three quarters
    // in, to the end.
    await expect(marks.nth(0)).toHaveAttribute("data-edge", "start");
    await expect(marks.nth(1)).toHaveAttribute("data-edge", "end");
    await expect(marks.nth(0)).toHaveAttribute("aria-hidden", "true");
    await expect(marks.nth(0)).not.toHaveAttribute("data-passed", /.*/);

    // The marker sits on the track where its check passed.
    const control = await replay.locator(".replay-scrub__control").boundingBox();
    const mark = await marks.nth(1).boundingBox();
    expect(control && mark).toBeTruthy();
    const at = (mark!.x + mark!.width / 2 - control!.x) / control!.width;
    expect(at).toBeCloseTo(0.75, 1);

    // Hovering shows the tip.
    await marks.nth(1).hover();
    await expect
      .poll(() =>
        marks
          .nth(1)
          .evaluate((element) => getComputedStyle(element, "::after").opacity),
      )
      .toBe("1");
  });

  test("names verified checks in the value text and jumps between them with Page keys", async ({
    page,
    ui,
  }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const slider = replay.getByRole("slider", { name: "Replay position" });
    const marks = replay.locator(".replay-scrub__mark");
    const clock = replay.locator(".replay-time");

    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "0:00 of 0:12, 0 of 2 checks verified",
    );

    await slider.focus();
    await page.keyboard.press("PageDown");
    await expect(clock).toHaveText("0:03 / 0:12");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "0:03 of 0:12, 1 of 2 checks verified",
    );
    await expect(marks.nth(0)).toHaveAttribute("data-passed", "");
    await expect(marks.nth(1)).not.toHaveAttribute("data-passed", /.*/);

    await page.keyboard.press("PageDown");
    await expect(clock).toHaveText("0:09 / 0:12");
    await expect(slider).toHaveAttribute(
      "aria-valuetext",
      "0:09 of 0:12, 2 of 2 checks verified",
    );
    await expect(marks.nth(1)).toHaveAttribute("data-passed", "");

    // Past the last check, the end.
    await page.keyboard.press("PageDown");
    await expect(clock).toHaveText("0:12 / 0:12");

    await page.keyboard.press("PageUp");
    await expect(clock).toHaveText("0:09 / 0:12");
    await page.keyboard.press("PageUp");
    await expect(clock).toHaveText("0:03 / 0:12");
    await page.keyboard.press("PageUp");
    await expect(clock).toHaveText("0:00 / 0:12");
    await expect(marks.nth(0)).not.toHaveAttribute("data-passed", /.*/);
  });

  test("a jump onto a check says which one, and its tip opens with focus", async ({
    page,
    ui,
  }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const slider = replay.getByRole("slider", { name: "Replay position" });
    const status = replay.locator('p[role="status"]');

    await slider.focus();
    await page.keyboard.press("PageDown");
    await expect(status).toHaveText("Check 1 verified: Start the web server.");
    const first = replay.locator(".replay-scrub__mark").nth(0);
    await expect(first).toHaveAttribute("data-current", "");
    await expect
      .poll(() =>
        first.evaluate((el) => getComputedStyle(el, "::after").opacity),
      )
      .toBe("1");

    // Back and forward onto the same check: the same words are spoken again.
    await page.keyboard.press("PageUp");
    await expect(status).toHaveText("Check 1 verified: Start the web server.");
    const before = await status.locator("span").elementHandle();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => before?.evaluate((el) => el.isConnected))
      .toBe(false);
    await expect(status).toHaveText("Check 1 verified: Start the web server.");

    // A tap on a marker says it too.
    await replay.locator(".replay-scrub__mark").nth(1).click();
    await expect(status).toHaveText(
      "Check 2 verified: Make the site reachable.",
    );
  });

  test("a marker is a jump target", async ({ page, ui }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);

    await replay.locator(".replay-scrub__mark").nth(1).click();
    await expect(replay.locator(".replay-time")).toHaveText("0:09 / 0:12");
    await expect(
      replay.getByRole("slider", { name: "Replay position" }),
    ).toBeFocused();
  });

  test("announces each check politely as playback passes it", async ({
    page,
    ui,
  }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const status = replay.locator('p[role="status"]');
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveText("");

    // Every announcement, in order, however quickly playback passes them.
    await status.evaluate((element) => {
      const said: string[] = [];
      (window as unknown as { said: string[] }).said = said;
      new MutationObserver(() => {
        if (element.textContent) said.push(element.textContent);
      }).observe(element, { childList: true, characterData: true, subtree: true });
    });

    const speed = replay.getByRole("button", { name: /^Playback speed: / });
    await speed.click();
    await speed.click();
    await replay.getByRole("button", { name: "Play replay" }).click();
    await expect(
      replay.getByRole("button", { name: "Replay from the start" }),
    ).toBeVisible({ timeout: 10_000 });

    expect(
      await page.evaluate(() => (window as unknown as { said: string[] }).said),
    ).toEqual([
      "Check 1 verified: Start the web server.",
      "Check 2 verified: Make the site reachable.",
    ]);

    // A seek passes checks without announcing them.
    const slider = replay.getByRole("slider", { name: "Replay position" });
    await slider.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    expect(
      await page.evaluate(
        () => (window as unknown as { said: string[] }).said.length,
      ),
    ).toBe(2);
  });

  test("a cast recorded before markers keeps the plain value text", async ({
    page,
    ui,
  }) => {
    const replay = await openReplay(page, ui);
    await expect(replay.locator(".replay-scrub__mark")).toHaveCount(0);
    await expect(
      replay.getByRole("slider", { name: "Replay position" }),
    ).toHaveAttribute("aria-valuetext", /^\d+:\d\d of \d+:\d\d$/);
  });
});

test.describe("replay screen", () => {
  test("insets the player 14px by 16px and fades the top edge", async ({
    page,
    ui,
  }) => {
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const screen = replay.locator(".replay-screen");

    await expect(screen).toHaveCSS("padding", "14px 16px");
    await expect(screen).toHaveCSS("box-sizing", "content-box");
    await expect(replay.locator(".replay-custom")).toHaveCSS(
      "mask-image",
      /linear-gradient/,
    );

    // The inset sits outside the player: the screen's content box keeps the
    // cast's aspect ratio and the fitted player stays inside it.
    const box = await screen.evaluate((element) => {
      const style = getComputedStyle(element);
      const content = element.getBoundingClientRect();
      const player = element
        .querySelector(".ap-player")!
        .getBoundingClientRect();
      const left = content.left + parseFloat(style.paddingLeft);
      const top = content.top + parseFloat(style.paddingTop);
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      return {
        ratio: width / height,
        aspect: style.aspectRatio,
        inside:
          player.left >= left - 0.5 &&
          player.top >= top - 0.5 &&
          player.right <= left + width + 0.5 &&
          player.bottom <= top + height + 0.5,
      };
    });
    expect(box.inside).toBe(true);
    const [w, h] = box.aspect.split("/").map((part) => Number(part.trim()));
    expect(box.ratio).toBeCloseTo((w ?? 0) / (h ?? 1), 2);
  });

  test("keeps the inset on a phone, where the screen scrolls sideways", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await useCast(page, MARKED_CAST);
    const replay = await openReplay(page, ui);
    const screen = replay.locator(".replay-screen");

    await expect(screen).toHaveCSS("padding", "14px 16px");
    await expect(screen).toHaveCSS("overflow-x", "auto");
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});
