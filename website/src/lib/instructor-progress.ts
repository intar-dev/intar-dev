import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, scenarioAssignments, scenarioRuns, user } from "@/db/schema";
import {
  bestSolveDuration,
  cellStatus,
  type ProgressStatus,
  type RunFacts,
} from "@/lib/progress-status";
import { listEnabledScenariosForUser } from "@/lib/scenario-runs";
import { requireTeamRole } from "@/lib/teams";

export type { ProgressStatus };

// Instructor read-model: roster × assigned scenarios → per-cell status.

export interface ProgressCell {
  scenarioId: string;
  status: ProgressStatus;
  solveDurationMs: number | null;
  runId: string | null;
}

export interface ProgressRow {
  userId: string;
  name: string;
  githubUsername: string | null;
  cells: ProgressCell[];
}

export interface TeamProgress {
  scenarios: Array<{ scenarioId: string; title: string | null }>;
  rows: ProgressRow[];
}

export async function getTeamProgress(params: {
  organizationId: string;
  userId: string;
}): Promise<TeamProgress> {
  await requireTeamRole({ ...params, instructor: true });

  const db = drizzle(env.DB);

  const [assignments, roster, enabled] = await Promise.all([
    db
      .select({
        scenarioId: scenarioAssignments.scenarioId,
        createdAt: scenarioAssignments.createdAt,
      })
      .from(scenarioAssignments)
      .where(eq(scenarioAssignments.organizationId, params.organizationId))
      .orderBy(scenarioAssignments.createdAt),
    db
      .select({
        userId: member.userId,
        name: user.name,
        githubUsername: user.username,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, params.organizationId))
      .orderBy(member.createdAt),
    listEnabledScenariosForUser(),
  ]);

  const titles = new Map(enabled.map((entry) => [entry.scenarioId, entry.title]));
  const scenarios = assignments.map((assignment) => ({
    scenarioId: assignment.scenarioId,
    title: titles.get(assignment.scenarioId) ?? null,
  }));

  if (!scenarios.length || !roster.length) {
    return { scenarios, rows: [] };
  }

  const runs = await db
    .select({
      runId: scenarioRuns.runId,
      userId: scenarioRuns.userId,
      scenarioId: scenarioRuns.scenarioId,
      activeKey: scenarioRuns.activeKey,
      solvedAt: scenarioRuns.solvedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
      createdAt: scenarioRuns.createdAt,
    })
    .from(scenarioRuns)
    .where(
      and(
        inArray(
          scenarioRuns.userId,
          roster.map((row) => row.userId),
        ),
        inArray(
          scenarioRuns.scenarioId,
          scenarios.map((row) => row.scenarioId),
        ),
      ),
    )
    .orderBy(desc(scenarioRuns.createdAt));

  const factsByCell = new Map<string, RunFacts[]>();
  for (const run of runs) {
    const key = `${run.userId}:${run.scenarioId}`;
    const facts = factsByCell.get(key) ?? [];
    facts.push({
      runId: run.runId,
      active: run.activeKey !== null,
      solvedAt: run.solvedAt,
      solutionAssisted: run.solutionAssisted,
      solveDurationMs:
        run.solvedAt !== null ? run.solvedAt - run.createdAt : null,
      createdAt: run.createdAt,
    });
    factsByCell.set(key, facts);
  }

  const rows: ProgressRow[] = roster.map((entry) => ({
    userId: entry.userId,
    name: entry.name,
    githubUsername: entry.githubUsername,
    cells: scenarios.map((scenario) => {
      const facts = factsByCell.get(`${entry.userId}:${scenario.scenarioId}`) ?? [];
      const solvedRuns = facts.filter((run) => run.solvedAt !== null);
      const best = solvedRuns
        .filter((run) => run.solveDurationMs !== null)
        .sort((a, b) => (a.solveDurationMs ?? 0) - (b.solveDurationMs ?? 0))[0];
      return {
        scenarioId: scenario.scenarioId,
        status: cellStatus(facts),
        solveDurationMs: bestSolveDuration(facts),
        runId: best?.runId ?? facts[0]?.runId ?? null,
      };
    }),
  }));

  return { scenarios, rows };
}
