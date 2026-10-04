import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_ROWS,
} from "@/lib/replay/config";

/** The tallest a replay grows: it fits inside this on larger screens. */
export const REPLAY_MAX_HEIGHT = "70dvh";

/** Speeds the replay cycles through. */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Seconds an arrow key moves the replay. */
export const REPLAY_KEY_STEP_SECONDS = 2;

/** The scrub track's step, in seconds. */
export const REPLAY_SCRUB_STEP = 0.01;

/**
 * A scrub value on the cast. The track's step grid can stop short of the
 * cast's end (28.12 for a 28.1234 s cast), which would leave the end out of
 * reach of a drag or a click on the track, so the last step snaps to it.
 */
export function snapReplayScrub(value: number, duration: number): number {
  return duration - value < REPLAY_SCRUB_STEP ? duration : value;
}

export function nextReplaySpeed(speed: ReplaySpeed): ReplaySpeed {
  const index = REPLAY_SPEEDS.indexOf(speed);
  return REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length] ?? 1;
}

/** `m:ss`, never zero-padded minutes. Unknown or negative values read 0:00. */
export function formatReplayClock(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** What assistive technology reads for the position: `0:21 of 0:28`. */
export function replayValueText(time: number, duration: number): string {
  return `${formatReplayClock(time)} of ${formatReplayClock(duration)}`;
}

/**
 * Where a key on the position slider goes, or null for any other key. Arrows
 * step two seconds, Home and End go to either end, and Page Up and Page Down
 * jump between checks (with no check markers yet, to the start and the end).
 */
export function replayKeyTarget(
  key: string,
  time: number,
  duration: number,
): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(duration, time + REPLAY_KEY_STEP_SECONDS);
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, time - REPLAY_KEY_STEP_SECONDS);
    case "Home":
    case "PageUp":
      return 0;
    case "End":
    case "PageDown":
      return duration;
    default:
      return null;
  }
}

export interface CastGeometry {
  cols: number;
  rows: number;
}

const MAX_CELLS = 1000;

function validCells(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_CELLS
    ? value
    : null;
}

/** The recorded grid from the cast header (v2 `width`/`height`, v3 `term`). */
export function castHeaderGeometry(content: string): CastGeometry {
  const fallback = { cols: REPLAY_TERMINAL_COLS, rows: REPLAY_TERMINAL_ROWS };
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  if (!first.startsWith("{")) return fallback;
  try {
    const header = JSON.parse(first) as {
      width?: unknown;
      height?: unknown;
      term?: { cols?: unknown; rows?: unknown };
    };
    const cols = validCells(header.term?.cols ?? header.width);
    const rows = validCells(header.term?.rows ?? header.height);
    return { cols: cols ?? fallback.cols, rows: rows ?? fallback.rows };
  } catch {
    return fallback;
  }
}

/**
 * The largest grid the cast ever uses: the header and every mid-session `r`
 * (resize) event. The screen is sized once from this, so a later resize
 * letterboxes inside the same box instead of moving the page.
 */
export function castGeometry(content: string): CastGeometry {
  const header = castHeaderGeometry(content);
  let { cols, rows } = header;
  for (const match of content.matchAll(/,\s*"r"\s*,\s*"(\d+)x(\d+)"/g)) {
    const resizedCols = validCells(Number(match[1]));
    const resizedRows = validCells(Number(match[2]));
    if (resizedCols !== null) cols = Math.max(cols, resizedCols);
    if (resizedRows !== null) rows = Math.max(rows, resizedRows);
  }
  return { cols, rows };
}

/**
 * Width over height of a cast screen, in cell units: a mono cell is about
 * 0.6em wide, a row is the shared line height, and the player draws 0.75em
 * of margin on every side. It only sizes the box; the player's own fit then
 * letterboxes whatever the real font metrics turn out to be.
 */
export function castAspectRatio({ cols, rows }: CastGeometry): number {
  return (0.6 * cols + 1.5) / (REPLAY_TERMINAL_LINE_HEIGHT * rows + 1.5);
}
