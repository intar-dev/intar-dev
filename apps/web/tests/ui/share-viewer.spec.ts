import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { SHARE_CHECKPOINT_SEGMENTS } from "@/lib/run-share/protocol";
import {
  SHARE_ID,
  SHARE_LIVE_TEST_ORIGIN,
  fastRetries,
  openShare,
  shareDetach,
  shareEnd,
  shareEvents,
  shareGap,
  shareHistory as history,
  shareMission as mission,
  shareStart,
} from "./fixtures/share-live";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

// The public page of a shared run, reading a share's files from a CDN that the
// test stands in for (fixtures/share-live.ts). New output reaches the page on
// its next poll of the head, about a second after it is published.

/**
 * Where an element is once it has stopped moving: the terminal draws again
 * when its font arrives, and a point taken before that misses the link.
 */
async function settledBox(locator: Locator) {
  let previous = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const box = await locator.boundingBox();
    const current = JSON.stringify(box);
    if (box && current === previous) return box;
    previous = current;
    await locator.page().waitForTimeout(100);
  }
  throw new Error("the element never stopped moving");
}

/** The terminal in front; the one a tab just left is hidden for a moment, not yet gone. */
const screenOf = (page: Page) => page.locator(".xterm-rows:visible");

const tabs = (page: Page) =>
  page.getByRole("tablist", { name: "Terminal sessions" }).getByRole("tab");

/** A long share: `count` segments, each one line of output on the learner's screen. */
function longShare(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const line = shareEvents("s-web", [
      [index * 100, "o", `line ${index + 1}\r\n`],
    ]);
    return index === 0 ? [shareStart("s-web"), line] : [line];
  });
}

/** The header's own word for the share, which is also said once more to screen readers. */
const headerStatus = (page: Page, word: string) =>
  page.getByText(word, { exact: true }).first();

