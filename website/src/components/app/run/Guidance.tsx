import { useState } from "react";
import { Eye, Lightbulb, LockKeyhole } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ScenarioRunHint, ScenarioRunSolution } from "./run-types";

// Hints unlock in order: revealed hints show their body, the next hint gets
// the reveal button, everything still locked stays a one-line row.
export function HintList(props: {
  hints: ScenarioRunHint[];
  nextHintKey: string | null;
  onReveal: (hintKey: string) => void;
  pendingHintKey: string | null;
  error: string | null;
}) {
  if (!props.hints.length) {
    return null;
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-heading text-base">
          <Lightbulb className="size-4 text-warning" />
          Hints
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.error ? (
          <p className="text-xs text-destructive">{props.error}</p>
        ) : null}
        {props.hints.map((hint, index) => {
          const label = hint.title?.trim() || `Hint ${index + 1}`;

          if (hint.revealed) {
            return (
              <div key={hint.key} className="rounded-lg border px-3 py-3">
                <p className="text-sm font-medium">{label}</p>
                {hint.bodyMarkdown ? (
                  <Markdown className="mt-2 space-y-2 text-xs leading-6 text-muted-foreground">
                    {hint.bodyMarkdown}
                  </Markdown>
                ) : null}
              </div>
            );
          }

          if (hint.key === props.nextHintKey) {
            return (
              <div
                key={hint.key}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
              >
                <p className="min-w-0 truncate text-sm font-medium">{label}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={props.pendingHintKey === hint.key}
                  onClick={() => props.onReveal(hint.key)}
                >
                  {props.pendingHintKey === hint.key ? "Revealing…" : "Reveal"}
                </Button>
              </div>
            );
          }

          return (
            <div
              key={hint.key}
              className="flex items-center gap-2.5 px-3 py-1.5 text-muted-foreground/70"
            >
              <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
              <p className="min-w-0 truncate text-sm">{label}</p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// The solution is deliberately quiet: one text link at the bottom of the
// rail. Revealing before solving marks the run as assisted.
export function SolutionCard(props: {
  solution: ScenarioRunSolution;
  onReveal: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  // Don't pre-open the view dialog here: the reveal mutation can fail, and a
  // latched-open flag would pop the dialog unprompted once a later poll turns
  // `revealed` true. The link switches to "View the solution" on success.
  const reveal = () => {
    setConfirmOpen(false);
    props.onReveal();
  };

  return (
    <div className="space-y-1 px-1">
      {props.error ? (
        <p className="text-xs text-destructive">{props.error}</p>
      ) : null}
      {props.solution.revealed || props.solution.bodyMarkdown ? (
        <Dialog open={viewOpen} onOpenChange={setViewOpen}>
          <DialogTrigger
            render={
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              />
            }
          >
            <Eye className="size-3.5" />
            View the solution
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Solution</DialogTitle>
              <DialogDescription>
                {props.solution.assisted
                  ? "Revealed before completion — this run counts as assisted."
                  : "Unlocked after completion."}
              </DialogDescription>
            </DialogHeader>
            {props.solution.bodyMarkdown ? (
              <Markdown className="max-h-[60vh] space-y-2 overflow-y-auto text-sm leading-6">
                {props.solution.bodyMarkdown}
              </Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">
                {props.pending ? "Loading solution…" : "Solution unavailable."}
              </p>
            )}
          </DialogContent>
        </Dialog>
      ) : props.solution.unlocked ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          disabled={props.pending}
          onClick={reveal}
        >
          <Eye className="size-3.5" />
          {props.pending ? "Loading solution…" : "Show the solution"}
        </button>
      ) : (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger
            render={
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                disabled={props.pending}
              />
            }
          >
            <LockKeyhole className="size-3.5" />
            Stuck? Reveal the full solution
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reveal solution?</DialogTitle>
              <DialogDescription>
                Revealing before the scenario is solved marks this run as
                assisted.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(false)}
              >
                Keep trying
              </Button>
              <Button type="button" onClick={reveal}>
                Reveal
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
