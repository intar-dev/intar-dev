import {
  SHARE_INGEST_CLOSE_STOPPED,
  SHARE_INGEST_PING,
  SHARE_INGEST_PONG,
} from "@/generated/constants";
import {
  SHARE_STREAM_PATH,
  parseShareViewerFrame,
  type ShareViewerMessage,
} from "./protocol";

/** What the socket is doing; the page words it as Live, Reconnecting and so on. */
export type ShareConnection =
  | "open"
  | "reconnecting"
  /** The share was stopped (close code 4001); this link is over. */
  | "stopped"
  /**
   * The handshake failed again and again. A browser cannot read why (a stopped
   * or unknown share answers 404, a rate limit 429, a full or paused share
   * 503, and a dropped network nothing at all), so this means gone or busy,
   * and the viewer may try again.
   */
  | "unavailable";

export const SHARE_PING_INTERVAL_MS = 30_000;
export const SHARE_RECONNECT_MIN_MS = 1_000;
export const SHARE_RECONNECT_MAX_MS = 30_000;
/**
 * Handshakes in a row that fail, first connection or not, before the share is
 * called unavailable: with the backoff below about half a minute of trying,
 * long enough for a busy server to let go and a laptop to find its network.
 */
export const SHARE_HANDSHAKE_FAILURES = 6;
const JITTER = 0.3;

/** One second doubling to thirty, each spread by 30% either way. */
export function shareReconnectDelay(attempt: number, random: number): number {
  const base = Math.min(
    SHARE_RECONNECT_MAX_MS,
    SHARE_RECONNECT_MIN_MS * 2 ** attempt,
  );
  return Math.round(base * (1 + (random * 2 - 1) * JITTER));
}

export function shareStreamUrl(
  origin: string,
  shareId: string,
  after: number | null,
): string {
  const url = new URL(SHARE_STREAM_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("s", shareId);
  if (after !== null) url.searchParams.set("after", String(after));
  return url.toString();
}

export interface ShareStreamOptions {
  shareId: string;
  origin: string;
  /** The highest log seq applied so far; read again at every (re)connect. */
  after: () => number | null;
  /** Every message of every frame, in order. */
  onMessages: (messages: ShareViewerMessage[]) => void;
  onConnection: (state: ShareConnection) => void;
  createSocket?: (url: string) => WebSocket;
  random?: () => number;
}

export interface ShareStream {
  /** After "unavailable": tries the share again from the start. */
  retry(): void;
  close(): void;
}

/**
 * The viewer's socket. It keeps itself up: a drop reconnects with a jittered
 * backoff and asks only for what it missed (`after`), a silent peer is found
 * by a ping every 30 s, and the two ends that are final are told apart. The
 * share was stopped when the server closes with 4001. A handshake that fails
 * says little: the server refused (404 for a share that is not there, 429 for
 * a rate limit, 503 for a full house) or the network dropped, and a browser
 * sees none of that. So the first connection is retried like every later one,
 * and only a run of failed handshakes calls the share unavailable.
 */
export function connectShareStream(options: ShareStreamOptions): ShareStream {
  const create = options.createSocket ?? ((url: string) => new WebSocket(url));
  const random = options.random ?? Math.random;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let awaitingPong = false;
  let attempt = 0;
  let failedHandshakes = 0;
  let closed = false;

  const stopHeartbeat = () => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    awaitingPong = false;
  };

  const detach = (target: WebSocket) => {
    target.onopen = null;
    target.onmessage = null;
    target.onclose = null;
    target.onerror = null;
  };

  const lost = (opened: boolean, code: number) => {
    stopHeartbeat();
    socket = null;
    if (closed) return;
    if (code === SHARE_INGEST_CLOSE_STOPPED) {
      options.onConnection("stopped");
      return;
    }
    failedHandshakes = opened ? 0 : failedHandshakes + 1;
    if (failedHandshakes >= SHARE_HANDSHAKE_FAILURES) {
      options.onConnection("unavailable");
      return;
    }
    options.onConnection("reconnecting");
    timer = setTimeout(connect, shareReconnectDelay(attempt, random()));
    attempt += 1;
  };

  function connect() {
    timer = null;
    if (closed) return;
    let opened = false;
    let created: WebSocket | null = null;
    try {
      created = create(
        shareStreamUrl(options.origin, options.shareId, options.after()),
      );
    } catch {
      // The browser refused the address itself.
    }
    if (!created) {
      // No handshake was tried and none would be, so waiting helps nothing.
      options.onConnection("unavailable");
      return;
    }
    const ws = created;
    socket = ws;

    // A connection that stops answering may never deliver its close event, so
    // it is treated as closed once a whole interval has passed without a word.
    const abandon = () => {
      detach(ws);
      try {
        ws.close();
      } catch {
        // Already gone.
      }
      lost(opened, 1006);
    };

    ws.onopen = () => {
      if (socket !== ws) return;
      opened = true;
      failedHandshakes = 0;
      heartbeat = setInterval(() => {
        if (socket !== ws) return;
        if (awaitingPong) {
          abandon();
          return;
        }
        awaitingPong = true;
        try {
          ws.send(SHARE_INGEST_PING);
        } catch {
          abandon();
        }
      }, SHARE_PING_INTERVAL_MS);
      options.onConnection("open");
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      awaitingPong = false;
      if (typeof event.data !== "string" || event.data === SHARE_INGEST_PONG) {
        return;
      }
      let messages: ShareViewerMessage[];
      try {
        messages = parseShareViewerFrame(event.data);
      } catch {
        // A frame this viewer cannot read is skipped, not a reason to leave.
        return;
      }
      // Caught up with the share: the next drop starts its backoff over.
      if (messages.some((message) => message.type === "synced")) attempt = 0;
      if (messages.length > 0) options.onMessages(messages);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      lost(opened, event.code);
    };
  }

  connect();

  return {
    retry() {
      if (closed || socket || timer !== null) return;
      attempt = 0;
      failedHandshakes = 0;
      connect();
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      stopHeartbeat();
      const target = socket;
      socket = null;
      if (!target) return;
      detach(target);
      try {
        target.close(1000);
      } catch {
        // Already gone.
      }
    },
  };
}
