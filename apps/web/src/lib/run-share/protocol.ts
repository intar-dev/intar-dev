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
 * One stored message of a share, as viewers read it from the published
 * segments. A session is one PTY at Stargate, so every reconnect and every
 * native SSH login is its own session. `start` with `resumed: true`
 * continues a session after Stargate's writer reconnected; `end` means the
 * PTY ended; `detach` means the writer dropped and may resume. `seq` numbers
 * the messages of one generation.
 */
export type ShareViewerMessage =
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
  /** Output past the storage cap was not published. */
  | { type: "truncated"; seq?: number };

/** The public page. The share id rides in the fragment, so it never reaches
 * a server log. */
export const SHARE_PAGE_PATH = "/watch";
/**
 * Viewers read a share as files from the CDN, never from the Worker:
 * `<origin>/<share id>/mission.json`, `head.json` (cached about a second) and
 * immutable `g<generation>/<n>.jsonl` segments of newline-separated stored
 * messages. A 404 on the head means the share was stopped. When the run's
 * archive is ready the share is republished from the complete recordings as
 * the next generation (`recorded: true`); session ids carry over.
 */
export const SHARE_LIVE_ORIGIN: string =
  (import.meta.env?.PUBLIC_SHARE_LIVE_ORIGIN as string | undefined) ??
  "https://live.intar.dev";

export interface ShareHead {
  generation: number;
  /** The newest written segment of this generation; 0 before the first. */
  segment: number;
  /**
   * Complete checkpoints of this generation. Checkpoint k holds exactly the
   * messages of segments (k - 1) * SHARE_CHECKPOINT_SEGMENTS + 1 through
   * k * SHARE_CHECKPOINT_SEGMENTS, so a late joiner reads the checkpoints and
   * then only the segments after the last one.
   */
  checkpoint: number;
  seq: number;
  /** Some output was not published because the share hit its size cap. */
  truncated: boolean;
  /** Rebuilt from the archived recordings: nothing is live anymore. */
  recorded: boolean;
}

export const SHARE_CHECKPOINT_SEGMENTS = 60;

export function shareSegmentPath(generation: number, segment: number): string {
  return `g${generation}/${segment}.jsonl`;
}

export function shareCheckpointPath(generation: number, checkpoint: number): string {
  return `g${generation}/c${checkpoint}.jsonl`;
}
/** Stargate's ingest socket, `GET ?s=<share id>` with a bearer write token. */
export const SHARE_INGEST_PATH = "/share-ingest";

export function shareUrl(origin: string, shareId: string): string {
  return `${origin}${SHARE_PAGE_PATH}#${shareId}`;
}

/** 16pt, sized for a livestream; xterm and the replay player take pixels. */
export const SHARE_VIEWER_FONT_SIZE_PX = 21;
