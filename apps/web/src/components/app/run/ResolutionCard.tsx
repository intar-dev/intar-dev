import { CheckCircle2, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatScenarioDurationMs } from "./run-support";

// Replaces the repair rail once every check passes. This stays deliberately
// flat: resolution needs one clear record and one clear next action.
export function ResolutionCard(props: {
  scenarioTitle: string;
  solveDurationMs: number | null;
  assisted: boolean;
  pending: boolean;
  onEndScenario: () => void;
}) {
  return (
    <section
      aria-labelledby="run-resolution-heading"
      className="space-y-4 motion-safe:animate-in motion-safe:fade-in"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-eyebrow text-success">Resolved</p>
          <h2
            id="run-resolution-heading"
            className="mt-1 font-heading text-base font-semibold"
          >
            {props.scenarioTitle}
          </h2>
        </div>
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {props.assisted ? "Solved with assistance" : "Solved"}
        </p>
      </div>
      {props.solveDurationMs !== null ? (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 className="size-3.5" aria-hidden="true" />
          <span className="font-mono tabular-nums">
            {formatScenarioDurationMs(props.solveDurationMs)}
          </span>
        </p>
      ) : null}
      <p className="max-w-[68ch] text-sm leading-6 text-muted-foreground">
        All objectives are verified. Finish the run to save your replay.
      </p>
      <Button
        className="w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success"
        onClick={props.onEndScenario}
        disabled={props.pending}
      >
        <CheckCircle2 className="size-4" />
        {props.pending ? "Finishing run…" : "Finish run"}
      </Button>
    </section>
  );
}
