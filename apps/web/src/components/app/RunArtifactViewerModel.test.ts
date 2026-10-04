import { describe, expect, it } from "vitest";
import {
  castAspectRatio,
  castGeometry,
  castHeaderGeometry,
  formatReplayClock,
  nextReplaySpeed,
  replayKeyTarget,
  replayValueText,
  snapReplayScrub,
} from "./RunArtifactViewerModel";

describe("replay clock", () => {
  it("reads m:ss with no zero-padded minutes", () => {
    expect(formatReplayClock(0)).toBe("0:00");
    expect(formatReplayClock(19.9)).toBe("0:19");
    expect(formatReplayClock(28)).toBe("0:28");
    expect(formatReplayClock(605)).toBe("10:05");
    expect(formatReplayClock(Number.NaN)).toBe("0:00");
    expect(formatReplayClock(-3)).toBe("0:00");
  });

  it("gives the slider value text a position and a total", () => {
    expect(replayValueText(21.4, 28)).toBe("0:21 of 0:28");
  });
});

describe("replay slider keys", () => {
  it("steps two seconds and stays inside the cast", () => {
    expect(replayKeyTarget("ArrowRight", 10, 28)).toBe(12);
    expect(replayKeyTarget("ArrowUp", 27, 28)).toBe(28);
    expect(replayKeyTarget("ArrowLeft", 10, 28)).toBe(8);
    expect(replayKeyTarget("ArrowDown", 1, 28)).toBe(0);
  });

  it("goes to either end, and Page keys fall back to the ends without checks", () => {
    expect(replayKeyTarget("Home", 10, 28)).toBe(0);
    expect(replayKeyTarget("End", 10, 28)).toBe(28);
    expect(replayKeyTarget("PageUp", 10, 28)).toBe(0);
    expect(replayKeyTarget("PageDown", 10, 28)).toBe(28);
  });

  it("leaves every other key alone", () => {
    expect(replayKeyTarget("a", 10, 28)).toBeNull();
    expect(replayKeyTarget(" ", 10, 28)).toBeNull();
  });
});

describe("replay scrub", () => {
  it("reaches the end of a cast that is not on the step grid", () => {
    // The track rounds 28.1234 s to 28.12, one step short of the end.
    expect(snapReplayScrub(28.12, 28.1234)).toBe(28.1234);
    expect(snapReplayScrub(28.1234, 28.1234)).toBe(28.1234);
  });

  it("leaves every other position where it is", () => {
    expect(snapReplayScrub(0, 28.1234)).toBe(0);
    expect(snapReplayScrub(14.5, 28.1234)).toBe(14.5);
    expect(snapReplayScrub(28.1, 28.1234)).toBe(28.1);
  });
});

describe("replay speed", () => {
  it("cycles 1, 2, 4 and back", () => {
    expect(nextReplaySpeed(1)).toBe(2);
    expect(nextReplaySpeed(2)).toBe(4);
    expect(nextReplaySpeed(4)).toBe(1);
  });
});

describe("cast geometry", () => {
  it("reads v2 and v3 headers and falls back to the live grid", () => {
    expect(castHeaderGeometry('{"version":2,"width":80,"height":24}\n')).toEqual({
      cols: 80,
      rows: 24,
    });
    expect(
      castHeaderGeometry('{"version":3,"term":{"cols":100,"rows":40}}\n'),
    ).toEqual({ cols: 100, rows: 40 });
    expect(castHeaderGeometry("not json")).toEqual({ cols: 120, rows: 30 });
    expect(castHeaderGeometry('{"version":2,"width":0}')).toEqual({
      cols: 120,
      rows: 30,
    });
  });

  it("takes the largest grid across resize events", () => {
    const cast = [
      '{"version":2,"width":80,"height":24}',
      '[0.5,"o","hi"]',
      '[1.0,"r","132x43"]',
      '[2.0,"r","90x20"]',
    ].join("\n");

    expect(castGeometry(cast)).toEqual({ cols: 132, rows: 43 });
  });

  it("derives a wider box for a wider grid", () => {
    expect(castAspectRatio({ cols: 120, rows: 30 })).toBeGreaterThan(
      castAspectRatio({ cols: 80, rows: 30 }),
    );
  });
});
