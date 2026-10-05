import { describe, expect, it } from "vitest";
import type { ShareEvent } from "@/generated/stargate";
import { createShareEventPump } from "./shared-run-pump";

/**
 * xterm parses a write later and runs its callback right after that chunk,
 * but resizes at once. This sink does the same, and records the order in which
 * the terminal would have seen things.
 */
function fakeTerminal() {
  const queue: Array<{ data: string; callback: (() => void) | undefined }> = [];
  const seen: string[] = [];
  return {
    seen,
    queued: () => queue.length,
    queuedSize: () => queue.reduce((total, item) => total + item.data.length, 0),
    sink: {
      write(data: string, callback?: () => void) {
        queue.push({ data, callback });
      },
      resize(cols: number, rows: number) {
        seen.push(`resize ${cols}x${rows}`);
      },
    },
    /** Parses everything queued, including what the callbacks queue. */
    drain() {
      while (queue.length) {
        const item = queue.shift()!;
        if (item.data) seen.push(`write ${item.data}`);
        item.callback?.();
      }
    },
    /** Parses one write, the way xterm's time slice would. */
    step() {
      const item = queue.shift();
      if (!item) return;
      if (item.data) seen.push(`write ${item.data}`);
      item.callback?.();
    },
  };
}

describe("share event pump", () => {
  it("joins output into one write and resizes only after the output before it", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);

    pump.push([
      [0, "o", "a"],
      [10, "o", "b"],
      [20, "r", "100x40"],
      [30, "o", "c"],
      [40, "r", "80x24"],
    ]);
    // Nothing has been parsed, so nothing may have been resized yet.
    expect(terminal.seen).toEqual([]);

    terminal.drain();
    expect(terminal.seen).toEqual([
      "write ab",
      "resize 100x40",
      "write c",
      "resize 80x24",
    ]);
  });

  it("writes only what is new when the same log grows", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);
    const log: ShareEvent[] = [[0, "o", "one"]];

    pump.push(log);
    terminal.drain();
    const grown: ShareEvent[] = [...log, [5, "o", "two"], [6, "o", "three"]];
    pump.push(grown);
    pump.push(grown);
    terminal.drain();

    expect(terminal.seen).toEqual(["write one", "write twothree"]);
  });

  it("holds the screen where a paused viewer left it, then catches up", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);
    const log: ShareEvent[] = [
      [0, "o", "a"],
      [1, "o", "b"],
      [2, "r", "100x40"],
      [3, "o", "c"],
    ];

    // Paused after the second event: the rest is held back.
    pump.push(log, 2);
    terminal.drain();
    expect(terminal.seen).toEqual(["write ab"]);

    // Still paused while the log grows.
    pump.push([...log, [4, "o", "d"]], 2);
    terminal.drain();
    expect(terminal.seen).toEqual(["write ab"]);

    // Resumed: the backlog follows, in order.
    pump.push([...log, [4, "o", "d"]]);
    terminal.drain();
    expect(terminal.seen).toEqual(["write ab", "resize 100x40", "write cd"]);
  });

  it("clamps a resize the learner's terminal chose", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);

    pump.push([
      [0, "r", "99999x99999"],
      [1, "r", "0x0"],
      [2, "r", "garbage"],
    ]);
    terminal.drain();

    expect(terminal.seen).toEqual(["resize 1000x1000", "resize 2x1"]);
  });

  it("skips an unknown code and an empty output without skipping its neighbours", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);

    pump.push([
      [0, "o", ""],
      [1, "o", "a"],
      [2, "i" as ShareEvent[1], "typed"],
      [3, "o", "b"],
      [4, "o", ""],
      [5, "r", "90x20"],
    ]);
    terminal.drain();

    expect(terminal.seen).toEqual(["write a", "write b", "resize 90x20"]);
  });

  it("writes a long backlog as the terminal drains instead of all at once", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);
    // 6 MB of output in 600 events of 10 kB.
    const line = "x".repeat(10_000);
    const log: ShareEvent[] = Array.from({ length: 600 }, (_, index) => [
      index,
      "o",
      line,
    ]);

    pump.push(log);
    expect(terminal.queuedSize()).toBeLessThan(2_100_000);

    let written = 0;
    while (terminal.queued() > 0) {
      terminal.step();
      expect(terminal.queuedSize()).toBeLessThan(2_100_000);
    }
    written = terminal.seen.reduce(
      (total, entry) => total + entry.length - "write ".length,
      0,
    );
    expect(written).toBe(6_000_000);
  });

  it("writes nothing and resizes nothing after it is disposed", () => {
    const terminal = fakeTerminal();
    const pump = createShareEventPump(terminal.sink);

    pump.push([
      [0, "o", "a"],
      [1, "r", "100x40"],
    ]);
    pump.dispose();
    terminal.drain();
    pump.push([[2, "o", "late"]]);
    terminal.drain();

    expect(terminal.seen).toEqual(["write a"]);
  });
});
