import { Fragment, type ReactNode } from "react";
import { BookOpenCheck, CircleCheck, Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScenarioCatalogWireEntry } from "@/lib/scenario-runs";
import {
  courseHeadingId,
  type CourseCatalogDisplayUnit,
  type CourseCatalogSectionView,
} from "./course-catalog";

export function CourseCatalogSections({
  units,
  renderScenario,
  gridClassName = "md:grid-cols-2 xl:grid-cols-3",
}: {
  units: readonly CourseCatalogDisplayUnit[];
  renderScenario: (scenario: ScenarioCatalogWireEntry) => ReactNode;
  gridClassName?: string;
}) {
  const courses = units.filter((unit) => unit.kind === "course");
  const individualScenarios = units.flatMap((unit) =>
    unit.kind === "scenario" ? [unit.scenario] : [],
  );

  return (
    <div className="space-y-10">
      {courses.map((unit) => (
        <CourseSection
          key={unit.key}
          section={unit.section}
          gridClassName={gridClassName}
          renderScenario={renderScenario}
        />
      ))}
      {individualScenarios.length ? (
        <section
          className="space-y-4 border-t-2 border-foreground/10 pt-6"
          aria-labelledby="individual-scenarios-heading"
        >
          <header className="space-y-1">
            <p className="text-eyebrow">Open practice</p>
            <h3
              id="individual-scenarios-heading"
              className="text-section-title"
            >
              Individual scenarios
            </h3>
            <p className="text-sm text-muted-foreground">
              Standalone systems you can tackle in any order.
            </p>
          </header>
          <ScenarioGrid className={gridClassName}>
            {individualScenarios.map((scenario) => (
              <Fragment key={scenario.scenarioId}>
                {renderScenario(scenario)}
              </Fragment>
            ))}
          </ScenarioGrid>
        </section>
      ) : null}
    </div>
  );
}

function CourseSection({
  section,
  gridClassName,
  renderScenario,
}: {
  section: CourseCatalogSectionView;
  gridClassName: string;
  renderScenario: (scenario: ScenarioCatalogWireEntry) => ReactNode;
}) {
  const headingId = courseHeadingId(section.course);
  const scenarioCount = section.accessibleScenarios.length;

  return (
    <section
      className="space-y-5 border-t-2 border-foreground/10 pt-6 first:border-t-0 first:pt-0"
      aria-labelledby={headingId}
      data-course-id={section.course.courseId}
      data-course-scope={section.course.organizationId ?? "public"}
    >
      <header className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-end">
        <div className="min-w-0 space-y-2">
          <p className="text-eyebrow">
            {section.course.organizationId ? "Organization course" : "Course"}
          </p>
          <h3
            id={headingId}
            className="font-heading text-2xl font-bold tracking-[-0.03em] text-balance [overflow-wrap:anywhere]"
          >
            {section.course.title}
          </h3>
          <p className="max-w-3xl text-body text-muted-foreground text-pretty">
            {section.course.description}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-2 border-y py-3 text-sm tabular-nums 2xl:justify-end 2xl:border-y-0 2xl:py-0">
          <CourseMetric
            icon={<BookOpenCheck className="size-4" aria-hidden />}
            label="Scenarios"
            value={`${scenarioCount} ${scenarioCount === 1 ? "scenario" : "scenarios"}`}
          />
          <CourseMetric
            icon={<Clock3 className="size-4" aria-hidden />}
            label="Estimated time"
            value={`~${section.totalEstimatedMinutes} min total`}
          />
          <CourseMetric
            icon={<CircleCheck className="size-4" aria-hidden />}
            label="Solved progress"
            value={`${section.solvedCount} of ${scenarioCount} solved`}
          />
        </dl>
      </header>
      <ScenarioGrid className={gridClassName}>
        {section.visibleScenarios.map((scenario) => (
          <Fragment key={scenario.scenarioId}>
            {renderScenario(scenario)}
          </Fragment>
        ))}
      </ScenarioGrid>
    </section>
  );
}

function CourseMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <dt className="sr-only">{label}</dt>
      <dd className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <span className="text-brand-text">{icon}</span>
        {value}
      </dd>
    </div>
  );
}

function ScenarioGrid({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return <div className={cn("grid gap-4", className)}>{children}</div>;
}
