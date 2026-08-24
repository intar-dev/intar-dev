import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChecksSection } from "./RunConsole";
import type { ScenarioProbeStatus } from "./run-types";

describe("run console probe diagnostics", () => {
  it("shows a Boolean command mismatch as expected and observed without raw stdout", () => {
    const hiddenRawOutput = "raw-kubernetes-document-must-not-render";
    const markup = renderToStaticMarkup(
      createElement(ChecksSection, {
        vmName: "workshop",
        objectives: [],
        probes: [
          commandProbe({
            stdout: JSON.stringify({ passed: false, hiddenRawOutput }),
            matchedValues: ["false"],
          }),
        ],
      }),
    );

    expect(markup).toContain("Expected");
    expect(markup).toContain("true");
    expect(markup).toContain("Observed");
    expect(markup).toContain("false");
    expect(markup).not.toContain(hiddenRawOutput);
  });

  it("limits real command failure output in the learner view", () => {
    const noisyOutput = "probe-output-".repeat(2_000);
    const markup = renderToStaticMarkup(
      createElement(ChecksSection, {
        vmName: "workshop",
        objectives: [],
        probes: [
          commandProbe({
            exitCode: 1,
            stdout: noisyOutput,
            error: "command exited with status 1",
          }),
        ],
      }),
    );

    expect(markup).toContain("preview truncated at 4 KiB");
    expect(markup).not.toContain(noisyOutput);
  });
});

function commandProbe(
  overrides: Partial<{
    stdout: string;
    matchedValues: string[];
    exitCode: number;
    error: string | null;
  }> = {},
): ScenarioProbeStatus {
  return {
    id: "deployment-ready",
    label: "Deployment is ready",
    kind: "command_json_path",
    phase: "scenario",
    status: "fail",
    error: null,
    value: {
      argv: ["kubectl", "get", "deployment", "web", "-o", "json"],
      jsonPath: "$.passed",
      expectedJson: "true",
      matched: false,
      matchedValues: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...overrides,
    },
  };
}
