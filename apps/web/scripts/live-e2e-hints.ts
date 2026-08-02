export interface LiveHintGateRef {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  unlocked: boolean;
}

export function selectSequentialHintPair(
  hints: LiveHintGateRef[],
): { first: LiveHintGateRef; skipAhead: LiveHintGateRef } {
  const groups = new Map<string, LiveHintGateRef[]>();
  for (const hint of hints) {
    const groupKey =
      hint.scope === "scenario" ? "scenario" : `probe:${hint.probeName ?? ""}`;
    const group = groups.get(groupKey) ?? [];
    group.push(hint);
    groups.set(groupKey, group);
  }

  const pair = [...groups.values()].find((group) => group.length >= 2);
  const first = pair?.[0];
  const skipAhead = pair?.[1];
  if (!first || !skipAhead) {
    throw new Error(
      "run needs a hint group with at least two authored hints to verify skip-ahead gating",
    );
  }
  if (!first.unlocked) {
    throw new Error(`expected first hint ${first.key} to be unlocked`);
  }
  if (skipAhead.unlocked) {
    throw new Error(`expected later hint ${skipAhead.key} to remain locked`);
  }
  return { first, skipAhead };
}
