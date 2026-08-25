import { describe, expect, it } from "vitest";
import { replayPlayerErrorCopy } from "./RunArtifactViewer";

describe("replay player error copy", () => {
  it("keeps raw player failures out of the learner replay", () => {
    const raw = "asciinema import failed at internal worker path";

    expect(replayPlayerErrorCopy(raw, true)).toBe(
      "Replay could not be loaded. Try again soon.",
    );
    expect(replayPlayerErrorCopy(raw, true)).not.toContain(raw);
    expect(replayPlayerErrorCopy(raw, false)).toBe(raw);
  });
});
