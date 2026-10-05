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
import {
  SHARE_CHECKPOINT_SEGMENTS,
  shareCheckpointPath,
  shareSegmentPath,
  type ShareHead,
  type SharedRunMission,
  type ShareViewerMessage,
} from "@/lib/run-share/protocol";

// ponytail: fixed caps sized for lab sessions; past the log cap a share stops
// publishing output (lifecycle messages still go out).
export const RUN_SHARE_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const RUN_SHARE_MAX_PRODUCERS = 64;
export const RUN_SHARE_MAX_MESSAGE_BYTES = 256 * 1024;
/** How long output waits before it is published as one segment. */
export const RUN_SHARE_SEGMENT_INTERVAL_MS = 1_000;
/** A republished generation is split into segments of about this size. */
export const RUN_SHARE_SEGMENT_BYTES = 256 * 1024;
// ponytail: recordings only fill holes in live captures, so these caps keep a
// rebuild well inside the object's memory; past them the live capture stays.
export const RUN_SHARE_MAX_CAST_BYTES = 8 * 1024 * 1024;
export const RUN_SHARE_MAX_RECORDING_BYTES = 32 * 1024 * 1024;
/** A session's recording starts this long after Stargate's bridge at most... */
const RECORDING_LATE_MS = 30_000;
/** ...or this long before it, for clock skew between Stargate and the VM. */
const RECORDING_EARLY_MS = 5_000;
/** A recording is only trusted when this much shared output matches it. */
const MIN_VERIFIED_OUTPUT = 64;
const MAX_VERIFIED_OUTPUT = 16 * 1024;
const HEAD_CACHE_CONTROL = "public, max-age=1";
// Long enough that the cache absorbs every viewer, short enough that a share
// that was stopped without a cache purge disappears within the hour.
const FILE_CACHE_CONTROL = "public, max-age=3600";
const NDJSON = "application/x-ndjson";
const MAX_COLS = 500;
const MAX_ROWS = 200;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const VM_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** `sessions.incomplete` bits: the live capture misses output. */
const INCOMPLETE_GAP = 1;
const INCOMPLETE_TRUNCATED = 2;

type SocketAttachment = { role: "producer"; session: string | null };

type StoredMessage = ShareViewerMessage;

/** One archived session recording of a VM, as the archive reported it. */
export interface ShareRecordingInput {
  start_ms: number;
  duration_ms: number;
  cast_key: string;
}

type LiveSession = {
  id: string;
  vm_id: string;
  mode: "browser" | "native";
  at_ms: number;
  mid_session: number;
  incomplete: number;
};

/** A publish that lost a race with a stop; the stop wins. */
class ShareStopped extends Error {}

/**
 * One public run share. Stargate holds one `producer` socket per PTY session;
 * each batch is stored once and, about once a second, everything new is
 * published to the public share bucket as one immutable segment plus a small
 * head file. Viewers read those files through the CDN and never reach this
 * object, so their number does not matter. Producer keepalives are answered
 * by the auto-response, so an idle share never wakes this object.
 *
 * When every VM with a shared session finished archiving, the share is
 * republished once as the next generation: live captures with holes are
 * filled from the VM's recording where it verifiably matches what was shared.
 */
export class RunShareDO extends DurableObject<Cloudflare.Env> {
  private readonly sql: SqlStorage;
  /** The alarm's publish in flight, which a wipe waits out. */
  private work: Promise<void> | null = null;

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
    if (pathname === "/recording" && request.method === "POST") {
      return this.recording(request);
    }
    if (pathname === "/vm-complete" && request.method === "POST") {
      return this.vmComplete(request);
    }
    if (
      pathname === "/ingest" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket"
    ) {
      return this.ingest(request);
    }
    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      closeQuietly(ws, 1008, "unknown socket");
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
    await this.append(outcome.message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.producerGone(ws, code);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.producerGone(ws, 1006);
  }

  /**
   * Publishes everything stored since the last segment, or the rebuild once
   * it is due. A failed write throws and the alarm retries; a stop that won
   * the race ends the publish quietly.
   */
  override async alarm(): Promise<void> {
    const work = this.publish();
    this.work = work;
    try {
      await work;
    } catch (error) {
      if (!(error instanceof ShareStopped)) throw error;
    } finally {
      if (this.work === work) this.work = null;
    }
  }