test.describe("shared run page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the mission, a tab per session and the live screen at 16pt", async ({
    page,
    ui,
  }) => {
    // Slow answers, so the page can be seen while it is still reading.
    const live = await openShare(page, ui, { history, delay: 1_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live run");
    await expect(headerStatus(page, "Connecting…")).toBeVisible();

    // The mission: title, tagline, lecture, objectives (not their hidden detail) and the markdown.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      mission.title,
    );
    await expect(page.getByText(mission.tagline)).toBeVisible();
    const aside = page.getByRole("complementary", { name: "Mission" });
    await expect(aside.getByText("Start the web server")).toBeVisible();
    await expect(aside.getByText("Return a healthy response")).toBeVisible();
    await expect(aside.getByText("HIDDEN_OBJECTIVE_DETAIL")).toHaveCount(0);
    await expect(
      aside.getByRole("heading", { name: "Service recovery" }),
    ).toBeVisible();
    await expect(
      aside.getByRole("heading", { name: "Why services fail", level: 3 }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/Repair a broken nginx service/);

    // One tab per session, numbered per machine, each marked Web or SSH.
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toContainText("web · 1");
    await expect(tabs(page).nth(0)).toContainText("Web");
    await expect(tabs(page).nth(1)).toContainText("web · 2");
    await expect(tabs(page).nth(1)).toContainText("SSH");
    // The newest running terminal is the one in front.
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(1);
    await expect(headerStatus(page, "Live")).toBeVisible();

    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("systemctl status nginx");
    await expect(screen).toContainText("nginx.service: failed");
    // 16pt, so it still reads when the page is captured for a stream.
    await expect(screen).toHaveCSS("font-size", "21px");
    await expect(screen).toHaveCSS("font-family", /IBM Plex Mono/);

    // The files come from the CDN, under the share's id, head first.
    expect(live.requests[0]).toBe("head.json");
    expect(live.urls.every((url) => url.startsWith(`${SHARE_LIVE_TEST_ORIGIN}/${SHARE_ID}/`))).toBe(true);

    // Output published later is drawn as it comes.
    live.publish(shareEvents("s-web", [[2_000, "o", "live line two\r\n"]]));
    await expect(screen).toContainText("live line two");
  });

  test("polls the head about once a second, and reads every other file once", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    await expect(tabs(page)).toHaveCount(2);

    live.publish(shareEvents("s-web", [[2_000, "o", "second\r\n"]]));
    await expect(screenOf(page)).toContainText("second");
    live.publish(shareEvents("s-web", [[3_000, "o", "third\r\n"]]));
    await expect(screenOf(page)).toContainText("third");

    expect(live.count("head.json")).toBeGreaterThanOrEqual(3);
    for (const file of [
      "mission.json",
      "g1/1.jsonl",
      "g1/2.jsonl",
      "g1/3.jsonl",
      "g1/4.jsonl",
    ]) {
      expect(live.count(file), file).toBe(1);
    }
  });

  test("joins a long share by reading every segment, once and in order", async ({
    page,
    ui,
  }) => {
    const segments = Array.from({ length: 30 }, (_, index) => {
      const line = shareEvents("s-web", [
        [index * 100, "o", `line ${index + 1}\r\n`],
      ]);
      return index === 0 ? [shareStart("s-web"), line] : [line];
    });
    const live = await openShare(page, ui, { history: segments });

    // The last lines are on the screen, in order: none lost, none doubled. (A
    // row's text runs straight into the next one's in the page.)
    await expect(screenOf(page)).toContainText(
      "line 20line 21line 22line 23line 24line 25line 26line 27line 28line 29line 30",
    );
    await expect(headerStatus(page, "Live")).toBeVisible();
    for (let segment = 1; segment <= 30; segment += 1) {
      expect(live.count(`g1/${segment}.jsonl`), `segment ${segment}`).toBe(1);
    }
  });

  test("joins a share past its first checkpoint through the checkpoints, and reads only the segments after them", async ({
    page,
    ui,
  }) => {
    const N = SHARE_CHECKPOINT_SEGMENTS;
    const live = await openShare(page, ui, { history: longShare(2 * N + 10) });

    // Everything is on the screen, in order, from two checkpoints and ten segments.
    await expect(screenOf(page)).toContainText(
      `line ${2 * N + 8}line ${2 * N + 9}line ${2 * N + 10}`,
    );
    await expect(headerStatus(page, "Live")).toBeVisible();
    await expect(tabs(page)).toHaveCount(1);
    expect(live.count("g1/c1.jsonl")).toBe(1);
    expect(live.count("g1/c2.jsonl")).toBe(1);
    // None of the 120 segments the checkpoints hold is read on its own.
    for (let segment = 1; segment <= 2 * N; segment += 1) {
      expect(live.count(`g1/${segment}.jsonl`), `segment ${segment}`).toBe(0);
    }
    for (let segment = 2 * N + 1; segment <= 2 * N + 10; segment += 1) {
      expect(live.count(`g1/${segment}.jsonl`), `segment ${segment}`).toBe(1);
    }

    // Following from here, it reads segments, and the new line is drawn.
    live.publish(shareEvents("s-web", [[99_000, "o", "a line after joining\r\n"]]));
    await expect(screenOf(page)).toContainText("a line after joining");
    expect(live.count(`g1/${2 * N + 11}.jsonl`)).toBe(1);
    expect(live.count("g1/c3.jsonl")).toBe(0);
  });

  test("keeps reading segments, never a checkpoint, while it keeps up", async ({
    page,
    ui,
  }) => {
    const N = SHARE_CHECKPOINT_SEGMENTS;
    const live = await openShare(page, ui, { history: longShare(10) });
    await expect(screenOf(page)).toContainText("line 10");

    // A minute of output arrives at once, and a checkpoint is completed.
    live.publishAll(longShare(N + 20).slice(10));
    await expect(screenOf(page)).toContainText(`line ${N + 20}`);

    expect(live.count("g1/c1.jsonl")).toBe(0);
    for (let segment = 1; segment <= N + 20; segment += 1) {
      expect(live.count(`g1/${segment}.jsonl`), `segment ${segment}`).toBe(1);
    }
  });

  test("pauses the screen while output keeps arriving, and catches up on resume", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("nginx.service: failed");

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(
      page.getByText("New output is held until you resume."),
    ).toBeVisible();
    live.publish(shareEvents("s-web", [[3_000, "o", "typed while paused\r\n"]]));
    // Give the page every poll it needs to see it; it must not draw it.
    const polls = live.count("head.json");
    await expect.poll(() => live.count("head.json")).toBeGreaterThan(polls + 1);
    await expect.poll(() => live.count("g1/3.jsonl")).toBe(1);
    await expect(screen).not.toContainText("typed while paused");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(screen).toContainText("typed while paused");
    // Live again: the next line follows without another click.
    live.publish(shareEvents("s-web", [[4_000, "o", "and after resuming\r\n"]]));
    await expect(screen).toContainText("and after resuming");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("replays an ended session, which opens as a replay at 16pt", async ({
    page,
    ui,
  }) => {
    await openShare(page, ui, { history });
    await expect(tabs(page)).toHaveCount(2);

    // The ended SSH session has no live dot, and says it joined mid-session.
    await tabs(page).nth(1).click();
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText(
        "Joined mid-session — the screen fills in as it redraws",
      ),
    ).toBeVisible();
    const slider = page.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeVisible();
    await expect(slider).toBeEnabled();
    await expect(page.locator(".xterm-rows")).toHaveCount(0);
    // The player draws it at the same size as the live screen.
    await expect
      .poll(() =>
        page
          .locator(".run-artifact-player .ap-term")
          .first()
          .evaluate((element) => getComputedStyle(element).fontSize),
      )
      .toBe("21px");

    // The final screen is one click away, and the replay again after it.
    await page.getByRole("button", { name: "Show final screen" }).click();
    await expect(page.locator(".xterm-rows")).toContainText("echo done");
    await page.getByRole("button", { name: "Replay from start" }).click();
    await expect(slider).toBeVisible();
  });

  test("plays a replay at the speed the learner typed, and shortens only a long pause", async ({
    page,
    ui,
  }) => {
    await openShare(page, ui, {
      history: [
        [
          shareStart("s-fast", { mode: "native" }),
          // Keys a second apart: below the idle limit, so as they were typed.
          shareEvents("s-fast", [
            [0, "o", "a"],
            [1_000, "o", "b"],
            [2_000, "o", "c"],
            [3_000, "o", "d"],
          ]),
          shareEnd("s-fast"),
          shareStart("s-pause", { mode: "native" }),
          // Ten seconds of nothing: the player's idle limit (1.5 s) takes over.
          shareEvents("s-pause", [
            [0, "o", "a"],
            [10_000, "o", "b"],
          ]),
          shareEnd("s-pause"),
        ],
      ],
    });
    await expect(tabs(page)).toHaveCount(2);

    // An ended session opens as a replay, and at normal speed. (A tab that was
    // left keeps its own clock in the page, hidden.)
    const clock = page.locator(".replay-time:visible");
    await expect(clock).toHaveText("0:00 / 0:01");
    await expect(
      page.getByRole("button", { name: "Playback speed: 1×" }),
    ).toBeVisible();

    await tabs(page).nth(0).click();
    await expect(clock).toHaveText("0:00 / 0:03");
    await expect(
      page.getByRole("button", { name: "Playback speed: 1×" }),
    ).toBeVisible();

    // Played, it takes the time the typing took: half a second in, the clock
    // has not moved a second, and it gets there on schedule.
    await page.getByRole("button", { name: "Play replay" }).click();
    await page.waitForTimeout(400);
    await expect(clock).toHaveText("0:00 / 0:03");
    await expect(clock).toHaveText("0:01 / 0:03");
  });

  test("a running session opens live and replays from the start on request", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    await expect(page.locator(".xterm-rows")).toContainText("nginx.service");

    await page.getByRole("button", { name: "Replay from start" }).click();
    const slider = page.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeEnabled();
    await expect(page.locator(".xterm-rows")).toHaveCount(0);

    // A replay is a recording up to now: the session goes on without it.
    live.publish(
      shareEvents("s-web", [[2_000, "o", "after the replay opened\r\n"]]),
    );
    await expect.poll(() => live.count("g1/3.jsonl")).toBe(1);
    await page.getByRole("button", { name: "Back to live" }).click();
    await expect(page.locator(".xterm-rows")).toContainText(
      "after the replay opened",
    );
    await expect(page.getByRole("slider")).toHaveCount(0);
  });

  test("brings a new session to the front while the viewer follows, and not once they leave", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");

    // The viewer has not moved, so the new session takes the front.
    live.publish(
      shareStart("s-web-3", { vm_id: "vm_db", mode: "native" }),
      shareEvents("s-web-3", [[0, "o", "postgres@db:~$ "]]),
    );
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).nth(2)).toContainText("db · 1");
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(screenOf(page)).toContainText("postgres@db");

    // Leaving for an older tab means the next session no longer takes over.
    await tabs(page).nth(0).click();
    await expect(screenOf(page)).toContainText("systemctl status");
    live.publish(shareStart("s-web-4"));
    await expect(tabs(page)).toHaveCount(4);
    await expect(tabs(page).nth(3)).toContainText("web · 3");
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
    // Going back to the newest tab follows again.
    await tabs(page).nth(3).click();
    live.publish(shareStart("s-web-5"));
    await expect(tabs(page)).toHaveCount(5);
    await expect(tabs(page).nth(4)).toHaveAttribute("aria-selected", "true");
  });

  test("notes dropped output, truncated replays, and a connection that dropped", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, {
      truncated: true,
      history: [
        [shareStart("s-web"), shareGap("s-web", 65_536), shareDetach("s-web")],
      ],
    });

    await expect(page.getByText("Replay truncated")).toBeVisible();
    // Past the size limit nothing more is published, so this says so, and does
    // not promise live output.
    await expect(
      page.getByText("This share reached its size limit, so later output isn't shown."),
    ).toBeVisible();
    await expect(page.getByText("Live output keeps arriving")).toHaveCount(0);
    await expect(page.getByText("Some output was dropped")).toBeVisible();
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toBeVisible();
    // The writer came back: the same tab is live again, with no extra tab.
    live.publish(shareStart("s-web", { resumed: true }));
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(1);
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(1);
  });

  test("keeps what it has through failed reads, and reads only what is new once they stop", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    await expect(screenOf(page)).toContainText("nginx.service");
    await expect(headerStatus(page, "Live")).toBeVisible();

    // Two reads of the head fail (a rate limit, a blip), while output goes on.
    live.failHeads(2);
    live.publish(
      shareEvents("s-web", [[2_500, "o", "output from while away\r\n"]]),
    );
    await expect(headerStatus(page, "Reconnecting…")).toBeVisible();
    // What was on the screen stays, and nothing is called live of the session.
    await expect(screenOf(page)).toContainText("nginx.service: failed");
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(0);

    // The share comes back: it carries on from the segment it was at.
    await expect(screenOf(page)).toContainText("output from while away", {
      timeout: 12_000,
    });
    await expect(headerStatus(page, "Live")).toBeVisible();
    await expect(tabs(page)).toHaveCount(2);
    for (const file of ["mission.json", "g1/1.jsonl", "g1/2.jsonl", "g1/3.jsonl"]) {
      expect(live.count(file), file).toBe(1);
    }
  });

  test("ends for good when the share is stopped", async ({ page, ui }) => {
    const live = await openShare(page, ui, { history });
    await expect(tabs(page)).toHaveCount(2);

    // The learner stops sharing: the head is gone on the next poll.
    live.stop();
    await expect(page.getByText("This share has ended")).toBeVisible();
    await expect(page.getByText("Sharing stopped").first()).toBeVisible();
    // What was captured stays, and nothing live is claimed of it.
    await expect(tabs(page)).toHaveCount(2);
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(0);
    await expect(page.locator(".xterm-rows")).toContainText("nginx.service");

    // A stopped share sends no end for its sessions. The one that was running
    // is stopped, not reconnecting (nothing is coming back), and the one whose
    // terminal had ended stays ended.
    await expect(page.getByText("Reconnecting…")).toHaveCount(0);
    await expect(tabs(page).nth(0)).toContainText("Stopped");
    await expect(tabs(page).nth(0).locator("[data-share-dot]")).toHaveAttribute(
      "data-share-dot",
      "stopped",
    );
    await expect(tabs(page).nth(1)).toContainText("Ended");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText("Stopped", { exact: true })).toBeVisible();
    // Nothing more will arrive, so there is nothing to hold still.
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Replay from start" }),
    ).toBeVisible();

    // It does not ask again: a stopped share does not come back.
    const heads = live.count("head.json");
    await page.waitForTimeout(2_500);
    expect(live.count("head.json")).toBe(heads);
  });

  test("does not wait for a dropped writer once the share is stopped", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history });
    live.publish(shareDetach("s-web"));
    // While the share is up, a dropped writer may resume.
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toBeVisible();
    await expect(tabs(page).nth(0)).toContainText("Interrupted");

    live.stop();
    await expect(page.getByText("This share has ended")).toBeVisible();
    await expect(tabs(page).nth(0)).toContainText("Stopped");
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toHaveCount(0);
    await expect(page.getByText("Interrupted")).toHaveCount(0);
  });

  test("keeps trying when the first read fails, and shows the share once one gets through", async ({
    page,
    ui,
  }) => {
    // A rate limit or an error from the CDN: not a missing share, so not called one.
    const live = await openShare(page, ui, { history, failHeads: 1 });
    await expect(headerStatus(page, "Reconnecting…")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live run");
    await expect(page.getByText("This share isn't available")).toHaveCount(0);
    await expect(page.getByText("This link isn't shared")).toHaveCount(0);

    // The retry is about a second away.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      mission.title,
    );
    await expect(tabs(page)).toHaveCount(2);
    await expect(screenOf(page)).toContainText("nginx.service");
    await expect(headerStatus(page, "Live")).toBeVisible();
    expect(live.count("head.json")).toBe(2);
  });

  test("says the share isn't available after a run of failures, and tries again on request", async ({
    page,
    ui,
  }, testInfo) => {
    await fastRetries(page);
    const live = await openShare(page, ui, { history, failHeads: 6 });

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This share isn't available",
    );
    await expect(
      page.getByText(/Check your connection and try again/),
    ).toBeVisible();
    await expect(page.getByText("This link isn't shared")).toHaveCount(0);
    expect(live.count("head.json")).toBe(6);
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoAxeViolations(page, testInfo);

    // It gave up: nothing more is asked of the CDN by itself.
    await page.waitForTimeout(1_500);
    expect(live.count("head.json")).toBe(6);

    // Try again reads once more, and this time the share is there.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      mission.title,
    );
    await expect(tabs(page)).toHaveCount(2);
    await expect(screenOf(page)).toContainText("nginx.service");
    expect(live.count("head.json")).toBe(7);
  });

  test("says the link is not shared when it names nothing, without asking for anything", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { path: "/watch#not-a-share" });

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This link isn't shared (anymore)",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    await page.waitForTimeout(300);
    expect(live.requests).toEqual([]);
    await expect(page).toHaveTitle(/Live run/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
  });

  test("says the link is not shared when the share was stopped before the viewer came", async ({
    page,
    ui,
  }) => {
    const live = await openShare(page, ui, { history, stopped: true });

    // The files are gone (a 404): nothing to show, and nothing to wait for.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This link isn't shared (anymore)",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    await expect(tabs(page)).toHaveCount(0);
    expect(live.requests).not.toContain("g1/1.jsonl");
    const asked = live.requests.length;
    await page.waitForTimeout(2_500);
    expect(live.requests).toHaveLength(asked);
  });

  test("never follows a link a program writes into the terminal", async ({
    page,
    ui,
  }) => {
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const popups: string[] = [];
    page.context().on("page", (opened) => popups.push(opened.url()));

    await openShare(page, ui, {
      history: [
        [
          shareStart("s-web"),
          shareEvents("s-web", [
            [
              0,
              "o",
              "see \u001b]8;;https://evil.example.test/\u0007this link\u001b]8;;\u0007 now\r\n",
            ],
          ]),
        ],
      ],
    });
    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("see this link now");

    // The screen layer sits over the rows and takes the pointer, so this is a
    // real mouse at the link's place, as a viewer would use.
    const box = await settledBox(screen.getByText("this link"));
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // xterm finds a link under the pointer after the pointer has moved onto
    // it, so the hover gets its moment before the click.
    await page.mouse.move(x - 30, y);
    await page.waitForTimeout(100);
    await page.mouse.move(x, y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    expect(popups).toEqual([]);
    expect(page.url()).toContain("/watch#");
  });
});

