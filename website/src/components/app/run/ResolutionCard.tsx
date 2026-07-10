import { CheckCircle2, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { firstPassTimes, useProbeSnapshots } from "./probe-pass-times";
import { formatScenarioDurationMs } from "./run-support";
import type { ScenarioObjective, ScenarioRunHint } from "./run-types";

// Replaces the rail once every check passes. The celebration lives in the
// chrome — the terminal stays interactive; people like to poke around after
// fixing things, and that exploration is learning.
export function ResolutionCard(props: {
  runId: string;
  scenarioName: string;
  createdAt: number;
  solveDurationMs: number | null;
  hints: ScenarioRunHint[];
  objectives: ScenarioObjective[];
  assisted: boolean;
  pending: boolean;
  onEndScenario: () => void;
}) {
  const snapshots = useProbeSnapshots(props.runId);
  const passTimes = firstPassTimes(snapshots.data?.snapshots ?? []);
  const hintsUsed = props.hints.filter((hint) => hint.revealed).length;

  return (
    <Card
      size="sm"
      className="border-success-border bg-success-subtle motion-safe:animate-in motion-safe:fade-in"
    >
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="font-heading text-base">
            Incident resolved
          </CardTitle>
          <Badge variant="success">
            <CheckCircle2 className="size-3.5" />
            {props.assisted ? "Solved · assisted" : "Solved"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {props.solveDurationMs !== null ? (
            <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
              <Clock3 className="size-3.5" />
              {formatScenarioDurationMs(props.solveDurationMs)}
            </span>
          ) : null}
          <span className="tabular-nums">
            {hintsUsed === 0
              ? "no hints"
              : hintsUsed === 1
                ? "1 hint"
                : `${hintsUsed} hints`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.objectives.length ? (
          <ol className="space-y-1.5">
            {props.objectives.map((objective) => {
              const passedAt = passTimes.get(objective.probeName) ?? null;
              const sinceStartMs =
                passedAt !== null ? passedAt - props.createdAt : null;
              return (
                <li
                  key={objective.probeName}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="inline-flex min-w-0 items-baseline gap-2">
                    <CheckCircle2
                      className="size-3.5 shrink-0 self-center text-success"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">
                      {objective.title?.trim() || objective.label}
                    </span>
                  </span>
                  {sinceStartMs !== null && sinceStartMs >= 0 ? (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      +{formatScenarioDurationMs(sinceStartMs)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">
            All scenario checks are complete.
          </p>
        )}
        <p className="text-sm leading-6 text-muted-foreground">
          You fixed {props.scenarioName}. The shell stays open if you want to
          look around — end the run to save your replay.
        </p>
        <Button
          className="w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success"
          onClick={props.onEndScenario}
          disabled={props.pending}
        >
          <CheckCircle2 className="size-4" />
          {props.pending ? "Ending run…" : "End run"}
        </Button>
      </CardContent>
    </Card>
  );
}
