import { describe, expect, it } from "vitest";
import {
  formatProbeFailurePreview,
  formatProbeValueFields,
  MAX_PROBE_FAILURE_PREVIEW_BYTES,
  parseProbeValue,
  summarizeProbeValue,
} from "./probe-values";

// These fixtures mirror the exact camelCase shapes emitted by the agent in
// crates/intar-agent/src/kino_probe.rs::normalize_probe. If that serialization
// changes, these tests should fail and force the union to be updated.
describe("parseProbeValue", () => {
  it("parses file_exists", () => {
    const parsed = parseProbeValue("file_exists", {
      path: "/etc/nginx/sites-enabled/default",
      exists: false,
    });
    expect(parsed).toEqual({
      kind: "file_exists",
      value: { path: "/etc/nginx/sites-enabled/default", exists: false },
    });
  });

  it("parses port_open with null detail", () => {
    const parsed = parseProbeValue("port_open", {
      host: "127.0.0.1",
      port: 8080,
      protocol: "tcp",
      open: false,
      detail: null,
    });
    expect(parsed?.kind).toBe("port_open");
    if (parsed?.kind === "port_open") {
      expect(parsed.value.port).toBe(8080);
      expect(parsed.value.open).toBe(false);
      expect(parsed.value.detail).toBeNull();
    }
  });

  it("parses service actual-vs-desired", () => {
    const parsed = parseProbeValue("service", {
      service: "nginx",
      desiredState: "running",
      actualState: "inactive",
      stateSatisfied: false,
    });
    if (parsed?.kind === "service") {
      expect(parsed.value.actualState).toBe("inactive");
      expect(parsed.value.stateSatisfied).toBe(false);
    } else {
      throw new Error("expected service");
    }
  });

  it("parses k8s_pod_state with pod names", () => {
    const parsed = parseProbeValue("k8s_pod_state", {
      namespace: "default",
      selector: "app=web",
      desiredState: "phase:Running",
      matchedPods: 2,
      matchingPodNames: ["web-abc", "web-def"],
      stateSatisfied: true,
    });
    if (parsed?.kind === "k8s_pod_state") {
      expect(parsed.value.matchedPods).toBe(2);
      expect(parsed.value.matchingPodNames).toEqual(["web-abc", "web-def"]);
    } else {
      throw new Error("expected k8s_pod_state");
    }
  });

  it("parses command_json_path with stdout/stderr/exit", () => {
    const parsed = parseProbeValue("command_json_path", {
      argv: ["kubectl", "get", "nodes", "-o", "json"],
      jsonPath: "$.items[*].status",
      expectedJson: null,
      matched: false,
      matchedValues: [],
      stdout: "{}",
      stderr: "error",
      exitCode: 1,
    });
    if (parsed?.kind === "command_json_path") {
      expect(parsed.value.argv).toHaveLength(5);
      expect(parsed.value.exitCode).toBe(1);
      expect(parsed.value.stderr).toBe("error");
    } else {
      throw new Error("expected command_json_path");
    }
  });

  it("returns null for missing value (boot) and unknown kinds", () => {
    expect(parseProbeValue("file_exists", null)).toBeNull();
    expect(parseProbeValue("nope", { a: 1 })).toBeNull();
  });

  it("coerces malformed fields defensively", () => {
    const parsed = parseProbeValue("port_open", {
      host: 123,
      port: "not-a-number",
      protocol: null,
      open: "yes",
      detail: undefined,
    });
    if (parsed?.kind === "port_open") {
      expect(parsed.value.host).toBe("");
      expect(parsed.value.port).toBe(0);
      expect(parsed.value.open).toBe(false);
      expect(parsed.value.detail).toBeNull();
    } else {
      throw new Error("expected port_open");
    }
  });
});

describe("summarizeProbeValue", () => {
  it("summarizes a closed port", () => {
    expect(
      summarizeProbeValue("port_open", {
        host: "127.0.0.1",
        port: 8080,
        protocol: "tcp",
        open: false,
        detail: null,
      }),
    ).toBe("127.0.0.1:8080/tcp closed");
  });

  it("summarizes a missing file", () => {
    expect(
      summarizeProbeValue("file_exists", { path: "/x", exists: false }),
    ).toBe("/x is missing");
  });
});

describe("probe diagnostics", () => {
  it("shows a command JSONPath mismatch as expected versus observed without stdout", () => {
    const value = {
      argv: ["kubectl", "get", "deployment", "web", "-o", "json"],
      jsonPath: "$.status.readyReplicas",
      expectedJson: "1",
      matched: false,
      matchedValues: ["0"],
      stdout: '{"items":["raw Kubernetes JSON must stay hidden"]}',
      stderr: null,
      exitCode: 0,
    };

    expect(formatProbeValueFields("command_json_path", value)).toEqual(
      expect.arrayContaining([
        { label: "Expected", value: "1" },
        { label: "Observed", value: "0" },
      ]),
    );
    expect(
      formatProbeFailurePreview("command_json_path", value, null),
    ).toBeNull();
  });

  it("bounds real failure output to one four KiB preview", () => {
    const noisyOutput = "x".repeat(MAX_PROBE_FAILURE_PREVIEW_BYTES * 3);
    const preview = formatProbeFailurePreview(
      "command_json_path",
      {
        argv: ["kubectl", "get", "pods", "-o", "json"],
        jsonPath: "$.items[*]",
        expectedJson: null,
        matched: false,
        matchedValues: [],
        stdout: noisyOutput,
        stderr: noisyOutput,
        exitCode: 1,
      },
      "command exited with status 1",
    );

    expect(preview).toContain("Error:");
    expect(preview).toContain("preview truncated at 4 KiB");
    if (!preview) throw new Error("expected a failure preview");
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(
      MAX_PROBE_FAILURE_PREVIEW_BYTES,
    );
    expect(preview).not.toContain(noisyOutput);
  });

  it("keeps unknown legacy values small in both summaries and details", () => {
    const legacyValue = { stdout: "x".repeat(64 * 1024) };
    const summary = summarizeProbeValue("legacy_probe", legacyValue);
    const fields = formatProbeValueFields("legacy_probe", legacyValue);
    const preview = formatProbeFailurePreview(
      "legacy_probe",
      legacyValue,
      "legacy probe failed",
    );

    expect(summary).toContain("truncated");
    expect(fields[0]).toMatchObject({ label: "Value" });
    expect(fields[0]?.value.length).toBeLessThan(1_000);
    expect(preview).toContain("Legacy value:");
    if (!preview) throw new Error("expected a legacy failure preview");
    expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(
      MAX_PROBE_FAILURE_PREVIEW_BYTES,
    );
  });
});
