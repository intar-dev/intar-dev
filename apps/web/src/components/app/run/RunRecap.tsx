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
  Check,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleStop,
  Clock3,
  Lightbulb,
  LockKeyhole,
  PlayCircle,
} from "lucide-react";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { ScenarioStepScreen } from "@/components/app/run/StatusScreens";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CourseLink,
  LectureLink,
} from "@/components/app/pages/learn/course-links";
import {
  courseRouteForRun,
  type CourseLectureSummary,
} from "@/components/app/pages/learn/course-wire";
import { CourseNextAction } from "@/components/app/pages/learn/CourseNextAction";
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
import { RollingNumber } from "@/components/app/patterns/RollingNumber";

const LazyAsciicastReplaySurface = lazy(() =>
  import("@/components/app/RunArtifactViewerReplay").then(
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
  /**
   * True only when the recap arrives live, right after the learner finished
   * and saved (the Moment Rule). The header, check rows and summary rise and
   * the solved mark pops. A saved run opened later renders still. The value at
   * first render is kept, so a later re-render can't cut the arrival short.
   */
  animate?: boolean;
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
  animate = false,
}: RunRecapProps) {
  const [play] = useState(animate);
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
      className="w-full space-y-6 md:space-y-8"
    >
      <header className="flex items-start gap-4 sm:items-center sm:gap-5">
        <RecapBadge kind={recap.kind} play={play} />
        <div className={cn("min-w-0", play && "animate-rise")}>
          <h2
            id="run-recap-heading"
            ref={headingRef}
            tabIndex={-1}
            className="text-feature-title outline-none"
          >
            {recap.title}
          </h2>
          <p className="mt-1 text-support text-muted-foreground">
            {recap.description}
          </p>
        </div>
      </header>

      {objectives.length ? (
        <section aria-labelledby="run-recap-checks-heading">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="run-recap-checks-heading" className="text-section-title">
              Final checks
            </h2>
            <span className="text-metadata">
              <RollingNumber value={verifiedObjectives} />/{objectives.length} verified
            </span>
          </div>
          <RunRecapProgress
            objectives={objectives}
            closed={verifiedObjectives === objectives.length}
          />
          <ol className="mt-3 divide-y overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)]">
            {objectives.map((objective, index) => (
              <li
                key={objective.key}
                className={cn(
                  "grid min-h-12 grid-cols-[1rem_minmax(0,1fr)] items-start gap-3 px-4 py-3",
                  play && "animate-rise",
                )}
                // Rows arrive 40ms apart, capped at 200ms.
                style={
                  play
                    ? { animationDelay: `${Math.min(index, 5) * 40}ms` }
                    : undefined
                }
              >
                {objective.status === "verified" ? (
                  // Verified before the recap opened: it never pops again.
                  <CheckCircle2
                    className="mt-0.5 size-4 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleDashed
                    className="mt-0.5 size-4 text-warning"
                    aria-hidden="true"
                  />
                )}
                <span className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-support font-medium [overflow-wrap:anywhere]">
                    {objective.title}
                  </span>
                  <span
                    className={cn(
                      "text-[0.8125rem] font-medium whitespace-nowrap",
                      objective.status === "verified"
                        ? "text-success"
                        : "text-warning",
                    )}
                  >
                    {objective.status === "verified"
                      ? "Verified"
                      : "Needs repair"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section
        aria-label="Learning summary"
        className={cn(play && "animate-rise [animation-delay:80ms]")}
      >
        <dl className="grid overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)] max-sm:divide-y sm:auto-cols-fr sm:grid-flow-col sm:divide-x">
          {recap.kind === "solved" && run.solveDurationMs !== null ? (
            <div className="px-5 py-4">
              <dt className="inline-flex items-center gap-2 text-label">
                <Clock3 className="size-3.5" aria-hidden="true" />
                Solve time
              </dt>
              <dd className="mt-1 text-stat">
                {formatScenarioDurationMs(run.solveDurationMs)}
              </dd>
            </div>
          ) : null}
          <div className="px-5 py-4">
            <dt className="inline-flex items-center gap-2 text-label">
              <Lightbulb className="size-3.5" aria-hidden="true" />
              Hints used
            </dt>
            <dd className="mt-1 text-stat">
              {revealedHints === 1 ? "1 hint" : `${revealedHints} hints`}
            </dd>
          </div>
          <div className="px-5 py-4">
            <dt className="inline-flex items-center gap-2 text-label">
              <LockKeyhole className="size-3.5" aria-hidden="true" />
              Full solution
            </dt>
            <dd className="mt-1 text-stat">
              {solutionUsed ? "Used" : "Not used"}
            </dd>
          </div>
        </dl>
      </section>

      <RunReplaySection run={run} />

      <section
        aria-labelledby="run-recap-next-heading"
        className="w-full rounded-2xl border bg-card p-5 shadow-[var(--highlight),var(--shadow-raised)]"
      >
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

const STALLED_NOTE =
  "This is taking longer than usual. Your work is safe, and your recap will appear here.";

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
        // One live region reads the sequence: the stalled note joins it
        // instead of speaking from a second status.
        statusAnnouncement={isStalled ? `${announcement} ${STALLED_NOTE}` : announcement}
        footer={
          isStalled ? (
            <p
              className="text-support text-muted-foreground"
              data-run-saving-stalled
            >
              {STALLED_NOTE}
            </p>
          ) : null
        }
      />
    </div>
  );
}

// Decorative: the visible "n/N verified" count carries the information once.
// A recap with every check verified draws the bar as one closed line, still.
function RunRecapProgress({
  objectives,
  closed,
}: {
  objectives: readonly RunRecapObjective[];
  closed: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      data-run-recap-progress
      data-closed={closed || undefined}
      className="mt-3 flex gap-1"
    >
      {objectives.map((objective) => (
        <span
          key={objective.key}
          data-run-recap-progress-segment
          data-status={objective.status}
          className={cn(
            "h-1 flex-1 rounded-[0.125rem]",
            objective.status === "verified"
              ? "bg-success"
              : "bg-border-strong/70",
          )}
        />
      ))}
    </div>
  );
}

// The solved moment gets one confirm motion: the check pops, and only when the
// recap arrives live. Other outcomes stay still.
function RecapBadge({
  kind,
  play,
}: {
  kind: ReturnType<typeof getRunRecapState>["kind"];
  play: boolean;
}) {
  if (kind === "solved") {
    return (
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] bg-success-subtle text-success ring-1 ring-success-border/60"
      >
        <Check
          className={cn(
            "size-5",
            play && "animate-pop [animation-delay:120ms]",
          )}
        />
      </span>
    );
  }
  const failed = kind === "could_not_finish";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] ring-1",
        failed
          ? "bg-destructive-subtle text-destructive ring-destructive-border/60"
          : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {failed ? (
        <CircleAlert className="size-5" />
      ) : (
        <CircleStop className="size-5" />
      )}
    </span>
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
    "min-h-11 w-full max-w-full sm:min-h-10 sm:w-auto [@media(pointer:coarse)]:min-h-11",
  );

  const route = courseRouteForRun(courseLocation);
  const lectureId = courseLocation?.lectureId ?? null;

  if (recapKind === "solved" && route && nextLecture) {
    return <CourseNextAction route={route} lecture={nextLecture} />;
  }

  if (recapKind === "solved" && route && courseLocation) {
    return (
      <CourseLink route={route} className={linkClassName}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to course
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
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to course
      </CourseLink>
    );
  }

  return (
    <Link
      to={recapKind === "solved" ? "/runs" : "/courses"}
      className={linkClassName}
    >
      {recapKind === "solved" ? (
        <>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to My runs
        </>
      ) : (
        <>
          Browse courses
          <ArrowRight className="size-4" aria-hidden="true" />
        </>
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
    <section aria-labelledby="run-recap-replay-heading">
      <DisclosureRow
        leading={
          <PlayCircle
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        }
        title={<span id="run-recap-replay-heading">Watch replay</span>}
        heading="h2"
        density="comfortable"
        // The row indents the panel under its title; the replay lines up
        // with the sections around it instead.
        contentClassName="pt-3 pb-4 pl-0"
      >
        <ReplayViewer
          runId={run.id}
          parts={parts}
          scenarioName={run.scenarioName}
        />
      </DisclosureRow>
    </section>
  );
}

export function ReplayViewer({
  runId,
  parts,
  scenarioName,
}: {
  runId: string;
  parts: RunReplayPart[];
  /** Names the replay for assistive technology. */
  scenarioName?: string;
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

  const label = scenarioName
    ? `Terminal replay of ${scenarioName}`
    : "Terminal replay";
  if (parts.length === 1) {
    return <ReplayPartSurface runId={runId} part={selected} label={label} />;
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
        <p
          className="min-w-0 text-card-title tabular-nums"
          data-run-replay-position
        >
          {selected.partLabel} of {parts.length}
          {selected.machineLabel ? ` · ${selected.machineLabel}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
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
              }
            />
            <TooltipContent>Previous replay part</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
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
              }
            />
            <TooltipContent>Next replay part</TooltipContent>
          </Tooltip>
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
          : `Showing part ${announcedPart + 1} of ${parts.length}`}
      </p>

      <ol
        aria-label="Replay order"
        className="flex w-full min-w-0 max-w-full gap-2 overflow-x-auto p-1"
      >
        {parts.map((part, index) => (
          <li key={part.key} className="shrink-0">
            <Button
              type="button"
              size="sm"
              variant={selected.key === part.key ? "default" : "outline"}
              className="min-h-9"
              aria-current={selected.key === part.key ? "step" : undefined}
              aria-label={`Show part ${index + 1} of ${parts.length}${
                part.machineLabel ? `, ${part.machineLabel}` : ""
              }`}
              onClick={() => selectPart(index)}
            >
              {part.partLabel}
              {part.machineLabel ? (
                // Full contrast on the selected chip; muted on the others.
                <span
                  className={cn(
                    "font-normal",
                    selected.key !== part.key && "text-muted-foreground",
                  )}
                >
                  · {part.machineLabel}
                </span>
              ) : null}
            </Button>
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
        <ReplayPartSurface
          runId={runId}
          part={selected}
          label={`${label}, ${selected.partLabel.toLowerCase()}${
            selected.machineLabel ? `, ${selected.machineLabel}` : ""
          }`}
        />
      </div>
    </div>
  );
}

// Retrying remounts the content, which starts the fetch again.
function ReplayPartSurface(props: {
  runId: string;
  part: RunReplayPart;
  label: string;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ReplayPartContent
      key={attempt}
      {...props}
      onRetry={() => setAttempt((count) => count + 1)}
    />
  );
}

function ReplayPartContent({
  runId,
  part,
  label,
  onRetry,
}: {
  runId: string;
  part: RunReplayPart;
  label: string;
  onRetry: () => void;
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
    <Alert className="rounded-xl">
      <AlertTitle>This replay is too large to play in the page.</AlertTitle>
      <AlertDescription>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          render={
            <a
              href={contentUrl ?? undefined}
              download="terminal-session.cast"
            />
          }
        >
          Download replay
        </Button>
      </AlertDescription>
    </Alert>
  ) : replay.error ? (
    // The error replaces the replay, so it is announced, and says what to do.
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-terminal-border bg-terminal-background px-4 py-4"
    >
      <p className="text-support text-terminal-foreground">
        Replay could not be loaded.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="border-terminal-border bg-terminal-surface text-terminal-foreground hover:border-terminal-muted hover:bg-terminal-surface dark:hover:bg-terminal-surface"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  ) : (
    // The replay frame draws its own edge, so this only marks the slot.
    <div data-run-recap-replay-surface>
      <Suspense
        fallback={
          <div
            className="rounded-xl border border-terminal-border bg-terminal-background px-4 py-6 text-support text-terminal-muted"
            role="status"
          >
            Preparing replay…
          </div>
        }
      >
        <LazyAsciicastReplaySurface
          contentId={part.castArtifactId}
          content={replay.content}
          loading={replay.loading}
          label={label}
          minimal
        />
      </Suspense>
    </div>
  );
}
