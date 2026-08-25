import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  getRunLearningPanelState,
  getRunLearningTriggerCopy,
  RunLearningPanel,
  RunLearningPanelContent,
} from "./RunLearningPanel";
import type {
  ScenarioObjective,
  ScenarioProbeStatus,
  ScenarioRunHint,
  ScenarioRunSolution,
} from "./run-types";

describe("run learning panel", () => {
  it("uses learner-facing app-bar labels with check and hint counts", () => {
    expect(
      getRunLearningTriggerCopy({
        phase: "booting",
        passedChecks: 0,
        totalChecks: 3,
        revealedHints: 0,
        totalHints: 2,
      }),
    ).toEqual({
      visibleLabel: "Work order",
      accessibleLabel: "Work order. 0 of 3 checks verified. 0 of 2 hints revealed.",
    });
    expect(
      getRunLearningTriggerCopy({
        phase: "running",
        passedChecks: 1,
        totalChecks: 3,
        revealedHints: 1,
        totalHints: 2,
      }),
    ).toEqual({
      visibleLabel: "Checks 1/3",
      accessibleLabel: "Checks. 1 of 3 checks verified. 1 of 2 hints revealed.",
    });
    expect(
      getRunLearningTriggerCopy({
        phase: "solved",
        passedChecks: 3,
        totalChecks: 3,
        revealedHints: 2,
        totalHints: 2,
      }),
    ).toEqual({
      visibleLabel: "Solved 3/3",
      accessibleLabel: "Solved. 3 of 3 checks verified. 2 of 2 hints revealed.",
    });
  });

  it("treats startup phases as a work order and every other active phase as checks", () => {
    expect(getRunLearningPanelState("launching")).toBe("booting");
    expect(getRunLearningPanelState("waiting_for_target")).toBe("booting");
    expect(getRunLearningPanelState("running")).toBe("running");
    expect(getRunLearningPanelState("solved")).toBe("solved");
    expect(getRunLearningPanelState("failed")).toBe("running");
  });

  it("renders a real 44px app-bar button with a useful accessible name", () => {
    const markup = renderToStaticMarkup(
      createElement(RunLearningPanel, panelProps()),
    );

    expect(markup).toContain('data-run-learning-panel-trigger="true"');
    expect(markup).toContain("Checks 0/1");
    expect(markup).toContain(
      'aria-label="Checks. 0 of 1 checks verified. 0 of 2 hints revealed."',
    );
    expect(markup).toContain("h-11");
  });

  it("never renders raw probe diagnostics in learner checks", () => {
    const hiddenError = "connect ECONNREFUSED 10.0.0.7:443";
    const hiddenOutput = "curl --fail --retry 99 https://internal.example";
    const markup = renderContent({
      probes: [
        probe({
          label: "nginx_http_request",
          kind: "http_request",
          error: hiddenError,
          value: { command: hiddenOutput, path: "/private/secret" },
        }),
      ],
    });

    expect(markup).toContain("Make the site reachable");
    expect(markup).toContain("Needs repair");
    expect(markup).not.toContain("http-ok");
    expect(markup).not.toContain("nginx_http_request");
    expect(markup).not.toContain("http_request");
    expect(markup).not.toContain(hiddenError);
    expect(markup).not.toContain(hiddenOutput);
    expect(markup).not.toContain("/private/secret");
  });

  it("shows an unreported check as checking instead of failed", () => {
    const markup = renderContent({
      probes: [probe({ status: "pending" })],
    });

    expect(markup).toContain("Checking");
    expect(markup).not.toContain("Needs repair");
  });

  it("scopes duplicate probe names to the selected authored machine", () => {
    const markup = renderContent({
      vmName: "worker",
      objectives: [
        { ...objective(), vmName: "web", title: "Web objective" },
        { ...objective(), vmName: "worker", title: "Worker objective" },
      ],
      hints: [
        hint({
          key: "probe:web:http-ok:first",
          scope: "probe",
          probeName: "http-ok",
          revealed: true,
          bodyMarkdown: "Web-only hint",
        }),
        hint({
          key: "probe:worker:http-ok:first",
          scope: "probe",
          probeName: "http-ok",
          revealed: true,
          bodyMarkdown: "Worker-only hint",
        }),
      ],
    });

    expect(markup).toContain("Worker objective");
    expect(markup).not.toContain("Web objective");
    expect(markup).toContain("Worker-only hint");
    expect(markup).not.toContain("Web-only hint");
  });

  it("keeps sealed hints quiet and only offers the next reveal in each ladder", () => {
    const markup = renderContent({
      hints: [
        hint({
          key: "first",
          revealed: true,
          title: "Start here",
          bodyMarkdown: "Read the service status.",
        }),
        hint({
          key: "second",
          unlocked: true,
          title: "This title must stay hidden",
          bodyMarkdown: "This body must stay hidden",
        }),
        hint({
          key: "third",
          unlocked: true,
          title: "Later secret",
          bodyMarkdown: "Later body",
        }),
      ],
    });

    expect(markup).toContain("Start here");
    expect(markup).toContain("Read the service status.");
    expect(markup).toContain("Hint 2");
    expect(markup).toContain("Hint 3");
    expect(markup).toContain("Reveal");
    expect(markup).not.toContain("This title must stay hidden");
    expect(markup).not.toContain("This body must stay hidden");
    expect(markup).not.toContain("Later secret");
    expect(markup).not.toContain("Later body");
  });

  it("puts a generic hint error beside the failed reveal without exposing its raw detail", () => {
    const rawError = "POST /hints/reveal returned 500 from worker-19";
    const markup = renderContent({
      hints: [hint({ key: "first", unlocked: true })],
      hintError: rawError,
      failedHintKey: "first",
    });

    expect(markup).toContain("Could not reveal this hint. Try again.");
    expect(markup).not.toContain(rawError);
  });

  it("puts save first for a solved lab and keeps the full solution last", () => {
    const markup = renderContent({
      phase: "solved",
      probes: [probe({ status: "passed" })],
      onFinishAndSave: vi.fn(),
      finishError: true,
      solution: {
        ...solution(),
        revealed: true,
        unlocked: true,
        assisted: true,
        bodyMarkdown: "`systemctl restart nginx`",
      },
    });

    expect(markup).toContain("Finish and save");
    expect(markup).toContain(
      "We could not save this run. Your work is still open. Try again.",
    );
    expect(markup).toContain("You used the full solution for this run.");
    expect(markup).toContain("systemctl restart nginx");
    expect(markup.indexOf("Finish and save")).toBeLessThan(
      markup.indexOf("Checks"),
    );
    expect(markup.lastIndexOf("Full solution")).toBeGreaterThan(
      markup.indexOf("Hints"),
    );
  });

  it("keeps the assisted-solution confirmation during an active repair", () => {
    const markup = renderContent({
      phase: "running",
      solution: {
        ...solution(),
        unlocked: true,
        bodyMarkdown: "HIDDEN_UNREVEALED_SOLUTION",
      },
    });

    expect(markup).toContain("Reveal the full solution");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Show the solution");
    expect(markup).not.toContain("HIDDEN_UNREVEALED_SOLUTION");
  });

  it("has clear empty states without a technical fallback", () => {
    const markup = renderContent({
      phase: "running",
      probes: [],
      objectives: [],
      hints: [],
    });

    expect(markup).toContain("No checks are available yet.");
    expect(markup).toContain("No hints are available for this lab.");
    expect(markup).toContain('data-run-learning-sticky-summary="true"');
    expect(markup).toContain('aria-label="Show checks. 0 of 0 verified."');
    expect(markup).not.toContain("probe");
    expect(markup).not.toContain("machine itself");
  });
});

