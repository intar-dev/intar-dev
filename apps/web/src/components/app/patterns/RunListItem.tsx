import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDurationMs, formatTimestamp } from "../lib/format";
import { RelativeTime } from "./RelativeTime";
import { StatusToken } from "./StatusToken";
import type { CourseLocation, ScenarioRunActivity } from "@/lib/scenario-runs";

export interface RunListItemData {
  runId: string;
  title: string;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  active: boolean;
  activity?: ScenarioRunActivity;
  createdAt: number;
  solveDurationMs: number | null;
  solutionAssisted?: boolean;
  hasReplay?: boolean;
  /** Per-scenario ordinal, where attempt 1 is the earliest recorded run. */
  attemptNumber?: number;
  /** The catalog context captured when this run started, when still available. */
  courseLocation?: CourseLocation | null;
}

export function RunOutcomeToken({
  run,
}: {
  run: Pick<RunListItemData, "active" | "activity" | "outcome">;
}) {
  const activity = run.activity ?? (run.active ? "foreground" : "settled");
  if (activity === "foreground") {
    return <StatusToken tone="live" word="In progress" />;
  }
  if (activity === "background") {
    return <StatusToken tone="pending" word="Finishing" pulse />;
  }
  switch (run.outcome) {
    case "succeeded":
      return <StatusToken tone="success" word="Solved" />;
    case "failed":
      return <StatusToken tone="danger" word="Failed" />;
    case "cancelled":
      return <StatusToken tone="muted" word="Ended early" />;
    default:
      return <StatusToken tone="muted" word="In progress" />;
  }
}

export function runAttemptLabel(attemptNumber?: number): string | null {
  return Number.isInteger(attemptNumber) && (attemptNumber ?? 0) > 0
    ? `Attempt ${attemptNumber}`
    : null;
}

export function runCourseContextLabel(
  location: CourseLocation | null | undefined,
): string | null {
  if (!location) return null;
  if (location.courseKind === "general-practice") {
    return location.courseTitle;
  }
  return `${location.courseTitle} · Step ${location.step} of ${location.steps}`;
}

function runActionContext(run: RunListItemData): string {
  const attempt = runAttemptLabel(run.attemptNumber);
  return attempt ? `${run.title}, ${attempt.toLowerCase()}` : run.title;
}

/** Gives repeated row actions a useful, unique accessible name. */
export function runListItemActionLabel(run: RunListItemData): string {
  const activity = run.activity ?? (run.active ? "foreground" : "settled");
  const target = runActionContext(run);
  if (activity === "foreground") return `Resume ${target}`;
  if (activity === "background") return `View progress for ${target}`;
  if (run.hasReplay) return `Watch replay of ${target}`;
  return `View ${target}`;
}

export function runListItemLinkLabel(run: RunListItemData): string {
  return `View ${runActionContext(run)}`;
}

// The one horizontal run row: status token, title, meta line, trailing action.
export function RunListItem({
  run,
  trailing,
}: {
  run: RunListItemData;
  /** Extra trailing controls (e.g. a delete icon button). */
  trailing?: ReactNode;
}) {
  const activity = run.activity ?? (run.active ? "foreground" : "settled");
  const attemptLabel = runAttemptLabel(run.attemptNumber);
  const courseContext = runCourseContextLabel(run.courseLocation);
  const actionLabel = runListItemActionLabel(run);
  return (
    <article className="flex flex-col gap-3 px-4 py-4 transition-colors sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/runs/$runId"
            params={{ runId: run.runId }}
            aria-label={runListItemLinkLabel(run)}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-balance underline-offset-4 hover:text-brand-text hover:underline"
          >
            {run.title}
          </Link>
          {attemptLabel ? <Badge variant="outline">{attemptLabel}</Badge> : null}
          <RunOutcomeToken run={run} />
          {run.solutionAssisted ? (
            <Badge variant="outline">Solution used</Badge>
          ) : null}
        </div>
        <p className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
          <span>
            Started <RelativeTime at={run.createdAt} />
            <span aria-hidden="true"> · </span>
            <time dateTime={new Date(run.createdAt).toISOString()}>
              {formatTimestamp(run.createdAt)}
            </time>
          </span>
          {courseContext ? <span>{courseContext}</span> : null}
          {run.solveDurationMs !== null ? (
            <span>Solved in {formatDurationMs(run.solveDurationMs)}</span>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-2 self-stretch sm:self-auto">
        <Button
          variant={activity === "foreground" ? "default" : "outline"}
          size="sm"
          className="flex-1 sm:flex-none"
          aria-label={actionLabel}
          render={<Link to="/runs/$runId" params={{ runId: run.runId }} />}
        >
          {activity === "foreground" ? (
            <>
              Resume
              <ArrowRight className="size-3.5" />
            </>
          ) : activity === "background" ? (
            <>
              View progress
              <ArrowRight className="size-3.5" />
            </>
          ) : run.hasReplay ? (
            <>
              <PlayCircle className="size-3.5" />
              Watch replay
            </>
          ) : (
            <>
              View
              <ArrowRight className="size-3.5" />
            </>
          )}
        </Button>
        {trailing}
      </div>
    </article>
  );
}
