import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "@/control-plane/auth";
import { timingSafeHashEqual } from "@/control-plane/image-registry/shared";
import {
  SHARE_INGEST_CLOSE_ENDED,
  SHARE_INGEST_CLOSE_LIMIT,
  SHARE_INGEST_CLOSE_STOPPED,
  SHARE_INGEST_PING,
  SHARE_INGEST_PONG,
} from "@/generated/constants";
import type { ShareEvent } from "@/generated/stargate";
import type {
  SharedRunMission,
  ShareViewerMessage,
} from "@/lib/run-share/protocol";

// ponytail: fixed caps sized for lab sessions; the log cap bounds both storage
// and the one history burst a joining viewer receives. Move history to a
// streamed GET if logs ever need to grow past this.
export const RUN_SHARE_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const RUN_SHARE_MAX_VIEWERS = 500;
// Per caller network (IPv4 address or IPv6 /64), so one client can not take
// every seat; high enough for a classroom behind one NAT.
export const RUN_SHARE_MAX_VIEWERS_PER_NETWORK = 32;
export const RUN_SHARE_MAX_PRODUCERS = 64;
export const RUN_SHARE_MAX_MESSAGE_BYTES = 256 * 1024;
export const RUN_SHARE_HISTORY_FRAME_BYTES = 512 * 1024;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const VM_ID = /^[A-Za-z0-9._-]{1,128}$/;
const NETWORK_KEY = /^[0-9a-f]{8,64}$/;

type SocketAttachment =
  | { role: "producer"; session: string | null }
  | { role: "viewer" };

type StoredMessage = Exclude<
  ShareViewerMessage,
  { type: "hello" } | { type: "synced" }
>;

/**
 * One public run share: the log of what Stargate streamed for the run's
 * terminals, written once per batch, and the sockets of everyone watching.
 * Stargate holds one `producer` socket per PTY session; viewers get the log
 * on join and every later message as it is appended. Both keep their sockets
 * alive with the auto-response ping, so an idle share never wakes this object.
 */
