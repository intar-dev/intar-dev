import { describe, expect, it } from "vitest";
import { hasPendingInfrastructureTeardown } from "./run-support";

describe("hasPendingInfrastructureTeardown", () => {
  it("keeps every unfinished VM destroyable", () => {
    expect(
      hasPendingInfrastructureTeardown([
        { phase: "failed" },
        { phase: "deleting" },
      ]),
    ).toBe(true);
  });

  it("does not treat a failed VM as teardown-complete", () => {
    expect(
      hasPendingInfrastructureTeardown([{ phase: "failed" }]),
    ).toBe(true);
  });

  it("allows archival deletion only after every VM is completed", () => {
    expect(
      hasPendingInfrastructureTeardown([{ phase: "completed" }]),
    ).toBe(false);
  });
});
