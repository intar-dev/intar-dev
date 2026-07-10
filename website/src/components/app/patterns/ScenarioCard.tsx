import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Clock3, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDurationMs } from "@/components/app/lib/format";
import { cn } from "@/lib/utils";
import type { ScenarioDifficulty } from "./MetaChip";
import type { ScenarioProgress } from "@/lib/scenario-runs";

export interface ScenarioCardData {
  scenarioId: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  vmCount: number;
  tags: string[];
  category: string;
  progress: ScenarioProgress;
}

// The one scenario card: the whole card is the link, chips carry the
// metadata, hover gives a gentle lift. Used by the catalog and any showcase.
export function ScenarioCard({
  scenario,
  footer,
  className,
}: {
  scenario: ScenarioCardData;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to="/scenarios/$scenarioId"
      params={{ scenarioId: scenario.scenarioId }}
      className={cn(
        "group flex min-h-64 min-w-0 flex-col gap-6 rounded-xl border bg-card p-4 transition-[background-color,border-color,transform] hover:border-brand-border hover:bg-muted/35 active:translate-y-px motion-reduce:transition-none sm:p-6",
        scenario.progress.status === "in_progress" && "border-brand-border",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 truncate text-eyebrow">
          {scenario.category || "Scenario"}
        </p>
        <ScenarioStatusBadge progress={scenario.progress} />
      </div>
      <div className="space-y-2">
        <h3 className="min-w-0 font-heading text-xl font-bold tracking-[-0.02em] [overflow-wrap:anywhere] [text-wrap:wrap] transition-colors group-hover:text-brand-text">
          {scenario.title}
        </h3>
        <p className="line-clamp-3 text-body text-muted-foreground">
          {scenario.tagline}
        </p>
      </div>
      <dl className="mt-auto grid min-w-0 grid-cols-3 divide-x border-y py-3 text-sm [&_dd]:[overflow-wrap:anywhere] [&_dt]:[overflow-wrap:anywhere]">
        <div className="min-w-0 pr-3">
          <dt className="text-caption">Difficulty</dt>
          <dd className="mt-1 font-semibold capitalize">{scenario.difficulty}</dd>
        </div>
        <div className="min-w-0 px-3">
          <dt className="inline-flex items-center gap-1 text-caption">
            <Clock3 className="size-3" /> Time
          </dt>
          <dd className="mt-1 font-semibold tabular-nums">
            ~{scenario.estimatedMinutes} min
          </dd>
        </div>
        <div className="min-w-0 pl-3">
          <dt className="inline-flex items-center gap-1 text-caption">
            <Server className="size-3" /> Machines
          </dt>
          <dd className="mt-1 font-semibold tabular-nums">{scenario.vmCount}</dd>
        </div>
      </dl>
      {footer}
    </Link>
  );
}

function ScenarioStatusBadge({ progress }: { progress: ScenarioProgress }) {
  switch (progress.status) {
    case "completed":
      return (
        <Badge
          variant="success"
          className="h-auto max-w-full shrink py-1 whitespace-normal"
        >
          <CircleCheck className="size-3" aria-hidden />
          {progress.bestSolveMs !== null
            ? `Solved · ${formatDurationMs(progress.bestSolveMs)}`
            : "Solved"}
        </Badge>
      );
    case "in_progress":
      return (
        <Badge
          variant="success"
          className="h-auto max-w-full shrink py-1 whitespace-normal"
        >
          <CircleDot className="size-3 motion-safe:animate-pulse" aria-hidden />
          In progress
        </Badge>
      );
    case "attempted":
      return (
        <Badge
          variant="outline"
          className="h-auto max-w-full shrink py-1 whitespace-normal"
        >
          Attempted
        </Badge>
      );
    case "new":
      return null;
  }
}
