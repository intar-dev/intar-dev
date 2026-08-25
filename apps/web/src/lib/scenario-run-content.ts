import type { ScenarioRunHintSnapshot } from "@/db/schema";
import type { RunStateDocument } from "@/lib/run-state";
import { isVerificationPassed } from "@/lib/verification-copy";

export interface ScenarioRunHintView {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  revealed: boolean;
  unlocked: boolean;
  bodyMarkdown: string | null;
}

// Hints unlock sequentially per group: the scenario-level ladder and one
// ladder per probe are independent, so being stuck on one objective never
// forces revealing hints for another.
type ScenarioRunHintGroupRef = {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
};

function scenarioRunHintGroupKey(hint: ScenarioRunHintGroupRef): string {
  if (hint.scope === "scenario") return "scenario";
  const vmName = scenarioRunHintVmName(hint.key);
  return vmName
    ? `probe:${vmName}:${hint.probeName ?? ""}`
    : `probe:${hint.probeName ?? ""}`;
}

function scenarioRunHintVmName(key: string): string | null {
  const parts = key.split(":");
  return parts[0] === "probe" && parts.length >= 4 ? (parts[1] ?? null) : null;
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
      reason: "unknown" | "already_revealed" | "not_next";
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
  const unlockedKeys = new Set<string>();
  for (const hint of hints) {
    const groupNext = nextScenarioRunHintKeyForGroup(
      hints,
      revealed,
      scenarioRunHintGroupKey(hint),
    );
    if (groupNext !== null) {
      unlockedKeys.add(groupNext);
    }
  }
  return hints.map((hint) => {
    const isRevealed = revealed.has(hint.key);
    return {
      key: hint.key,
      scope: hint.scope,
      probeName: hint.probeName,
      id: hint.id,
      // Sealed hints leak neither title nor body.
      title: isRevealed ? hint.title : null,
      revealed: isRevealed,
      unlocked: !isRevealed && unlockedKeys.has(hint.key),
      bodyMarkdown: isRevealed ? hint.bodyMarkdown : null,
    };
  });
}

function nextScenarioRunHintKeyForGroup(
  hints: ScenarioRunHintGroupRef[],
  canonicalRevealed: ReadonlySet<string>,
  groupKey: string,
): string | null {
  for (const hint of hints) {
    if (scenarioRunHintGroupKey(hint) !== groupKey) {
      continue;
    }
    if (!canonicalRevealed.has(hint.key)) {
      return hint.key;
    }
  }
  return null;
}

export function appendRevealedScenarioRunHintKey(input: {
  hints: ScenarioRunHintGroupRef[];
  revealedHintKeys: string[];
  hintKey: string;
}): string[] {
  const hints = uniqueScenarioRunHints(input.hints);
  const current = canonicalRevealedScenarioRunHintKeys({
    hints,
    revealedHintKeys: input.revealedHintKeys,
  });
  const currentSet = new Set(current);
  if (currentSet.has(input.hintKey)) {
    return current;
  }
  const hint = hints.find((candidate) => candidate.key === input.hintKey);
  if (!hint) {
    return current;
  }
  const groupNext = nextScenarioRunHintKeyForGroup(
    hints,
    currentSet,
    scenarioRunHintGroupKey(hint),
  );
  if (groupNext !== input.hintKey) {
    return current;
  }
  // Re-canonicalize so stored keys stay in deterministic manifest order —
  // the optimistic-concurrency UPDATE compares the raw JSON string.
  return canonicalRevealedScenarioRunHintKeys({
    hints,
    revealedHintKeys: [...current, input.hintKey],
  });
}

export function canonicalRevealedScenarioRunHintKeys(input: {
  hints: ScenarioRunHintGroupRef[];
  revealedHintKeys: string[];
}): string[] {
  const hints = uniqueScenarioRunHints(input.hints);
  const revealed = new Set(input.revealedHintKeys);
  const blockedGroups = new Set<string>();
  const keys: string[] = [];
  for (const hint of hints) {
    const groupKey = scenarioRunHintGroupKey(hint);
    if (blockedGroups.has(groupKey)) {
      continue;
    }
    if (!revealed.has(hint.key)) {
      blockedGroups.add(groupKey);
      continue;
    }
    keys.push(hint.key);
  }
  return keys;
}

export function decideScenarioRunHintReveal(input: {
  hints: ScenarioRunHintGroupRef[];
  revealedHintKeys: string[];
  requestedHintKey: string;
}): ScenarioRunHintRevealDecision {
  const hints = uniqueScenarioRunHints(input.hints);
  const requested = hints.find((hint) => hint.key === input.requestedHintKey);
  if (!requested) {
    return {
      allowed: false,
      reason: "unknown",
      nextHintKey: null,
    };
  }
  const revealed = new Set(
    canonicalRevealedScenarioRunHintKeys({
      hints,
      revealedHintKeys: input.revealedHintKeys,
    }),
  );
  const groupNext = nextScenarioRunHintKeyForGroup(
    hints,
    revealed,
    scenarioRunHintGroupKey(requested),
  );
  if (revealed.has(requested.key)) {
    return {
      allowed: false,
      reason: "already_revealed",
      nextHintKey: groupNext,
    };
  }
  if (groupNext !== requested.key) {
    return {
      allowed: false,
      reason: "not_next",
      nextHintKey: groupNext,
    };
  }
  return {
    allowed: true,
    hintKey: requested.key,
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
      isVerificationPassed(probe.status),
    )
  );
}
