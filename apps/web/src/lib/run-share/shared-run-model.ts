import { SHARE_ID_LEN } from "@/generated/constants";
import type { ShareEvent, TerminalSessionMode } from "@/generated/stargate";
import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_ROWS,
} from "@/lib/replay/config";
import type { ShareViewerMessage, SharedRunMission } from "./protocol";

/**
 * One message of a share's stored log, as a segment file holds it: a session
 * starting, output, dropped output, a session ending or its writer dropping,
 * or the point where the stored replay stops.
 */
export type StoredShareMessage = ShareViewerMessage;

/**
 * What the model is told: the share's mission, the generation of the log that
 * follows, and that log message by message.
 *
 * A generation is one complete version of the log. The live capture is the
 * first; when the run's recordings are archived the share is rebuilt from them
 * as the next, with the same session ids, and its sequence numbers start over.
 */
export type ShareUpdate =
  | StoredShareMessage
  | { type: "mission"; mission: SharedRunMission }
  | { type: "generation"; generation: number };

/**
 * The share id in a page address's fragment, or null when that is not one: 22
 * base64url characters. Checked before anything is requested, so a mistyped
 * link never reaches the CDN.
 */
export function parseShareId(fragment: string): string | null {
  const id = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return id.length === SHARE_ID_LEN && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/**
 * The viewer's model of one public share: what the share's messages have said
 * so far. It is a plain reducer with no React and no network, so the page can
 * feed it a segment at a time and a test can feed it by hand.
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

/**
 * How the viewer's link to the share is doing: still reading what the share
 * holds, keeping up with it, reading a finished recording of it, failing to
 * reach it, told it is gone (a 404), or given up after a run of failures.
 */
export type ShareStatus =
  | "connecting"
  | "live"
  | "recorded"
  | "reconnecting"
  | "stopped"
  | "unavailable";

/** What one session is doing, as the viewer says it. */
export type ShareSessionPhase =
  | "live"
  | "loading"
  | "reconnecting"
  | "interrupted"
  | "stopped"
  | "ended";

/**
 * A session's status says what the share last recorded, and the link says
 * whether anything more can arrive. A stopped share records no end or detach
 * for its sessions (its files are deleted), so once the link is over every
 * session that had not ended is stopped, not live and not waiting for a
 * connection that will not come.
 */
export function shareSessionPhase(
  session: Pick<ShareSession, "status">,
  link: ShareStatus,
): ShareSessionPhase {
  // The PTY ending is a fact the share recorded, and it stays true.
  if (session.status === "ended") return "ended";
  // A recording has no live end: whatever its log leaves open is over.
  if (link === "recorded") return "ended";
  if (link === "stopped") return "stopped";
  if (session.status === "detached") return "interrupted";
  if (link === "live") return "live";
  // Part of the history is still arriving, or the share cannot be reached.
  return link === "connecting" ? "loading" : "reconnecting";
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
  /** The generation of the log the sessions come from; null before the first. */
  generation: number | null;
  /** Tab order is arrival order, and within a generation a session is never removed. */
  sessions: ShareSession[];
  /** The stored replay stops early; there is no output past that point. */
  truncated: boolean;
  /**
   * The highest log sequence number of this generation applied; null until a
   * stored message arrives. A message at or below it was applied already and is
   * skipped, so a segment that is delivered twice cannot draw twice.
   */
  seq: number | null;
}

export function createSharedRunState(): SharedRunState {
  return {
    mission: null,
    generation: null,
    sessions: [],
    truncated: false,
    seq: null,
  };
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
  messages: readonly ShareUpdate[],
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
  message: ShareUpdate,
  copied: Set<string> = new Set(),
): SharedRunState {
  if (message.type === "mission") {
    return state.mission === message.mission
      ? state
      : { ...state, mission: message.mission };
  }
  if (message.type === "generation") {
    if (state.generation === message.generation) return state;
    // The share was rebuilt: what the viewer holds is of the old log, and the
    // new one numbers its messages from the start again. The mission stays.
    copied.clear();
    return {
      ...state,
      generation: message.generation,
      sessions: [],
      truncated: false,
      seq: null,
    };
  }

  const seq = typeof message.seq === "number" ? message.seq : undefined;
  // Stored messages arrive once, in order; one that does not is already here.
  if (seq !== undefined && state.seq !== null && seq <= state.seq) return state;
  const next = applyStored(state, message, copied);
  return seq === undefined ? next : { ...next, seq };
}

function applyStored(
  state: SharedRunState,
  message: StoredShareMessage,
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
      // is open. The share publishes a capped log (it stops publishing output
      // past the cap), so this is bounded by that cap; a viewer that has to
      // stay lighter would drop the oldest events and mark the replay truncated.
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
      return state.truncated ? state : { ...state, truncated: true };
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
