import type { ShareSession } from "./shared-run-model";
import { clampShareGrid, parseShareResize } from "./shared-run-model";

/**
 * A session's log as an asciicast v3 recording, the shape the replay surface
 * plays: a header with the grid, then one `[seconds since the last event, code,
 * data]` line per event. The log's own times are milliseconds since the PTY
 * started, so each line carries the difference from the one before it.
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
    // A clock that steps back is a stalled one, not a negative interval.
    const at = Math.max(ms, previous);
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