  private async publish(): Promise<void> {
    if (!this.live()) return;
    if (this.meta("recording_due") !== null) {
      await this.publishRecording();
    } else {
      await this.flushLive();
    }
  }

  /** Shared and not stopped. Every write path checks this first. */
  private live(): boolean {
    return this.meta("mission") !== null && this.meta("stopped") === null;
  }

  private async flushLive(): Promise<void> {
    if (this.meta("recorded") !== null) return;
    const flushed = Number(this.meta("flushed_seq") ?? "0");
    const rows = this.sql
      .exec<{ seq: number; body: string }>(
        `SELECT seq, body FROM log WHERE seq > ? ORDER BY seq`,
        flushed,
      )
      .toArray();
    const last = rows.at(-1);
    if (!last) return;
    const segment = Number(this.meta("segment") ?? "0") + 1;
    await this.putFile(
      shareSegmentPath(1, segment),
      rows.map((row) => row.body).join("\n"),
      NDJSON,
      FILE_CACHE_CONTROL,
    );
    let checkpoint = Number(this.meta("checkpoint") ?? "0");
    if (segment % SHARE_CHECKPOINT_SEGMENTS === 0) {
      // The checkpoint repeats the last SHARE_CHECKPOINT_SEGMENTS segments in
      // one file, so a late joiner reads one file per minute of output.
      const from = Number(this.meta("checkpoint_seq") ?? "0");
      const bodies = this.sql
        .exec<{ body: string }>(
          `SELECT body FROM log WHERE seq > ? AND seq <= ? ORDER BY seq`,
          from,
          last.seq,
        )
        .toArray()
        .map((row) => row.body);
      checkpoint += 1;
      await this.putFile(
        shareCheckpointPath(1, checkpoint),
        bodies.join("\n"),
        NDJSON,
        FILE_CACHE_CONTROL,
      );
    }
    await this.putHead({
      generation: 1,
      segment,
      checkpoint,
      seq: last.seq,
      truncated: this.meta("truncated") !== null,
      recorded: false,
    });
    this.setMeta("segment", String(segment));
    this.setMeta("flushed_seq", String(last.seq));
    if (segment % SHARE_CHECKPOINT_SEGMENTS === 0) {
      this.setMeta("checkpoint", String(checkpoint));
      this.setMeta("checkpoint_seq", String(last.seq));
    }
  }

  /** Stores one VM's archived recordings. A repeat replaces them. */
  private async recording(request: Request): Promise<Response> {
    if (!this.live()) return new Response("share not found", { status: 404 });
    // The share was already rebuilt; a re-delivered timeline changes nothing.
    if (this.meta("recorded") !== null) return new Response(null, { status: 204 });
    const body = (await request.json()) as { vm_id?: unknown; sessions?: unknown };
    const sessions = Array.isArray(body.sessions)
      ? body.sessions.filter(isRecordingInput)
      : null;
    if (typeof body.vm_id !== "string" || !VM_ID.test(body.vm_id) || !sessions) {
      return new Response("invalid recording", { status: 400 });
    }
    this.sql.exec(
      `INSERT INTO recordings (vm_id, sessions) VALUES (?, ?)
       ON CONFLICT (vm_id) DO UPDATE SET sessions = excluded.sessions`,
      body.vm_id,
      JSON.stringify(sessions),
    );
    return new Response(null, { status: 204 });
  }

  /**
   * One VM finished archiving, with or without recordings. Once every VM
   * that had a shared session finished, the next alarm rebuilds the share.
   */
  private async vmComplete(request: Request): Promise<Response> {
    if (!this.live()) return new Response("share not found", { status: 404 });
    if (this.meta("recorded") !== null) return new Response(null, { status: 204 });
    const body = (await request.json()) as { vm_id?: unknown };
    if (typeof body.vm_id !== "string" || !VM_ID.test(body.vm_id)) {
      return new Response("invalid vm", { status: 400 });
    }
    this.sql.exec(
      `INSERT INTO recordings (vm_id, sessions, done) VALUES (?, '[]', 1)
       ON CONFLICT (vm_id) DO UPDATE SET done = 1`,
      body.vm_id,
    );
    const waiting = this.sql
      .exec(
        `SELECT 1 FROM sessions
          WHERE vm_id NOT IN (SELECT vm_id FROM recordings WHERE done = 1)
          LIMIT 1`,
      )
      .toArray();
    if (waiting.length === 0) {
      this.setMeta("recording_due", "1");
      await this.ctx.storage.setAlarm(Date.now());
    }
    return new Response(null, { status: 204 });
  }