export class RunShareDO extends DurableObject<Cloudflare.Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(SHARE_INGEST_PING, SHARE_INGEST_PONG),
    );
    this.ensureSchema();
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/init" && request.method === "PUT") {
      return this.init(request);
    }
    if (pathname === "/wipe" && request.method === "POST") {
      return this.wipe();
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    if (pathname === "/ingest") return this.ingest(request);
    if (pathname === "/watch") return this.watch(request);
    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment?.role !== "producer") {
      closeQuietly(ws, 1003, "viewer sockets are server-only");
      return;
    }
    if (
      typeof message !== "string" ||
      message.length > RUN_SHARE_MAX_MESSAGE_BYTES
    ) {
      closeQuietly(ws, SHARE_INGEST_CLOSE_LIMIT, "ingest frame too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      closeQuietly(ws, 1007, "ingest frame is not JSON");
      return;
    }
    const outcome = this.toViewerMessage(attachment, parsed);
    if (!outcome.ok) {
      closeQuietly(ws, 1008, outcome.reason);
      return;
    }
    if (outcome.message.type === "start") {
      ws.serializeAttachment({
        role: "producer",
        session: outcome.message.session,
      } satisfies SocketAttachment);
    }
    this.append(outcome.message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.producerGone(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.producerGone(ws, 1006);
  }

  private ensureSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         seq INTEGER PRIMARY KEY,
         body TEXT NOT NULL,
         total INTEGER NOT NULL
       )`,
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)`);
  }

  private meta(key: string): string | null {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private async init(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      mission?: SharedRunMission;
      write_token_hash?: string;
    };
    if (
      !body.mission ||
      typeof body.write_token_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.write_token_hash)
    ) {
      return new Response("invalid share init", { status: 400 });
    }
    this.setMeta("mission", JSON.stringify(body.mission));
    this.setMeta("write_token_hash", body.write_token_hash);
    return new Response(null, { status: 204 });
  }

  /** Closes every socket and deletes the log. A later message finds no
   * share and is dropped, so nothing reappears after a wipe. */
  private async wipe(): Promise<Response> {
    for (const socket of this.ctx.getWebSockets()) {
      closeQuietly(socket, SHARE_INGEST_CLOSE_STOPPED, "sharing stopped");
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    return new Response(null, { status: 204 });
  }

  private async ingest(request: Request): Promise<Response> {
    const expected = this.meta("write_token_hash");
    if (!expected) return new Response("share not found", { status: 404 });
    const token = /^Bearer (\S+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (!token || !sameHash(await sha256Hex(token), expected)) {
      return new Response("invalid write token", { status: 401 });
    }
    if (this.ctx.getWebSockets("producer").length >= RUN_SHARE_MAX_PRODUCERS) {
      return new Response("too many producers", { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["producer"]);
    server.serializeAttachment({
      role: "producer",
      session: null,
    } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Accepts a viewer and sends `hello`, the stored log after `after`, and
   * `synced` before returning. Nothing awaits in between, so no live append
   * can reach this socket ahead of the history.
   */
  private watch(request: Request): Response {
    const mission = this.meta("mission");
    if (!mission) return new Response("share not found", { status: 404 });
    const network = request.headers.get("x-share-viewer-network") ?? "";
    if (!NETWORK_KEY.test(network)) {
      return new Response("missing viewer network", { status: 400 });
    }
    const networkTag = `viewer:${network}`;
    if (
      this.ctx.getWebSockets("viewer").length >= RUN_SHARE_MAX_VIEWERS ||
      this.liveViewers(networkTag) >= RUN_SHARE_MAX_VIEWERS_PER_NETWORK
    ) {
      return new Response("too many viewers", { status: 503 });
    }
    const afterParam = new URL(request.url).searchParams.get("after");
    const after =
      afterParam && /^\d{1,15}$/.test(afterParam) ? Number(afterParam) : 0;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ["viewer", networkTag]);
    server.serializeAttachment({ role: "viewer" } satisfies SocketAttachment);

    let frame = `{"type":"hello","mission":${mission},"truncated":${
      this.meta("truncated") === "1"
    }}`;
    let lastSeq = after;
    for (const row of this.sql.exec<{ seq: number; body: string }>(
      `SELECT seq, body FROM log WHERE seq > ? ORDER BY seq`,
      after,
    )) {
      if (frame.length + 1 + row.body.length > RUN_SHARE_HISTORY_FRAME_BYTES) {
        server.send(frame);
        frame = row.body;
      } else {
        frame += `\n${row.body}`;
      }
      lastSeq = row.seq;
    }
    server.send(`${frame}\n{"type":"synced","seq":${lastSeq}}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Viewers of one network, closing any whose ping went silent: a
   * half-open socket must not hold a seat after a network blip. */
  private liveViewers(tag: string): number {
    const cutoff = Date.now() - 75_000;
    let live = 0;
    for (const socket of this.ctx.getWebSockets(tag)) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(socket);
      if (lastPing && lastPing.getTime() < cutoff) {
        closeQuietly(socket, 1001, "viewer went silent");
      } else {
        live += 1;
      }
    }
    return live;
  }

  private producerGone(ws: WebSocket, code: number): void {
    const attachment = readAttachment(ws);
    if (attachment?.role !== "producer" || !attachment.session) return;
    const session = attachment.session;
    // The writer already resumed the session on a new socket, and this is the
    // old one's late close: the session is still live.
    const resumed = this.ctx
      .getWebSockets("producer")
      .some((other) => {
        const otherAttachment = readAttachment(other);
        return (
          other !== ws &&
          otherAttachment?.role === "producer" &&
          otherAttachment.session === session
        );
      });
    // An error and a close can both arrive for one socket; report it once.
    try {
      ws.serializeAttachment({
        role: "producer",
        session: null,
      } satisfies SocketAttachment);
    } catch {
      // a closed socket keeps its old attachment; the append below is still right
    }
    if (resumed && code !== SHARE_INGEST_CLOSE_ENDED) return;
    this.append({
      type: code === SHARE_INGEST_CLOSE_ENDED ? "end" : "detach",
      session,
    });
  }

  /**
   * Stores the message once and pushes it to every viewer. Past the log cap,
   * session lifecycle messages are still stored (they keep the tabs right for
   * later viewers) but output is only broadcast.
   */
  private append(message: StoredMessage): void {
    if (!this.meta("mission")) return;
    const truncated = this.meta("truncated") === "1";
    const storable = !truncated || message.type !== "events";
    if (!storable) {
      this.broadcast(JSON.stringify(message));
      return;
    }
    const last = this.sql
      .exec<{ seq: number; total: number }>(
        `SELECT seq, total FROM log ORDER BY seq DESC LIMIT 1`,
      )
      .toArray()[0] ?? { seq: 0, total: 0 };
    const seq = last.seq + 1;
    const body = JSON.stringify({ ...message, seq });
    const total = last.total + body.length;
    if (!truncated && message.type === "events" && total > RUN_SHARE_MAX_LOG_BYTES) {
      this.setMeta("truncated", "1");
      const marker = JSON.stringify({ type: "truncated", seq });
      this.sql.exec(
        `INSERT INTO log (seq, body, total) VALUES (?, ?, ?)`,
        seq,
        marker,
        last.total + marker.length,
      );
      this.broadcast(marker);
      this.broadcast(JSON.stringify(message));
      return;
    }
    this.sql.exec(
      `INSERT INTO log (seq, body, total) VALUES (?, ?, ?)`,
      seq,
      body,
      total,
    );
    this.broadcast(body);
  }

  private broadcast(body: string): void {
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      try {
        viewer.send(body);
      } catch {
        // A viewer that is already closing misses the update.
      }
    }
  }

  private toViewerMessage(
    attachment: { role: "producer"; session: string | null },
    raw: unknown,
  ):
    | { ok: true; message: StoredMessage }
    | { ok: false; reason: string } {
    if (!isRecord(raw)) return { ok: false, reason: "ingest frame must be an object" };
    if (raw.type === "start") {
      const { session, vm_id, mode, cols, rows, at_ms, mid_session } = raw;
      if (
        typeof session !== "string" ||
        !SESSION_ID.test(session) ||
        typeof vm_id !== "string" ||
        !VM_ID.test(vm_id) ||
        (mode !== "browser" && mode !== "native") ||
        !isCount(cols) ||
        !isCount(rows) ||
        !isCount(at_ms) ||
        typeof mid_session !== "boolean"
      ) {
        return { ok: false, reason: "invalid start" };
      }
      if (attachment.session !== null && attachment.session !== session) {
        return { ok: false, reason: "one session per ingest socket" };
      }
      const known =
        this.sql
          .exec(`SELECT 1 FROM sessions WHERE id = ?`, session)
          .toArray().length > 0;
      if (!known) {
        this.sql.exec(`INSERT INTO sessions (id) VALUES (?)`, session);
      }
      return {
        ok: true,
        message: {
          type: "start",
          session,
          vm_id,
          mode,
          cols: clamp(cols, MAX_COLS),
          rows: clamp(rows, MAX_ROWS),
          at_ms,
          mid_session,
          resumed: known,
        },
      };
    }
    const session = attachment.session;
    if (session === null) return { ok: false, reason: "start must come first" };
    if (raw.type === "gap") {
      if (!isCount(raw.bytes)) return { ok: false, reason: "invalid gap" };
      return { ok: true, message: { type: "gap", session, bytes: raw.bytes } };
    }
    if (raw.type === "events" && Array.isArray(raw.events)) {
      const events: ShareEvent[] = [];
      for (const event of raw.events) {
        const normalized = normalizeEvent(event);
        if (!normalized) return { ok: false, reason: "invalid event" };
        events.push(normalized);
      }
      return { ok: true, message: { type: "events", session, events } };
    }
    return { ok: false, reason: "unknown ingest message" };
  }
}

/** Output passes through; a resize is clamped so a native client's huge
 * window can not make every viewer allocate a giant terminal. */
function normalizeEvent(event: unknown): ShareEvent | null {
  if (!Array.isArray(event) || event.length !== 3) return null;
  const [at, code, data] = event as unknown[];
  if (!isCount(at) || typeof data !== "string") return null;
  if (code === "o") return [at, "o", data];
  if (code !== "r") return null;
  const size = /^(\d{1,5})x(\d{1,5})$/.exec(data);
  if (!size) return null;
  return [
    at,
    "r",
    `${clamp(Number(size[1]), MAX_COLS)}x${clamp(Number(size[2]), MAX_ROWS)}`,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 1), max);
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  try {
    return ws.deserializeAttachment() as SocketAttachment | null;
  } catch {
    return null;
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore an already-closed hibernatable socket
  }
}

/** Both sides are 64-character hex digests, so lengths never leak. */
function sameHash(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.byteLength === b.byteLength && timingSafeHashEqual(a.buffer, b.buffer);
}
