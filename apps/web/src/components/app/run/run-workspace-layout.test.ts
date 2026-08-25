import { describe, expect, it } from "vitest";
import {
  DESKTOP_RUN_RAIL_MIN_WIDTH,
  shouldShowDesktopRunRail,
} from "./run-workspace-layout";

describe("run workspace layout", () => {
  it("uses the available workspace width instead of the viewport width", () => {
    expect(shouldShowDesktopRunRail(DESKTOP_RUN_RAIL_MIN_WIDTH - 1)).toBe(
      false,
    );
    expect(shouldShowDesktopRunRail(DESKTOP_RUN_RAIL_MIN_WIDTH)).toBe(true);
  });
});