  /**
   * Republishes the share as the next generation, with nothing live left.
   * Only what was shared is published. Every session keeps its live capture,
   * except one shared from its first output whose capture has a hole (a gap
   * or the size cap): that one is replaced by its VM's recording, but only
   * when exactly one recording near its start reproduces everything that was
   * shared before the hole. Typed input never leaves the recording.
   * Sessions are written one at a time, so memory holds one recording.
   */
  private async publishRecording(): Promise<void> {
    const generation = Number(this.meta("generation") ?? "1") + 1;
    const recordings = new Map(
      this.sql
        .exec<{ vm_id: string; sessions: string }>(`SELECT vm_id, sessions FROM recordings`)
        .toArray()
        .map((row) => [row.vm_id, JSON.parse(row.sessions) as ShareRecordingInput[]]),
    );
    const sessions = this.sql
      .exec<LiveSession>(
        `SELECT id, vm_id, mode, at_ms, mid_session, incomplete
           FROM sessions ORDER BY at_ms, id`,
      )
      .toArray();

    let seq = 0;
    let segment = 0;
    let chunk: string[] = [];
    let chunkBytes = 0;
    let truncated = false;
    let budget = RUN_SHARE_MAX_RECORDING_BYTES;
    const used = new Set<string>();
    const writeChunk = async () => {
      if (chunk.length === 0) return;
      segment += 1;
      await this.putFile(
        shareSegmentPath(generation, segment),
        chunk.join("\n"),
        NDJSON,
        FILE_CACHE_CONTROL,
      );
      chunk = [];
      chunkBytes = 0;
    };
    const emit = async (message: StoredMessage) => {
      seq += 1;
      const body = JSON.stringify({ ...message, seq });
      if (chunkBytes + body.length > RUN_SHARE_SEGMENT_BYTES) await writeChunk();
      chunk.push(body);
      chunkBytes += body.length + 1;
    };

    for (const session of sessions) {
      const recording =
        session.incomplete !== 0 && session.mid_session === 0
          ? await this.verifiedRecording(
              session,
              recordings.get(session.vm_id) ?? [],
              used,
              budget,
            )
          : null;
      if (recording) {
        budget -= recording.size;
        used.add(recording.key);
        for (const message of recording.messages) await emit(message);
        continue;
      }
      if (session.incomplete & INCOMPLETE_TRUNCATED) truncated = true;
      // The live capture, closed: nothing is live after the archive.
      let ended = false;
      for (const row of this.sql
        .exec<{ body: string }>(`SELECT body FROM log WHERE session = ? ORDER BY seq`, session.id)
        .toArray()) {
        const { seq: _seq, ...message } = JSON.parse(row.body) as StoredMessage & {
          seq?: number;
        };
        if (message.type === "detach") continue;
        ended ||= message.type === "end";
        await emit(message);
      }
      if (!ended) await emit({ type: "end", session: session.id });
    }
    await writeChunk();
    await this.putHead({
      generation,
      segment,
      checkpoint: 0,
      seq,
      truncated,
      recorded: true,
    });
    await this.deleteFiles(`g${generation - 1}/`);
    this.setMeta("generation", String(generation));
    this.setMeta("segment", String(segment));
    this.setMeta("recorded", "1");
    this.sql.exec(`DELETE FROM meta WHERE key = 'recording_due'`);
    // The bucket holds what is published; the live log is not needed again.
    this.sql.exec(`DELETE FROM log`);
  }