function renderContent(
  overrides: Partial<ComponentProps<typeof RunLearningPanelContent>> = {},
) {
  return renderToStaticMarkup(
    createElement(RunLearningPanelContent, {
      ...panelProps(),
      ...overrides,
    }),
  );
}

function panelProps(): ComponentProps<typeof RunLearningPanelContent> {
  return {
    phase: "running",
    probes: [probe()],
    objectives: [objective()],
    hints: [hint({ key: "first", unlocked: true }), hint({ key: "second" })],
    solution: solution(),
    onRevealHint: vi.fn(),
    pendingHintKey: null,
    hintError: null,
    failedHintKey: null,
    onRevealSolution: vi.fn(),
    solutionPending: false,
    solutionError: null,
    onFinishAndSave: undefined,
    finishPending: false,
  };
}

function objective(): ScenarioObjective {
  return {
    probeName: "http-ok",
    vmName: "web",
    label: "nginx_http_request",
    title: "Make the site reachable",
    bodyMarkdown: "Do not render this check detail.",
    hintCount: 2,
  };
}

function probe(
  overrides: Partial<ScenarioProbeStatus> = {},
): ScenarioProbeStatus {
  return {
    id: "http-ok",
    label: "nginx_http_request",
    kind: "http_request",
    phase: "scenario",
    status: "fail",
    error: null,
    value: { internal: "must not render" },
    ...overrides,
  };
}

function hint(
  overrides: Partial<ScenarioRunHint> & { key: string },
): ScenarioRunHint {
  return {
    scope: "scenario",
    probeName: null,
    id: overrides.key,
    title: null,
    revealed: false,
    unlocked: false,
    bodyMarkdown: null,
    ...overrides,
  };
}

function solution(): ScenarioRunSolution {
  return {
    unlocked: false,
    revealed: false,
    assisted: false,
    revealedAt: null,
    bodyMarkdown: null,
  };
}
