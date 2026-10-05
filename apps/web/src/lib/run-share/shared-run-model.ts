import { SHARE_ID_LEN } from "@/generated/constants";
import type { ShareEvent, TerminalSessionMode } from "@/generated/stargate";
import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_ROWS,
} from "@/lib/replay/config";
import type { ShareViewerMessage, SharedRunMission } from "./protocol";

/**
 * The share id in a page address's fragment, or null when that is not one: 22
 * base64url characters. Checked before anything connects, so a mistyped link
 * never reaches the server.
 */
export function parseShareId(fragment: string): string | null {
  const id = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return id.length === SHARE_ID_LEN && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/**
 * The viewer's model of one public share: what the share's messages have said
 * so far. It is a plain reducer with no React and no socket, so the page can
 * feed it frames in any order a reconnect produces and a test can feed it by
 * hand.
 */

/** xterm's own minimum grid. */
const MIN_COLS = 2;
const MIN_ROWS = 1;
/**
 * A learner controls their terminal's size (a native SSH client can ask for
 * anything), and this page draws it for everyone who opens the link, so no grid
 * the viewer builds is larger than the replay model's own limit.
 */
export const SHARE_MAX_CELLS = 1000;

export interface ShareGrid {
  cols: number;
  rows: number;
}

function cells(value: unknown, minimum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), SHARE_MAX_CELLS);
}

export function clampShareGrid(cols: unknown, rows: unknown): ShareGrid {
  return {
    cols: cells(cols, MIN_COLS, REPLAY_TERMINAL_COLS),
    rows: cells(rows, MIN_ROWS, REPLAY_TERMINAL_ROWS),
  };
}

/** An `r` event's data, `"COLSxROWS"`; null when it is anything else. */
export function parseShareResize(data: unknown): ShareGrid | null {
  if (typeof data !== "string") return null;
  const match = /^(\d{1,6})x(\d{1,6})$/.exec(data);
  return match ? clampShareGrid(Number(match[1]), Number(match[2])) : null;
}

export type ShareSessionStatus = "live" | "detached" | "ended";

/** How the viewer's link to the share is doing. */
export type ShareStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "stopped"
  | "unavailable";

/** What one session is doing, as the viewer says it. */
export type ShareSessionPhase =
  | "live"
  | "reconnecting"
  | "interrupted"
  | "stopped"
  | "ended";

/**
 * A session's status says what the share last recorded, and the link says
 * whether anything more can arrive. A stopped share records no end or detach
 * for its sessions (the writers are cut off and the log is wiped), so once the
 * link is over every session that had not ended is stopped, not live and not
 * waiting for a connection that will not come.
 */
export function shareSessionPhase(
  session: Pick<ShareSession, "status">,
  link: ShareStatus,
): ShareSessionPhase {
  // The PTY ending is a fact the share recorded, and it stays true.
  if (session.status === "ended") return "ended";
  if (link === "stopped") return "stopped";
  if (session.status === "detached") return "interrupted";
  return link === "live" ? "live" : "reconnecting";
}

/** One PTY at Stargate: every reconnect and every native SSH login is its own. */
export interface ShareSession {
  id: string;
  vmId: string;
  mode: TerminalSessionMode;
  /**
   * The grid the log begins with. A later size arrives as an `r` event, so the
   * log alone says what the grid was at any point; `cols` and `rows` never
   * change after the first `start`.
   */
  cols: number;
  rows: number;
  atMs: number;
  /** Mirroring began after the PTY had been running: the first screen is unknown. */
  midSession: boolean;
  events: ShareEvent[];
  status: ShareSessionStatus;
  /** Output the mirror had to drop (a flood, or the writer fell behind). */
  gapBytes: number;
}

export interface SharedRunState {
  mission: SharedRunMission | null;
  /** Tab order is arrival order, and a session is never removed. */
  sessions: ShareSession[];
  /** The stored replay stops early; live output still arrives. */
  truncated: boolean;
  /** Everything the share had stored when this connection began is applied. */
  synced: boolean;
  /**
   * The highest log sequence number applied. A reconnect keeps the model and
   * asks for `?after=<seq>`, so this is the cursor; null until a stored
   * message arrives.
   */
  seq: number | null;
}

export function createSharedRunState(): SharedRunState {
  return {
    mission: null,
    sessions: [],
    truncated: false,
    synced: false,
    seq: null,
  };
}

function highest(left: number | null, right: number): number {
  return left === null ? right : Math.max(left, right);
}

/**
 * Applies every message in order, as one batch. The state it is given is never
 * changed, but the batch does not copy a session's whole log for every row of
 * it either: each session the batch touches has its events copied once, and
 * the rest of the batch appends to that copy. Joining a long share (history
 * arrives as thousands of rows) is then linear, where a copy per row is not.
 */
export function applyShareMessages(
  state: SharedRunState,
  messages: readonly ShareViewerMessage[],
): SharedRunState {
  const copied = new Set<string>();
  let next = state;
  for (const message of messages) next = reduceShareMessage(next, message, copied);
  return next;
}

/**
 * Applies one message. `copied` names the sessions whose events array an
 * earlier call of the same batch already copied: those arrays belong to the
 * batch and are appended to in place. Left out, every call copies what it
 * changes, so no array that another state holds is ever written to.
 */
