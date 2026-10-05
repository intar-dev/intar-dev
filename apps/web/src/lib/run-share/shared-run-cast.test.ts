import { describe, expect, it } from "vitest";
import type { ShareEvent } from "@/generated/stargate";
import {
  castGeometry,
  castHeaderGeometry,
  castMarkers,
} from "@/components/app/RunArtifactViewerModel";
import { REPLAY_IDLE_TIME_LIMIT_SECONDS } from "@/lib/replay/config";
import { buildShareCast } from "./shared-run-cast";
import { applyShareMessages, createSharedRunState } from "./shared-run-model";

function session(
  events: ShareEvent[],
  overrides: { mode?: "browser" | "native"; cols?: number; rows?: number } = {},
) {
  return { cols: 120, rows: 30, mode: "native" as const, events, ...overrides };
}

function lines(cast: string): unknown[] {
  return cast.split("\n").map((line) => JSON.parse(line) as unknown);
}

/** The seconds each event waits for, as the cast says them. */
function intervals(cast: string): number[] {
  return lines(cast)
    .slice(1)
    .map((line) => (line as [number])[0]);
}

/**
 * How long the player takes to play a cast. The replay model's own clock puts
 * a marker where the player shows it, and that clock shortens a pause to the
 * idle limit, so a marker after the last event is the length of the replay.
 */
function playedSeconds(cast: string): number {
  return castMarkers(`${cast}\n[0,"m","end"]`)[0]?.time ?? 0;
}

describe("buildShareCast", () => {
  it("writes an asciicast v3 header with the session's grid", () => {
    const cast = buildShareCast(
      session([[0, "o", "$ "]], { cols: 132, rows: 34 }),
    );

    expect(lines(cast)[0]).toEqual({ version: 3, term: { cols: 132, rows: 34 } });
    // The replay surface reads the same grid back.
    expect(castHeaderGeometry(cast)).toEqual({ cols: 132, rows: 34 });
  });

  it("turns the log's absolute milliseconds into v3 intervals in seconds", () => {
    const cast = buildShareCast(
      session([
        [400, "o", "a"],
        [1_650, "o", "b"],
        [1_650, "o", "c"],
        [4_000, "o", "d"],
      ]),
    );

    expect(lines(cast).slice(1)).toEqual([
      [0.4, "o", "a"],
      [1.25, "o", "b"],
      [0, "o", "c"],
      [2.35, "o", "d"],
    ]);
  });

  it("treats a clock that steps back as no time passing", () => {
    const cast = buildShareCast(
      session([
        [1_000, "o", "a"],
        [500, "o", "b"],
        [1_500, "o", "c"],
      ]),
    );

    expect(lines(cast).slice(1)).toEqual([
      [1, "o", "a"],
      [0, "o", "b"],
      [0.5, "o", "c"],
    ]);
  });

  it("keeps resizes as r events that the surface counts toward the grid", () => {
    const cast = buildShareCast(
      session([
        [0, "o", "$ "],
        [200, "r", "160x50"],
        [300, "o", "ls\r\n"],
      ]),
    );

    expect(lines(cast).slice(1)).toEqual([
      [0, "o", "$ "],
      [0.2, "r", "160x50"],
      [0.1, "o", "ls\r\n"],
    ]);
    expect(castGeometry(cast)).toEqual({ cols: 160, rows: 50 });
  });

  it("drops what a cast cannot say without losing the time it took", () => {
    const cast = buildShareCast(
      session([
        [100, "o", "a"],
        [200, "r", "wide"],
        [300, "i" as ShareEvent[1], "typed"],
        [400, "o", "b"],
      ]),
    );

    expect(lines(cast).slice(1)).toEqual([
      [0.1, "o", "a"],
      [0.3, "o", "b"],
    ]);
  });

  it("clamps a hostile grid in the header and in a resize", () => {
    const cast = buildShareCast(
      session(
        [
          [0, "o", "x"],
          [1, "r", "999999x999999"],
        ],
        { cols: 100_000, rows: 100_000 },
      ),
    );

    expect(lines(cast)[0]).toEqual({
      version: 3,
      term: { cols: 1000, rows: 1000 },
    });
    expect(lines(cast)[2]).toEqual([0.001, "r", "1000x1000"]);
  });

  it("returns the carriage with every line feed of a browser session", () => {
    const events: ShareEvent[] = [
      [0, "o", "one\ntwo\r\nthree\n"],
      [1, "o", "\rfour"],
    ];

    expect(lines(buildShareCast(session(events, { mode: "browser" }))).slice(1))
      .toEqual([
        [0, "o", "one\r\ntwo\r\nthree\r\n"],
        [0.001, "o", "\rfour"],
      ]);
    // A native session is the user's own terminal, which does not.
    expect(lines(buildShareCast(session(events, { mode: "native" }))).slice(1))
      .toEqual([
        [0, "o", "one\ntwo\r\nthree\n"],
        [0.001, "o", "\rfour"],
      ]);
  });

  it("escapes control characters so every event stays on its own line", () => {
    const cast = buildShareCast(
      session([[0, "o", "\u001b[31mred\u001b[0m \n"]], { mode: "native" }),
    );

    expect(cast.split("\n")).toHaveLength(2);
    expect(lines(cast)[1]).toEqual([0, "o", "\u001b[31mred\u001b[0m \n"]);
  });

  it("is empty when there is nothing to play", () => {
    expect(buildShareCast(session([]))).toBe("");
    expect(buildShareCast(session([[0, "r", "nonsense"]]))).toBe("");
  });

  it("carries no check markers, so the surface has none to draw", () => {
    expect(castMarkers(buildShareCast(session([[0, "o", "x"]])))).toEqual([]);
  });
});

