import { describe, expect, it } from "vitest";
import {
  adminScenarioRunArtifactContentPath,
  scenarioRunArtifactContentPath,
  workshopArtifactContentPath,
  workshopTerminalTranscriptPath,
} from "./artifact-content-paths";

describe("artifact content paths", () => {
  it("keeps scenario artifact colons literal for the canonical Worker path", () => {
    const path = scenarioRunArtifactContentPath(
      "urtj68e1n4zyk9o6l7fhtxvp",
      "srunvm123:0",
    );

    expect(path).toBe(
      "/api/runs/urtj68e1n4zyk9o6l7fhtxvp/artifacts/srunvm123:0/content",
    );
    expect(path).not.toContain("%3A");
  });

  it("builds the admin-only scenario artifact path", () => {
    expect(adminScenarioRunArtifactContentPath("run-1", "runtimevm1:2")).toBe(
      "/api/admin/runs/run-1/artifacts/runtimevm1:2/content",
    );
  });

  it("keeps workshop artifact and terminal-session colons literal", () => {
    expect(workshopArtifactContentPath("session-1", "runtimevm1:2")).toBe(
      "/api/workshops/session-1/artifacts/runtimevm1:2/content",
    );
    expect(
      workshopTerminalTranscriptPath(
        "session-1",
        "runtimevm1:session:2",
      ),
    ).toBe(
      "/api/workshops/session-1/terminal-sessions/runtimevm1:session:2/transcript",
    );
  });

  it.each(["", ".", "..", "id/path", "id%3A0", "id?query", "id#hash"])(
    "rejects a non-canonical resource ID: %s",
    (value) => {
      expect(() => scenarioRunArtifactContentPath("run-1", value)).toThrow(
        "resource id is not a canonical path segment",
      );
    },
  );
});
