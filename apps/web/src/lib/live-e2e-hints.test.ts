import { describe, expect, it } from "vitest";
import { selectSequentialHintPair } from "../../scripts/live-e2e-hints";

describe("live E2E hint gating", () => {
  it("selects the first locked pair from one independent hint ladder", () => {
    expect(
      selectSequentialHintPair([
        hint("scenario:first", "scenario", null, true),
        hint("scenario:second", "scenario", null, false),
        hint("probe:http:first", "probe", "http", true),
      ]),
    ).toEqual({
      first: hint("scenario:first", "scenario", null, true),
      skipAhead: hint("scenario:second", "scenario", null, false),
    });
  });

  it("rejects stale global-next assumptions and invalid unlock state", () => {
    expect(() =>
      selectSequentialHintPair([
        hint("scenario:first", "scenario", null, true),
        hint("probe:http:first", "probe", "http", true),
      ]),
    ).toThrow("at least two authored hints");

    expect(() =>
      selectSequentialHintPair([
        hint("scenario:first", "scenario", null, true),
        hint("scenario:second", "scenario", null, true),
      ]),
    ).toThrow("remain locked");
  });
});

function hint(
  key: string,
  scope: "scenario" | "probe",
  probeName: string | null,
  unlocked: boolean,
) {
  return { key, scope, probeName, unlocked };
}