export function reduceShareMessage(
  state: SharedRunState,
  message: ShareViewerMessage,
  copied: Set<string> = new Set(),
): SharedRunState {
  switch (message.type) {
    case "hello":
      // A resumed connection says hello again. The mission and the truncation
      // flag are the share's current word; the sessions are what this viewer
      // already holds, and what it missed follows.
      return {
        ...state,
        mission: message.mission,
        truncated: message.truncated,
        synced: false,
      };
    case "synced":
      return {
        ...state,
        synced: true,
        seq:
          typeof message.seq === "number"
            ? highest(state.seq, message.seq)
            : state.seq,
      };
    default:
      break;
  }

  const seq = typeof message.seq === "number" ? message.seq : undefined;
  // Stored messages arrive once, in order; one that does not is already here.
  if (seq !== undefined && state.seq !== null && seq <= state.seq) return state;
  const next = applyStored(state, message, copied);
  // Live output past the storage cap carries no seq and moves nothing.
  return seq === undefined ? next : { ...next, seq };
}

function applyStored(
  state: SharedRunState,
  message: Exclude<ShareViewerMessage, { type: "hello" | "synced" }>,
  copied: Set<string>,
): SharedRunState {
  switch (message.type) {
    case "start":
      return startSession(state, message, copied);
    case "events":
      if (!Array.isArray(message.events) || message.events.length === 0) {
        return state;
      }
      // ponytail: every event of every session stays in memory while the page
      // is open. The share stores a capped log, but output past the cap keeps
      // arriving live, so hours of heavy output grow without bound. Drop the
      // oldest events and mark the replay truncated if that ever bites.
      return updateSession(state, message.session, (session) => {
        const events = ownedEvents(session, copied);
        // One at a time: spreading a long row into push() overflows the stack.
        for (const event of message.events) events.push(event);
        return { ...session, events };
      });
    case "gap":
      return updateSession(state, message.session, (session) => ({
        ...session,
        gapBytes: session.gapBytes + Math.max(0, message.bytes),
      }));
    case "end":
      return updateSession(state, message.session, (session) => ({
        ...session,
        status: "ended",
      }));
    case "detach":
      // The PTY ending is final; a writer that drops after it changes nothing.
      return updateSession(state, message.session, (session) =>
        session.status === "ended" ? session : { ...session, status: "detached" },
      );
    case "truncated":
      return { ...state, truncated: true };
    default:
      // A message type a newer share sends is not this viewer's to apply.
      return state;
  }
}

/**
 * The session's events, ready to be appended to in place: copied the first
 * time a batch touches the session, and the batch's own from then on.
 */
function ownedEvents(session: ShareSession, copied: Set<string>): ShareEvent[] {
  if (copied.has(session.id)) return session.events;
  copied.add(session.id);
  return session.events.slice();
}

function updateSession(
  state: SharedRunState,
  id: string,
  update: (session: ShareSession) => ShareSession,
): SharedRunState {
  const index = state.sessions.findIndex((session) => session.id === id);
  const current = state.sessions[index];
  // An unknown session has no start to say what it is; there is nothing to draw.
  if (!current) return state;
  const updated = update(current);
  if (updated === current) return state;
  const sessions = state.sessions.slice();
  sessions[index] = updated;
  return { ...state, sessions };
}

function startSession(
  state: SharedRunState,
  message: Extract<ShareViewerMessage, { type: "start" }>,
  copied: Set<string>,
): SharedRunState {
  const grid = clampShareGrid(message.cols, message.rows);
  const known = state.sessions.some((session) => session.id === message.session);
  if (!known) {
    const session: ShareSession = {
      id: message.session,
      vmId: message.vm_id,
      mode: message.mode,
      cols: grid.cols,
      rows: grid.rows,
      atMs: message.at_ms,
      midSession: message.mid_session,
      events: [],
      status: "live",
      gapBytes: 0,
    };
    return { ...state, sessions: [...state.sessions, session] };
  }
  // The same PTY after its writer reconnected: one tab, live again. The writer
  // reports the size now, which may not be the last one the log saw (a resize
  // while it was away is not in it), so a difference becomes a resize event.
  return updateSession(state, message.session, (session) => {
    const current = currentShareGrid(session);
    const same = current.cols === grid.cols && current.rows === grid.rows;
    if (same) return { ...session, status: "live" };
    const events = ownedEvents(session, copied);
    events.push([events.at(-1)?.[0] ?? 0, "r", `${grid.cols}x${grid.rows}`]);
    return { ...session, status: "live", events };
  });
}

/** The grid after the last resize in the log, else the one it began with. */
export function currentShareGrid(session: ShareSession): ShareGrid {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.[1] !== "r") continue;
    const grid = parseShareResize(event[2]);
    if (grid) return grid;
  }
  return { cols: session.cols, rows: session.rows };
}

export interface ShareTab {
  session: ShareSession;
  /** `web · 2`: the machine's name and which of its sessions this is. */
  label: string;
  vmName: string;
  /** 1-based, per machine, in arrival order. */
  index: number;
}

export function shareTabs(state: SharedRunState): ShareTab[] {
  const perVm = new Map<string, number>();
  return state.sessions.map((session) => {
    const index = (perVm.get(session.vmId) ?? 0) + 1;
    perVm.set(session.vmId, index);
    const vmName =
      state.mission?.vms.find((vm) => vm.id === session.vmId)?.name ??
      session.vmId;
    return { session, label: `${vmName} · ${index}`, vmName, index };
  });
}

/** Where a viewer who is following the share looks: the newest running terminal. */
export function followedSession(
  sessions: readonly ShareSession[],
): ShareSession | null {
  return (
    sessions.findLast((session) => session.status !== "ended") ??
    sessions.at(-1) ??
    null
  );
}
