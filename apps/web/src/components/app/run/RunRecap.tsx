import {
  lazy,
  Suspense,
  type ReactNode,
  type Ref,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  PlayCircle,
} from "lucide-react";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { ScenarioStepScreen } from "@/components/app/run/StatusScreens";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  CourseLink,
  LectureLink,
} from "@/components/app/pages/learn/course-links";
import {
  courseRouteForRun,
  type CourseLectureSummary,
} from "@/components/app/pages/learn/course-wire";
import { scenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import type {
  CourseLocation,
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
import type { ScenarioRunRecord, ScenarioStatusStep } from "./run-types";
import { MAX_INLINE_REPLAY_BYTES, useStreamedText } from "./useStreamedText";

const LazyAsciicastReplaySurface = lazy(() =>
  import("@/components/app/RunArtifactViewer").then(
    ({ AsciicastReplaySurface }) => ({ default: AsciicastReplaySurface }),
  ),
);

export interface RunRecapProps {
  run: ScenarioRunRecord;
  /** The saved course context builds the one learner-safe next step. */
  courseLocation?: CourseLocation | null | undefined;
  /** The next current-course lecture, when the catalog can prove one exists. */
  nextLecture?: CourseLectureSummary | null | undefined;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  /** Optional override for embedding the recap in another learner flow. */
  nextAction?: ReactNode;
}

type RunSavingStage = NonNullable<ScenarioRunRecord["savingStage"]>;
export const RUN_SAVING_STALLED_DELAY_MS = 30_000;

export const RUN_SAVING_STEPS = [
  {
    stage: "save_requested",
    label: "Save requested",
    detail: "Your run is queued to be saved.",
  },
  {
    stage: "closing_workspace",
    label: "Closing workspace",
    detail: "Closing your workspace safely.",
  },
  {
    stage: "saving_files",
    label: "Saving files",
    detail: "Saving the files from your workspace.",
  },
  {
    stage: "preparing_replay",
    label: "Preparing replay",
    detail: "Preparing your terminal replay.",
  },
  {
    stage: "finalizing_recap",
    label: "Finalizing recap",
    detail: "Putting your learning recap together.",
  },
] as const satisfies readonly {
  stage: RunSavingStage;
  label: string;
  detail: string;
}[];

type RunSavingStepState = "done" | "active" | "up_next";

export function getRunSavingStage(
  run: Pick<ScenarioRunRecord, "phase" | "savingStage">,
): RunSavingStage {
  if (run.savingStage) return run.savingStage;

  // Older agents do not send detailed archive milestones. Keep their fallback
  // deliberately coarse rather than implying later work has completed.
  if (run.phase === "deleting" || run.phase === "archiving") {
    return "closing_workspace";
  }

  return "save_requested";
}

export function getRunSavingStepState(
  stage: RunSavingStage | string,
  step: RunSavingStage,
): RunSavingStepState {
  const matchedIndex = RUN_SAVING_STEPS.findIndex(
    (candidate) => candidate.stage === stage,
  );
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const stepIndex = RUN_SAVING_STEPS.findIndex(
    (candidate) => candidate.stage === step,
  );
  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";
  return "up_next";
}

export function getRunSavingAnnouncement(stage: RunSavingStage | string) {
  const matchedIndex = RUN_SAVING_STEPS.findIndex(
    (candidate) => candidate.stage === stage,
  );
  const activeIndex = matchedIndex >= 0 ? matchedIndex : 0;
  const activeStep = RUN_SAVING_STEPS[activeIndex] ?? RUN_SAVING_STEPS[0];
  return `Stage ${activeIndex + 1} of ${RUN_SAVING_STEPS.length}: ${activeStep.label}. In progress.`;
}

/**
 * A saved run is a short learning recap, not an operations timeline. All
 * technical run state stays outside this component.
 */
export function RunRecap({
  run,
  courseLocation = run.courseLocation,
  nextLecture = null,
  headingRef,
  nextAction,
}: RunRecapProps) {
  const recap = getRunRecapState(run);

  if (recap.kind === "saving") {
    return (
      <section
        aria-labelledby="run-recap-heading"
        className="flex w-full flex-1 flex-col justify-center py-4 sm:py-6"
      >
        <RunSavingProgress
          stage={getRunSavingStage(run)}
          title={recap.title}
          description={recap.description}
          headingRef={headingRef}
        />
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
      className="w-full space-y-6 py-6 md:space-y-8 md:py-8"
    >
      <header className="border-b border-primary/15 pb-6">
        <h2
          id="run-recap-heading"
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 text-feature-title outline-none"
        >
          {recap.title}
        </h2>
        <p className="mt-2 max-w-[54ch] text-support text-muted-foreground">
          {recap.description}
        </p>
      </header>

      {objectives.length ? (
        <section aria-labelledby="run-recap-checks-heading">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="run-recap-checks-heading" className="text-section-title">
              Final checks
            </h2>
            <span className="text-caption tabular-nums">
              {verifiedObjectives}/{objectives.length} verified
            </span>
          </div>
          <RunRecapProgress
            objectives={objectives}
            verifiedObjectives={verifiedObjectives}
          />
          <ol className="mt-4 divide-y">
            {objectives.map((objective) => (
              <li
                key={objective.key}
                className="grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-3 py-4"
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
                <span className="min-w-0 text-support font-medium">
                  {objective.title}
                </span>
                <span
                  className={cn(
                    "text-support font-medium whitespace-nowrap",
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

      <section aria-label="Learning summary">
        <dl className="grid gap-x-8 gap-y-4 text-support sm:grid-cols-3">
          {recap.kind === "solved" && run.solveDurationMs !== null ? (
            <div>
              <dt className="inline-flex items-center gap-2 text-caption">
                <Clock3 className="size-4" aria-hidden="true" />
                Solve time
              </dt>
              <dd className="mt-1 font-medium tabular-nums">
                {formatScenarioDurationMs(run.solveDurationMs)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-caption">Hints used</dt>
            <dd className="mt-1 font-medium">
              {revealedHints === 1 ? "1 hint" : `${revealedHints} hints`}
            </dd>
          </div>
          <div>
            <dt className="text-caption">Full solution</dt>
            <dd className="mt-1 font-medium">
              {solutionUsed ? "Used" : "Not used"}
            </dd>
          </div>
        </dl>
      </section>

      <RunReplaySection run={run} />

      <section aria-labelledby="run-recap-next-heading">
        <h2 id="run-recap-next-heading" className="text-section-title">
          {recap.kind === "solved" ? "Keep learning" : "Give it another try"}
        </h2>
        <div className="mt-4">
          {nextAction ?? (
            <DefaultNextAction
              recapKind={recap.kind}
              courseLocation={courseLocation}
              nextLecture={nextLecture}
            />
          )}
        </div>
      </section>
    </section>
  );
}

function RunSavingProgress({
  stage,
  title,
  description,
  headingRef,
}: {
  stage: RunSavingStage;
  title: string;
  description: string;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const previousStageRef = useRef(stage);
  const [announcement, setAnnouncement] = useState(() =>
    getRunSavingAnnouncement(stage),
  );
  const [isStalled, setIsStalled] = useState(false);

  useEffect(() => {
    if (previousStageRef.current !== stage) {
      setAnnouncement(getRunSavingAnnouncement(stage));
      previousStageRef.current = stage;
    }
  }, [stage]);

  useEffect(() => {
    setIsStalled(false);
    const timeout = window.setTimeout(
      () => setIsStalled(true),
      RUN_SAVING_STALLED_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [stage]);

  const steps: ScenarioStatusStep[] = RUN_SAVING_STEPS.map((step) => {
    const savingState = getRunSavingStepState(stage, step.stage);

    return {
      id: step.stage,
      label: step.label,
      detail: step.detail,
      state: savingState === "up_next" ? "pending" : savingState,
    };
  });

  return (
    <div className="w-full" data-run-saving-progress>
      <ScenarioStepScreen
        title={title}
        description={description}
        steps={steps}
        headingId="run-recap-heading"
        headingRef={headingRef}
        listLabel="Saving steps"
        statusAnnouncement={announcement}
        footer={
          isStalled ? (
            <p
              className="max-w-[52ch] text-support text-muted-foreground"
              data-run-saving-stalled
              role="status"
            >
              This is taking longer than usual. Your work is safe, and your
              recap will appear here.
            </p>
          ) : null
        }
      />
    </div>
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
      className="mt-5 flex flex-wrap gap-2"
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
  recapKind,
  courseLocation,
  nextLecture,
}: {
  recapKind: Exclude<ReturnType<typeof getRunRecapState>["kind"], "saving">;
  courseLocation: CourseLocation | null | undefined;
  nextLecture: CourseLectureSummary | null | undefined;
}) {
  const linkClassName = cn(
    buttonVariants({ variant: "default", size: "default" }),
    "min-h-11 w-full max-w-full whitespace-normal sm:min-h-10 sm:w-auto [@media(pointer:coarse)]:min-h-11",
  );

  const route = courseRouteForRun(courseLocation);
  const lectureId = courseLocation?.lectureId ?? null;

  if (recapKind === "solved" && route && nextLecture) {
    return (
      <LectureLink
        route={route}
        lectureId={nextLecture.lectureId}
        className={linkClassName}
      >
        Next lecture: {nextLecture.title}
        <ArrowRight className="size-4" aria-hidden="true" />
      </LectureLink>
    );
  }

  if (recapKind === "solved" && route && courseLocation) {
    return (
      <CourseLink route={route} className={linkClassName}>
        Back to {courseLocation.courseTitle}
        <ArrowLeft className="size-4" aria-hidden="true" />
      </CourseLink>
    );
  }

  if (recapKind !== "solved" && route && lectureId) {
    return (
      <LectureLink route={route} lectureId={lectureId} className={linkClassName}>
        Read lecture and try again
        <ArrowRight className="size-4" aria-hidden="true" />
      </LectureLink>
    );
  }

  if (recapKind !== "solved" && route) {
    return (
      <CourseLink route={route} className={linkClassName}>
        Back to course
        <ArrowRight className="size-4" aria-hidden="true" />
      </CourseLink>
    );
  }

  return (
    <Link
      to={recapKind === "solved" ? "/runs" : "/courses"}
      className={linkClassName}
    >
      {recapKind === "solved" ? "Back to My runs" : "Browse courses"}
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
      <section
        aria-labelledby="run-recap-replay-heading"
        className="border-t pt-4 pb-4"
      >
        <div className="flex items-center gap-2">
          <PlayCircle
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 id="run-recap-replay-heading" className="text-section-title">
            Watch replay
          </h2>
        </div>
        <p className="mt-2 text-support text-muted-foreground" role="status">
          Your replay is being prepared.
        </p>
      </section>
    );
  }

  if (availability === "unavailable") {
    return (
      <section
        aria-labelledby="run-recap-replay-heading"
        className="border-t pt-4 pb-4"
      >
        <div className="flex items-center gap-2">
          <PlayCircle
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 id="run-recap-replay-heading" className="text-section-title">
            Watch replay
          </h2>
        </div>
        <p className="mt-2 text-support text-muted-foreground">
          Replay unavailable.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="run-recap-replay-heading"
      className="border-t pt-4 pb-4"
    >
      <DisclosureRow
        title={
          <span className="flex items-center gap-2">
            <PlayCircle
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span id="run-recap-replay-heading">Watch replay</span>
          </span>
        }
        density="comfortable"
        contentClassName="pt-3 pb-4"
      >
        <ReplayViewer runId={run.id} parts={parts} />
      </DisclosureRow>
    </section>
  );
}

export function ReplayViewer({
  runId,
  parts,
}: {
  runId: string;
  parts: RunReplayPart[];
}) {
  const firstPart =
    parts.find((part) => part.castArtifactId) ?? parts[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    firstPart?.key ?? null,
  );
  const [announcedPart, setAnnouncedPart] = useState<number | null>(null);
  const selected = parts.find((part) => part.key === selectedKey) ?? firstPart;
  const selectedIndex = selected
    ? parts.findIndex((part) => part.key === selected.key)
    : -1;

  useEffect(() => {
    if (selectedKey && parts.some((part) => part.key === selectedKey)) {
      return;
    }
    setSelectedKey(firstPart?.key ?? null);
  }, [firstPart?.key, parts, selectedKey]);

  const selectPart = (index: number) => {
    const part = parts[index];
    if (!part || part.key === selected?.key) return;
    setSelectedKey(part.key);
    setAnnouncedPart(index);
  };

  if (!selected) {
    return (
      <p className="text-support text-muted-foreground" role="status">
        Replay unavailable.
      </p>
    );
  }

  if (parts.length === 1) {
    return <ReplayPartSurface runId={runId} part={selected} />;
  }

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Replay parts"
      data-run-replay-carousel
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 text-card-title" data-run-replay-position>
          {selected.partLabel} of {parts.length}
          {selected.machineLabel ? ` · ${selected.machineLabel}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous replay part"
            disabled={selectedIndex <= 0}
            onClick={() => selectPart(selectedIndex - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next replay part"
            disabled={selectedIndex >= parts.length - 1}
            onClick={() => selectPart(selectedIndex + 1)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcedPart === null
          ? ""
          : `Showing Part ${announcedPart + 1} of ${parts.length}`}
      </p>

      <ol
        aria-label="Replay order"
        className="flex w-full min-w-0 max-w-full gap-3 overflow-x-auto pb-2"
      >
        {parts.map((part, index) => (
          <li key={part.key} className="shrink-0">
            <button
              type="button"
              className={cn(
                "min-h-9 rounded-lg border px-3 text-support font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                selected?.key === part.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background hover:bg-muted",
              )}
              aria-current={selected.key === part.key ? "step" : undefined}
              aria-label={`Show ${part.partLabel} of ${parts.length}${
                part.machineLabel ? `, ${part.machineLabel}` : ""
              }`}
              onClick={() => selectPart(index)}
            >
              {part.partLabel}
              {part.machineLabel ? (
                <span className="ml-1 text-xs opacity-75">
                  · {part.machineLabel}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>

      <div
        key={selected.key}
        role="group"
        aria-roledescription="slide"
        aria-label={`${selected.partLabel} of ${parts.length}${
          selected.machineLabel ? `, ${selected.machineLabel}` : ""
        }`}
        data-run-replay-slide
      >
        <ReplayPartSurface runId={runId} part={selected} />
      </div>
    </div>
  );
}

function ReplayPartSurface({
  runId,
  part,
}: {
  runId: string;
  part: RunReplayPart;
}) {
  const contentUrl = part.castArtifactId
    ? scenarioRunArtifactContentPath(runId, part.castArtifactId)
    : null;
  const knownTooLarge =
    part.sizeBytes !== undefined && part.sizeBytes > MAX_INLINE_REPLAY_BYTES;
  const replay = useStreamedText(
    contentUrl,
    Boolean(contentUrl) && !knownTooLarge,
  );

  return !part.castArtifactId ? (
    <p className="text-support text-muted-foreground" role="status">
      Replay unavailable.
    </p>
  ) : knownTooLarge || replay.truncated ? (
    <div className="space-y-3 rounded-md border bg-muted/20 px-4 py-4">
      <p className="text-support text-muted-foreground" role="status">
        This replay is too large to play in the page.
      </p>
      <Button
        variant="outline"
        size="sm"
        render={
          <a href={contentUrl ?? undefined} download="terminal-session.cast" />
        }
      >
        Download replay
      </Button>
    </div>
  ) : replay.error ? (
    <p className="text-support text-muted-foreground" role="status">
      Replay could not be loaded. Try again soon.
    </p>
  ) : (
    <div
      className="overflow-hidden rounded-md border border-border/70 bg-terminal-background"
      data-run-recap-replay-surface
    >
      <Suspense
        fallback={
          <div
            className="flex aspect-video items-center justify-center text-support text-terminal-muted"
            role="status"
          >
            Opening replay…
          </div>
        }
      >
        <LazyAsciicastReplaySurface
          contentId={part.castArtifactId}
          content={replay.content}
          loading={replay.loading}
          minimal
        />
      </Suspense>
    </div>
  );
}
