import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ScenarioProbeRecord,
  ScenarioVmRecord,
} from "@/lib/scenario-model";
import {
  ScenarioLearnerPreview,
  ScenarioOperationalRecord,
  ScenarioVerificationContract,
  scenarioVerificationSummary,
} from "./ScenarioDetails";

describe("admin scenario detail disclosure", () => {
  it("shows learner briefing content while keeping hints and solution closed", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioLearnerPreview, {
        briefingMarkdown: "The learner-visible briefing.",
        hints: [
          {
            id: "hint-1",
            title: "Private hint title",
            body_markdown: "HIDDEN_LEARNER_HINT",
          },
        ],
        solutionMarkdown: "HIDDEN_LEARNER_SOLUTION",
      }),
    );

    expect(markup).toContain("Learner preview");
    expect(markup).toContain("The learner-visible briefing.");
    expect(markup).toContain("Hints");
    expect(markup).toContain("Solution");
    expect(markup).not.toContain("HIDDEN_LEARNER_HINT");
    expect(markup).not.toContain("HIDDEN_LEARNER_SOLUTION");
  });

  it("keeps probe implementation and image metadata collapsed by default", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(ScenarioVerificationContract, {
          probes: [
            probe({
              name: "raw-probe-id",
              kind: "command_json_path",
              title: "Keep the rollout ready",
              description: "The learner-visible repair objective.",
            }),
          ],
        }),
        createElement(ScenarioOperationalRecord, {
          enabled: true,
          scenario: {
            scenarioId: "raw-scenario-id",
            category: "Kubernetes",
            difficulty: "medium",
            estimatedMinutes: 20,
            tags: ["k8s"],
            scenarioHintCount: 1,
            probeCount: 1,
            vmCount: 1,
            enabledAt: 1,
            createdAt: 1,
            updatedAt: 1,
            vms: [vm()],
          },
        }),
      ),
    );

    expect(markup).toContain("Verification contract");
    expect(markup).toContain("Keep the rollout ready");
    expect(markup).toContain("Probe implementation");
    expect(markup).toContain("Image provenance");
    expect(markup).toContain("Record metadata");
    expect(markup).not.toContain("raw-probe-id");
    expect(markup).not.toContain("command_json_path");
    expect(markup).not.toContain("raw-scenario-id");
    expect(markup).not.toContain("HIDDEN_KERNEL_HASH");
    expect(markup).not.toContain("HIDDEN_BOOT_COMMAND");
  });

  it("summarizes the verification contract and learner availability", () => {
    expect(
      scenarioVerificationSummary(
        [probe({ phase: "boot" }), probe({ phase: "scenario" })],
        true,
      ),
    ).toBe("1 boot checks · 1 repair objectives · enabled");
  });
});

function probe(
  overrides: Partial<ScenarioProbeRecord> = {},
): ScenarioProbeRecord {
  return {
    scenarioVmId: "vm-id",
    scenarioVmName: "workshop",
    ordinal: 1,
    name: "probe-id",
    description: "Repair the service.",
    title: null,
    bodyMarkdown: null,
    hints: [],
    phase: "scenario",
    kind: "command_json_path",
    ...overrides,
  };
}

function vm(): ScenarioVmRecord {
  return {
    id: "vm-id",
    ordinal: 1,
    name: "workshop",
    image: "ubuntu-24.04",
    imageKey: {
      scenario: "raw-scenario-id",
      vm: "workshop",
      arch: "x86_64",
    },
    imageSha256: "HIDDEN_IMAGE_HASH",
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 4_294_967_296,
    kernelSha256: "HIDDEN_KERNEL_HASH",
    initrdSha256: "HIDDEN_INITRD_HASH",
    bootCmdline: "HIDDEN_BOOT_COMMAND",
    cpuMillis: 1000,
    vcpuCount: 1,
    memoryMib: 1024,
    diskMib: 4096,
  };
}
