import { describe, expect, it } from "vitest";
import type { ShareEvent } from "@/generated/stargate";
import {
  castGeometry,
  castHeaderGeometry,
  castMarkers,
} from "@/components/app/RunArtifactViewerModel";
import { buildShareCast } from "./shared-run-cast";

function session(
  events: ShareEvent[],
  overrides: { mode?: "browser" | "native"; cols?: number; rows?: number } = {},
) {
  return { cols: 120, rows: 30, mode: "native" as const, events, ...overrides };
}

function lines(cast: string): unknown[] {
  return cast.split("\n").map((line) => JSON.parse(line) as unknown);
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
