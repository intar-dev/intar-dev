import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScenarioRunArchiveCard } from "./ScenarioRunArchiveCard";
import type { AgentHostApi, AgentVmRunArtifact, AgentVmRunRecord } from "./types";

const artifactViewerModule = vi.hoisted(() => ({ loadCount: 0 }));

vi.mock("@/components/app/RunArtifactViewer", () => {
  artifactViewerModule.loadCount += 1;
  return { RunArtifactViewer: () => null };
});

describe("scenario run archive artifacts", () => {
  it("downloads a raw recording bundle instead of passing it to the text viewer", () => {
    const onStreamArtifact = vi.fn();
    const detail = run({
      artifactCount: 1,
      artifacts: [
        artifact({
          id: "vm-1:0",
          kind: "ssh_recording_raw_bundle",
          filename: "ssh-recordings-raw.tar",
          contentType: "application/x-tar",
          sizeBytes: 512 * 1024 * 1024,
        }),
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: detail,
        detail,
        isDetailLoading: false,
        detailError: null,
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
    const detail = run({ artifactCount: 1, artifacts: [artifact()] });
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: detail,
        detail,
        isDetailLoading: false,
        detailError: null,
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

  it("does not mount collapsed details or load the artifact viewer", () => {
    const detail = run({
      eventCount: 1,
      artifactCount: 1,
      events: [
        {
          id: "event-1",
          kind: "created",
          message: "Keep this milestone hidden until details open",
          createdAt: 0,
        },
      ],
      artifacts: [
        artifact({ filename: "keep-this-artifact-hidden.log" }),
      ],
    });
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: detail,
        detail,
        isDetailLoading: false,
        detailError: null,
        viewer: null,
        isExpanded: false,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
        onStreamArtifact: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(artifactViewerModule.loadCount).toBe(0);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Milestones");
    expect(markup).not.toContain("Keep this milestone hidden until details open");
    expect(markup).not.toContain("keep-this-artifact-hidden.log");
    expect(markup).not.toContain("Select an artifact");
    expect(markup).not.toContain('aria-label="Artifact text content"');
  });

  it("does not mount the artifact viewer until an artifact is selected", () => {
    const detail = run({ artifactCount: 1, artifacts: [artifact()] });
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: detail,
        detail,
        isDetailLoading: false,
        detailError: null,
        viewer: null,
        isExpanded: true,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
        onStreamArtifact: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(artifactViewerModule.loadCount).toBe(0);
    expect(markup).toContain("Artifacts");
    expect(markup).not.toContain("Select an artifact");
    expect(markup).not.toContain('aria-label="Artifact text content"');
  });

  it("shows a local detail loading state without mounting an archive tree", () => {
    const markup = renderToStaticMarkup(
      createElement(ScenarioRunArchiveCard, {
        host: host(),
        run: run({ artifactCount: 1, eventCount: 1 }),
        detail: null,
        isDetailLoading: true,
        detailError: null,
        viewer: null,
        isExpanded: true,
        onToggle: vi.fn(),
        onDelete: vi.fn(),
        onStreamArtifact: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading run details…");
    expect(markup).not.toContain("Milestones");
    expect(markup).not.toContain("Select an artifact");
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
    artifactCount: 0,
    eventCount: 0,
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
