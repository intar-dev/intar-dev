import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import { scenarioRuns } from "@/db/schema";
import {
  applyLectureBriefingPresentation,
  resolveCourseLectureForScenario,
  type ResolvedCourseLecture,
} from "@/lib/course-catalogs";
import { RUN_PHASE_ORDER, type RunPhase } from "@/lib/run-state";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
} from "@/lib/scenario-run-outcome";
import {
  type ScenarioCatalogEntry,
  type ScenarioDetail,
  type ScenarioRunRecord,
  type ScenarioRunListEntry,
  type CourseLocation,
} from "./types";
import {
  loadEnabledScenarioRows,
  slugify,
  loadActiveRunRow,
  loadFinishedRuns,
  loadRunRow,
  toScenarioRunRecord,
  hydrateScenarioRunSavingStage,
  hydrateScenarioRunReplayArtifacts,
  parseRunState,
  scenarioRunDifficulty,
} from "./storage";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
} from "./activity";

export async function listEnabledScenariosForUser(options?: {
  organizationId?: string | null;
}): Promise<ScenarioCatalogEntry[]> {
  const scenarios = await loadEnabledScenarioRows(
    undefined,
    options?.organizationId ?? null,
  );
  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    organizationId: scenario.organizationId,
    slug: slugify(scenario.scenarioId),
    title: scenario.briefing.title,
    tagline: scenario.briefing.tagline,
    difficulty: scenario.briefing.difficulty,
    estimatedMinutes: scenario.briefing.estimatedMinutes,
    tags: scenario.briefing.tags,
    category: scenario.briefing.category,
    scenarioName: scenario.scenarioId,
    enabledAt: scenario.enabledAt,
    vmCount: scenario.launchSpecs.length,
  }));
}

export async function loadEnabledScenarioForUser(params: {
  scenarioId: string;
  userId: string;
  organizationId?: string | null;
  allowSequenceBypass?: boolean;
}): Promise<ScenarioDetail | null> {
  const organizationId = params.organizationId ?? null;
  const courseLecture = await resolveCourseLectureForScenario({
    db: drizzle(env.DB),
    userId: params.userId,
    organizationId,
    scenarioId: params.scenarioId,
    ...(params.allowSequenceBypass ? { allowSequenceBypass: true } : {}),
  });
  // Standalone scenarios and locked units are intentionally not detailable.
  if (!courseLecture || courseLecture.state === "locked") return null;
  const rows = await loadEnabledScenarioRows(
    params.scenarioId,
    organizationId,
  );
  const enabled = rows[0];
  if (!enabled) {
    return null;
  }

  const active = await loadActiveRunRow(params.userId);
  const activeHere =
    active &&
    active.scenarioId === enabled.scenarioId &&
    active.organizationId === organizationId
      ? active
      : null;
  const finishedRuns = await loadFinishedRuns(
    params.userId,
    enabled.scenarioId,
    organizationId,
  );
  return {
    scenarioId: enabled.scenarioId,
    organizationId: enabled.organizationId,
    slug: slugify(enabled.scenarioId),
    enabledAt: enabled.enabledAt,
    scenarioName: enabled.scenarioId,
    briefing: applyLectureBriefingPresentation(
      enabled.briefing,
      courseLecture.lecture,
    ),
    vmCount: enabled.launchSpecs.length,
    hasActiveRun: activeHere !== null,
    activeRunId: activeHere?.runId ?? null,
    activeRun: activeHere
      ? {
          runId: activeHere.runId,
          phase: activeHere.state.phase,
          phaseTitle: activeHere.state.phaseTitle,
          phaseDetail: activeHere.state.phaseDetail,
          canOpenTerminal: activeHere.state.canOpenTerminal,
          terminalPhase: activeHere.state.terminalPhase,
          updatedAt: activeHere.updatedAt,
        }
      : null,
    blockingRun:
      active && !activeHere
        ? {
            runId: active.runId,
            scenarioId: active.scenarioId,
            slug: slugify(active.scenarioId),
            title: active.title,
          }
        : null,
    courseLocation: courseLocationFromResolved(courseLecture, organizationId),
    finishedRuns,
  };
}

export async function getScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<ScenarioRunRecord> {
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  const run = await hydrateScenarioRunSavingStage(
    toScenarioRunRecord(row),
    row.runtimeExecutionId,
  );
  // Recording artifacts are produced only after teardown starts. Keep the
  // startup/readiness poll to one run-row query without hiding artifact
  // upload progress from teardown and archive views.
  if (RUN_PHASE_ORDER[run.phase] < RUN_PHASE_ORDER.teardown_requested) {
    return withScenarioRunCourseLocation(run, params.userId);
  }
  return withScenarioRunCourseLocation(
    await hydrateScenarioRunReplayArtifacts(run),
    params.userId,
  );
}

