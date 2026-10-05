import type { ShareEvent } from "@/generated/stargate";
import { parseShareResize } from "./shared-run-model";

/** The slice of an xterm `Terminal` the pump drives. */
export interface ShareEventSink {
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
}

/** xterm discards a write once 50 MB wait; the pump stays far below that. */
const PENDING_LIMIT = 2_000_000;
const CHUNK_SIZE = 64_000;

export interface ShareEventPump {
  /**
   * The session's log so far. Each call passes the same log, grown: what the
   * pump already wrote is skipped and the rest is written in order, up to
   * `until` events (a paused viewer holds the screen where it was).
   */
  push(events: readonly ShareEvent[], until?: number): void;
  /** After this the sink is gone and nothing more is written to it. */
  dispose(): void;
}

/**
 * Writes a session's events to a terminal. Output is joined into few large
 * writes, and a resize waits for the output before it to be parsed: xterm
 * parses a write later but resizes at once, so a resize called in line would
 * reflow the screen before the text meant for the old size had landed. A big
 * backlog (a viewer joining a long session, or resuming after a pause) is
 * written as the terminal drains, not all at once.
 */
export function createShareEventPump(sink: ShareEventSink): ShareEventPump {
  let log: readonly ShareEvent[] = [];
  let end = 0;
  let index = 0;
  let pending = 0;
  let disposed = false;

  const run = () => {
    while (!disposed && index < end && pending < PENDING_LIMIT) {
      const event = log[index]!;
      if (event[1] === "r") {
        index += 1;
        const grid = parseShareResize(event[2]);
        if (grid) {
          sink.write("", () => {
            if (!disposed) sink.resize(grid.cols, grid.rows);
          });
        }
        continue;
      }
      const first = index;
      let chunk = "";
      while (index < end && chunk.length < CHUNK_SIZE && log[index]![1] === "o") {
        chunk += log[index]![2];
        index += 1;
      }
      if (index === first) {
        // A code this viewer does not know.
        index += 1;
        continue;
      }
      if (chunk.length === 0) continue;
      const size = chunk.length;
      pending += size;
      sink.write(chunk, () => {
        pending -= size;
        run();
      });
    }
  };

  return {
    push(events, until = events.length) {
      log = events;
      end = Math.min(until, events.length);
      run();
    },
    dispose() {
      disposed = true;
    },
  };
}
