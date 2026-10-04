import { describe, expect, it } from "vitest";
import {
  castAspectRatio,
  castGeometry,
  castHeaderGeometry,
  castMarkers,
  formatReplayClock,
  nextReplaySpeed,
  replayCheckMarkers,
  replayKeyTarget,
  replayMarkerAnnouncement,
  replayMarkerEdge,
  replayMarkerAt,
  replayMarkersAnnouncement,
  replayMarkersPassed,
  replayMarkerTip,
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

  it("adds how many checks are verified when the replay has checks", () => {
    expect(replayValueText(21.4, 28, { passed: 2, total: 3 })).toBe(
      "0:21 of 0:28, 2 of 3 checks verified",
    );
    expect(replayValueText(5, 28, { passed: 0, total: 1 })).toBe(
      "0:05 of 0:28, 0 of 1 check verified",
    );
    expect(replayValueText(5, 28, { passed: 0, total: 0 })).toBe("0:05 of 0:28");
  });

  it("counts only this part's checks when the machine has several sessions", () => {
    expect(replayValueText(21.4, 28, { passed: 2, total: null })).toBe(
      "0:21 of 0:28, 2 checks verified in this part",
    );
    expect(replayValueText(5, 28, { passed: 1, total: null })).toBe(
      "0:05 of 0:28, 1 check verified in this part",
    );
  });
});

describe("replay slider keys", () => {
  it("steps two seconds and stays inside the cast", () => {
    expect(replayKeyTarget("ArrowRight", 10, 28)).toBe(12);
    expect(replayKeyTarget("ArrowUp", 27, 28)).toBe(28);
    expect(replayKeyTarget("ArrowLeft", 10, 28)).toBe(8);
    expect(replayKeyTarget("ArrowDown", 1, 28)).toBe(0);
  });

  it("jumps between checks with Page Up and Page Down", () => {
    const checks = [7, 21, 25];
    expect(replayKeyTarget("PageDown", 0, 28, checks)).toBe(7);
    expect(replayKeyTarget("PageDown", 7, 28, checks)).toBe(21);
    expect(replayKeyTarget("PageDown", 25, 28, checks)).toBe(28);
    expect(replayKeyTarget("PageUp", 22, 28, checks)).toBe(21);
    expect(replayKeyTarget("PageUp", 21, 28, checks)).toBe(7);
    expect(replayKeyTarget("PageUp", 7, 28, checks)).toBe(0);
    expect(replayKeyTarget("Home", 22, 28, checks)).toBe(0);
    expect(replayKeyTarget("End", 2, 28, checks)).toBe(28);
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

describe("replay check markers", () => {
  const cast = [
    '{"version":3,"term":{"cols":80,"rows":24}}',
    '[0.5,"o","$ "]',
    '[1.5,"m","nginx-running"]',
    '[0.3,"o","ok"]',
    // An idle gap the player clamps to 1.5 s.
    '[9.0,"o","later"]',
    '[0.2,"m","site-enabled"]',
    '[0.1,"m","boot-probe"]',
    '[0.1,"m","nginx-running"]',
  ].join("\n");

  it("reads marker events at playback time, with the player's idle clamp", () => {
    expect(castMarkers(cast)).toEqual([
      { time: 2, label: "nginx-running" },
      { time: expect.closeTo(4, 6), label: "site-enabled" },
      { time: expect.closeTo(4.1, 6), label: "boot-probe" },
      { time: expect.closeTo(4.2, 6), label: "nginx-running" },
    ]);
  });

  it("reads absolute v2 times and ignores casts it cannot read", () => {
    expect(
      castMarkers(
        ['{"version":2,"width":80,"height":24}', '[1.0,"o","a"]', '[2.5,"m","x"]'].join(
          "\n",
        ),
      ),
    ).toEqual([{ time: 2.5, label: "x" }]);
    expect(castMarkers("not a cast")).toEqual([]);
    expect(castMarkers('{"version":3}\n[1,"o","no markers"]')).toEqual([]);
  });

  it("keeps each of the machine's checks once, at its first pass", () => {
    const markers = replayCheckMarkers(cast, [
      { probeName: "site-enabled", number: 2, title: "The default site is enabled" },
      { probeName: "nginx-running", number: 1, title: "Nginx is running" },
    ]);
    expect(markers).toEqual([
      { time: 2, number: 1, title: "Nginx is running" },
      { time: expect.closeTo(4, 6), number: 2, title: "The default site is enabled" },
    ]);
    expect(replayCheckMarkers(cast, [])).toEqual([]);
  });

  it("names a marker in its tip and its announcement", () => {
    const marker = { time: 21.4, number: 2, title: "The default site is enabled" };
    expect(replayMarkerTip(marker)).toBe("Check 2 verified · 0:21");
    expect(replayMarkerAnnouncement(marker)).toBe(
      "Check 2 verified: The default site is enabled.",
    );
  });

  it("anchors tips inward near the ends of the track", () => {
    expect(replayMarkerEdge(0.1)).toBe("start");
    expect(replayMarkerEdge(0.5)).toBeUndefined();
    expect(replayMarkerEdge(0.9)).toBe("end");
  });

  it("finds the markers playback crossed, not the one it started on", () => {
    const markers = [
      { time: 7, number: 1, title: "a" },
      { time: 21, number: 2, title: "b" },
    ];
    expect(replayMarkersPassed(markers, 6.9, 7)).toEqual([markers[0]]);
    expect(replayMarkersPassed(markers, 7, 20)).toEqual([]);
    expect(replayMarkersPassed(markers, 0, 28)).toEqual(markers);
  });

  it("announces every check a frame crossed, and finds the one a jump landed on", () => {
    const markers = [
      { time: 7, number: 1, title: "a" },
      { time: 21, number: 2, title: "b" },
    ];
    expect(replayMarkersAnnouncement(markers)).toBe(
      "Check 1 verified: a. Check 2 verified: b.",
    );
    expect(replayMarkerAt(markers, 21)).toBe(markers[1]);
    expect(replayMarkerAt(markers, 20)).toBeUndefined();
  });
});
