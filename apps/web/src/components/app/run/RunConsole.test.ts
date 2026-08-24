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
    expect(markup).toContain("0 of 1 verified");
    expect(markup).toContain("Repair in progress");
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

  it("turns a probe error into a plain automatic-retry message", () => {
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

    expect(markup).toContain("Retrying");
    expect(markup).toContain(
      "Verification is temporarily unavailable. The workspace will try again automatically.",
    );
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

    expect(markup).toContain("1 of 1 verified");
    expect(markup).toContain("All verified");
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

  it("uses plain checking and retrying states", () => {
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
        probes: [commandProbe({ status: "error" })],
      }),
    );

    expect(checking).toContain("Checking");
    expect(checking).toContain(
      "The workspace is checking this repair objective.",
    );
    expect(retrying).toContain("Verification retrying");
    expect(retrying).toContain("Retrying");
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
