import type { ScenarioRunHintSnapshot } from "@/db/schema";
import type { RunStateDocument } from "@/lib/run-state";

export interface ScenarioRunHintView {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  revealed: boolean;
  bodyMarkdown: string | null;
}

export interface ScenarioRunSolutionView {
  unlocked: boolean;
  revealed: boolean;
  assisted: boolean;
  revealedAt: number | null;
  bodyMarkdown: string | null;
}

export type ScenarioRunHintRevealDecision =
  | {
      allowed: true;
      hintKey: string;
    }
  | {
      allowed: false;
      reason: "exhausted" | "not_next";
      nextHintKey: string | null;
    };

export function buildScenarioRunHintViews(input: {
  hints: ScenarioRunHintSnapshot[];
  revealedHintKeys: string[];
}): ScenarioRunHintView[] {
  const hints = uniqueScenarioRunHints(input.hints);
  const revealed = new Set(
    canonicalRevealedScenarioRunHintKeys({
      hints,
      revealedHintKeys: input.revealedHintKeys,
    }),
  );
  return hints.map((hint) => {
    const isRevealed = revealed.has(hint.key);
    return {
      key: hint.key,
      scope: hint.scope,
      probeName: hint.probeName,
      id: hint.id,
      title: hint.title,
      revealed: isRevealed,
      bodyMarkdown: isRevealed ? hint.bodyMarkdown : null,
    };
  });
}

export function nextScenarioRunHintKey(
  hints: Array<{ key: string }>,
  revealedHintKeys: string[],
): string | null {
  const orderedHints = uniqueScenarioRunHints(hints);
  const revealed = new Set(revealedHintKeys);
  return orderedHints.find((hint) => !revealed.has(hint.key))?.key ?? null;
}

export function appendRevealedScenarioRunHintKey(input: {
  hints: Array<{ key: string }>;
  revealedHintKeys: string[];
  hintKey: string;
}): string[] {
  const hints = uniqueScenarioRunHints(input.hints);
  const current = canonicalRevealedScenarioRunHintKeys({
    hints,
    revealedHintKeys: input.revealedHintKeys,
  });
  const nextHintKey = hints[current.length]?.key ?? null;
  return nextHintKey === input.hintKey ? [...current, input.hintKey] : current;
}

export function canonicalRevealedScenarioRunHintKeys(input: {
  hints: Array<{ key: string }>;
  revealedHintKeys: string[];
}): string[] {
  const hints = uniqueScenarioRunHints(input.hints);
  const revealed = new Set(input.revealedHintKeys);
  const keys: string[] = [];
  for (const hint of hints) {
    if (!revealed.has(hint.key)) {
      break;
    }
    keys.push(hint.key);
  }
  return keys;
}

export function decideScenarioRunHintReveal(input: {
  hints: Array<{ key: string }>;
  revealedHintKeys: string[];
  requestedHintKey: string;
}): ScenarioRunHintRevealDecision {
  const hints = uniqueScenarioRunHints(input.hints);
  const nextHintKey = nextScenarioRunHintKey(hints, input.revealedHintKeys);
  if (!nextHintKey) {
    return {
      allowed: false,
      reason: "exhausted",
      nextHintKey: null,
    };
  }
  if (input.requestedHintKey !== nextHintKey) {
    return {
      allowed: false,
      reason: "not_next",
      nextHintKey,
    };
  }
  return {
    allowed: true,
    hintKey: nextHintKey,
  };
}

function uniqueScenarioRunHints<T extends { key: string }>(hints: T[]): T[] {
  const seen = new Set<string>();
  const uniqueHints: T[] = [];
  for (const hint of hints) {
    if (seen.has(hint.key)) {
      continue;
    }
    seen.add(hint.key);
    uniqueHints.push(hint);
  }
  return uniqueHints;
}

export function buildScenarioRunSolutionView(input: {
  solutionMarkdown: string;
  solutionRevealedAt: number | null;
  solutionAssisted: boolean;
  state: RunStateDocument;
  solvedAt: number | null;
}): ScenarioRunSolutionView {
  const revealed = input.solutionRevealedAt !== null;
  const unlocked =
    revealed ||
    isScenarioRunSolved({
      state: input.state,
      solvedAt: input.solvedAt,
    });
  return {
    unlocked,
    revealed,
    assisted: input.solutionAssisted,
    revealedAt: input.solutionRevealedAt,
    bodyMarkdown: revealed ? input.solutionMarkdown : null,
  };
}

export function isScenarioRunSolved(input: {
  state: RunStateDocument;
  solvedAt: number | null;
}): boolean {
  if (
    input.solvedAt !== null ||
    ["solved", "archiving", "completed"].includes(input.state.phase)
  ) {
    return true;
  }

  return (
    input.state.scenarioProbes.length > 0 &&
    input.state.scenarioProbes.every((probe) =>
      isPassingProbeStatus(probe.status),
    )
  );
}

function isPassingProbeStatus(status: string | null | undefined): boolean {
  switch (status?.trim().toLowerCase()) {
    case "pass":
    case "passed":
    case "passing":
    case "ready":
    case "ok":
    case "success":
    case "succeeded":
      return true;
    default:
      return false;
  }
}
