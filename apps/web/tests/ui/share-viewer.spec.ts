import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures/test";
import { SHARE_HANDSHAKE_FAILURES } from "@/lib/run-share/shared-run-stream";
import {
  SHARE_ID,
  fastReconnects,
  openShare,
  shareFrame as frame,
  shareHello as hello,
  shareHistory as history,
  shareMission as mission,
  shareStart as start,
} from "./fixtures/share-socket";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

// The public page of a shared run, with the share replaced by a socket the
// test drives (fixtures/share-socket.ts).

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

test.describe("shared run page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the mission, a tab per session and the live screen at 16pt", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live run");
    await expect(page.getByText("Connecting…").first()).toBeVisible();

    const socket = await sockets.nth(0);
    expect(sockets.urls[0]?.searchParams.get("s")).toBe(SHARE_ID);
    expect(sockets.urls[0]?.searchParams.has("after")).toBe(false);
    socket.send(frame(...history));

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
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("systemctl status nginx");
    await expect(screen).toContainText("nginx.service: failed");
    // 16pt, so it still reads when the page is captured for a stream.
    await expect(screen).toHaveCSS("font-size", "21px");
    await expect(screen).toHaveCSS("font-family", /IBM Plex Mono/);

    // Output that arrives later is drawn as it comes.
    socket.send(
      frame({
        type: "events",
        seq: 6,
        session: "s-web",
        events: [[2_000, "o", "live line two\r\n"]],
      }),
    );
    await expect(screen).toContainText("live line two");
  });

  test("pauses the screen while output keeps arriving, and catches up on resume", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    const socket = await sockets.nth(0);
    socket.send(frame(...history));
    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("nginx.service: failed");

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(
      page.getByText("New output is held until you resume."),
    ).toBeVisible();
    socket.send(
      frame({
        type: "events",
        seq: 6,
        session: "s-web",
        events: [[3_000, "o", "typed while paused\r\n"]],
      }),
    );
    // Give the page every chance to draw it; it must not.
    await page.waitForTimeout(300);
    await expect(screen).not.toContainText("typed while paused");

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(screen).toContainText("typed while paused");
    // Live again: the next line follows without another click.
    socket.send(
      frame({
        type: "events",
        seq: 7,
        session: "s-web",
        events: [[4_000, "o", "and after resuming\r\n"]],
      }),
    );
    await expect(screen).toContainText("and after resuming");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  test("replays an ended session, which opens as a replay at 16pt", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    (await sockets.nth(0)).send(frame(...history));
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

  test("a running session opens live and replays from the start on request", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    const socket = await sockets.nth(0);
    socket.send(frame(...history));
    await expect(page.locator(".xterm-rows")).toContainText("nginx.service");

    await page.getByRole("button", { name: "Replay from start" }).click();
    const slider = page.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeEnabled();
    await expect(page.locator(".xterm-rows")).toHaveCount(0);

    // A replay is a recording up to now: the session goes on without it.
    socket.send(
      frame({
        type: "events",
        seq: 6,
        session: "s-web",
        events: [[2_000, "o", "after the replay opened\r\n"]],
      }),
    );
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
    const sockets = await openShare(page, ui);
    const socket = await sockets.nth(0);
    socket.send(frame(...history));
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");

    // The viewer has not moved, so the new session takes the front.
    socket.send(
      frame(start("s-web-3", 6, { vm_id: "vm_db", mode: "native" }), {
        type: "events",
        seq: 7,
        session: "s-web-3",
        events: [[0, "o", "postgres@db:~$ "]],
      }),
    );
    await expect(tabs(page)).toHaveCount(3);
    await expect(tabs(page).nth(2)).toContainText("db · 1");
    await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(screenOf(page)).toContainText("postgres@db");

    // Leaving for an older tab means the next session no longer takes over.
    await tabs(page).nth(0).click();
    await expect(screenOf(page)).toContainText("systemctl status");
    socket.send(frame(start("s-web-4", 8)));
    await expect(tabs(page)).toHaveCount(4);
    await expect(tabs(page).nth(3)).toContainText("web · 3");
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
    // Going back to the newest tab follows again.
    await tabs(page).nth(3).click();
    socket.send(frame(start("s-web-5", 9)));
    await expect(tabs(page)).toHaveCount(5);
    await expect(tabs(page).nth(4)).toHaveAttribute("aria-selected", "true");
  });

  test("notes dropped output, truncated replays, and a connection that dropped", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    (await sockets.nth(0)).send(
      frame(
        hello(true),
        start("s-web", 1),
        { type: "gap", seq: 2, session: "s-web", bytes: 65_536 },
        { type: "detach", seq: 3, session: "s-web" },
        { type: "synced", seq: 3 },
      ),
    );

    await expect(page.getByText("Replay truncated")).toBeVisible();
    await expect(page.getByText("Some output was dropped")).toBeVisible();
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toBeVisible();
    // The writer came back: the same tab is live again, with no extra tab.
    (await sockets.nth(0)).send(frame(start("s-web", 4, { resumed: true })));
    await expect(tabs(page)).toHaveCount(1);
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toHaveCount(0);
    await expect(page.locator("[data-share-dot='live']")).toHaveCount(1);
  });

  test("reconnects asking only for what was missed, and keeps what it has", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    const first = await sockets.nth(0);
    first.send(frame(...history));
    await expect(page.locator(".xterm-rows")).toContainText("nginx.service");
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

    // The connection drops; the page says so and tries again.
    await first.close({ code: 1001, reason: "going away" });
    await expect(page.getByText("Reconnecting…").first()).toBeVisible();
    const second = await sockets.nth(1);
    expect(sockets.urls[1]?.searchParams.get("after")).toBe("5");
    expect(sockets.urls[1]?.searchParams.get("s")).toBe(SHARE_ID);

    // Hello again, then only what came after; nothing replays, nothing resets.
    second.send(
      frame(
        { ...hello(), mission: { ...mission, tagline: "Now with a new tagline." } },
        {
          type: "events",
          seq: 6,
          session: "s-web",
          events: [[2_500, "o", "output from while away\r\n"]],
        },
        { type: "synced", seq: 6 },
      ),
    );
    await expect(page.getByText("Now with a new tagline.")).toBeVisible();
    await expect(tabs(page)).toHaveCount(2);
    const screen = page.locator(".xterm-rows");
    await expect(screen).toContainText("output from while away");
    await expect(screen).toContainText("nginx.service: failed");
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

    // The next drop asks from the new place.
    await second.close({ code: 1006 });
    await sockets.nth(2);
    expect(sockets.urls[2]?.searchParams.get("after")).toBe("6");
  });

  test("ends for good when the share is stopped", async ({ page, ui }) => {
    const sockets = await openShare(page, ui);
    const socket = await sockets.nth(0);
    socket.send(frame(...history));
    await expect(tabs(page)).toHaveCount(2);

    await socket.close({ code: 4001, reason: "sharing stopped" });
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

    // A reconnect would have come within a second and a half.
    await page.waitForTimeout(1_600);
    expect(sockets.all).toHaveLength(1);
  });

  test("does not wait for a dropped writer once the share is stopped", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui);
    const socket = await sockets.nth(0);
    socket.send(
      frame(...history, { type: "detach", seq: 6, session: "s-web" }),
    );
    // While the share is up, a dropped writer may resume.
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toBeVisible();
    await expect(tabs(page).nth(0)).toContainText("Interrupted");

    await socket.close({ code: 4001, reason: "sharing stopped" });
    await expect(page.getByText("This share has ended")).toBeVisible();
    await expect(tabs(page).nth(0)).toContainText("Stopped");
    await expect(
      page.getByText(/connection to this terminal dropped/),
    ).toHaveCount(0);
    await expect(page.getByText("Interrupted")).toHaveCount(0);
  });

  test("keeps trying when the first connection is refused, and shows the share once one gets through", async ({
    page,
    ui,
  }) => {
    // A rate limit or a full house refuses the upgrade; a browser cannot tell
    // that from a missing share, so it is not called one.
    const sockets = await openShare(page, ui, { refuse: 1 });
    await expect(page.getByText("Reconnecting…").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Live run");
    await expect(page.getByText("This share isn't available")).toHaveCount(0);
    await expect(page.getByText("This link isn't shared")).toHaveCount(0);

    // The retry is about a second away.
    (await sockets.nth(1)).send(frame(...history));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      mission.title,
    );
    await expect(tabs(page)).toHaveCount(2);
    await expect(screenOf(page)).toContainText("nginx.service");
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
    expect(sockets.all).toHaveLength(2);
    // Nothing had been received, so the second asks for the share from the start.
    expect(sockets.urls[1]?.searchParams.has("after")).toBe(false);
    expect(sockets.urls[1]?.searchParams.get("s")).toBe(SHARE_ID);
  });

  test("says the share isn't available after a run of refusals, and tries again on request", async ({
    page,
    ui,
  }, testInfo) => {
    await fastReconnects(page);
    const sockets = await openShare(page, ui, {
      refuse: SHARE_HANDSHAKE_FAILURES,
    });

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This share isn't available",
    );
    await expect(
      page.getByText(/may have been stopped, or it's busy right now/),
    ).toBeVisible();
    await expect(page.getByText("This link isn't shared")).toHaveCount(0);
    expect(sockets.all).toHaveLength(SHARE_HANDSHAKE_FAILURES);
    await expect(page.locator("main")).toHaveCount(1);
    await expectNoAxeViolations(page, testInfo);

    // It gave up: nothing more is asked of the server by itself.
    await page.waitForTimeout(300);
    expect(sockets.all).toHaveLength(SHARE_HANDSHAKE_FAILURES);

    // Try again asks once more, and this time the share is there.
    await page.getByRole("button", { name: "Try again" }).click();
    (await sockets.nth(SHARE_HANDSHAKE_FAILURES)).send(frame(...history));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      mission.title,
    );
    await expect(tabs(page)).toHaveCount(2);
    await expect(screenOf(page)).toContainText("nginx.service");
    expect(sockets.all).toHaveLength(SHARE_HANDSHAKE_FAILURES + 1);
  });

  test("says the link is not shared when it names nothing, without connecting", async ({
    page,
    ui,
  }) => {
    const sockets = await openShare(page, ui, { path: "/watch#not-a-share" });

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "This link isn't shared (anymore)",
    );
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    await page.waitForTimeout(300);
    expect(sockets.all).toHaveLength(0);
    await expect(page).toHaveTitle(/Live run/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
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

    const sockets = await openShare(page, ui);
    (await sockets.nth(0)).send(
      frame(
        hello(),
        start("s-web", 1),
        {
          type: "events",
          seq: 2,
          session: "s-web",
          events: [
            [
              0,
              "o",
              "see \u001b]8;;https://evil.example.test/\u0007this link\u001b]8;;\u0007 now\r\n",
            ],
          ],
        },
        { type: "synced", seq: 2 },
      ),
    );
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

test.describe("shared run page layout", () => {
  test("sits the mission beside the terminals at 1920x1080 and keeps the terminal on screen", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const sockets = await openShare(page, ui, { theme: "dark" });
    (await sockets.nth(0)).send(frame(...history));
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
    const sockets = await openShare(page, ui);
    (await sockets.nth(0)).send(
      frame(
        hello(),
        start("s-wide", 1, { cols: 160, rows: 10 }),
        {
          type: "events",
          seq: 2,
          session: "s-wide",
          events: [[0, "o", "wide terminal ".repeat(12)]],
        },
        { type: "synced", seq: 2 },
      ),
    );
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
    const sockets = await openShare(page, ui);
    const longMission = {
      ...mission,
      markdown: Array.from(
        { length: 40 },
        (_, index) =>
          `## Step ${index + 1}\n\nCheck the unit, read the journal, and compare the configuration with the last good one.`,
      ).join("\n\n"),
    };
    (await sockets.nth(0)).send(
      frame(
        { ...hello(), mission: longMission },
        ...history.slice(1),
      ),
    );
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
      const sockets = await openShare(page, ui, { theme });
      (await sockets.nth(0)).send(frame(...history));
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
