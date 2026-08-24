import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProbeRows } from "./ProbeRows";
import type { VmProbe } from "./types";

describe("operator probe diagnostics", () => {
  it("uses the same Boolean comparison fields and omits valid mismatch stdout", () => {
    const hiddenRawOutput = "raw-kubernetes-document-must-not-render";
    const markup = renderToStaticMarkup(
      createElement(ProbeRows, {
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

    expect(markup).toContain("Expected");
    expect(markup).toContain("true");
    expect(markup).toContain("Observed");
    expect(markup).toContain("false");
    expect(markup).not.toContain(hiddenRawOutput);
  });

  it("bounds old oversized values instead of JSON-stringifying them", () => {
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

    expect(markup).toContain("Legacy value:");
    expect(markup).toContain("preview truncated at 4 KiB");
    expect(markup).not.toContain(oversized);
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
