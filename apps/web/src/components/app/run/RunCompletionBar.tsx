import { CheckCircle2 } from "lucide-react";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface RunCompletionBarProps {
  canFinish: boolean;
  pending: boolean;
  error: boolean;
  onFinish: () => void;
  /**
   * True only when the run turned solved while the page was open (the Moment
   * Rule). The bar rises 650ms in, after the closing check line, and its check
   * pops 120ms later. A run that loads solved shows the bar still.
   */
  animate?: boolean;
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
  animate = false,
}: RunCompletionBarProps) {
  return (
    <section
      aria-labelledby="run-completion-heading"
      data-run-completion-bar
      className={cn(
        "shrink-0 rounded-xl border border-success-border bg-success-subtle px-4 py-3 shadow-(--shadow-raised) [@media(max-height:500px)]:!px-3 [@media(max-height:500px)]:!py-2",
        animate && "animate-rise [animation-delay:650ms]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <CheckCircle2
            className={cn(
              "size-5 shrink-0 text-success",
              animate && "animate-pop [animation-delay:770ms]",
            )}
            aria-hidden="true"
          />
          <p
            id="run-completion-heading"
            className="text-support font-semibold text-foreground"
          >
            All checks verified
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="success"
          data-run-finish-and-save
          className="w-full sm:w-auto"
          aria-busy={pending || undefined}
          disabled={!canFinish || pending}
          // Keep focus on the button while the save runs, and after it fails.
          focusableWhenDisabled={pending}
          onClick={onFinish}
        >
          <AsyncLabel
            state={pending ? "pending" : "idle"}
            idle="Finish and save"
            pending="Saving your run…"
          />
        </Button>
      </div>
      {!canFinish && !pending ? (
        <InlineFeedback tone="pending" className="mt-2">
          Getting your run ready to save…
        </InlineFeedback>
      ) : null}
      {error ? (
        <p className="mt-2 text-support text-destructive" role="alert">
          Could not save this run. Your work is still open. Try again.
        </p>
      ) : null}
    </section>
  );
}
