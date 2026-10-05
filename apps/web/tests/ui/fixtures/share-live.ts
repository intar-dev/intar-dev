import type { Page } from "@playwright/test";
import { SHARE_CHECKPOINT_SEGMENTS } from "@/lib/run-share/protocol";
import type { UiHarness } from "./test";

// The public page of a shared run reads the share as files from a CDN. The CDN
// is replaced here by routes the test drives: it publishes what the share's
// writer would, and the page polls it as it does in production.

export const SHARE_ID = "Zm9vYmFyYmF6cXV4cXV1eA";
export const SHARE_WATCH_PATH = `/watch#${SHARE_ID}`;
/** Where the page reads a share's files from unless it is told otherwise. */
export const SHARE_LIVE_TEST_ORIGIN = "https://live.intar.dev";

export const shareMission = {
  title: "Repair a broken nginx service",
  tagline: "Bring the website back online.",
  scenario_name: "repair-nginx",
  lecture_title: "Service recovery",
  markdown:
    "## Why services fail\n\nA web service depends on process state, configuration, and network reachability.",
  objectives: [
    {
      vm_name: "web",
      label: "Restore the public web listener",
      title: "Start the web server",
      body_markdown: "HIDDEN_OBJECTIVE_DETAIL",
    },
    {
      vm_name: "web",
      label: "Return a healthy response",
      title: null,
      body_markdown: null,
    },
  ],
  vms: [
    { id: "vm_web", name: "web" },
    { id: "vm_db", name: "db" },
  ],
};

/** A stored message as the share's log holds it; the CDN numbers them. */
export type ShareMessage = Record<string, unknown>;

export function shareStart(
  session: string,
  overrides: Record<string, unknown> = {},
): ShareMessage {
  return {
    type: "start",
    session,
    vm_id: "vm_web",
    mode: "browser",
    cols: 80,
    rows: 12,
    at_ms: 1_791_187_200_000,
    mid_session: false,
    resumed: false,
    ...overrides,
  };
}

export const shareEvents = (
  session: string,
  events: Array<[number, "o" | "r", string]>,
): ShareMessage => ({ type: "events", session, events });

export const shareEnd = (session: string): ShareMessage => ({
  type: "end",
  session,
});

export const shareDetach = (session: string): ShareMessage => ({
  type: "detach",
  session,
});

export const shareGap = (session: string, bytes: number): ShareMessage => ({
  type: "gap",
  session,
  bytes,
});

/**
 * Two sessions of the web machine, as the segments the share publishes: one
 * running in the browser, and one over SSH that has ended.
 */
export const shareHistory: ShareMessage[][] = [
  [
    shareStart("s-web"),
    shareEvents("s-web", [
      [0, "o", "learner@web:~$ "],
      [900, "o", "systemctl status nginx\r\n"],
      [1_400, "o", "nginx.service: failed\r\n"],
    ]),
  ],
  [
    shareStart("s-ssh", {
      mode: "native",
      cols: 100,
      rows: 20,
      mid_session: true,
    }),
    shareEvents("s-ssh", [
      [0, "o", "root@web:~# "],
      [500, "o", "echo done\r\n"],
      [800, "o", "done\r\n"],
    ]),
    shareEnd("s-ssh"),
  ],
];

export interface ShareLive {
  /** What the page asked for, in order: `head.json`, `g1/2.jsonl`, and so on. */
  requests: string[];
  /** The same, with the origin it asked. */
  urls: string[];
  count(file: string): number;
  /** The share's writer sent these, and the share published them as a segment. */
  publish(...messages: ShareMessage[]): void;
  publishAll(segments: ShareMessage[][]): void;
  /**
   * The run's archive is ready: the share is republished from the recordings
   * as the next generation (numbered from 1 again, `recorded`), and the old
   * generation's files are deleted.
   */
  record(...segments: ShareMessage[][]): void;
  /** The share went past its size cap: no output is published after this. */
  truncate(): void;
  /** The learner stopped sharing: every file is gone. */
  stop(): void;
  /** The next `count` reads of the head fail (a rate limit, a blip). */
  failHeads(count: number): void;
}

/** Any origin: the page's own default, or one set for the build. */
const SHARE_FILE =
  /\/[A-Za-z0-9_-]{22}\/(?:mission\.json|head\.json|g\d+\/c?\d+\.jsonl)(?:\?.*)?$/;

const lines = (messages: readonly ShareMessage[]) =>
  messages.map((message) => JSON.stringify(message)).join("\n");

/**
 * Routes every file of a share to the test's own CDN. A 404 or a 503 shows in
 * the browser's console, which the UI harness fails a test on, so each one is
 * counted as expected before it is served.
 */
