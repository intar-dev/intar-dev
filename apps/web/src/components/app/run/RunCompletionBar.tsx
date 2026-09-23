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
      className="shrink-0 rounded-xl border border-success-border bg-success-subtle px-4 py-3 shadow-(--shadow-raised) motion-safe:animate-rise lg:px-5 [@media(max-height:500px)]:!px-3 [@media(max-height:500px)]:!py-2"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <CheckCircle2
            className="size-5 shrink-0 text-success motion-safe:animate-pop [animation-delay:120ms]"
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
          size="sm"
          data-run-finish-and-save
          className="w-full bg-success text-success-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-[color-mix(in_oklch,var(--success),white_12%)] focus-visible:outline-success sm:w-auto"
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