export async function listScenarioRunsForUser(params: {
  userId: string;
}): Promise<ScenarioRunListEntry[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      organizationId: scenarioRuns.organizationId,
      scenarioName: scenarioRuns.scenarioName,
      courseScopeKey: scenarioRuns.courseScopeKey,
      courseId: scenarioRuns.courseId,
      courseTitle: scenarioRuns.courseTitle,
      lectureId: scenarioRuns.lectureId,
      lectureOrdinal: scenarioRuns.lectureOrdinal,
      lectureCount: scenarioRuns.lectureCount,
      title: scenarioRuns.title,
      difficulty: scenarioRuns.difficulty,
      state: scenarioRuns.state,
      stateJson: scenarioRuns.stateJson,
      activeKey: scenarioRuns.activeKey,
      createdAt: scenarioRuns.createdAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.userId, params.userId))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(100);

  const listedRuns = rows.map((row) => {
    const phase = row.state as RunPhase;
    const replayState = deriveScenarioRunReplayState(
      parseRunState(row.stateJson),
    );
    return {
      runId: row.runId,
      scenarioId: row.scenarioId,
      organizationId: row.organizationId,
      scenarioName: row.scenarioName,
      courseScopeKey: row.courseScopeKey,
      courseId: row.courseId,
      courseTitle: row.courseTitle,
      lectureId: row.lectureId,
      lectureOrdinal: row.lectureOrdinal,
      lectureCount: row.lectureCount,
      title: row.title,
      difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
      phase,
      outcome: deriveScenarioRunOutcome({
        phase,
        solvedAt: row.solvedAt,
        deleteRequestedAt: row.deleteRequestedAt,
        failedAt: row.failedAt,
      }),
      active: row.activeKey !== null,
      activity: deriveScenarioRunActivity({
        activeKey: row.activeKey,
        phase,
      }),
      deleteRequestedAt: row.deleteRequestedAt,
      replayState,
      createdAt: row.createdAt,
      finishedAt: row.completedAt ?? row.failedAt ?? null,
      solvedAt: row.solvedAt,
      solveDurationMs: deriveScenarioRunSolveDurationMs({
        createdAt: row.createdAt,
        solvedAt: row.solvedAt,
      }),
      solutionAssisted: row.solutionAssisted,
      hasReplay: replayState === "ready",
    };
  });
  const locations = await resolveScenarioCourseLocationsForUser({
    userId: params.userId,
    targets: listedRuns.map((run) => ({
      scenarioId: run.scenarioId,
      organizationId: run.organizationId,
    })),
  });
  return listedRuns.map((run) => ({
    ...run,
    courseLocation:
      courseLocationFromRunSnapshot(run) ??
      locations.get(courseLocationLookupKey(run.organizationId, run.scenarioId)) ??
      null,
  }));
}

export async function resolveScenarioCourseLocationForUser(params: {
  userId: string;
  scenarioId: string;
  organizationId?: string | null;
}): Promise<CourseLocation | null> {
  const organizationId = params.organizationId ?? null;
  const resolved = await resolveCourseLectureForScenario({
    db: drizzle(env.DB),
    userId: params.userId,
    organizationId,
    scenarioId: params.scenarioId,
  });
  return resolved ? courseLocationFromResolved(resolved, organizationId) : null;
}

async function withScenarioRunCourseLocation(
  run: ScenarioRunRecord,
  userId: string,
): Promise<ScenarioRunRecord> {
  const snapshotLocation = courseLocationFromRunSnapshot(run);
  return {
    ...run,
    courseLocation:
      snapshotLocation ??
      (await resolveScenarioCourseLocationForUser({
        userId,
        scenarioId: run.scenarioId,
        organizationId: run.organizationId,
      })),
  };
}

async function resolveScenarioCourseLocationsForUser(input: {
  userId: string;
  targets: Array<{ scenarioId: string; organizationId: string | null }>;
}): Promise<Map<string, CourseLocation | null>> {
  const locations = new Map<string, CourseLocation | null>();
  const targets = [
    ...new Map(
      input.targets.map((target) => [
        courseLocationLookupKey(target.organizationId, target.scenarioId),
        target,
      ]),
    ).values(),
  ];
  const resolved = await Promise.all(
    targets.map(async (target) => [
      target,
      await resolveScenarioCourseLocationForUser({
        userId: input.userId,
        scenarioId: target.scenarioId,
        organizationId: target.organizationId,
      }),
    ] as const),
  );
  for (const [target, location] of resolved) {
    locations.set(
      courseLocationLookupKey(target.organizationId, target.scenarioId),
      location,
    );
  }
  return locations;
}

function courseLocationLookupKey(
  organizationId: string | null,
  scenarioId: string,
): string {
  return organizationId
    ? `organization:${organizationId}\u0000${scenarioId}`
    : `public\u0000${scenarioId}`;
}

function courseLocationFromResolved(
  resolved: ResolvedCourseLecture,
  organizationId: string | null,
): CourseLocation {
  return {
    scope: organizationId
      ? resolved.organizationId
        ? "organization-private"
        : "organization-public"
      : "public",
    organizationId,
    courseId: resolved.courseId,
    courseTitle: resolved.courseTitle,
    lectureId: resolved.lectureId,
    step: resolved.lectureOrdinal,
    steps: resolved.lectureCount,
  };
}

export function courseLocationFromRunSnapshot(
  run: Pick<
    ScenarioRunRecord,
    | "organizationId"
    | "courseScopeKey"
    | "courseId"
    | "courseTitle"
    | "lectureId"
    | "lectureOrdinal"
    | "lectureCount"
  >,
): CourseLocation | null {
  if (!run.courseScopeKey || !run.courseId || !run.courseTitle || !run.lectureId) {
    return null;
  }
  return {
    scope: run.organizationId
      ? run.courseScopeKey === "public"
        ? "organization-public"
        : "organization-private"
      : "public",
    organizationId: run.organizationId,
    courseId: run.courseId,
    courseTitle: run.courseTitle,
    lectureId: run.lectureId,
    step: run.lectureOrdinal ?? 1,
    steps: run.lectureCount ?? 1,
  };
}
