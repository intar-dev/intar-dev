import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Clock3, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDurationMs } from "@/components/app/lib/format";
import { cn } from "@/lib/utils";
import { DifficultyChip, MetaChip, type ScenarioDifficulty } from "./MetaChip";
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
        "group flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
        scenario.progress.status === "in_progress" && "border-primary/30",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 truncate text-eyebrow">
          {scenario.category || "Scenario"}
        </p>
        <ScenarioStatusBadge progress={scenario.progress} />
      </div>
      <div className="space-y-1.5">
        <h3 className="font-heading text-xl font-semibold tracking-tight transition-colors group-hover:text-primary">
          {scenario.title}
        </h3>
        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {scenario.tagline}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <DifficultyChip difficulty={scenario.difficulty} />
        <MetaChip icon={<Clock3 />}>~{scenario.estimatedMinutes} min</MetaChip>
        <MetaChip icon={<Server />}>
          {scenario.vmCount === 1 ? "1 machine" : `${scenario.vmCount} machines`}
        </MetaChip>
      </div>
      {footer}
    </Link>
  );
}

function ScenarioStatusBadge({ progress }: { progress: ScenarioProgress }) {
  switch (progress.status) {
    case "completed":
      return (
        <Badge variant="success">
          <CircleCheck className="size-3" aria-hidden />
          {progress.bestSolveMs !== null
            ? `Solved · ${formatDurationMs(progress.bestSolveMs)}`
            : "Solved"}
        </Badge>
      );
    case "in_progress":
      return (
        <Badge variant="success">
          <CircleDot className="size-3 motion-safe:animate-pulse" aria-hidden />
          In progress
        </Badge>
      );
    case "attempted":
      return <Badge variant="outline">Attempted</Badge>;
    case "new":
      return null;
  }
}