describe("the speed of the replay", () => {
  it("keeps the learner's real spacing: events at 0, 120, 250 and 400 ms", () => {
    const cast = buildShareCast(
      session([
        [0, "o", "l"],
        [120, "o", "s"],
        [250, "o", " "],
        [400, "o", "-la"],
      ]),
    );

    expect(intervals(cast)).toEqual([0, 0.12, 0.13, 0.15]);
    // Played back, the replay takes as long as the typing did.
    expect(playedSeconds(cast)).toBeCloseTo(0.4, 6);
  });

  it("does not give the events of one batch one timestamp", () => {
    // A learner typing fast: five keys in 120 ms, delivered as one row.
    const state = applyShareMessages(createSharedRunState(), [
      { type: "mission", mission: undefined as never },
      {
        type: "start",
        session: "a",
        vm_id: "vm_web",
        mode: "native",
        cols: 80,
        rows: 24,
        at_ms: 0,
        mid_session: false,
        resumed: false,
      },
      {
        type: "events",
        session: "a",
        events: [
          [0, "o", "e"],
          [30, "o", "c"],
          [60, "o", "h"],
          [90, "o", "o"],
          [120, "o", "\r\n"],
        ],
      },
    ]);

    expect(intervals(buildShareCast(state.sessions[0]!))).toEqual([
      0, 0.03, 0.03, 0.03, 0.03,
    ]);
  });

  it("keeps the spacing across the batches the events arrived in", () => {
    const row = (events: ShareEvent[]) =>
      ({ type: "events", session: "a", events }) as const;
    const startA = {
      type: "start",
      session: "a",
      vm_id: "vm_web",
      mode: "native",
      cols: 80,
      rows: 24,
      at_ms: 0,
      mid_session: false,
      resumed: false,
    } as const;

    // Two segments, then one batch: the same events, however they came.
    const early = applyShareMessages(createSharedRunState(), [
      startA,
      row([
        [0, "o", "a"],
        [120, "o", "b"],
      ]),
    ]);
    const late = applyShareMessages(early, [
      row([
        [250, "o", "c"],
        [400, "o", "d"],
      ]),
    ]);
    const together = applyShareMessages(createSharedRunState(), [
      startA,
      row([
        [0, "o", "a"],
        [120, "o", "b"],
      ]),
      row([
        [250, "o", "c"],
        [400, "o", "d"],
      ]),
    ]);

    expect(intervals(buildShareCast(late.sessions[0]!))).toEqual([
      0, 0.12, 0.13, 0.15,
    ]);
    expect(buildShareCast(late.sessions[0]!)).toBe(
      buildShareCast(together.sessions[0]!),
    );
  });

  it("shortens a pause of ten seconds to the idle limit, and only that", () => {
    const cast = buildShareCast(
      session([
        [0, "o", "a"],
        [120, "o", "b"],
        [10_120, "o", "c"],
        [10_250, "o", "d"],
      ]),
    );

    // The cast keeps the pause as it was: shortening it is the player's job.
    expect(intervals(cast)).toEqual([0, 0.12, 10, 0.13]);
    expect(REPLAY_IDLE_TIME_LIMIT_SECONDS).toBe(1.5);
    // The 120 and 130 ms stay as they were; the ten seconds become 1.5.
    expect(playedSeconds(cast)).toBeCloseTo(
      0.12 + REPLAY_IDLE_TIME_LIMIT_SECONDS + 0.13,
      6,
    );
  });

  it("keeps every gap up to the idle limit as it was", () => {
    for (const gap of [0.2, 1, 1.4, 1.5]) {
      const cast = buildShareCast(
        session([
          [0, "o", "a"],
          [gap * 1000, "o", "b"],
        ]),
      );
      expect(playedSeconds(cast)).toBeCloseTo(gap, 6);
    }
    // Past it, the player's limit takes over.
    const longer = buildShareCast(
      session([
        [0, "o", "a"],
        [1_600, "o", "b"],
      ]),
    );
    expect(playedSeconds(longer)).toBeCloseTo(1.5, 6);
  });

  it("adds up to the log's own times, with no rounding that drifts", () => {
    // Whole milliseconds, so a long session ends where the log ends.
    const events: ShareEvent[] = Array.from({ length: 1_000 }, (_, index) => [
      index * 1.7,
      "o",
      "x",
    ]);
    const total = intervals(buildShareCast(session(events))).reduce(
      (sum, interval) => sum + interval,
      0,
    );

    expect(total).toBeCloseTo(Math.round(999 * 1.7) / 1000, 6);
  });

  it("takes a time that is not a number to take no time", () => {
    const cast = buildShareCast(
      session([
        [100, "o", "a"],
        [Number.NaN, "o", "b"],
        [200, "o", "c"],
      ]),
    );

    expect(intervals(cast)).toEqual([0.1, 0, 0.1]);
  });
});