test.describe("a share rebuilt from the recordings", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Generation 1: what the share captured live, with a line the recording will not have. */
  const live = [
    [
      shareStart("s-web"),
      shareEvents("s-web", [
        [0, "o", "learner@web:~$ "],
        [900, "o", "systemctl status nginx\r\n"],
        [1_400, "o", "live only line\r\n"],
      ]),
    ],
    [
      shareStart("s-ssh", { mode: "native", cols: 100, rows: 20 }),
      shareEvents("s-ssh", [
        [0, "o", "root@web:~# "],
        [600, "o", "uptime\r\n"],
      ]),
    ],
  ];
  /** Generation 2: the same sessions from the archive, every one ended. */
  const recording = [
    [
      shareStart("s-web"),
      shareEvents("s-web", [
        [0, "o", "learner@web:~$ "],
        [900, "o", "systemctl status nginx\r\n"],
        [1_400, "o", "recorded tail\r\n"],
      ]),
      shareEnd("s-web"),
    ],
    [
      shareStart("s-ssh", { mode: "native", cols: 100, rows: 20 }),
      shareEvents("s-ssh", [
        [0, "o", "root@web:~# "],
        // Not what the live capture had at this point.
        [600, "o", "uptime -p\r\n"],
        [1_900, "o", "exit\r\n"],
      ]),
      shareEnd("s-ssh"),
    ],
  ];

  test("rebuilds its tabs from the new generation, keeps the viewer's tab, and stops polling fast", async ({
    page,
    ui,
  }) => {
    const share = await openShare(page, ui, { history: live });
    await expect(tabs(page)).toHaveCount(2);
    await expect(headerStatus(page, "Live")).toBeVisible();
    // The viewer chooses the second tab, and holds its screen still.
    await tabs(page).nth(1).click();
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(
      page.getByText("New output is held until you resume."),
    ).toBeVisible();

    // The run ends and its archive is ready: the share is rebuilt from the
    // recordings, as the next generation, and the live files are deleted.
    share.record(...recording);
    await expect(headerStatus(page, "Recorded")).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);

    // Every session is ended, in tabs rebuilt from the new generation.
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toContainText("Ended");
    await expect(tabs(page).nth(1)).toContainText("Ended");
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(0);
    // The viewer's own tab is still theirs, since the session id carried over,
    // and still the screen they were reading. Where they had paused it means
    // nothing in a log that was made again, so that is let go of.
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(screenOf(page)).toContainText("root@web:~# uptime -p");
    await expect(screenOf(page)).toContainText("exit");
    await expect(
      page.getByText("New output is held until you resume."),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);

    // The first tab is the recording's: what it holds is not what was live.
    // The viewer had not looked at it, so it opens as an ended session does.
    await tabs(page).nth(0).click();
    await page.getByRole("button", { name: "Show final screen" }).click();
    await expect(screenOf(page)).toContainText("recorded tail");
    await expect(screenOf(page)).not.toContainText("live only line");

    // Nothing changes in a recording, so the head is not read every second.
    const heads = share.count("head.json");
    await page.waitForTimeout(3_000);
    expect(share.count("head.json")).toBe(heads);
    // The old generation was read once, and not again; the new one once.
    expect(share.count("g1/1.jsonl")).toBe(1);
    expect(share.count("g1/2.jsonl")).toBe(1);
    expect(share.count("g2/1.jsonl")).toBe(1);
    expect(share.count("g2/2.jsonl")).toBe(1);
    expect(share.count("mission.json")).toBe(1);
  });

  test("keeps a viewer who was in a replay in one when the share is rebuilt", async ({
    page,
    ui,
  }) => {
    const share = await openShare(page, ui, { history: live });
    await expect(tabs(page)).toHaveCount(2);
    // The newest running session is in front: the live capture's SSH session,
    // which is a little over half a second long.
    await page.getByRole("button", { name: "Replay from start" }).click();
    const slider = page.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeEnabled();
    await expect(page.locator(".replay-time:visible")).toHaveText("0:00 / 0:00");

    share.record(...recording);
    await expect(headerStatus(page, "Recorded")).toBeVisible();

    // Still a replay, and made from the recording: it is almost two seconds.
    await expect(page.locator(".xterm-rows")).toHaveCount(0);
    await expect(slider).toBeEnabled();
    await expect(page.locator(".replay-time:visible")).toHaveText("0:00 / 0:01");
  });

  test("starts at the first tab when the viewer's session is not in the rebuilt share", async ({
    page,
    ui,
  }) => {
    const share = await openShare(page, ui, {
      history: [
        ...live,
        [
          shareStart("s-extra"),
          shareEvents("s-extra", [[0, "o", "only in the live capture"]]),
        ],
      ],
    });
    await expect(tabs(page)).toHaveCount(3);
    await tabs(page).nth(2).click();
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");

    share.record(...recording);
    await expect(headerStatus(page, "Recorded")).toBeVisible();

    // The third session is not in the recording, so there is no third tab and
    // the viewer is at the first.
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(tabs(page).nth(0)).toContainText("web · 1");
  });

  test("says a recording was cut at the size limit, which a rebuilt share has of its own", async ({
    page,
    ui,
  }) => {
    // A recording can carry the flag too: part of it kept its live capture.
    await openShare(page, ui, { recorded: recording, truncated: true });

    await expect(headerStatus(page, "Recorded")).toBeVisible();
    await expect(page.getByText("Replay truncated")).toBeVisible();
    await expect(
      page.getByText("This share reached its size limit, so later output isn't shown."),
    ).toBeVisible();
  });

  test("lets go of the size limit's notice when the rebuilt share was not cut", async ({
    page,
    ui,
  }) => {
    const share = await openShare(page, ui, { history: live, truncated: true });
    await expect(page.getByText("Replay truncated")).toBeVisible();

    // The recordings are whole, so the share rebuilt from them is not cut.
    share.record(...recording);
    await expect(headerStatus(page, "Recorded")).toBeVisible();
    await expect(page.getByText("Replay truncated")).toHaveCount(0);
  });

  test("shows a share that was rebuilt before the viewer came as a recording", async ({
    page,
    ui,
  }) => {
    const share = await openShare(page, ui, { recorded: recording });

    await expect(headerStatus(page, "Recorded")).toBeVisible();
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toContainText("Ended");
    // Ended sessions open as replays.
    await expect(
      page.getByRole("slider", { name: "Replay position" }),
    ).toBeEnabled();
    expect(share.count("g1/1.jsonl")).toBe(0);
    expect(share.count("g2/1.jsonl")).toBe(1);
    const heads = share.count("head.json");
    await page.waitForTimeout(2_500);
    expect(share.count("head.json")).toBe(heads);
  });
});

