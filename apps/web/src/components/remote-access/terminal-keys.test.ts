import { describe, expect, it } from "vitest";
import { applyCtrl, arrowSequence, nextCtrlState } from "./terminal-keys";

describe("terminal key row", () => {
  it("turns letters into control codes and leaves the rest alone", () => {
    expect(applyCtrl("c")).toBe("\x03");
    expect(applyCtrl("C")).toBe("\x03");
    expect(applyCtrl("[")).toBe("\x1b");
    expect(applyCtrl("1")).toBe("1");
    expect(applyCtrl("ls")).toBe("ls");
  });

  it("follows the application cursor mode for arrows", () => {
    expect(arrowSequence("up", false)).toBe("\x1b[A");
    expect(arrowSequence("left", true)).toBe("\x1bOD");
  });

  it("latches, locks on a quick second tap, and releases", () => {
    expect(nextCtrlState("off", 9999)).toBe("latched");
    expect(nextCtrlState("latched", 200)).toBe("locked");
    expect(nextCtrlState("latched", 900)).toBe("off");
    expect(nextCtrlState("locked", 100)).toBe("off");
  });
});
