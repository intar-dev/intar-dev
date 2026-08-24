import { useMemo, useState } from "react";
import { Eye, LifeBuoy, LockKeyhole } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { repairObjectiveTitle } from "@/lib/verification-copy";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type {
  ScenarioObjective,
  ScenarioRunHint,
  ScenarioRunSolution,
} from "./run-types";

interface HintGroup {
  key: string;
  label: string;
  hints: ScenarioRunHint[];
}

// Group hints into their ladders: scenario-scoped guidance first, then one
// ladder per objective in objective order.
function groupHints(
  hints: ScenarioRunHint[],
  objectives: ScenarioObjective[],
): HintGroup[] {
  const groups: HintGroup[] = [];
  const scenarioHints = hints.filter((hint) => hint.scope === "scenario");
  if (scenarioHints.length) {
    groups.push({
      key: "scenario",
      label: "General guidance",
      hints: scenarioHints,
    });
  }

  const byProbe = new Map<string, ScenarioRunHint[]>();
  for (const hint of hints) {
    if (hint.scope !== "probe" || !hint.probeName) {
      continue;
    }
    const group = byProbe.get(hint.probeName) ?? [];
    group.push(hint);
    byProbe.set(hint.probeName, group);
  }

  const orderedProbeNames = [
    ...objectives
      .map((objective) => objective.probeName)
      .filter((probeName) => byProbe.has(probeName)),
    ...[...byProbe.keys()].filter(
      (probeName) =>
        !objectives.some((objective) => objective.probeName === probeName),
    ),
  ];
  for (const [groupIndex, probeName] of [
    ...new Set(orderedProbeNames),
  ].entries()) {
    const objectiveIndex = objectives.findIndex(
      (candidate) => candidate.probeName === probeName,
    );
    const objective =
      objectiveIndex >= 0 ? objectives[objectiveIndex] : undefined;
    groups.push({
      key: `probe:${probeName}`,
      label:
        objectiveIndex >= 0
          ? repairObjectiveTitle(objective, objectiveIndex)
          : `Repair guidance ${groupIndex + 1}`,
      hints: byProbe.get(probeName) ?? [],
    });
  }

  return groups;
}

// Collapsed-by-default assist drawer: per-objective hint ladders (sealed
// hints leak nothing) with the solution reveal as its quiet footer.
export function AssistDrawer(props: {
  hints: ScenarioRunHint[];
  objectives: ScenarioObjective[];
  solution: ScenarioRunSolution;
  onRevealHint: (hintKey: string) => void;
  pendingHintKey: string | null;
  hintError: string | null;
  onRevealSolution: () => void;
  solutionPending: boolean;
  solutionError: string | null;
}) {
  const groups = useMemo(
    () => groupHints(props.hints, props.objectives),
    [props.hints, props.objectives],
  );
  const revealedCount = props.hints.filter((hint) => hint.revealed).length;

  return (
    <section aria-label="Assist">
      <DisclosureRow
        leading={
          <LifeBuoy
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        }
        title="Assist"
        meta={
          props.hints.length
            ? `${revealedCount}/${props.hints.length}`
            : undefined
        }
        contentClassName="space-y-6"
      >
        {props.hintError ? (
          <p className="text-xs text-destructive">{props.hintError}</p>
        ) : null}
        {groups.map((group) => (
          <HintLadder
            key={group.key}
            group={group}
            onReveal={props.onRevealHint}
            pendingHintKey={props.pendingHintKey}
          />
        ))}
        {!props.hints.length ? (
          <p className="text-sm text-muted-foreground">
            This scenario ships no hints. The machine itself is the
            documentation.
          </p>
        ) : null}
        <SolutionFooter
          solution={props.solution}
          onReveal={props.onRevealSolution}
          pending={props.solutionPending}
          error={props.solutionError}
        />
      </DisclosureRow>
    </section>
  );
}

function HintLadder(props: {
  group: HintGroup;
  onReveal: (hintKey: string) => void;
  pendingHintKey: string | null;
}) {
  if (!props.group.hints.length) {
    return null;
  }
  const revealed = props.group.hints.filter((hint) => hint.revealed).length;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-eyebrow">{props.group.label}</p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {revealed}/{props.group.hints.length}
        </span>
      </div>
      {props.group.hints.map((hint, index) => {
        const ordinal = `Hint ${index + 1}`;

        if (hint.revealed) {
          return (
            <div key={hint.key} className="rounded-lg border px-3 py-3">
              <p className="text-sm font-medium">
                {hint.title?.trim() || ordinal}
              </p>
              {hint.bodyMarkdown ? (
                <Markdown className="mt-2 space-y-2 text-xs leading-6 text-muted-foreground">
                  {hint.bodyMarkdown}
                </Markdown>
              ) : null}
            </div>
          );
        }

        if (hint.unlocked) {
          return (
            <div
              key={hint.key}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            >
              {/* Sealed hints carry no title — nothing to spoil. */}
              <p className="min-w-0 truncate text-sm font-medium">{ordinal}</p>
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
            className="flex items-center gap-2.5 px-3 py-1.5 text-muted-foreground"
          >
            <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 truncate text-sm">{ordinal}</p>
          </div>
        );
      })}
    </div>
  );
}

// The solution is a different ceremony from hints: an explicit consent gate
// (revealing pre-solve marks the run assisted), styled as a warning, never
// as failure — assisted runs are how people learn.
function SolutionFooter(props: {
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
    <div className="space-y-1 border-t pt-4">
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
                This shows the full fix and marks the run as assisted. Your
                probes and your time stay — only the badge changes.
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
