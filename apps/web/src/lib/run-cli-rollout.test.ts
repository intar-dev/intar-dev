import { describe, expect, it } from "vitest";
import { learnerRunCliV1EnforcementEnabled } from "./run-cli-rollout";

describe("learner run CLI rollout gate", () => {
  it("defaults open until the final explicit on deployment", () => {
    expect(learnerRunCliV1EnforcementEnabled({})).toBe(false);
    expect(
      learnerRunCliV1EnforcementEnabled({
        LEARNER_RUN_CLI_V1_ENFORCEMENT: "off",
      }),
    ).toBe(false);
    expect(
      learnerRunCliV1EnforcementEnabled({
        LEARNER_RUN_CLI_V1_ENFORCEMENT: "on",
      }),
    ).toBe(true);
  });
});
