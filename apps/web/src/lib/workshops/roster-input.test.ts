import { describe, expect, it } from "vitest";
import { withWorkshopManagerRosterDefault } from "./roster-input";

describe("workshop manager roster defaults", () => {
  it("preserves an explicit participant role for an organization manager", () => {
    expect(
      withWorkshopManagerRosterDefault(
        [{ userId: "owner", role: "participant" }],
        "owner",
      ),
    ).toEqual([
      {
        userId: "owner",
        role: "participant",
        workspaceEnabled: true,
      },
    ]);
  });

  it("adds the manager as facilitator only when the roster omits them", () => {
    expect(
      withWorkshopManagerRosterDefault(
        [{ userId: "learner", role: "participant" }],
        "owner",
      ),
    ).toEqual([
      {
        userId: "learner",
        role: "participant",
        workspaceEnabled: true,
      },
      {
        userId: "owner",
        role: "facilitator",
        workspaceEnabled: false,
      },
    ]);
  });

  it("preserves a staff role while opting into a learner workspace", () => {
    expect(
      withWorkshopManagerRosterDefault(
        [
          {
            userId: "owner",
            role: "facilitator",
            workspaceEnabled: true,
          },
        ],
        "owner",
      ),
    ).toEqual([
      {
        userId: "owner",
        role: "facilitator",
        workspaceEnabled: true,
      },
    ]);
  });
});
