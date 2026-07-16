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

export interface ScenarioCatalogWireEntry extends ScenarioCatalogEntry {
  progress: ScenarioProgress;
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
