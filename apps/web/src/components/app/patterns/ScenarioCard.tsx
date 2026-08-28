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
        "group flex min-h-48 min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 transition-[background-color,border-color,transform] hover:border-brand-border hover:bg-muted/35 active:translate-y-px motion-reduce:transition-none sm:p-5",
        scenario.progress.status === "in_progress" && "border-brand-border",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 truncate text-label">
          {scenario.category || "Scenario"}
        </p>
        <ScenarioStatusBadge progress={scenario.progress} />
      </div>
      <div className="space-y-2">
        <Heading className="min-w-0 text-section-title [overflow-wrap:anywhere] [text-wrap:wrap] transition-colors group-hover:text-brand-text">
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

/**
 * The focused course view uses a curriculum list instead of repeating the
 * full catalog card for every step. It deliberately keeps only the decision
 * data a learner needs: where they are, the cost of the step, and what to do.
 */
export function CourseCurriculumItem({
  scenario,
  className,
  headingLevel = 4,
  search,
  sequence,
  courseLocation,
  isNext = false,
  sourceLabel,
}: {
  scenario: ScenarioCardData;
  className?: string;
  headingLevel?: 3 | 4;
  search?: CatalogSearch | undefined;
  sequence?: {
    position: number;
    total: number;
  } | undefined;
  courseLocation: CourseLocation | null;
  isNext?: boolean | undefined;
  sourceLabel?: string | undefined;
}) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  const action = curriculumActionLabel(scenario.progress);

  return (
    <CourseScenarioLink
      location={courseLocation}
      scenarioId={scenario.scenarioId}
      search={search}
      preloadDelay={250}
      className={cn(
        "group grid min-h-20 min-w-0 items-start gap-x-3 gap-y-2 px-4 py-4 outline-none transition-colors hover:bg-muted/55 focus-visible:bg-muted/55 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/40 sm:items-center sm:gap-x-4 sm:px-6",
        sequence
          ? "grid-cols-[2.5rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]"
          : "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]",
        isNext && "bg-brand-subtle/70 ring-1 ring-inset ring-brand-border",
        className,
      )}
    >
      {sequence ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-10 self-center items-center justify-center rounded-lg bg-secondary font-mono text-sm font-semibold tabular-nums text-secondary-foreground",
            isNext && "bg-brand-text text-primary-foreground",
          )}
        >
          {sequence.position}
        </span>
      ) : null}
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {isNext ? (
            <span className="text-label text-brand-text">Next step</span>
          ) : null}
          <Heading className="min-w-0 text-card-title [overflow-wrap:anywhere] transition-colors group-hover:text-brand-text sm:text-section-title">
            {scenario.title}
          </Heading>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <CurriculumStatus progress={scenario.progress} />
          <MetaLine
            items={[
              sequence && `Step ${sequence.position} of ${sequence.total}`,
              sourceLabel,
              <MetaDifficulty key="difficulty" difficulty={scenario.difficulty} />,
              `~${scenario.estimatedMinutes} min`,
            ]}
            className="text-xs"
          />
        </div>
      </div>
      <div
        className={cn(
          "flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-text sm:row-start-1 sm:self-center",
          sequence
            ? "col-start-2 sm:col-start-3"
            : "col-start-1 sm:col-start-2",
        )}
      >
        <span className="sr-only">
          {isNext ? "Next course step: " : ""}
        </span>
        {action}
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          aria-hidden
        />
      </div>
    </CourseScenarioLink>
  );
}

function scenarioActionLabel(progress: ScenarioProgress) {
  return progress.status === "completed" ? "Review briefing" : "View briefing";
}

function curriculumActionLabel(progress: ScenarioProgress) {
  switch (progress.status) {
    case "completed":
      return "Review";
    case "in_progress":
      return "Continue";
    case "attempted":
      return "Try again";
    case "new":
      return "Start";
  }
}

function CurriculumStatus({ progress }: { progress: ScenarioProgress }) {
  switch (progress.status) {
    case "completed":
      return <StatusToken tone="success" word="Solved" />;
    case "in_progress":
      return <StatusToken tone="live" word="In progress" />;
    case "attempted":
      return <StatusToken tone="pending" word="Attempted" />;
    case "new":
      return <StatusToken tone="muted" word="Ready" />;
  }
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
