import {
  REPLAY_IDLE_TIME_LIMIT_SECONDS,
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

/**
 * What assistive technology reads for the position: `0:21 of 0:28`, and with
 * checks `0:21 of 0:28, 2 of 3 checks verified` (or, for one session of
 * several, `0:21 of 0:28, 2 checks verified in this part`).
 */
export function replayValueText(
  time: number,
  duration: number,
  checks?: { passed: number; total: number | null },
): string {
  const position = `${formatReplayClock(time)} of ${formatReplayClock(duration)}`;
  if (!checks || checks.total === 0) return position;
  // No total: one of several sessions of a machine, whose cast only holds the
  // checks that first passed in it, so a fraction would undercount.
  if (checks.total === null) {
    const noun = checks.passed === 1 ? "check" : "checks";
    return `${position}, ${checks.passed} ${noun} verified in this part`;
  }
  const noun = checks.total === 1 ? "check" : "checks";
  return `${position}, ${checks.passed} of ${checks.total} ${noun} verified`;
}

/** Two marker times this close are the same place on the track. */
const MARKER_EPSILON_SECONDS = 0.01;

/**
 * Where a key on the position slider goes, or null for any other key. Arrows
 * step two seconds, Home and End go to either end, and Page Up and Page Down
 * jump to the previous or next check (past the last one, to the ends).
 */
export function replayKeyTarget(
  key: string,
  time: number,
  duration: number,
  markerTimes: readonly number[] = [],
): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(duration, time + REPLAY_KEY_STEP_SECONDS);
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, time - REPLAY_KEY_STEP_SECONDS);
    case "Home":
      return 0;
    case "End":
      return duration;
    case "PageUp":
      return (
        markerTimes.findLast((at) => at < time - MARKER_EPSILON_SECONDS) ?? 0
      );
    case "PageDown":
      return Math.min(
        duration,
        markerTimes.find((at) => at > time + MARKER_EPSILON_SECONDS) ??
          duration,
      );
    default:
      return null;
  }
}

/** A check of the replayed machine, matched to the cast by its probe name. */
export interface ReplayCheck {
  probeName: string;
  number: number;
  title: string;
}

/** A check that first passed during this cast, at its playback time. */
export interface ReplayCheckMarker {
  time: number;
  number: number;
  title: string;
}

/**
 * The cast's marker (`m`) events at playback time. The recorder writes a
 * check's first pass as one; the times follow the player's own idle clamp, so
 * a marker sits where the player shows it.
 */
export function castMarkers(
  content: string,
): { time: number; label: string }[] {
  const lines = content.split("\n");
  let intervals = false;
  try {
    intervals = (JSON.parse(lines[0] ?? "") as { version?: unknown }).version === 3;
  } catch {
    return [];
  }
  const markers: { time: number; label: string }[] = [];
  let raw = 0;
  let played = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith("[")) continue;
    const stamp = Number.parseFloat(line.slice(1));
    if (!Number.isFinite(stamp)) continue;
    const next = intervals ? raw + Math.max(stamp, 0) : Math.max(stamp, raw);
    played += Math.min(next - raw, REPLAY_IDLE_TIME_LIMIT_SECONDS);
    raw = next;
    if (!/^\[[^,]*,\s*"m"/.test(line)) continue;
    try {
      const label = (JSON.parse(line) as unknown[])[2];
      if (typeof label === "string") markers.push({ time: played, label });
    } catch {
      // A torn line marks nothing.
    }
  }
  return markers;
}

/**
 * The checks this cast marks, in playback order: each check once, at its
 * first pass. Markers for anything that is not one of `checks` (a startup
 * probe, another machine's check) are left out.
 */
export function replayCheckMarkers(
  content: string,
  checks: readonly ReplayCheck[],
): ReplayCheckMarker[] {
  const byProbe = new Map(checks.map((check) => [check.probeName, check]));
  const seen = new Set<string>();
  const markers: ReplayCheckMarker[] = [];
  for (const { time, label } of castMarkers(content)) {
    const check = byProbe.get(label);
    if (!check || seen.has(label)) continue;
    seen.add(label);
    markers.push({ time, number: check.number, title: check.title });
  }
  return markers.sort((left, right) => left.time - right.time);
}

/** The tip on a marker: `Check 2 verified · 0:21`. */
export function replayMarkerTip(marker: ReplayCheckMarker): string {
  return `Check ${marker.number} verified · ${formatReplayClock(marker.time)}`;
}

/** What is announced as playback passes a marker. */
export function replayMarkerAnnouncement(marker: ReplayCheckMarker): string {
  return `Check ${marker.number} verified: ${marker.title}.`;
}

/** What is announced when playback crosses several markers at once. */
export function replayMarkersAnnouncement(
  markers: readonly ReplayCheckMarker[],
): string {
  return markers.map(replayMarkerAnnouncement).join(" ");
}

/** The marker sitting at `time` (a jump landed on it), if any. */
export function replayMarkerAt(
  markers: readonly ReplayCheckMarker[],
  time: number,
): ReplayCheckMarker | undefined {
  return markers.find(
    (marker) => Math.abs(marker.time - time) < MARKER_EPSILON_SECONDS,
  );
}

/** Near an end of the track a marker's tip anchors inward. */
export function replayMarkerEdge(at: number): "start" | "end" | undefined {
  if (at <= 0.25) return "start";
  if (at >= 0.75) return "end";
  return undefined;
}

/** The markers playback crossed going from `from` to `to`. */
export function replayMarkersPassed(
  markers: readonly ReplayCheckMarker[],
  from: number,
  to: number,
): ReplayCheckMarker[] {
  return markers.filter((marker) => marker.time > from && marker.time <= to);
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
