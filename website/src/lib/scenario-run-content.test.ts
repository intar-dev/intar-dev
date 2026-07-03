import { describe, expect, it } from "vitest";
import type { ScenarioRunHintSnapshot } from "@/db/schema";
import type { RunStateDocument, RunPhase } from "@/lib/run-state";
import {
  appendRevealedScenarioRunHintKey,
  buildScenarioRunHintViews,
  buildScenarioRunSolutionView,
  canonicalRevealedScenarioRunHintKeys,
  decideScenarioRunHintReveal,
  isScenarioRunSolved,
  nextScenarioRunHintKey,
} from "@/lib/scenario-run-content";

const hints: ScenarioRunHintSnapshot[] = [
  {
    key: "scenario:look-around",
    scope: "scenario",
    probeName: null,
    id: "look-around",
    title: "Look around",
    bodyMarkdown: "Check `/etc/nginx/sites-enabled/default`.",
  },
  {
    key: "probe:http-ok:curl",
    scope: "probe",
    probeName: "http-ok",
    id: "curl",
    title: "Curl locally",
    bodyMarkdown: "Run `curl -i http://127.0.0.1`.",
  },
];

describe("scenario run content gating", () => {
  it("redacts unrevealed hint bodies from serialized run content", () => {
    expect(
      buildScenarioRunHintViews({
        hints,
        revealedHintKeys: [],
      }),
    ).toEqual([
      {
        key: "scenario:look-around",
        scope: "scenario",
        probeName: null,
        id: "look-around",
        title: "Look around",
        revealed: false,
        bodyMarkdown: null,
      },
      {
        key: "probe:http-ok:curl",
        scope: "probe",
        probeName: "http-ok",
        id: "curl",
        title: "Curl locally",
        revealed: false,
        bodyMarkdown: null,
      },
    ]);

    expect(
      buildScenarioRunHintViews({
        hints,
        revealedHintKeys: ["scenario:look-around"],
      }).map((hint) => hint.bodyMarkdown),
    ).toEqual(["Check `/etc/nginx/sites-enabled/default`.", null]);
  });

  it("ignores out-of-order stored hint keys when serializing hint bodies", () => {
    expect(
      canonicalRevealedScenarioRunHintKeys({
        hints,
        revealedHintKeys: ["probe:http-ok:curl"],
      }),
    ).toEqual([]);

    expect(
      buildScenarioRunHintViews({
        hints,
        revealedHintKeys: ["probe:http-ok:curl"],
      }).map((hint) => hint.bodyMarkdown),
    ).toEqual([null, null]);

    expect(
      canonicalRevealedScenarioRunHintKeys({
        hints,
        revealedHintKeys: [
          "scenario:look-around",
          "probe:http-ok:curl",
          "unknown:stale",
          "probe:http-ok:curl",
        ],
      }),
    ).toEqual(["scenario:look-around", "probe:http-ok:curl"]);
  });

  it("deduplicates stored hint keys before serializing or revealing bodies", () => {
    const firstHint = hints[0];
    const secondHint = hints[1];
    if (!firstHint || !secondHint) {
      throw new Error("expected hint fixtures");
    }
    const duplicatedHints = [
      firstHint,
      {
        ...firstHint,
        title: "Duplicate",
        bodyMarkdown: "This duplicate body must not be exposed.",
      },
      secondHint,
    ];

    expect(
      buildScenarioRunHintViews({
        hints: duplicatedHints,
        revealedHintKeys: ["scenario:look-around"],
      }).map((hint) => hint.bodyMarkdown),
    ).toEqual(["Check `/etc/nginx/sites-enabled/default`.", null]);

    expect(
      nextScenarioRunHintKey(duplicatedHints, ["scenario:look-around"]),
    ).toBe("probe:http-ok:curl");

    expect(
      appendRevealedScenarioRunHintKey({
        hints: duplicatedHints,
        revealedHintKeys: ["scenario:look-around"],
        hintKey: "probe:http-ok:curl",
      }),
    ).toEqual(["scenario:look-around", "probe:http-ok:curl"]);
  });

  it("reveals hints strictly in manifest order", () => {
    expect(nextScenarioRunHintKey(hints, [])).toBe("scenario:look-around");
    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: [],
        requestedHintKey: "probe:http-ok:curl",
      }),
    ).toEqual({
      allowed: false,
      reason: "not_next",
      nextHintKey: "scenario:look-around",
    });

    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: ["scenario:look-around"],
        requestedHintKey: "probe:http-ok:curl",
      }),
    ).toEqual({
      allowed: true,
      hintKey: "probe:http-ok:curl",
    });

    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: ["scenario:look-around", "probe:http-ok:curl"],
        requestedHintKey: "probe:http-ok:curl",
      }),
    ).toEqual({
      allowed: false,
      reason: "exhausted",
      nextHintKey: null,
    });
  });

  it("persists only the next revealed hint key in manifest order", () => {
    expect(
      appendRevealedScenarioRunHintKey({
        hints,
        revealedHintKeys: [
          "probe:http-ok:curl",
          "unknown:stale",
          "probe:http-ok:curl",
        ],
        hintKey: "scenario:look-around",
      }),
    ).toEqual(["scenario:look-around"]);

    expect(
      appendRevealedScenarioRunHintKey({
        hints,
        revealedHintKeys: ["scenario:look-around", "unknown:stale"],
        hintKey: "probe:http-ok:curl",
      }),
    ).toEqual(["scenario:look-around", "probe:http-ok:curl"]);
  });

  it("keeps solution bodies gated and marks pre-solve reveals as assisted", () => {
    const unsolved = runState({
      phase: "active_full",
      scenarioProbes: [{ id: "http-ok", status: "pending" }],
    });
    expect(isScenarioRunSolved({ state: unsolved, solvedAt: null })).toBe(
      false,
    );
    expect(
      buildScenarioRunSolutionView({
        solutionMarkdown: "Restart nginx.",
        solutionRevealedAt: null,
        solutionAssisted: false,
        state: unsolved,
        solvedAt: null,
      }),
    ).toEqual({
      unlocked: false,
      revealed: false,
      assisted: false,
      revealedAt: null,
      bodyMarkdown: null,
    });

    expect(
      buildScenarioRunSolutionView({
        solutionMarkdown: "Restart nginx.",
        solutionRevealedAt: 123,
        solutionAssisted: true,
        state: unsolved,
        solvedAt: null,
      }),
    ).toMatchObject({
      unlocked: true,
      revealed: true,
      assisted: true,
      bodyMarkdown: "Restart nginx.",
    });

    const solved = runState({
      phase: "active_full",
      scenarioProbes: [{ id: "http-ok", status: "succeeded" }],
    });
    expect(isScenarioRunSolved({ state: solved, solvedAt: null })).toBe(true);
    expect(
      buildScenarioRunSolutionView({
        solutionMarkdown: "Restart nginx.",
        solutionRevealedAt: null,
        solutionAssisted: false,
        state: solved,
        solvedAt: null,
      }),
    ).toMatchObject({
      unlocked: true,
      revealed: false,
      assisted: false,
      bodyMarkdown: null,
    });
  });
});

function runState(input: {
  phase: RunPhase;
  scenarioProbes: Array<{ id: string; status: string }>;
}): RunStateDocument {
  return {
    phase: input.phase,
    phaseTitle: input.phase,
    phaseDetail: "",
    progressPercent: 0,
    terminalPhase: "pending",
    canOpenTerminal: false,
    canDestroy: true,
    bootProbes: [],
    scenarioProbes: input.scenarioProbes.map((probe) => ({
      id: probe.id,
      label: probe.id,
      kind: "probe",
      phase: "scenario",
      status: probe.status,
      error: null,
      value: null,
    })),
    replayArtifacts: [],
    primaryReplayArtifactId: null,
    terminalTarget: {
      host: null,
      port: 0,
      username: "ubuntu",
      hostKeyOpenssh: null,
      checkedAt: null,
    },
    vms: [],
  };
}