export async function installShareLive(
  page: Page,
  ui: UiHarness,
  options: { delay?: number; mission?: object } = {},
): Promise<ShareLive> {
  const requests: string[] = [];
  const urls: string[] = [];
  let generation = 1;
  let segments: string[] = [];
  /** Checkpoint k holds the messages of its run of segments, as one file. */
  let checkpoints: string[] = [];
  let seq = 0;
  let truncated = false;
  let recorded = false;
  let gone = false;
  let headFailures = 0;

  await page.route(SHARE_FILE, async (route) => {
    const url = route.request().url();
    const file = new URL(url).pathname.split("/").slice(2).join("/");
    requests.push(file);
    urls.push(url);
    if (options.delay) {
      await new Promise((resolve) => setTimeout(resolve, options.delay));
    }
    // The CDN answers every read, errors included, for any origin to read.
    const answer = (status: number, body = "", contentType = "text/plain") => {
      if (status === 404) ui.server.expectedNotFound += 1;
      if (status === 503) ui.server.expectedUnavailable += 1;
      return route.fulfill({
        status,
        body,
        contentType,
        headers: { "access-control-allow-origin": "*" },
      });
    };
    if (gone) return answer(404);
    if (file === "head.json") {
      if (headFailures > 0) {
        headFailures -= 1;
        return answer(503);
      }
      return answer(
        200,
        JSON.stringify({
          generation,
          segment: segments.length,
          checkpoint: checkpoints.length,
          seq,
          truncated,
          recorded,
        }),
        "application/json",
      );
    }
    if (file === "mission.json") {
      return answer(
        200,
        JSON.stringify(options.mission ?? shareMission),
        "application/json",
      );
    }
    const segment = /^g(\d+)\/(c?)(\d+)\.jsonl$/.exec(file);
    // A generation that was replaced has no files left.
    const body =
      segment && Number(segment[1]) === generation
        ? (segment[2] ? checkpoints : segments)[Number(segment[3]) - 1]
        : undefined;
    return body === undefined
      ? answer(404)
      : answer(200, body, "application/x-ndjson");
  });

  const live: ShareLive = {
    requests,
    urls,
    count: (file) => requests.filter((request) => request === file).length,
    publish(...messages) {
      segments.push(lines(messages.map((message) => ({ ...message, seq: ++seq }))));
      // As the share's writer does: a complete run of segments is also written
      // as one checkpoint, before the head names it.
      if (segments.length % SHARE_CHECKPOINT_SEGMENTS === 0) {
        checkpoints.push(segments.slice(-SHARE_CHECKPOINT_SEGMENTS).join("\n"));
      }
    },
    publishAll(all) {
      for (const messages of all) live.publish(...messages);
    },
    record(...rebuilt) {
      generation += 1;
      seq = 0;
      truncated = false;
      recorded = true;
      // A rebuilt share is read from its segments.
      checkpoints = [];
      segments = rebuilt.map((messages) =>
        lines(messages.map((message) => ({ ...message, seq: ++seq }))),
      );
    },
    truncate() {
      truncated = true;
    },
    stop() {
      gone = true;
    },
    failHeads(count) {
      headFailures = count;
    },
  };
  return live;
}

/**
 * A page that makes every timer longer than 1.3 seconds fire at once, for a
 * test that has to live through a whole retry backoff (half a minute). The
 * first wait of a backoff and the one-second poll stay as they are. Call it
 * before the page opens.
 */
export async function fastRetries(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      original(
        handler,
        typeof delay === "number" && delay > 1_300 ? 1 : delay,
        ...args,
      )) as typeof window.setTimeout;
  });
}

/** Opens the public page with the share's files in place; the test publishes what the writer sends. */
export async function openShare(
  page: Page,
  ui: UiHarness,
  options: {
    theme?: "light" | "dark";
    path?: string;
    /** Every answer waits this many milliseconds. */
    delay?: number;
    /** The mission file, where it is not the usual one. */
    mission?: object;
    /** Published before the page opens, a segment each. */
    history?: ShareMessage[][];
    /** Then republished from the recordings, as a viewer who comes late finds it. */
    recorded?: ShareMessage[][];
    /** The share is past its log cap. */
    truncated?: boolean;
    /** The first reads of the head that fail. */
    failHeads?: number;
    /** The learner stopped sharing before the page opens. */
    stopped?: boolean;
  } = {},
): Promise<ShareLive> {
  const live = await installShareLive(page, ui, {
    ...(options.delay === undefined ? {} : { delay: options.delay }),
    ...(options.mission === undefined ? {} : { mission: options.mission }),
  });
  if (options.history) live.publishAll(options.history);
  if (options.recorded) live.record(...options.recorded);
  if (options.truncated) live.truncate();
  if (options.failHeads) live.failHeads(options.failHeads);
  if (options.stopped) live.stop();
  await ui.open({
    path: options.path ?? SHARE_WATCH_PATH,
    sessionRole: "anonymous",
    theme: options.theme ?? "light",
  });
  return live;
}
