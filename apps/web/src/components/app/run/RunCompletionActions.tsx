import { ArrowLeft, ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  CourseCatalogLink,
  CourseScenarioLink,
} from "@/components/app/pages/learn/course-route-links";
import type {
  CourseLocation,
  ScenarioCatalogWireEntry,
} from "@/lib/scenario-runs";

/** A quiet, course-aware exit from a saved run. */
export function RunCompletionActions({
  courseLocation,
  nextScenario,
}: {
  courseLocation: CourseLocation | null | undefined;
  nextScenario: ScenarioCatalogWireEntry | null;
}) {
  return (
    <section
      aria-labelledby="course-next-steps-heading"
      className="border-y border-primary/20 bg-muted/35 px-4 py-4 sm:px-5"
    >
      <p className="text-eyebrow">Course</p>
      <h2
        id="course-next-steps-heading"
        className="mt-1 font-heading text-lg font-semibold tracking-tight"
      >
        Continue learning
      </h2>
      <p className="mt-1 max-w-[62ch] text-sm leading-5 text-muted-foreground">
        {!courseLocation
          ? "Your run is saved. Return to My runs to review your work."
          : nextScenario
          ? "Your run is saved. Return to the course or continue with the next lab."
          : "Your run is saved. Return to the course to choose what to practice next."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {courseLocation ? (
          <CourseCatalogLink
            location={courseLocation}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back to {courseLocation.courseTitle}
          </CourseCatalogLink>
        ) : (
          <Link
            to="/runs"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back to My runs
          </Link>
        )}
        {courseLocation && nextScenario ? (
          <CourseScenarioLink
            location={courseLocation}
            scenarioId={nextScenario.scenarioId}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-brand-text focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            Next: {nextScenario.title}
            <ArrowRight className="size-4" aria-hidden />
          </CourseScenarioLink>
        ) : null}
      </div>
    </section>
  );
}
