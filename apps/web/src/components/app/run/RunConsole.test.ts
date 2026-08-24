import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepairProgressSection } from "./RunConsole";
import type { ScenarioProbeStatus } from "./run-types";

describe("run console probe diagnostics", () => {
  it("shows a repair objective without probe implementation details", () => {
    const hiddenRawOutput = "raw-kubernetes-document-must-not-render";
    const markup = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [objective()],
        probes: [
          commandProbe({
            stdout: JSON.stringify({ passed: false, hiddenRawOutput }),
            matchedValues: ["false"],
          }),
        ],
      }),
    );

    expect(markup).toContain("Repair progress");
    expect(markup).toContain("0 Verified");
    expect(markup).toContain("1 Needs repair");
    expect(markup).toContain("Restore the web rollout");
    expect(markup).toContain("Run one current, Ready replica.");
    expect(markup).toContain("Needs repair");
    expect(markup).not.toContain(hiddenRawOutput);
    expect(markup).not.toContain("Command");
    expect(markup).not.toContain("kubectl");
    expect(markup).not.toContain("$.passed");
    expect(markup).not.toContain("Expected");
    expect(markup).not.toContain("Observed");
    expect(markup).not.toContain("Exit code");
    expect(markup).not.toContain("command_json_path");
  });

  it("keeps a probe error inside the two-state result model", () => {
    const noisyOutput = "probe-output-".repeat(2_000);
    const hiddenError = "command exited with status 1";
    const markup = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [objective()],
        probes: [
          commandProbe({
            exitCode: 1,
            stdout: noisyOutput,
            error: hiddenError,
          }),
        ],
      }),
    );

    expect(markup).toContain("Needs repair");
    expect(markup).toContain(
      "Verification unavailable. We cannot confirm all progress right now.",
    );
    expect(markup).not.toContain("Retrying");
    expect(markup).not.toContain("Checking");
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain(noisyOutput);
    expect(markup).not.toContain("kubectl");
    expect(markup).not.toContain("stdout:");
    expect(markup).not.toContain("stderr:");
  });

  it("marks a completed repair objective as verified", () => {
    const markup = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [objective()],
        probes: [commandProbe({ status: "pass", matchedValues: ["true"] })],
      }),
    );

    expect(markup).toContain("1 Verified");
    expect(markup).toContain("0 Needs repair");
    expect(markup).toContain("Verified");
    expect(markup).not.toContain("$.passed");
  });

  it("uses a neutral title when authored objective copy is missing", () => {
    const markup = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [
          {
            ...objective(),
            title: null,
            label: "internal-objective-name",
            bodyMarkdown: null,
          },
        ],
        probes: [commandProbe({ label: "raw-probe-id" })],
      }),
    );

    expect(markup).toContain("Repair objective 1");
    expect(markup).not.toContain("internal-objective-name");
    expect(markup).not.toContain("raw-probe-id");
  });

  it("maps pending and error states to needs repair", () => {
    const checking = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [objective()],
        probes: [commandProbe({ status: "pending" })],
      }),
    );
    const retrying = renderToStaticMarkup(
      createElement(RepairProgressSection, {
        vmName: "workshop",
        objectives: [objective()],
        probes: [commandProbe({ status: "ERROR" })],
      }),
    );

    expect(checking).toContain("Needs repair");
    expect(retrying).toContain("Needs repair");
    expect(retrying).toContain("Verification unavailable");
    for (const markup of [checking, retrying]) {
      expect(markup).not.toContain("Checking");
      expect(markup).not.toContain("Retrying");
      expect(markup).not.toContain("Recheck");
    }
  });
});

function objective() {
  return {
    probeName: "deployment-ready",
    vmName: "workshop",
    label: "Deployment is ready",
    title: "Restore the web rollout",
    bodyMarkdown: "Run one current, Ready replica.",
    hintCount: 0,
  };
}

function commandProbe(
  overrides: Partial<{
    stdout: string;
    matchedValues: string[];
    exitCode: number;
    error: string | null;
    status: string;
    label: string;
  }> = {},
): ScenarioProbeStatus {
  const {
    error = null,
    status = "fail",
    label = "Deployment is ready",
    ...valueOverrides
  } = overrides;
  return {
    id: "deployment-ready",
    label,
    kind: "command_json_path",
    phase: "scenario",
    status,
    error,
    value: {
      argv: ["kubectl", "get", "deployment", "web", "-o", "json"],
      jsonPath: "$.passed",
      expectedJson: "true",
      matched: false,
      matchedValues: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...valueOverrides,
    },
  };
}
