import { describe, expect, it } from "vitest";
import {
  formatReplayTimestamp,
  parseReplayCommandLog,
} from "./replay-command-log";

const CAST = [
  '{"version":2,"width":120,"height":40}',
  '[0.5,"o","$ "]',
  '[1.25,"i","systemctl start nginx\\r"]',
  '[2.0,"o","started\\r\\n"]',
  '[65.4,"i","curl -fsS http://localhost\\n"]',
  '[70.1,"i","\\u001b[A"]',
  "not json",
  '[71,"i","  "]',
].join("\n");

describe("parseReplayCommandLog", () => {
  it("extracts only meaningful input events", () => {
    const entries = parseReplayCommandLog(CAST);
    expect(entries).toEqual([
      { atSeconds: 1.25, text: "systemctl start nginx" },
      { atSeconds: 65.4, text: "curl -fsS http://localhost" },
    ]);
  });

  it("keeps multi-line pasted input readable", () => {
    const entries = parseReplayCommandLog(
      '[3,"i","echo one\\necho two\\n"]',
    );
    expect(entries[0]?.text).toBe("echo one\necho two");
  });

  it("returns empty for casts without input events", () => {
    expect(parseReplayCommandLog('[1,"o","output only"]')).toEqual([]);
  });

  it("accumulates v3 interval times into absolute timestamps", () => {
    const cast = [
      '{"version":3,"term":{"cols":80,"rows":24}}',
      '[0.5,"o","$ "]',
      '[0.75,"i","ls\\r"]',
      '[1.0,"o","listing\\r\\n"]',
      '[2.0,"i","exit\\r"]',
    ].join("\n");
    expect(parseReplayCommandLog(cast)).toEqual([
      { atSeconds: 1.25, text: "ls" },
      { atSeconds: 4.25, text: "exit" },
    ]);
  });
});

describe("formatReplayTimestamp", () => {
  it("formats mm:ss", () => {
    expect(formatReplayTimestamp(65.4)).toBe("01:05");
    expect(formatReplayTimestamp(0)).toBe("00:00");
  });
});