  /**
   * The one recording that verifiably is this session, or null. Any doubt
   * (no candidate, two candidates, an unreadable or oversized one, too little
   * shared output to compare) keeps the live capture.
   */
  private async verifiedRecording(
    session: LiveSession,
    candidates: readonly ShareRecordingInput[],
    used: ReadonlySet<string>,
    budget: number,
  ): Promise<{ key: string; size: number; messages: StoredMessage[] } | null> {
    const shared = comparableOutput(this.sharedOutputBeforeHole(session.id));
    if (shared.length < MIN_VERIFIED_OUTPUT) return null;
    const nearby = candidates.filter(
      (candidate) =>
        !used.has(candidate.cast_key) &&
        candidate.start_ms >= session.at_ms - RECORDING_EARLY_MS &&
        candidate.start_ms <= session.at_ms + RECORDING_LATE_MS,
    );
    let winner: { key: string; size: number; messages: StoredMessage[] } | null = null;
    for (const candidate of nearby) {
      const object = await this.env.VM_RUN_ARTIFACTS_BUCKET.get(candidate.cast_key);
      if (!object || object.size > RUN_SHARE_MAX_CAST_BYTES || object.size > budget) {
        return null;
      }
      const messages = castMessages(await object.text(), session);
      if (!messages) return null;
      if (!sharedMatchesRecording(shared, recordedOutput(messages, shared.length))) continue;
      if (winner) return null;
      winner = { key: candidate.cast_key, size: object.size, messages };
    }
    return winner;
  }

  /** The session's shared output up to its first gap, bounded. */
  private sharedOutputBeforeHole(sessionId: string): string {
    let output = "";
    for (const row of this.sql
      .exec<{ body: string }>(`SELECT body FROM log WHERE session = ? ORDER BY seq`, sessionId)
      .toArray()) {
      const message = JSON.parse(row.body) as StoredMessage;
      if (message.type === "gap") break;
      if (message.type !== "events") continue;
      for (const [, code, data] of message.events) {
        if (code === "o") output += data;
      }
      if (output.length >= MAX_VERIFIED_OUTPUT) break;
    }
    return output.slice(0, MAX_VERIFIED_OUTPUT);
  }