test.describe("shared run page layout", () => {
  test("sits the mission beside the terminals at 1920x1080 and keeps the terminal on screen", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openShare(page, ui, { theme: "dark", history });
    await expect(page.locator(".xterm-rows")).toContainText("nginx.service");

    const terminals = await page
      .getByRole("region", { name: "Terminals" })
      .boundingBox();
    const aside = await page
      .getByRole("complementary", { name: "Mission" })
      .boundingBox();
    expect(terminals && aside).toBeTruthy();
    expect(aside!.x).toBeGreaterThanOrEqual(terminals!.x + terminals!.width);
    // The terminal's first lines are on the first screen, not below the fold.
    const screen = await page.locator(".xterm-rows").boundingBox();
    expect(screen!.y + 100).toBeLessThan(1080);
    await expectNoHorizontalOverflow(page);
  });

  test("stacks on a phone and scrolls a wide terminal inside its frame", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openShare(page, ui, {
      history: [
        [
          shareStart("s-wide", { cols: 160, rows: 10 }),
          shareEvents("s-wide", [[0, "o", "wide terminal ".repeat(12)]]),
        ],
      ],
    });
    await expect(page.locator(".xterm-rows")).toContainText("wide terminal");

    const terminals = await page
      .getByRole("region", { name: "Terminals" })
      .boundingBox();
    const aside = await page
      .getByRole("complementary", { name: "Mission" })
      .boundingBox();
    expect(aside!.y).toBeGreaterThanOrEqual(terminals!.y + terminals!.height);
    // The page itself does not scroll sideways; the terminal's frame does.
    await expectNoHorizontalOverflow(page);
    const frameScroll = await page
      .locator("[data-share-terminal]")
      .evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
    expect(frameScroll.scroll).toBeGreaterThan(frameScroll.client);
    // The frame is a keyboard stop, so the cut-off columns can be reached.
    await page.locator("[data-share-terminal]").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        page.locator("[data-share-terminal]").evaluate((e) => e.scrollLeft),
      )
      .toBeGreaterThan(0);
  });

  test("scrolls a long mission beside the terminals and reaches it from the keyboard", async ({
    page,
    ui,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    const longMission = {
      ...mission,
      markdown: Array.from(
        { length: 40 },
        (_, index) =>
          `## Step ${index + 1}\n\nCheck the unit, read the journal, and compare the configuration with the last good one.`,
      ).join("\n\n"),
    };
    await openShare(page, ui, { history, mission: longMission });
    await expect(screenOf(page)).toContainText("nginx.service");

    const aside = page.getByRole("complementary", { name: "Mission" });
    const metrics = await aside.evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
      tab: element.tabIndex,
    }));
    // It stays within the screen and scrolls, and a scroller is a tab stop.
    expect(metrics.client).toBeLessThanOrEqual(700);
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    expect(metrics.tab).toBe(0);
    await aside.focus();
    await page.keyboard.press("PageDown");
    await expect
      .poll(() => aside.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expectNoAxeViolations(page, testInfo);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no accessibility violations (${theme})`, async ({
      page,
      ui,
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openShare(page, ui, { theme, history });
      await expect(page.locator(".xterm-rows")).toContainText("nginx.service");
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
      await expectNoAxeViolations(page, testInfo);

      // The replay view too.
      await tabs(page).nth(1).click();
      await expect(
        page.getByRole("slider", { name: "Replay position" }),
      ).toBeEnabled();
      await expectNoAxeViolations(page, testInfo);
    });
  }
});
