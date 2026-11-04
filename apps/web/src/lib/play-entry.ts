import { env } from "cloudflare:workers";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { courseCatalogs, vmScenarios } from "@/db/schema";
import {
  courseCatalogScopeKey,
  findCourseLecturePresentation,
} from "@/lib/course-catalogs";
import { PLAY_NAMESPACE, type PlayEntryResponse } from "@/lib/play";
import { runsHeldCondition } from "@/lib/run-admission-gate";
import { isSafeScenarioId } from "@/lib/scenario-id";

/**
 * The /play entry for one scenario, or null when it is not playable. M1:
 * playable means the `intar` namespace, an enabled public scenario, and a
 * lecture in the public course catalog that links it. The briefing is the
 * lecture body the run shows; it is returned only for a signed-in caller.
 * Hints, solution, objectives and checks never leave here.
 */
export async function loadPlayEntry(input: {
  namespace: string;
  slug: string;
  signedIn: boolean;
}): Promise<PlayEntryResponse | null> {
  if (input.namespace !== PLAY_NAMESPACE || !isSafeScenarioId(input.slug)) {
    return null;
  }
  const db = drizzle(env.DB);
  const [[catalog], [scenario], held] = await Promise.all([
    db
      .select({ snapshot: courseCatalogs.catalogJson })
      .from(courseCatalogs)
      .where(eq(courseCatalogs.scopeKey, courseCatalogScopeKey(null)))
      .limit(1),
    db
      .select({ difficulty: vmScenarios.difficulty })
      .from(vmScenarios)
      .where(
        and(
          eq(vmScenarios.scenarioId, input.slug),
          isNull(vmScenarios.organizationId),
          eq(vmScenarios.enabled, true),
          isNotNull(vmScenarios.enabledAt),
        ),
      )
      .limit(1),
    env.DB.prepare(`SELECT ${runsHeldCondition()} AS held`).first<{
      held: number;
    }>(),
  ]);
  if (!catalog || !scenario) return null;
  const lecture = findCourseLecturePresentation(catalog.snapshot, input.slug);
  if (!lecture) return null;
  return {
    title: lecture.title,
    summary: lecture.summary,
    difficulty: lecture.difficulty ?? scenario.difficulty,
    minutes: lecture.estimatedMinutes,
    // The scenario format has no credit field until the epoch cutover.
    credit: null,
    available: !held?.held,
    ...(input.signedIn ? { briefing_markdown: lecture.bodyMarkdown } : {}),
  };
}
