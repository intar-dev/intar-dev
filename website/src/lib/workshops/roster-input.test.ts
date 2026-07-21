import { describe, expect, it } from "vitest";
import { withWorkshopManagerRosterDefault } from "./roster-input";

describe("workshop manager roster defaults", () => {
  it("preserves an explicit participant role for an organization manager", () => {
    expect(
      withWorkshopManagerRosterDefault(
        [{ userId: "owner", role: "participant" }],
        "owner",
      ),
    ).toEqual([{ userId: "owner", role: "participant" }]);
  });

  it("adds the manager as facilitator only when the roster omits them", () => {
    expect(
      withWorkshopManagerRosterDefault(
        [{ userId: "learner", role: "participant" }],
        "owner",
      ),
    ).toEqual([
      { userId: "learner", role: "participant" },
      { userId: "owner", role: "facilitator" },
    ]);
  });
});
