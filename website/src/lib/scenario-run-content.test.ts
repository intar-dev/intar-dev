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
} from "@/lib/scenario-run-content";

function hint(
  key: string,
  scope: "scenario" | "probe",
  probeName: string | null,
): ScenarioRunHintSnapshot {
  const id = key.split(":").at(-1) ?? key;
  return {
    key,
    scope,
    probeName,
    id,
    title: `Title of ${id}`,
    bodyMarkdown: `Body of ${id}.`,
  };
}

// Two scenario-level hints plus two probes with two hints each — three
// independent sequential ladders.
const hints: ScenarioRunHintSnapshot[] = [
  hint("scenario:look-around", "scenario", null),
  hint("scenario:read-logs", "scenario", null),
  hint("probe:http-ok:curl", "probe", "http-ok"),
  hint("probe:http-ok:config", "probe", "http-ok"),
  hint("probe:cert-valid:openssl", "probe", "cert-valid"),
  hint("probe:cert-valid:renew", "probe", "cert-valid"),
];

describe("scenario run content gating", () => {
  it("seals unrevealed hints: no title, no body, one unlocked per group", () => {
    const views = buildScenarioRunHintViews({
      hints,
      revealedHintKeys: [],
    });

    for (const view of views) {
      expect(view.revealed).toBe(false);
      expect(view.title).toBeNull();
      expect(view.bodyMarkdown).toBeNull();
    }
    expect(views.filter((view) => view.unlocked).map((view) => view.key)).toEqual([
      "scenario:look-around",
      "probe:http-ok:curl",
      "probe:cert-valid:openssl",
    ]);
  });

  it("reveals title and body only for revealed hints and advances the group unlock", () => {
    const views = buildScenarioRunHintViews({
      hints,
      revealedHintKeys: ["probe:http-ok:curl"],
    });
    const byKey = new Map(views.map((view) => [view.key, view]));

    expect(byKey.get("probe:http-ok:curl")).toMatchObject({
      revealed: true,
      unlocked: false,
      title: "Title of curl",
      bodyMarkdown: "Body of curl.",
    });
    expect(byKey.get("probe:http-ok:config")).toMatchObject({
      revealed: false,
      unlocked: true,
      title: null,
      bodyMarkdown: null,
    });
    // Other groups are untouched: their first hints stay unlocked.
    expect(byKey.get("scenario:look-around")?.unlocked).toBe(true);
    expect(byKey.get("probe:cert-valid:openssl")?.unlocked).toBe(true);
  });

  it("marks no hint unlocked in an exhausted group", () => {
    const views = buildScenarioRunHintViews({
      hints,
      revealedHintKeys: ["probe:http-ok:curl", "probe:http-ok:config"],
    });
    const httpViews = views.filter((view) => view.probeName === "http-ok");
    expect(httpViews.every((view) => view.revealed)).toBe(true);
    expect(httpViews.every((view) => !view.unlocked)).toBe(true);
  });

  it("allows each group ladder to progress independently", () => {
    // Probe hint with zero scenario hints revealed.
    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: [],
        requestedHintKey: "probe:cert-valid:openssl",
      }),
    ).toEqual({
      allowed: true,
      hintKey: "probe:cert-valid:openssl",
    });

    // Second hint of a group is blocked until the first is revealed.
    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: [],
        requestedHintKey: "probe:http-ok:config",
      }),
    ).toEqual({
      allowed: false,
      reason: "not_next",
      nextHintKey: "probe:http-ok:curl",
    });

    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: ["probe:http-ok:curl"],
        requestedHintKey: "probe:http-ok:config",
      }),
    ).toEqual({
      allowed: true,
      hintKey: "probe:http-ok:config",
    });
  });

  it("rejects unknown and already revealed hint keys", () => {
    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: [],
        requestedHintKey: "probe:missing:nope",
      }),
    ).toEqual({
      allowed: false,
      reason: "unknown",
      nextHintKey: null,
    });

    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: ["scenario:look-around"],
        requestedHintKey: "scenario:look-around",
      }),
    ).toEqual({
      allowed: false,
      reason: "already_revealed",
      nextHintKey: "scenario:read-logs",
    });

    expect(
      decideScenarioRunHintReveal({
        hints,
        revealedHintKeys: ["scenario:look-around", "scenario:read-logs"],
        requestedHintKey: "scenario:read-logs",
      }),
    ).toEqual({
      allowed: false,
      reason: "already_revealed",
      nextHintKey: null,
    });
  });

  it("canonicalizes stored keys to per-group prefixes in manifest order", () => {
    // A group's later hint without its earlier one is dropped.
    expect(
      canonicalRevealedScenarioRunHintKeys({
        hints,
        revealedHintKeys: ["probe:http-ok:config"],
      }),
    ).toEqual([]);

    // Interleaved, stale, and duplicate keys collapse per group and are
    // re-emitted in overall manifest order.
    expect(
      canonicalRevealedScenarioRunHintKeys({
        hints,
        revealedHintKeys: [
          "probe:cert-valid:openssl",
          "unknown:stale",
          "scenario:look-around",
          "probe:cert-valid:openssl",
          "probe:http-ok:curl",
        ],
      }),
    ).toEqual([
      "scenario:look-around",
      "probe:http-ok:curl",
      "probe:cert-valid:openssl",
    ]);
  });

  it("deduplicates manifest hints before serializing or revealing bodies", () => {
    const firstHint = hints[0];
    const thirdHint = hints[2];
    if (!firstHint || !thirdHint) {
      throw new Error("expected hint fixtures");
    }
    const duplicatedHints = [
      firstHint,
      {
        ...firstHint,
        title: "Duplicate",
        bodyMarkdown: "This duplicate body must not be exposed.",
      },
      thirdHint,
    ];

    expect(
      buildScenarioRunHintViews({
        hints: duplicatedHints,
        revealedHintKeys: ["scenario:look-around"],
      }).map((view) => view.bodyMarkdown),
    ).toEqual(["Body of look-around.", null]);
  });

  it("persists only group-next reveals and re-canonicalizes the stored keys", () => {
    // Non-next key is ignored; stale keys are scrubbed.
    expect(
      appendRevealedScenarioRunHintKey({
        hints,
        revealedHintKeys: ["unknown:stale"],
        hintKey: "probe:http-ok:config",
      }),
    ).toEqual([]);

    // Group-next reveal appends without touching other groups.
    expect(
      appendRevealedScenarioRunHintKey({
        hints,
        revealedHintKeys: ["probe:cert-valid:openssl"],
        hintKey: "scenario:look-around",
      }),
    ).toEqual(["scenario:look-around", "probe:cert-valid:openssl"]);

    // Already revealed is idempotent.
    expect(
      appendRevealedScenarioRunHintKey({
        hints,
        revealedHintKeys: ["scenario:look-around"],
        hintKey: "scenario:look-around",
      }),
    ).toEqual(["scenario:look-around"]);
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