  private async deleteFiles(within: string): Promise<void> {
    const shareId = this.meta("share_id");
    if (!shareId) return;
    const prefix = `${shareId}/${within}`;
    let cursor: string | undefined;
    do {
      const listing = await this.bucket().list({
        prefix,
        ...(cursor ? { cursor } : {}),
      });
      if (listing.objects.length > 0) {
        await this.bucket().delete(listing.objects.map((object) => object.key));
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  private ensureSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    // The live log stays until the share is rebuilt from the recordings,
    // which copies the live captures and checks recordings against them.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS log (
         seq INTEGER PRIMARY KEY,
         session TEXT,
         body TEXT NOT NULL
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         vm_id TEXT NOT NULL,
         mode TEXT NOT NULL,
         at_ms INTEGER NOT NULL,
         mid_session INTEGER NOT NULL,
         incomplete INTEGER NOT NULL DEFAULT 0
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS recordings (
         vm_id TEXT PRIMARY KEY,
         sessions TEXT NOT NULL,
         done INTEGER NOT NULL DEFAULT 0
       )`,
    );
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

  private bucket(): R2Bucket {
    return this.env.SHARE_LIVE_BUCKET;
  }

  /**
   * Writes one public file under the share's id, its capability. A stop that
   * landed while the write was in flight deletes it again, so nothing a stop
   * missed stays public.
   */
  private async putFile(
    name: string,
    body: string,
    contentType: string,
    cacheControl: string,
  ): Promise<void> {
    const shareId = this.meta("share_id");
    if (!shareId || this.meta("stopped") !== null) throw new ShareStopped();
    const key = `${shareId}/${name}`;
    await this.bucket().put(key, body, { httpMetadata: { contentType, cacheControl } });
    if (this.meta("stopped") !== null || this.meta("share_id") !== shareId) {
      await this.bucket().delete(key);
      throw new ShareStopped();
    }
  }

  private async putHead(head: ShareHead): Promise<void> {
    await this.putFile(
      "head.json",
      JSON.stringify(head),
      "application/json",
      HEAD_CACHE_CONTROL,
    );
  }

  private async init(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      share_id?: string;
      mission?: SharedRunMission;
      write_token_hash?: string;
    };
    if (
      typeof body.share_id !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(body.share_id) ||
      !body.mission ||
      typeof body.write_token_hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.write_token_hash)
    ) {
      return new Response("invalid share init", { status: 400 });
    }
    if (this.meta("stopped") !== null) {
      return new Response("share was stopped", { status: 409 });
    }
    this.setMeta("share_id", body.share_id);
    await this.putFile(
      "mission.json",
      JSON.stringify(body.mission),
      "application/json",
      FILE_CACHE_CONTROL,
    );
    await this.putHead({
      generation: 1,
      segment: 0,
      checkpoint: 0,
      seq: 0,
      truncated: false,
      recorded: false,
    });
    this.setMeta("mission", "1");
    this.setMeta("write_token_hash", body.write_token_hash);
    return new Response(null, { status: 204 });
  }

  /**
   * Stops the share. The fence comes first, before any await: from then on
   * no writer, alarm, rebuild or late write can publish. Then the publish in
   * flight is waited out, every file deleted, the CDN purged (best effort:
   * the files' max-age bounds what a failed purge leaves) and the share
   * forgotten. A failed delete throws and keeps the share id for the retry.
   */
  private async wipe(): Promise<Response> {
    const shareId = this.meta("share_id");
    this.setMeta("stopped", "1");
    this.sql.exec(
      `DELETE FROM meta WHERE key IN ('mission', 'write_token_hash', 'recording_due')`,
    );
    for (const socket of this.ctx.getWebSockets()) {
      closeQuietly(socket, SHARE_INGEST_CLOSE_STOPPED, "sharing stopped");
    }
    await this.ctx.storage.deleteAlarm();
    await this.work?.catch(() => undefined);
    if (shareId) {
      await this.deleteFiles("");
      await purgeShareFromCache(this.env, shareId).catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            event: "run_share_cache_purge_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
    await this.ctx.storage.deleteAll();
    this.ensureSchema();
    // Share ids are never reused, so the marker stays: an init that arrives
    // after the wipe (a stop racing an enable) is refused, not republished.
    this.setMeta("stopped", "1");
    return new Response(null, { status: 204 });
  }

  private async ingest(request: Request): Promise<Response> {
    const expected = this.meta("write_token_hash");
    if (!expected || !this.live()) {
      return new Response("share not found", { status: 404 });
    }
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

  private async producerGone(ws: WebSocket, code: number): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment?.session) return;
    const session = attachment.session;
    // The writer already resumed the session on a new socket, and this is the
    // old one's late close: the session is still live.
    const resumed = this.ctx
      .getWebSockets("producer")
      .some((other) => other !== ws && readAttachment(other)?.session === session);
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
    await this.append({
      type: code === SHARE_INGEST_CLOSE_ENDED ? "end" : "detach",
      session,
    });
  }

  /**
   * Stores the message once and schedules the next segment. Past the log cap
   * output is dropped (and its session marked as having a hole), but session
   * lifecycle messages are still published so the tabs stay right.
   */
  private async append(message: StoredMessage): Promise<void> {
    if (!this.live() || this.meta("recorded") !== null) return;
    const session = "session" in message ? message.session : null;
    const truncated = this.meta("truncated") !== null;
    if (truncated && message.type === "events") {
      this.markIncomplete(message.session, INCOMPLETE_TRUNCATED);
      return;
    }
    const seq = Number(this.meta("seq") ?? "0") + 1;
    const body = JSON.stringify({ ...message, seq });
    const total = Number(this.meta("total") ?? "0") + body.length;
    if (message.type === "events" && total > RUN_SHARE_MAX_LOG_BYTES) {
      this.setMeta("truncated", "1");
      this.markIncomplete(message.session, INCOMPLETE_TRUNCATED);
      this.store(seq, null, JSON.stringify({ type: "truncated", seq }), total);
    } else {
      if (message.type === "gap") this.markIncomplete(message.session, INCOMPLETE_GAP);
      this.store(seq, session, body, total);
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RUN_SHARE_SEGMENT_INTERVAL_MS);
    }
  }

  private markIncomplete(session: string, reason: number): void {
    this.sql.exec(
      `UPDATE sessions SET incomplete = incomplete | ? WHERE id = ?`,
      reason,
      session,
    );
  }

  private store(
    seq: number,
    session: string | null,
    body: string,
    total: number,
  ): void {
    this.sql.exec(
      `INSERT INTO log (seq, session, body) VALUES (?, ?, ?)`,
      seq,
      session,
      body,
    );
    this.setMeta("seq", String(seq));
    this.setMeta("total", String(total));
  }

  private toViewerMessage(
    attachment: SocketAttachment,
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
        this.sql.exec(
          `INSERT INTO sessions (id, vm_id, mode, at_ms, mid_session)
           VALUES (?, ?, ?, ?, ?)`,
          session,
          vm_id,
          mode,
          at_ms,
          mid_session ? 1 : 0,
        );
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

function isRecordingInput(value: unknown): value is ShareRecordingInput {
  return (
    isRecord(value) &&
    isCount(value.start_ms) &&
    isCount(value.duration_ms) &&
    typeof value.cast_key === "string" &&
    value.cast_key.length > 0
  );
}

/** Replacement characters differ where Stargate and kino split multi-byte
 * characters differently, so comparisons ignore them. */
function comparableOutput(output: string): string {
  return output.replaceAll("\uFFFD", "");
}

/**
 * Whether the shared output is this recording. A live capture starts with
 * what sshd prints before kino starts recording (the motd, the last login),
 * so the recording's opening is looked up in the shared output, and from
 * there everything shared must be exactly how the recording begins.
 */
export function sharedMatchesRecording(shared: string, recording: string): boolean {
  const opening = recording.slice(0, MIN_VERIFIED_OUTPUT);
  if (opening.length < MIN_VERIFIED_OUTPUT) return false;
  const at = shared.indexOf(opening);
  if (at < 0) return false;
  const overlap = shared.slice(at);
  return overlap.length >= MIN_VERIFIED_OUTPUT && recording.startsWith(overlap);
}

/** The recording's output, comparable, at least `length` long if it has it. */
function recordedOutput(messages: readonly StoredMessage[], length: number): string {
  let output = "";
  for (const message of messages) {
    if (message.type !== "events") continue;
    for (const [, code, data] of message.events) {
      if (code !== "o") continue;
      output += comparableOutput(data);
      if (output.length >= length) return output;
    }
  }
  return output;
}

/**
 * Turns one archived asciicast v3 recording into the session's messages.
 * Output and resizes keep their recorded spacing (idle gaps were already
 * shortened by the archive); typed input and check markers are dropped.
 * Returns null for anything that is not a v3 cast.
 */
export function castMessages(
  text: string,
  session: Pick<LiveSession, "id" | "vm_id" | "mode" | "at_ms">,
): StoredMessage[] | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return null;
  }
  if (
    !isRecord(header) ||
    header.version !== 3 ||
    !isRecord(header.term) ||
    !isCount(header.term.cols) ||
    !isCount(header.term.rows)
  ) {
    return null;
  }
  const messages: StoredMessage[] = [
    {
      type: "start",
      session: session.id,
      vm_id: session.vm_id,
      mode: session.mode,
      cols: clamp(header.term.cols, MAX_COLS),
      rows: clamp(header.term.rows, MAX_ROWS),
      at_ms: session.at_ms,
      mid_session: false,
      resumed: false,
    },
  ];
  let atMs = 0;
  let batch: ShareEvent[] = [];
  let batchBytes = 0;
  const flush = () => {
    if (batch.length === 0) return;
    messages.push({ type: "events", session: session.id, events: batch });
    batch = [];
    batchBytes = 0;
  };
  for (const line of lines.slice(1)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!Array.isArray(event) || event.length !== 3) return null;
    const [interval, code, data] = event as unknown[];
    if (typeof interval !== "number" || interval < 0 || typeof data !== "string") {
      return null;
    }
    atMs += interval * 1000;
    if (code !== "o" && code !== "r") continue;
    const normalized = normalizeEvent([Math.round(atMs), code, data]);
    if (!normalized) continue;
    batch.push(normalized);
    batchBytes += data.length + 32;
    if (batchBytes >= 32 * 1024) flush();
  }
  flush();
  messages.push({ type: "end", session: session.id });
  return messages;
}

/**
 * Drops the share's files from Cloudflare's cache at once. Without a token
 * (local development, tests) the files expire on their own within the hour.
 */
async function purgeShareFromCache(
  env: Cloudflare.Env,
  shareId: string,
): Promise<void> {
  const token = (env as { SHARE_LIVE_PURGE_TOKEN?: string }).SHARE_LIVE_PURGE_TOKEN;
  const zone = (env as { SHARE_LIVE_ZONE_ID?: string }).SHARE_LIVE_ZONE_ID;
  const origin = (env as { SHARE_LIVE_ORIGIN?: string }).SHARE_LIVE_ORIGIN;
  if (!token || !zone || !origin) return;
  const host = new URL(origin).host;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefixes: [`${host}/${shareId}/`] }),
    },
  );
  if (!response.ok) {
    throw new Error(`share cache purge failed (${response.status})`);
  }
}
