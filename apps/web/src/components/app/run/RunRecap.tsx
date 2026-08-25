import {
  type ReactNode,
  type Ref,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  PlayCircle,
} from "lucide-react";
import { AsciicastReplaySurface } from "@/components/app/RunArtifactViewer";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import {
  CourseCatalogLink,
  CourseScenarioLink,
} from "@/components/app/pages/learn/course-route-links";
import { scenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import type {
  CourseLocation,
  ScenarioCatalogWireEntry,
} from "@/lib/scenario-runs";
import { cn } from "@/lib/utils";
import { formatScenarioDurationMs } from "./run-support";
import {
  getRunRecapObjectives,
  getRunRecapState,
  getRunReplayAvailability,
  getRunReplayParts,
  type RunRecapObjective,
  type RunReplayPart,
} from "./run-recap-model";
import type { ScenarioRunRecord } from "./run-types";
import { useStreamedText } from "./useStreamedText";

export interface RunRecapProps {
  run: ScenarioRunRecord;
  /** The saved course context builds the one learner-safe next step. */
  courseLocation?: CourseLocation | null | undefined;
  /** The next current-course lab, when the catalog can prove one exists. */
  nextScenario?: ScenarioCatalogWireEntry | null | undefined;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Optional override for embedding the recap in another learner flow. */
  nextAction?: ReactNode;
}

/**
 * A saved run is a short learning recap, not an operations timeline. All
 * technical run state stays outside this component.
 */
export function RunRecap({
  run,
  courseLocation = run.courseLocation,
  nextScenario = null,
  headingRef,
  nextAction,
}: RunRecapProps) {
  const recap = getRunRecapState(run);

  if (recap.kind === "saving") {
    return (
      <section
        aria-labelledby="run-recap-heading"
        className="mx-auto w-full max-w-2xl py-10 sm:py-14"
      >
        <p className="text-eyebrow">Lab run</p>
        <h2
          id="run-recap-heading"
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-heading text-3xl font-semibold tracking-tight outline-none sm:text-4xl"
        >
          {recap.title}
        </h2>
        <p className="mt-3 max-w-[46ch] text-sm leading-6 text-muted-foreground">
          {recap.description}
        </p>
      </section>
    );
  }

  const objectives = getRunRecapObjectives(run);
  const verifiedObjectives = objectives.filter(
    (objective) => objective.status === "verified",
  ).length;
  const revealedHints = run.hints.filter((hint) => hint.revealed).length;
  const solutionUsed = run.solution.assisted || run.solution.revealed;

  return (
    <section
      aria-labelledby="run-recap-heading"
      className="mx-auto w-full max-w-3xl space-y-8 py-5 sm:py-8"
    >
      <header className="border-b border-primary/15 pb-6">
        <p className="text-eyebrow">Lab recap</p>
        <h2
          id="run-recap-heading"
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-heading text-3xl font-semibold tracking-tight outline-none sm:text-4xl"
        >
          {recap.title}
        </h2>
        <p className="mt-2 max-w-[54ch] text-sm leading-6 text-muted-foreground">
          {recap.description}
        </p>
      </header>

      {objectives.length ? (
        <section aria-labelledby="run-recap-checks-heading">
          <div className="flex items-baseline justify-between gap-4">
            <h2
              id="run-recap-checks-heading"
              className="font-heading text-lg font-semibold tracking-tight"
            >
              Final checks
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {verifiedObjectives}/{objectives.length} verified
            </span>
          </div>
          <RunRecapProgress
            objectives={objectives}
            verifiedObjectives={verifiedObjectives}
          />
          <ol className="mt-3 divide-y border-y">
            {objectives.map((objective) => (
              <li
                key={objective.key}
                className="grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 py-3"
              >
                {objective.status === "verified" ? (
                  <CheckCircle2
                    className="size-4 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleAlert
                    className="size-4 text-destructive"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 text-sm font-medium">
                  {objective.title}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium whitespace-nowrap",
                    objective.status === "verified"
                      ? "text-success"
                      : "text-destructive",
                  )}
                >
                  {objective.status === "verified"
                    ? "Verified"
                    : "Needs repair"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-label="Learning summary" className="border-y py-4">
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
          {recap.kind === "solved" && run.solveDurationMs !== null ? (
            <div>
              <dt className="inline-flex items-center gap-2 text-caption">
                <Clock3 className="size-4" aria-hidden="true" />
                Solve time
              </dt>
              <dd className="font-medium tabular-nums">
                {formatScenarioDurationMs(run.solveDurationMs)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-caption">Hints used</dt>
            <dd className="font-medium">
              {revealedHints === 1 ? "1 hint" : `${revealedHints} hints`}
            </dd>
          </div>
          <div>
            <dt className="text-caption">Full solution</dt>
            <dd className="font-medium">
              {solutionUsed ? "Used" : "Not used"}
            </dd>
          </div>
        </dl>
      </section>

      <RunReplaySection run={run} />

      <section aria-labelledby="run-recap-next-heading" className="pt-1">
        <p className="text-eyebrow">What next?</p>
        <h2
          id="run-recap-next-heading"
          className="mt-1 font-heading text-xl font-semibold tracking-tight"
        >
          {recap.kind === "solved" ? "Keep learning" : "Give it another try"}
        </h2>
        <div className="mt-4">
          {nextAction ?? (
            <DefaultNextAction
              run={run}
              recapKind={recap.kind}
              courseLocation={courseLocation}
              nextScenario={nextScenario}
            />
          )}
        </div>
      </section>
    </section>
  );
}

function RunRecapProgress({
  objectives,
  verifiedObjectives,
}: {
  objectives: readonly RunRecapObjective[];
  verifiedObjectives: number;
}) {
  return (
    <div
      role="progressbar"
      aria-label="Final checks progress"
      aria-valuemin={0}
      aria-valuemax={objectives.length}
      aria-valuenow={verifiedObjectives}
      aria-valuetext={`${verifiedObjectives} of ${objectives.length} final checks verified`}
      data-run-recap-progress
      className="mt-4 flex flex-wrap gap-2"
    >
      {objectives.map((objective) => (
        <span
          key={objective.key}
          aria-hidden="true"
          data-run-recap-progress-segment
          data-status={objective.status}
          className={cn(
            "size-3 rounded-full border",
            objective.status === "verified"
              ? "border-success bg-success"
              : "border-destructive bg-transparent",
          )}
        />
      ))}
    </div>
  );
}

function DefaultNextAction({
  run,
  recapKind,
  courseLocation,
  nextScenario,
}: {
  run: ScenarioRunRecord;
  recapKind: Exclude<ReturnType<typeof getRunRecapState>["kind"], "saving">;
  courseLocation: CourseLocation | null | undefined;
  nextScenario: ScenarioCatalogWireEntry | null | undefined;
}) {
  const linkClassName =
    "inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-brand-text focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40";

  if (recapKind === "solved" && courseLocation && nextScenario) {
    return (
      <CourseScenarioLink
        location={courseLocation}
        scenarioId={nextScenario.scenarioId}
        className={linkClassName}
      >
        Next lab: {nextScenario.title}
        <ArrowRight className="size-4" aria-hidden="true" />
      </CourseScenarioLink>
    );
  }

  if (recapKind === "solved" && courseLocation) {
    return (
      <CourseCatalogLink location={courseLocation} className={linkClassName}>
        Back to {courseLocation.courseTitle}
        <ArrowLeft className="size-4" aria-hidden="true" />
      </CourseCatalogLink>
    );
  }

  if (recapKind !== "solved" && courseLocation) {
    return (
      <CourseScenarioLink
        location={courseLocation}
        scenarioId={run.scenarioId}
        className={linkClassName}
      >
        Try this lab again
        <ArrowRight className="size-4" aria-hidden="true" />
      </CourseScenarioLink>
    );
  }

  return (
    <Link to={recapKind === "solved" ? "/runs" : "/courses"} className={linkClassName}>
      {recapKind === "solved" ? "Back to My runs" : "Choose a lab"}
      {recapKind === "solved" ? (
        <ArrowLeft className="size-4" aria-hidden="true" />
      ) : (
        <ArrowRight className="size-4" aria-hidden="true" />
      )}
    </Link>
  );
}

function RunReplaySection({ run }: { run: ScenarioRunRecord }) {
  const parts = useMemo(() => getRunReplayParts(run), [run]);
  const availability = getRunReplayAvailability(run, parts);

  if (availability === "none") {
    return null;
  }

  if (availability === "pending") {
    return (
      <section aria-labelledby="run-recap-replay-heading" className="border-y py-4">
        <div className="flex items-center gap-2">
          <PlayCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2
            id="run-recap-replay-heading"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            Watch replay
          </h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground" role="status">
          Your replay is being prepared.
        </p>
      </section>
    );
  }

  if (availability === "unavailable") {
    return (
      <section aria-labelledby="run-recap-replay-heading" className="border-y py-4">
        <div className="flex items-center gap-2">
          <PlayCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2
            id="run-recap-replay-heading"
            className="font-heading text-lg font-semibold tracking-tight"
          >
            Watch replay
          </h2>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Replay unavailable.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="run-recap-replay-heading" className="border-y py-2">
      <DisclosureRow
        title={
          <span className="flex items-center gap-2">
            <PlayCircle className="size-4 text-muted-foreground" aria-hidden="true" />
            <span id="run-recap-replay-heading">Watch replay</span>
          </span>
        }
        density="comfortable"
        contentClassName="pb-4"
      >
        <ReplayViewer runId={run.id} parts={parts} />
      </DisclosureRow>
    </section>
  );
}

function ReplayViewer({
  runId,
  parts,
}: {
  runId: string;
  parts: RunReplayPart[];
}) {
  const firstPart = parts.find((part) => part.castArtifactId) ?? parts[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    firstPart?.key ?? null,
  );
  const selected =
    parts.find((part) => part.key === selectedKey) ?? firstPart;

  useEffect(() => {
    if (selectedKey && parts.some((part) => part.key === selectedKey)) {
      return;
    }
    setSelectedKey(firstPart?.key ?? null);
  }, [firstPart?.key, parts, selectedKey]);

  const contentUrl = selected?.castArtifactId
    ? scenarioRunArtifactContentPath(runId, selected.castArtifactId)
    : null;
  const replay = useStreamedText(contentUrl, Boolean(contentUrl));

  return (
    <div className="space-y-3">
      {parts.length > 1 ? (
        <div className="flex flex-wrap gap-2" aria-label="Replay parts">
          {parts.map((part) => (
            <button
              key={part.key}
              type="button"
              className={cn(
                "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                selected?.key === part.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted",
              )}
              aria-pressed={selected?.key === part.key}
              onClick={() => setSelectedKey(part.key)}
            >
              {part.machineLabel ? `${part.machineLabel} · ` : ""}
              {part.partLabel}
            </button>
          ))}
        </div>
      ) : null}

      {!selected?.castArtifactId ? (
        <p className="text-sm text-muted-foreground" role="status">
          Replay unavailable.
        </p>
      ) : replay.error ? (
        <p className="text-sm text-muted-foreground" role="status">
          Replay could not be loaded. Try again soon.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border bg-terminal-background">
          <AsciicastReplaySurface
            key={selected.castArtifactId}
            contentId={selected.castArtifactId}
            content={replay.content}
            loading={replay.loading}
            minimal
          />
        </div>
      )}
    </div>
  );
}
