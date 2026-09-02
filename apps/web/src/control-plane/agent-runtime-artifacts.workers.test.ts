import { describe, expect, it } from "vitest";
import {
  artifactIdFor,
  buildArtifactObjectKey,
  sanitizeObjectKeySegment,
} from "@/control-plane/agent-run-artifacts/storage";

describe("scenario artifact identifiers", () => {
  it("builds stable and safe artifact keys", () => {
    expect(artifactIdFor("server", 2)).toBe("server:2");
    expect(sanitizeObjectKeySegment("cast 01.krec")).toBe("cast-01.krec");
    expect(
      buildArtifactObjectKey({
        runId: "run-1",
        vmId: "server",
        ordinal: 2,
        kind: "recording",
        filename: "cast 01.krec",
      }),
    ).toBe("run-1/server/2-recording-cast-01.krec");
  });
});
