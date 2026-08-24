import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProbeRows } from "./ProbeRows";
import type { VmProbe } from "./types";

describe("operator probe diagnostics", () => {
  it("shows a descriptive check state without implementation details", () => {
    const hiddenRawOutput = "raw-kubernetes-document-must-not-render";
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
        checkLabelMap: { "deployment-ready": "Restore the web rollout" },
        probes: [
          probe({
            value: commandValue({
              stdout: JSON.stringify({ passed: false, hiddenRawOutput }),
              matchedValues: ["false"],
            }),
          }),
        ],
      }),
    );

    expect(markup).toContain("Restore the web rollout");
    expect(markup).toContain("Needs repair");
    expect(markup).not.toContain(hiddenRawOutput);
    expect(markup).not.toContain("Command");
    expect(markup).not.toContain("kubectl");
    expect(markup).not.toContain("command_json_path");
    expect(markup).not.toContain("$.passed");
    expect(markup).not.toContain("Expected");
    expect(markup).not.toContain("Observed");
    expect(markup).not.toContain("Exit code");
    expect(markup).not.toContain("Every:");
    expect(markup).not.toContain("Last duration");
    expect(markup).not.toContain("deployment-ready");
    expect(markup).toContain("<ul");
  });

  it("hides old oversized values", () => {
    const oversized = "legacy-output-".repeat(8_000);
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
        probes: [
          probe({
            kind: "legacy_probe",
            error: "legacy probe failed",
            value: { stdout: oversized },
          }),
        ],
      }),
    );

    expect(markup).toContain("Verification objective 1");
    expect(markup).toContain("Needs repair");
    expect(markup).not.toContain("Retrying");
    expect(markup).not.toContain(oversized);
    expect(markup).not.toContain("Legacy value");
  });

  it("keeps real command failures inside the two-state result model", () => {
    const hiddenOutput = "command-output-must-not-render";
    const hiddenError = "command exited with status 1";
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
        checkLabelMap: { "deployment-ready": "Restore the web rollout" },
        probes: [
          probe({
            error: hiddenError,
            value: commandValue({
              stdout: hiddenOutput,
              stderr: hiddenOutput,
              exitCode: 1,
            }),
          }),
        ],
      }),
    );

    expect(markup).toContain("Needs repair");
    expect(markup).not.toContain("Retrying");
    expect(markup).not.toContain("Checking");
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain(hiddenOutput);
    expect(markup).not.toContain("kubectl");
    expect(markup).not.toContain("stdout:");
    expect(markup).not.toContain("stderr:");
    expect(markup).not.toContain("deployment-ready");
  });

  it("marks a completed objective as verified", () => {
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
        checkLabelMap: { "deployment-ready": "Restore the web rollout" },
        probes: [probe({ status: "pass" })],
      }),
    );

    expect(markup).toContain("Restore the web rollout");
    expect(markup).toContain("Verified");
    expect(markup).not.toContain("command_json_path");
  });

  it("maps every non-pass result to needs repair", () => {
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
        probes: [
          probe({ id: "raw-unknown-id", status: "unknown" }),
          probe({ id: "raw-error-id", status: "error", error: null }),
        ],
      }),
    );

    expect(markup).toContain("Verification objective 1");
    expect(markup).toContain("Verification objective 2");
    expect(markup.match(/Needs repair/g)).toHaveLength(2);
    expect(markup).not.toContain("Checking");
    expect(markup).not.toContain("Retrying");
    expect(markup).not.toContain("Recheck");
    expect(markup).not.toContain("raw-unknown-id");
    expect(markup).not.toContain("raw-error-id");
  });
});

function probe(overrides: Partial<VmProbe> = {}): VmProbe {
  return {
    id: "deployment-ready",
    kind: "command_json_path",
    status: "fail",
    every_seconds: 5,
    last_attempt_at: null,
    last_success_at: null,
    last_duration_ms: 15,
    error: null,
    value: commandValue(),
    ...overrides,
  };
}

function commandValue(
  overrides: Partial<{
    stdout: string;
    stderr: string;
    matchedValues: string[];
    exitCode: number;
  }> = {},
) {
  return {
    argv: ["kubectl", "get", "deployment", "web", "-o", "json"],
    jsonPath: "$.passed",
    expectedJson: "true",
    matched: false,
    matchedValues: [],
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}
