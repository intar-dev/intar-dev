import type { ReactNode } from "react";
import { ArrowRight, CircleCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDurationMs } from "@/components/app/lib/format";
import { cn } from "@/lib/utils";
import { MetaDifficulty, MetaLine, type ScenarioDifficulty } from "./MetaLine";
import { StatusToken } from "./StatusToken";
import type { CourseLocation, ScenarioProgress } from "@/lib/scenario-runs";
import type { CatalogSearch } from "@/components/app/pages/learn/catalog-search";
import { CourseScenarioLink } from "@/components/app/pages/learn/course-route-links";

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
  headingLevel = 3,
  search,
  sequence,
  courseLocation,
}: {
  scenario: ScenarioCardData;
  footer?: ReactNode;
  className?: string;
  headingLevel?: 3 | 4;
  search?: CatalogSearch | undefined;
  sequence?: {
    position: number;
    total: number;
  } | undefined;
  courseLocation: CourseLocation | null;
}) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <CourseScenarioLink
      location={courseLocation}
      scenarioId={scenario.scenarioId}
      search={search}
      preloadDelay={250}
      className={cn(
        "group flex min-h-56 min-w-0 flex-col gap-6 rounded-xl border bg-card p-4 transition-[background-color,border-color,transform] hover:border-brand-border hover:bg-muted/35 active:translate-y-px motion-reduce:transition-none sm:p-6",
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
        <Heading className="min-w-0 font-heading text-lg font-bold tracking-[-0.02em] [overflow-wrap:anywhere] [text-wrap:wrap] transition-colors group-hover:text-brand-text">
          {scenario.title}
        </Heading>
        <p className="line-clamp-3 text-body text-muted-foreground">
          {scenario.tagline}
        </p>
      </div>
      <MetaLine
        className="mt-auto border-t pt-3"
        items={[
          sequence && `Step ${sequence.position} of ${sequence.total}`,
          <MetaDifficulty key="difficulty" difficulty={scenario.difficulty} />,
          `~${scenario.estimatedMinutes} min`,
          scenario.vmCount === 1 ? "1 VM" : `${scenario.vmCount} VMs`,
        ]}
      />
      {footer}
      <span className="flex items-center gap-2 text-sm font-semibold text-brand-text">
        {scenarioActionLabel(scenario.progress)}
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </span>
    </CourseScenarioLink>
  );
}

function scenarioActionLabel(progress: ScenarioProgress) {
  return progress.status === "completed" ? "Review briefing" : "View briefing";
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
      return <StatusToken tone="live" word="In progress" />;
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
