import { useState } from "react";
import { Eye, Lightbulb, LockKeyhole } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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

export function HintList(props: {
  hints: ScenarioRunHint[];
  nextHintKey: string | null;
  onReveal: (hintKey: string) => void;
  pendingHintKey: string | null;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-muted-foreground" />
          Hints
        </CardTitle>
        <CardDescription>Hints unlock in order.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        {props.hints.length ? (
          props.hints.map((hint, index) => {
            const canReveal = hint.key === props.nextHintKey;
            return (
              <div key={hint.key} className="rounded-lg border px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {hint.title?.trim() || `Hint ${index + 1}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {hint.scope === "probe" && hint.probeName
                        ? `Probe: ${hint.probeName}`
                        : "Scenario"}
                    </p>
                  </div>
                  {hint.revealed ? (
                    <Badge variant="outline">Shown</Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canReveal || props.pendingHintKey === hint.key}
                      onClick={() => props.onReveal(hint.key)}
                    >
                      {props.pendingHintKey === hint.key ? "Revealing" : "Reveal"}
                    </Button>
                  )}
                </div>
                {hint.bodyMarkdown ? (
                  <Markdown className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
                    {hint.bodyMarkdown}
                  </Markdown>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="border border-dashed border-border/70 px-3 py-6 text-sm text-muted-foreground">
            No hints for this run.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SolutionCard(props: {
  solution: ScenarioRunSolution;
  onReveal: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reveal = () => {
    setConfirmOpen(false);
    props.onReveal();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {props.solution.revealed ? (
            <Eye className="size-4 text-muted-foreground" />
          ) : (
            <LockKeyhole className="size-4 text-muted-foreground" />
          )}
          Solution
        </CardTitle>
        <CardDescription>
          {props.solution.revealed
            ? props.solution.assisted
              ? "Revealed before completion."
              : "Unlocked after completion."
            : props.solution.unlocked
              ? "Available after all objectives pass."
              : "Reveal now or solve first."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        {props.solution.bodyMarkdown ? (
          <Markdown className="space-y-2 text-xs leading-6 text-muted-foreground">
            {props.solution.bodyMarkdown}
          </Markdown>
        ) : props.solution.unlocked ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={props.pending}
            onClick={props.onReveal}
          >
            {props.pending ? "Revealing" : "Show solution"}
          </Button>
        ) : (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={props.pending}
                >
                  {props.pending ? "Revealing" : "Reveal solution"}
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reveal solution?</DialogTitle>
                <DialogDescription>
                  Revealing before the scenario is solved marks this run as assisted.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={reveal}>
                  Reveal
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}
