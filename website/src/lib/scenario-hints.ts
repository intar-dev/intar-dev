import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioRuns } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { getScenarioRunForUser, type ScenarioRunRecord } from "@/lib/scenario-runs";
import {
  appendRevealedScenarioRunHintKey,
  decideScenarioRunHintReveal,
  isScenarioRunSolved,
} from "@/lib/scenario-run-content";
import {
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";

export async function revealScenarioRunHintForUser(input: {
  runId: string;
  userId: string;
  hintKey: string;
}): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select()
    .from(scenarioRuns)
    .where(and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.userId, input.userId)))
    .limit(1);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const decision = decideScenarioRunHintReveal({
    hints: row.hintsJson,
    revealedHintKeys: row.revealedHintsJson,
    requestedHintKey: input.hintKey,
  });
  if (!decision.allowed && decision.reason === "unknown") {
    throw appError(404, "scenario_hint_unknown", "hint not found");
  }
  if (!decision.allowed && decision.reason === "already_revealed") {
    throw appError(
      409,
      "scenario_hint_already_revealed",
      "hint is already revealed",
    );
  }
  if (!decision.allowed) {
    throw appError(
      409,
      "scenario_hint_not_next",
      "only the next hint of its group can be revealed",
    );
  }

  const now = Date.now();
  const revealedHintsJson = appendRevealedScenarioRunHintKey({
    hints: row.hintsJson,
    revealedHintKeys: row.revealedHintsJson,
    hintKey: decision.hintKey,
  });
  const updated = await db
    .update(scenarioRuns)
    .set({
      revealedHintsJson,
      updatedAt: now,
    })
    .where(
      and(
        eq(scenarioRuns.runId, input.runId),
        eq(scenarioRuns.userId, input.userId),
        eq(scenarioRuns.revealedHintsJson, row.revealedHintsJson),
      ),
    )
    .returning({ runId: scenarioRuns.runId });
  if (!updated.length) {
    return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
  }

  return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
}

export async function revealScenarioRunSolutionForUser(input: {
  runId: string;
  userId: string;
}): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select()
    .from(scenarioRuns)
    .where(and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.userId, input.userId)))
    .limit(1);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const now = Date.now();
  const solved = isScenarioRunSolved({
    state: parseRunState(row.stateJson),
    solvedAt: row.solvedAt,
  });
  await db
    .update(scenarioRuns)
    .set({
      solutionRevealedAt: row.solutionRevealedAt ?? now,
      solutionAssisted: row.solutionAssisted || !solved,
      updatedAt: now,
    })
    .where(and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.userId, input.userId)));

  return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
