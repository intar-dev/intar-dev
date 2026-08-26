import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScenarioRunArchiveCard } from "./ScenarioRunArchiveCard";
import type { AgentHostApi, AgentVmRunArtifact, AgentVmRunRecord } from "./types";

describe("scenario run archive artifacts", () => {
  it("downloads a raw recording bundle instead of passing it to the text viewer", () => {
    const onStreamArtifact = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: run({
          artifacts: [
            artifact({
              id: "vm-1:0",
              kind: "ssh_recording_raw_bundle",
              filename: "ssh-recordings-raw.tar",
              contentType: "application/x-tar",
              sizeBytes: 512 * 1024 * 1024,
            }),
          ],
        }),
        viewer: null,
        isExpanded: true,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
        onStreamArtifact,
        isDeleting: false,
      }),
    );

    expect(markup).toContain(
      'href="/api/runs/run-1/artifacts/vm-1:0/content?download=1"',
    );
    expect(markup).toContain("Raw Recording Bundle");
    expect(markup).toContain("Download");
    expect(onStreamArtifact).not.toHaveBeenCalled();
  });

  it("keeps regular artifacts on the inline viewer path", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: run({ artifacts: [artifact()] }),
        viewer: null,
        isExpanded: true,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
        onStreamArtifact: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(markup).toContain('type="button"');
    expect(markup).not.toContain("?download=1");
  });
});

function host(): AgentHostApi {
  return {
    id: "host-1",
    name: "Agent 1",
    role: "agent",
    disabled: false,
    scenarioEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    status: null,
    actualState: null,
  };
}

function run(
  overrides: Partial<AgentVmRunRecord> = {},
): AgentVmRunRecord {
  return {
    id: "run-1",
    hostId: "host-1",
    userId: "user-1",
    vmName: "vm-1",
    state: "deleted",
    outcome: "succeeded",
    solvedAt: null,
    solveDurationMs: null,
    uploadStatus: "complete",
    vmCreatedAt: 0,
    deleteRequestedAt: 0,
    deletedAt: 0,
    uploadStartedAt: 0,
    uploadCompletedAt: 0,
    uploadError: null,
    createdAt: 0,
    updatedAt: 0,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

function artifact(
  overrides: Partial<AgentVmRunArtifact> = {},
): AgentVmRunArtifact {
  return {
    id: "vm-1:1",
    ordinal: 1,
    kind: "console_log",
    filename: "console.log",
    contentType: "text/plain",
    sizeBytes: 4,
    sha256: "a".repeat(64),
    uploadStatus: "uploaded",
    uploadedAt: 0,
    ...overrides,
  };
}
