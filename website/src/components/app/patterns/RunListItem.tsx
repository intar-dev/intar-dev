import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDurationMs } from "../lib/format";
import { RelativeTime } from "./RelativeTime";
import { StatusToken } from "./StatusToken";

export interface RunListItemData {
  runId: string;
  title: string;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  active: boolean;
  createdAt: number;
  solveDurationMs: number | null;
  solutionAssisted?: boolean;
  hasReplay?: boolean;
}

export function RunOutcomeToken({
  run,
}: {
  run: Pick<RunListItemData, "active" | "outcome">;
}) {
  if (run.active) {
    return <StatusToken tone="live" word="In progress" />;
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

// The one horizontal run row: status token, title, meta line, trailing action.
export function RunListItem({
  run,
  trailing,
}: {
  run: RunListItemData;
  /** Extra trailing controls (e.g. a delete icon button). */
  trailing?: ReactNode;
}) {
  return (
    <article className="flex flex-col gap-3 py-4 transition-colors sm:flex-row sm:items-center sm:gap-4 sm:px-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/runs/$runId"
              params={{ runId: run.runId }}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-balance underline-offset-4 hover:text-brand-text hover:underline"
            >
              {run.title}
            </Link>
            <RunOutcomeToken run={run} />
            {run.solutionAssisted ? (
              <Badge variant="outline">Solution used</Badge>
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 font-mono text-xs text-muted-foreground">
            <span>
              Started <RelativeTime at={run.createdAt} />
            </span>
            {run.solveDurationMs !== null ? (
              <span>Solved in {formatDurationMs(run.solveDurationMs)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <Button
            variant={run.active ? "default" : "outline"}
            size="sm"
            className="flex-1 sm:flex-none"
            render={<Link to="/runs/$runId" params={{ runId: run.runId }} />}
          >
            {run.active ? (
              <>
                Resume
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
