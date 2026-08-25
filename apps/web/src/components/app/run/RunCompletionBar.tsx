import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface RunCompletionBarProps {
  canFinish: boolean;
  pending: boolean;
  error: boolean;
  onFinish: () => void;
}

/**
 * The solved action belongs to the workspace, not inside optional guidance.
 * Keep it visible until the run moves into its calm saving state.
 */
export function RunCompletionBar({
  canFinish,
  pending,
  error,
  onFinish,
}: RunCompletionBarProps) {
  return (
    <section
      aria-labelledby="run-completion-heading"
      data-run-completion-bar
      className="shrink-0 rounded-lg border border-success-border bg-success-subtle px-3 py-3 sm:px-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <CheckCircle2
            className="size-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <p
            id="run-completion-heading"
            className="text-sm font-semibold text-foreground"
          >
            All checks verified
          </p>
        </div>
        <Button
          type="button"
          data-run-finish-and-save
          className="w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success sm:w-auto"
          disabled={!canFinish || pending}
          onClick={onFinish}
        >
          {pending ? "Saving your run…" : "Finish and save"}
        </Button>
      </div>
      {!canFinish && !pending ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Getting your run ready to save…
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm leading-6 text-destructive" role="alert">
          We could not save this run. Your work is still open. Try again.
        </p>
      ) : null}
    </section>
  );
}
