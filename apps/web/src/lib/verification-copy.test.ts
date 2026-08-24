import { describe, expect, it } from "vitest";
import {
  buildVerificationLabelMap,
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

  it("translates engine states into learner states", () => {
    expect(verificationStatusLabel("pass")).toBe("Verified");
    expect(verificationStatusLabel("fail")).toBe("Needs repair");
    expect(verificationStatusLabel("error")).toBe("Retrying");
    expect(verificationStatusLabel("unknown")).toBe("Checking");
  });
});
