import type { ShareSession } from "./shared-run-model";
import { clampShareGrid, parseShareResize } from "./shared-run-model";

/**
 * A session's log as an asciicast v3 recording, the shape the replay surface
 * plays: a header with the grid, then one `[seconds since the last event, code,
 * data]` line per event. The log's own times are milliseconds since the PTY
 * started, one per event, so each line carries the real difference from the
 * event before it, however the events were batched on their way here: the
 * replay plays at the speed the learner typed. A long pause stays long in the
 * cast; the player shortens it (to its idle limit) as it plays.
 *
 * The web terminal draws with `convertEol`, so a line feed there returns the
 * carriage too. The player has no such option, so a browser session's output
 * gets it here (a CRLF is already one, and stays one).
 *
 * A log with nothing to play is an empty string, which the surface shows as an
 * empty replay instead of a player with nothing to play.
 */
export function buildShareCast(
  session: Pick<ShareSession, "cols" | "rows" | "mode" | "events">,
): string {
  const { cols, rows } = clampShareGrid(session.cols, session.rows);
  const lines = [JSON.stringify({ version: 3, term: { cols, rows } })];
  let previous = 0;
  for (const [ms, code, data] of session.events) {
    // Whole milliseconds, so the intervals add up to the log's own times with
    // no rounding that drifts. A clock that steps back is a stalled one, not a
    // negative interval, and a time that is not a number takes no time.
    const at = Number.isFinite(ms) ? Math.max(Math.round(ms), previous) : previous;
    const interval = Number(((at - previous) / 1000).toFixed(3));
    if (code === "o") {
      const text = session.mode === "browser" ? toCrlf(data) : data;
      lines.push(JSON.stringify([interval, "o", text]));
    } else if (code === "r") {
      const grid = parseShareResize(data);
      if (!grid) continue;
      lines.push(JSON.stringify([interval, "r", `${grid.cols}x${grid.rows}`]));
    } else {
      continue;
    }
    previous = at;
  }
  return lines.length === 1 ? "" : lines.join("\n");
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}
