import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { runtimeExecutions, scenarioRuns } from "@/db/schema";
import { retireHostRuntime, wakeHostRuntime } from "@/lib/host-runtime-wake";
import { destroyScenarioRunForUser } from "@/lib/scenario-runs";
import { parseRunState } from "@/lib/scenario-runs/storage";
import { revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";

/** Called after credentials are revoked. Retries never restore host access. */
export async function cleanupRemovedHost(hostId: string): Promise<void> {
  const runs = await drizzle(env.DB).select({
    runId: scenarioRuns.runId, userId: scenarioRuns.userId,
    state: scenarioRuns.state, stateJson: scenarioRuns.stateJson,
    executionState: runtimeExecutions.state,
  }).from(scenarioRuns)
    .leftJoin(runtimeExecutions, eq(runtimeExecutions.id, scenarioRuns.runtimeExecutionId))
    .where(eq(scenarioRuns.hostId, hostId));
  const cleanup = await Promise.allSettled([
    retireHostRuntime(hostId),
    (async () => {
      const failures: unknown[] = [];
      for (const run of runs) {
        try {
          if (run.state === "completed" || run.executionState === "archived") {
            await revokeScenarioRunRoutes({ runId: run.runId, state: parseRunState(run.stateJson) });
          } else {
            await destroyScenarioRunForUser({ runId: run.runId, userId: run.userId });
          }
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Workload cleanup failed");
    })(),
  ]);
  const wake = await Promise.allSettled([wakeHostRuntime(hostId)]);
  if ([...cleanup, ...wake].some(result => result.status === "rejected")) {
    throw new Error("Server session and workload cleanup is pending");
  }
}
