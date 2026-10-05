import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { UiHarness } from "./test";

// The public page of a shared run: the share's Durable Object is replaced by a
// socket the test drives, so every frame the page sees is written by the test.

export const SHARE_ID = "Zm9vYmFyYmF6cXV4cXV1eA";
export const SHARE_WATCH_PATH = `/watch#${SHARE_ID}`;

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

export function shareStart(
  session: string,
  seq: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "start",
    seq,
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

export const shareHello = (truncated = false) => ({
  type: "hello",
  mission: shareMission,
  truncated,
});

/** Two sessions of the web machine: one running in the browser, one over SSH that has ended. */
export const shareHistory = [
  shareHello(),
  shareStart("s-web", 1),
  {
    type: "events",
    seq: 2,
    session: "s-web",
    events: [
      [0, "o", "learner@web:~$ "],
      [900, "o", "systemctl status nginx\r\n"],
      [1_400, "o", "nginx.service: failed\r\n"],
    ],
  },
  shareStart("s-ssh", 3, {
    mode: "native",
    cols: 100,
    rows: 20,
    mid_session: true,
  }),
  {
    type: "events",
    seq: 4,
    session: "s-ssh",
    events: [
      [0, "o", "root@web:~# "],
      [500, "o", "echo done\r\n"],
      [800, "o", "done\r\n"],
    ],
  },
  { type: "end", seq: 5, session: "s-ssh" },
  { type: "synced", seq: 5 },
];

/** A frame of the viewer socket: one JSON message per line. */
export const shareFrame = (...messages: object[]) =>
  messages.map((message) => JSON.stringify(message)).join("\n");

export interface ShareSockets {
  /** Every socket the page opened, refused ones included, in order. */
  all: WebSocketRoute[];
  urls: URL[];
  /** Resolves with the nth socket once the page has opened it. */
  nth(index: number): Promise<WebSocketRoute>;
}

/**
 * `refuse`: how many of the first sockets are refused before they open, as a
 * rate limit (429) or a full house (503) refuses an upgrade. The page sees a
 * socket that closes without ever opening, which is all a browser can see of
 * a refused handshake.
 */
export async function installShareSocket(
  page: Page,
  refuse = 0,
): Promise<ShareSockets> {
  const all: WebSocketRoute[] = [];
  const urls: URL[] = [];
  await page.routeWebSocket(/\/api\/shares\/stream/, (ws) => {
    all.push(ws);
    urls.push(new URL(ws.url()));
    if (all.length <= refuse) {
      void ws.close({ code: 4000, reason: "refused" });
      return;
    }
    // The Durable Object answers the keep-alive on its own.
    ws.onMessage((message) => {
      if (message === "ping") ws.send("pong");
    });
  });
  return {
    all,
    urls,
    async nth(index) {
      await expect.poll(() => all.length).toBeGreaterThan(index);
      return all[index]!;
    },
  };
}

/**
 * A page that makes every timer of half a second or more fire at once, for a
 * test that has to live through a whole reconnect backoff (half a minute).
 * Call it before the page opens.
 */
export async function fastReconnects(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      original(
        handler,
        typeof delay === "number" && delay >= 500 ? 1 : delay,
        ...args,
      )) as typeof window.setTimeout;
  });
}

/** Opens the public page with the socket in place; the test sends what the share says. */
export async function openShare(
  page: Page,
  ui: UiHarness,
  options: { theme?: "light" | "dark"; path?: string; refuse?: number } = {},
): Promise<ShareSockets> {
  const sockets = await installShareSocket(page, options.refuse ?? 0);
  await ui.open({
    path: options.path ?? SHARE_WATCH_PATH,
    sessionRole: "anonymous",
    theme: options.theme ?? "light",
  });
  return sockets;
}
