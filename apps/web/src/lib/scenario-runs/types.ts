import {
  type ScenarioBriefing,
  type ScenarioDifficulty,
  type ScenarioObjective,
} from "@/lib/scenario-model";
import { type RunPhase, type RunStateDocument } from "@/lib/run-state";
import {
  type ScenarioRunHintView,
  type ScenarioRunSolutionView,
} from "@/lib/scenario-run-content";
import { type ScenarioRunOutcome } from "@/lib/scenario-run-outcome";
import {
  type BrowserTerminalSessionResult,
  type NativeTerminalSessionResult,
} from "@/lib/stargate";
import type { ScenarioRunActivity, ScenarioRunReplayState } from "./activity";
import type { ScenarioRunSavingStage } from "./saving-stage";

export interface ScenarioCatalogEntry {
  scenarioId: string;
  organizationId: string | null;
  slug: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  tags: string[];
  category: string;
  scenarioName: string;
  enabledAt: number;
  vmCount: number;
}

export interface ScenarioProgress {
  status: "new" | "in_progress" | "attempted" | "completed";
  activeRunId: string | null;
  attemptCount: number;
  completedCount: number;
  bestSolveMs: number | null;
  lastPlayedAt: number | null;
}

/**
 * The canonical course context for a scenario.  A scenario can be linked from
 * a run, assignment, or admin record without carrying route state in a query
 * string; consumers use this view to build its canonical learner URL.
 */
export type CourseLocation =
  | {
      courseKind: "authored";
      scope: "public" | "organization-public" | "organization-private";
      organizationId: string | null;
      courseId: string;
      courseTitle: string;
      step: number;
      steps: number;
    }
  | {
      courseKind: "general-practice";
      scope: "public" | "organization-general-practice";
      organizationId: string | null;
      courseId: null;
      courseTitle: "General practice";
      step: null;
      steps: null;
    };

export interface ScenarioCatalogWireEntry extends ScenarioCatalogEntry {
  progress: ScenarioProgress;
}

export type ScenarioCatalogCourseWireEntry =
  | {
      kind: "authored";
      courseId: string;
      organizationId: string | null;
      title: string;
      description: string;
      scenarios: ScenarioCatalogWireEntry[];
    }
  | {
      kind: "general-practice";
      courseId: null;
      organizationId: null;
      title: "General practice";
      description: string;
      scenarios: ScenarioCatalogWireEntry[];
    };

export interface ScenarioCatalogWireResponse {
  courses: ScenarioCatalogCourseWireEntry[];
}

export interface ScenarioDetail {
  scenarioId: string;
  organizationId: string | null;
  slug: string;
  enabledAt: number;
  scenarioName: string;
  briefing: ScenarioBriefing;
  vmCount: number;
  hasActiveRun: boolean;
  activeRunId: string | null;
  activeRun: {
    runId: string;
    phase: RunStateDocument["phase"];
    phaseTitle: string;
    phaseDetail: string;
    canOpenTerminal: boolean;
    terminalPhase: RunStateDocument["terminalPhase"];
    updatedAt: number;
  } | null;
  blockingRun: {
    runId: string;
    scenarioId: string;
    slug: string;
    title: string;
  } | null;
  /** Null when this scenario is no longer visible in the current catalog. */
  courseLocation: CourseLocation | null;
  finishedRuns: Array<{
    runId: string;
    phase: "completed" | "failed";
    outcome: Exclude<ScenarioRunOutcome, "in_progress">;
    createdAt: number;
    finishedAt: number;
    solvedAt: number | null;
    solveDurationMs: number | null;
    solutionAssisted: boolean;
    replayState: ScenarioRunReplayState;
    hasReplay: boolean;
  }>;
}

export interface ScenarioRunRecord extends RunStateDocument {
  id: string;
  scenarioId: string;
  organizationId: string | null;
  /** Resolved when a user-facing run view loads; absent on internal snapshots. */
  courseLocation?: CourseLocation | null;
  scenarioName: string;
  title: string;
  tagline: string;
  briefingMarkdown: string;
  objectives: ScenarioObjective[];
  tags: string[];
  hints: ScenarioRunHintView[];
  solution: ScenarioRunSolutionView;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: ScenarioRunOutcome;
  active: boolean;
  activity: ScenarioRunActivity;
  deleteRequestedAt: number | null;
  /** Learner-safe, aggregate archive progress. Null outside save flow. */
  savingStage: ScenarioRunSavingStage | null;
  replayState: ScenarioRunReplayState;
  hasReplay: boolean;
  createdAt: number;
  updatedAt: number;
}

export type ScenarioTerminalSessionResult =
  | BrowserTerminalSessionResult
  | NativeTerminalSessionResult;

export interface ScenarioRunListEntry {
  runId: string;
  scenarioId: string;
  organizationId: string | null;
  courseLocation?: CourseLocation | null;
  scenarioName: string;
  title: string;
  difficulty: ScenarioDifficulty;
  phase: RunPhase;
  outcome: ScenarioRunOutcome;
  active: boolean;
  activity: ScenarioRunActivity;
  deleteRequestedAt: number | null;
  replayState: ScenarioRunReplayState;
  createdAt: number;
  finishedAt: number | null;
  solvedAt: number | null;
  solveDurationMs: number | null;
  solutionAssisted: boolean;
  hasReplay: boolean;
}

export type { ScenarioRunActivity, ScenarioRunReplayState } from "./activity";
