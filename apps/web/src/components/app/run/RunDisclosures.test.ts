import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistDrawer } from "./AssistDrawer";
import { RunDetailsSection } from "./RunDetailsSection";

const objectiveTimeline = vi.hoisted(() => vi.fn(() => null));

vi.mock("./ObjectiveTimeline", () => ({
  ObjectiveTimeline: objectiveTimeline,
}));

describe("run disclosures", () => {
  it("keeps hints quiet while retaining the existing reveal count", () => {
    const markup = renderToStaticMarkup(
      createElement(AssistDrawer, {
        hints: [hint("first"), hint("second")],
        objectives: [],
        solution: {
          unlocked: false,
          revealed: false,
          assisted: false,
          revealedAt: null,
          bodyMarkdown: null,
        },
        onRevealHint: vi.fn(),
        pendingHintKey: null,
        hintError: null,
        onRevealSolution: vi.fn(),
        solutionPending: false,
        solutionError: null,
      }),
    );

    expect(markup).toContain("Need a hint?");
    expect(markup).toContain("0/2");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="Assist"');
    expect(markup).not.toContain("lucide-life-buoy");
  });

  it("keeps machine and timeline information behind a quiet run-details disclosure", () => {
    objectiveTimeline.mockClear();
    const markup = renderToStaticMarkup(
      createElement(RunDetailsSection, {
        runId: "run-1",
        objectives: [],
        vmName: null,
        hostname: null,
        provisioning: null,
        terminalTarget: null,
      }),
    );

    expect(markup).toContain("Run details");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="Details"');
    expect(objectiveTimeline).not.toHaveBeenCalled();
  });
});

function hint(key: string) {
  return {
    key,
    scope: "scenario" as const,
    probeName: null,
    id: key,
    title: null,
    revealed: false,
    unlocked: key === "first",
    bodyMarkdown: null,
  };
}
