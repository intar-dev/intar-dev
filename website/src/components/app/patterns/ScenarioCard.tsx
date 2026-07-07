import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Clock3, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { DifficultyChip, MetaChip, type ScenarioDifficulty } from "./MetaChip";

export interface ScenarioCardData {
  scenarioId: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  vmCount: number;
  tags: string[];
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
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DifficultyChip difficulty={scenario.difficulty} />
        <MetaChip icon={<Clock3 />}>~{scenario.estimatedMinutes} min</MetaChip>
        <MetaChip icon={<Server />}>
          {scenario.vmCount === 1 ? "1 machine" : `${scenario.vmCount} machines`}
        </MetaChip>
      </div>
      <div className="space-y-1.5">
        <h3 className="font-heading text-xl font-semibold tracking-tight transition-colors group-hover:text-primary">
          {scenario.title}
        </h3>
        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {scenario.tagline}
        </p>
      </div>
      {scenario.tags.length ? (
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {scenario.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {footer}
    </Link>
  );
}
