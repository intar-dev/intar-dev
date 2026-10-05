import type { ShareEvent, TerminalSessionMode } from "@/generated/stargate";

/**
 * What a public share shows besides the terminals. It is copied into the
 * share's Durable Object once, when sharing starts, and never names the owner
 * or carries hints, the solution, or the run state.
 */
export interface SharedRunMission {
  title: string;
  tagline: string;
  scenario_name: string;
  lecture_title: string | null;
  markdown: string;
  objectives: SharedRunObjective[];
  vms: { id: string; name: string }[];
}

export interface SharedRunObjective {
  vm_name: string;
  label: string;
  title: string | null;
  body_markdown: string | null;
}

/**
 * One message from a share's Durable Object to a viewer. A frame carries one
 * or more of them separated by "\n" (JSON escapes newlines, so the split is
 * unambiguous): history arrives coalesced, live updates one per frame.
 *
 * A session is one PTY at Stargate, so every reconnect and every native SSH
 * login is its own session. `start` with `resumed: true` continues a session
 * after Stargate's writer reconnected; `end` means the PTY ended; `detach`
 * means the writer dropped and may resume.
 *
 * Every stored message carries its log `seq`. A viewer that reconnects keeps
 * what it has and asks for `?after=<highest seq seen>`, so it only downloads
 * what it missed. Output past the storage cap is broadcast live without a
 * `seq` and is not replayed.
 */
export type ShareViewerMessage =
  | { type: "hello"; mission: SharedRunMission; truncated: boolean }
  | {
      type: "start";
      seq?: number;
      session: string;
      vm_id: string;
      mode: TerminalSessionMode;
      cols: number;
      rows: number;
      at_ms: number;
      mid_session: boolean;
      resumed: boolean;
    }
  | { type: "events"; seq?: number; session: string; events: ShareEvent[] }
  | { type: "gap"; seq?: number; session: string; bytes: number }
  | { type: "end"; seq?: number; session: string }
  | { type: "detach"; seq?: number; session: string }
  /** The stored replay stops here; live updates continue. */
  | { type: "truncated"; seq?: number }
  /** Everything stored up to `seq` has been sent; later messages are live. */
  | { type: "synced"; seq: number };

export function parseShareViewerFrame(frame: string): ShareViewerMessage[] {
  return frame
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ShareViewerMessage);
}

/** The public page. The share id rides in the fragment, so it never reaches
 * a server log. */
export const SHARE_PAGE_PATH = "/watch";
/** `GET ?s=<share id>[&after=<seq>]` upgrades to the viewer socket. */
export const SHARE_STREAM_PATH = "/api/shares/stream";
/** Stargate's ingest socket, `GET ?s=<share id>` with a bearer write token. */
export const SHARE_INGEST_PATH = "/share-ingest";

export function shareUrl(origin: string, shareId: string): string {
  return `${origin}${SHARE_PAGE_PATH}#${shareId}`;
}

/** 16pt, sized for a livestream; xterm and the replay player take pixels. */
export const SHARE_VIEWER_FONT_SIZE_PX = 21;
