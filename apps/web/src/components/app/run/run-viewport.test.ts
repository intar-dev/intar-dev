import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detentForSection,
  readKeyboard,
  RUN_QUERY,
  type KeyboardBaseline,
} from "./run-viewport";

const css = readFileSync(
  new URL("../../../styles/global.css", import.meta.url),
  "utf8",
);

describe("run viewport thresholds", () => {
  it("keeps the matchMedia queries and the Tailwind variants in step", () => {
    expect(css).toContain(`@custom-variant dock (@media ${RUN_QUERY.docked});`);
    expect(css).toContain(`@custom-variant split (@media ${RUN_QUERY.split});`);
    expect(css).toContain(`@custom-variant short (@media ${RUN_QUERY.short});`);
    expect(css).toContain(`@custom-variant phone (@media ${RUN_QUERY.phone});`);
    expect(css).toContain("--breakpoint-run: 60rem;");
  });

  it("peeks at the checks and opens lecture and hints full", () => {
    expect(detentForSection("checks")).toBe("peek");
    expect(detentForSection("lecture")).toBe("full");
    expect(detentForSection("hints")).toBe("full");
  });
});

describe("on-screen keyboard", () => {
  const portrait: KeyboardBaseline = { width: 390, height: 844, shrunk: false };

  it("reports the keyboard when the viewport loses its gap in the terminal", () => {
    const up = readKeyboard(portrait, { width: 390, height: 508 }, true, false);
    expect(up.up).toBe(true);
    // Another input taking the keyboard is not the terminal's.
    expect(readKeyboard(portrait, { width: 390, height: 508 }, false, false).up).toBe(
      false,
    );
  });

  it("keeps the keyboard up across a rotation, until it closes", () => {
    // Landscape, keyboard still up: the viewport is already shrunk.
    const rotated = readKeyboard(portrait, { width: 844, height: 190 }, true, true);
    expect(rotated.up).toBe(true);
    expect(rotated.baseline).toEqual({ width: 844, height: 190, shrunk: true });
    // A small nudge (a suggestion bar) does not end it, and the anchor stays.
    const nudged = readKeyboard(rotated.baseline, { width: 844, height: 230 }, true, true);
    expect(nudged.up).toBe(true);
    expect(nudged.baseline.height).toBe(190);
    // The keyboard closing grows the viewport past the gap.
    const closed = readKeyboard(nudged.baseline, { width: 844, height: 390 }, true, true);
    expect(closed.up).toBe(false);
    expect(closed.baseline).toEqual({ width: 844, height: 390, shrunk: false });
  });

  it("does not invent a keyboard when rotating without one", () => {
    const rotated = readKeyboard(portrait, { width: 844, height: 390 }, true, false);
    expect(rotated.up).toBe(false);
    expect(rotated.baseline.shrunk).toBe(false);
  });

  it("drops a rotation's keyboard when the terminal loses focus", () => {
    const rotated = readKeyboard(portrait, { width: 844, height: 190 }, true, true);
    const blurred = readKeyboard(rotated.baseline, { width: 844, height: 190 }, false, true);
    expect(blurred.up).toBe(false);
    expect(blurred.baseline.shrunk).toBe(false);
  });
});
