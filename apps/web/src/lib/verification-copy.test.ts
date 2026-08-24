import { describe, expect, it } from "vitest";
import {
  buildVerificationLabelMap,
  isVerificationPassed,
  repairObjectiveTitle,
  verificationStatusLabel,
} from "./verification-copy";

describe("verification copy", () => {
  it("uses authored objective titles and neutral numbered fallbacks", () => {
    expect(
      buildVerificationLabelMap({
        bootProbeIds: ["k3s-running", "cluster-dns-ready"],
        scenarioProbeIds: ["deployment-ready", "raw-probe-id"],
        objectives: [
          { probeName: "deployment-ready", title: "Restore the web rollout" },
        ],
      }),
    ).toEqual({
      "k3s-running": "Startup check 1",
      "cluster-dns-ready": "Startup check 2",
      "deployment-ready": "Restore the web rollout",
      "raw-probe-id": "Repair objective 2",
    });
  });

  it("never falls back to an internal objective name", () => {
    expect(
      repairObjectiveTitle(
        { probeName: "internal-probe-name", title: "  " },
        2,
      ),
    ).toBe("Repair objective 3");
  });

  it("shows exactly two probe results", () => {
    for (const status of [
      "pass",
      "passed",
      "passing",
      "ready",
      "ok",
      "success",
      "succeeded",
    ]) {
      expect(isVerificationPassed(status)).toBe(true);
      expect(verificationStatusLabel(status)).toBe("Verified");
    }
    for (const status of [
      "fail",
      "error",
      "unknown",
      "pending",
      "",
      "unexpected",
    ]) {
      expect(isVerificationPassed(status)).toBe(false);
      expect(verificationStatusLabel(status)).toBe("Needs repair");
    }
  });
});
