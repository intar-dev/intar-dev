import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  binaryProbeSummary,
  LiveScenarioRunCard,
  VerificationCollectionStatus,
} from "./LiveScenarioRunCard";
import type { AgentHostApi, VmStatus } from "./types";

const nativeSshModule = vi.hoisted(() => ({ loadCount: 0 }));

vi.mock("@/components/remote-access/NativeSshDialogButton", () => {
  nativeSshModule.loadCount += 1;
  return {
    NativeSshDialog: () => null,
  };
});

describe("verification collection status", () => {
  it("keeps a collector failure separate from the two probe results", () => {
    const hiddenError =
      "kubectl stderr: internal probe command and output must not render";
    const markup = renderToStaticMarkup(
      createElement(VerificationCollectionStatus, {
        state: "error",
        generatedAt: null,
        error: hiddenError,
      }),
    );

    expect(markup).toContain("Verification unavailable");
    expect(markup).toContain(
      "We cannot confirm verification progress right now.",
    );
    expect(markup).not.toContain("retrying");
    expect(markup).not.toContain("automatically");
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain("kubectl");
  });

  it("folds unknown and failed checks into one needs-repair count", () => {
    expect(
      binaryProbeSummary({ total: 7, pass: 2, fail: 3, unknown: 2 }),
    ).toEqual({ verified: 2, needsRepair: 5 });
  });

  it("hides the collector status when verification is available", () => {
    const markup = renderToStaticMarkup(
      createElement(VerificationCollectionStatus, {
        state: "complete",
        generatedAt: "2026-08-24T00:00:00Z",
        error: null,
      }),
    );

    expect(markup).toBe("");
  });

  it("does not mount closed VM details or load native SSH", () => {
    const markup = renderToStaticMarkup(
      createElement(LiveScenarioRunCard, {
        host: host(),
        vmItem: vm(),
        isExpanded: false,
        onToggle: vi.fn(),
        onOpenWebSsh: vi.fn(),
        onDelete: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(nativeSshModule.loadCount).toBe(0);
    expect(markup).toContain("Details");
    expect(markup).not.toContain("Boot checks");
    expect(markup).not.toContain("Keep this hidden until details open");
    expect(markup).not.toContain("Native SSH for");
  });

  it("mounts VM details after the operator opens the card", () => {
    const markup = renderToStaticMarkup(
      createElement(LiveScenarioRunCard, {
        host: host(),
        vmItem: vm(),
        isExpanded: true,
        onToggle: vi.fn(),
        onOpenWebSsh: vi.fn(),
        onDelete: vi.fn(),
        isDeleting: false,
      }),
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Boot checks");
    expect(markup).toContain("Keep this hidden until details open");
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

function vm(): VmStatus {
  return {
    id: "vm-1",
    name: "scenario-vm-1",
    state: "running",
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    error: null,
    run_id: "run-1",
    terminal_target: {
      state: "ready",
      reason: null,
      host: "127.0.0.1",
      port: 22,
      username: "ubuntu",
      checkedAt: 0,
    },
    scenario_meta: {
      scenarioName: "Test scenario",
      scenarioDescription: "Test scenario description",
      scenarioVmName: "Test VM",
      hostname: "scenario-vm-1",
      probePhaseMap: { "probe-1": "boot" },
      checkLabelMap: {
        "probe-1": "Keep this hidden until details open",
      },
    },
    probe_state: {
      collection_state: "complete",
      collection_error: null,
      generated_at: "2026-08-27T00:00:00Z",
      updated_at: "2026-08-27T00:00:00Z",
      summary: { total: 1, pass: 1, fail: 0, unknown: 0 },
      probes: [
        {
          id: "probe-1",
          kind: "command",
          status: "pass",
          every_seconds: 30,
          last_attempt_at: "2026-08-27T00:00:00Z",
          last_success_at: "2026-08-27T00:00:00Z",
          last_duration_ms: 1,
          error: null,
          value: null,
        },
      ],
    },
  };
}
