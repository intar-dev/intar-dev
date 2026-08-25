import {
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
import { AsciicastReplaySurface } from "@/components/app/RunArtifactViewer";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { Button } from "@/components/ui/button";
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

type RunSavingStage = NonNullable<ScenarioRunRecord["savingStage"]>;
export const RUN_SAVING_STALLED_DELAY_MS = 30_000;

export const RUN_SAVING_STEPS = [
  { stage: "save_requested", label: "Save requested" },
  { stage: "closing_workspace", label: "Closing workspace" },
  { stage: "saving_files", label: "Saving files" },
  { stage: "preparing_replay", label: "Preparing replay" },
  { stage: "finalizing_recap", label: "Finalizing recap" },
] as const satisfies readonly { stage: RunSavingStage; label: string }[];

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
  stage: RunSavingStage,
  step: RunSavingStage,
): RunSavingStepState {
  const activeIndex = RUN_SAVING_STEPS.findIndex(
    (candidate) => candidate.stage === stage,
  );
  const stepIndex = RUN_SAVING_STEPS.findIndex(
    (candidate) => candidate.stage === step,
  );
  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";
  return "up_next";
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
        className="mx-auto w-full max-w-3xl py-8 md:py-12"
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
        <RunSavingProgress stage={getRunSavingStage(run)} />
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
      className="mx-auto w-full max-w-3xl space-y-8 py-8 md:space-y-12 md:py-10"
    >
      <header className="border-b border-primary/15 pb-8">
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

      <section aria-label="Learning summary">
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
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

function RunSavingProgress({ stage }: { stage: RunSavingStage }) {
  const activeStep =
    RUN_SAVING_STEPS.find((step) => step.stage === stage) ??
    RUN_SAVING_STEPS[0];
  const previousStageRef = useRef(stage);
  const [announcement, setAnnouncement] = useState("");
  const [isStalled, setIsStalled] = useState(false);

  useEffect(() => {
    if (previousStageRef.current !== stage) {
      setAnnouncement(`${activeStep.label}. In progress.`);
      previousStageRef.current = stage;
    }
  }, [activeStep.label, stage]);

  useEffect(() => {
    setIsStalled(false);
    const timeout = window.setTimeout(
      () => setIsStalled(true),
      RUN_SAVING_STALLED_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [stage]);

  return (
    <div className="mt-8 w-full" data-run-saving-progress>
      <div className="flex items-center justify-between gap-4 text-xs font-medium">
        <span>Saving steps</span>
        <span className="text-muted-foreground">In progress</span>
      </div>
      <ol
        aria-label="Saving steps"
        className="mt-4 grid gap-3 sm:grid-cols-5 sm:gap-2"
        data-run-saving-steps
      >
        {RUN_SAVING_STEPS.map((step, index) => {
          const state = getRunSavingStepState(stage, step.stage);
          const stateLabel =
            state === "done"
              ? "Done"
              : state === "active"
                ? "In progress"
                : "Up next";
          return (
            <li
              key={step.stage}
              aria-current={state === "active" ? "step" : undefined}
              data-run-saving-step
              data-state={state}
              className="flex min-w-0 items-center gap-3 sm:flex-col sm:items-start sm:gap-2"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-[transform,opacity] duration-150 motion-reduce:transition-none",
                  state === "done"
                    ? "scale-100 border-success bg-success text-success-foreground"
                    : state === "active"
                      ? "scale-100 border-primary bg-primary text-primary-foreground"
                      : "scale-95 border-border bg-background text-muted-foreground opacity-70",
                )}
              >
                {state === "done" ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="min-w-0 text-sm leading-5 sm:text-xs">
                <span className="block font-medium text-foreground">
                  {step.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {stateLabel}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {isStalled ? (
        <p
          className="mt-5 max-w-[52ch] text-sm leading-6 text-muted-foreground"
          data-run-saving-stalled
          role="status"
        >
          This is taking longer than usual. Your work is safe, and your recap
          will appear here.
        </p>
      ) : null}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-run-saving-announcement
      >
        {announcement}
      </p>
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
      <section
        aria-labelledby="run-recap-replay-heading"
        className="border-t pt-4 pb-6"
      >
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
      <section
        aria-labelledby="run-recap-replay-heading"
        className="border-t pt-4 pb-6"
      >
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
    <section
      aria-labelledby="run-recap-replay-heading"
      className="border-t pt-4 pb-6"
    >
      <DisclosureRow
        title={
          <span className="flex items-center gap-2">
            <PlayCircle className="size-4 text-muted-foreground" aria-hidden="true" />
            <span id="run-recap-replay-heading">Watch replay</span>
          </span>
        }
        density="comfortable"
        contentClassName="pt-4 pb-6"
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
  const firstPart = parts.find((part) => part.castArtifactId) ?? parts[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    firstPart?.key ?? null,
  );
  const [announcedPart, setAnnouncedPart] = useState<number | null>(null);
  const selected =
    parts.find((part) => part.key === selectedKey) ?? firstPart;
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
      <p className="text-sm text-muted-foreground" role="status">
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
      className="space-y-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p
          className="min-w-0 font-heading text-base font-semibold tracking-tight"
          data-run-replay-position
        >
          {selected.partLabel} of {parts.length}
          {selected.machineLabel ? ` · ${selected.machineLabel}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous replay part"
            disabled={selectedIndex <= 0}
            onClick={() => selectPart(selectedIndex - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next replay part"
            disabled={selectedIndex >= parts.length - 1}
            onClick={() => selectPart(selectedIndex + 1)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcedPart === null
          ? ""
          : `Showing Part ${announcedPart + 1} of ${parts.length}`}
      </p>

      <ol
        aria-label="Replay order"
        className="flex max-w-full gap-3 overflow-x-auto pb-2"
      >
        {parts.map((part, index) => (
          <li key={part.key} className="shrink-0">
            <button
              type="button"
              className={cn(
                "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
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
  const replay = useStreamedText(contentUrl, Boolean(contentUrl));

  return !part.castArtifactId ? (
    <p className="text-sm text-muted-foreground" role="status">
      Replay unavailable.
    </p>
  ) : replay.error ? (
    <p className="text-sm text-muted-foreground" role="status">
      Replay could not be loaded. Try again soon.
    </p>
  ) : (
    <div
      className="overflow-hidden rounded-md border border-border/70 bg-terminal-background"
      data-run-recap-replay-surface
    >
      <AsciicastReplaySurface
        contentId={part.castArtifactId}
        content={replay.content}
        loading={replay.loading}
        minimal
      />
    </div>
  );
}
