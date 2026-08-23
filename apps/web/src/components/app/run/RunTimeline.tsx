import {
  type Ref,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Archive,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Play,
  Power,
  TerminalSquare,
} from "lucide-react";
import {
  AsciicastReplaySurface,
  ReadOnlyTextSurface,
} from "@/components/app/RunArtifactViewer";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import {
  formatReplayTimestamp,
  parseReplayCommandLog,
} from "@/lib/replay-command-log";
import { cn } from "@/lib/utils";
import { useProbeSnapshots } from "./probe-pass-times";
import { formatScenarioDurationMs } from "./run-support";
import {
  buildRunTimelineItems,
  type RunTimelineItem,
  type RunTimelineProbeChange,
  type RunTimelineTone,
} from "./run-timeline-model";
import type { ScenarioRunRecord, SessionTimelineEntry } from "./run-types";
import { useStreamedText } from "./useStreamedText";

export function RunTimeline({
  run,
  headingRef,
}: {
  run: ScenarioRunRecord;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const snapshots = useProbeSnapshots(run.id, { refetchOnMount: "always" });
  const refetchedSettledRun = useRef<string | null>(null);
  const settled = run.phase === "completed" || run.phase === "failed";

  useEffect(() => {
    if (!settled || refetchedSettledRun.current === run.id) {
      return;
    }
    refetchedSettledRun.current = run.id;
    void snapshots.refetch();
  }, [run.id, settled, snapshots.refetch]);

  const items = useMemo(
    () => buildRunTimelineItems(run, snapshots.data?.snapshots ?? []),
    [run, snapshots.data?.snapshots],
  );
  const currentLifecycle = items.find(
    (item): item is Extract<RunTimelineItem, { type: "lifecycle" }> =>
      item.type === "lifecycle" && item.current,
  );

  return (
    <section aria-labelledby="run-timeline-heading" className="space-y-4">
      <header className="space-y-1">
        <p className="text-eyebrow">{run.scenarioName}</p>
        <h2
          id="run-timeline-heading"
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
        >
          Run timeline
        </h2>
        {currentLifecycle ? (
          <p className="sr-only" role="status" aria-live="polite" aria-atomic>
            {currentLifecycle.title}. {currentLifecycle.detail}
          </p>
        ) : null}
        {snapshots.isLoading ? (
          <p className="text-caption" role="status">
            Loading check history…
          </p>
        ) : snapshots.error ? (
          <p className="text-sm text-destructive" role="status">
            Check history could not be loaded. Other run events are still
            available.
          </p>
        ) : null}
      </header>

      <ol aria-label="Run timeline">
        {items.map((item, index) => (
          <TimelineRow
            key={item.id}
            item={item}
            run={run}
            isLast={index === items.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}

function TimelineRow({
  item,
  run,
  isLast,
}: {
  item: RunTimelineItem;
  run: ScenarioRunRecord;
  isLast: boolean;
}) {
  const isCurrent = item.type === "lifecycle" && item.current;

  return (
    <li
      className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0 sm:grid-cols-[8rem_1.25rem_minmax(0,1fr)]"
      aria-current={isCurrent ? "step" : undefined}
    >
      <div className="hidden pt-0.5 text-right sm:block">
        <TimelineTime item={item} />
      </div>
      <div
        className="relative flex justify-center pt-6 sm:-translate-y-0.5 sm:pt-0"
        aria-hidden="true"
      >
        {!isLast ? (
          <span className="absolute -bottom-10 top-11 w-px bg-border sm:-bottom-4 sm:top-5" />
        ) : null}
        <TimelineMarker item={item} />
      </div>
      <div className="w-full min-w-0 max-w-4xl">
        <div className="mb-1 sm:hidden">
          <TimelineTime item={item} />
        </div>
        <TimelineEvent item={item} run={run} />
      </div>
    </li>
  );
}

function TimelineTime({ item }: { item: RunTimelineItem }) {
  if (item.at === null) {
    return (
      <span className="text-caption font-medium tabular-nums">
        {item.type === "recording_status"
          ? item.current
            ? "Processing"
            : "Final status"
          : "Now"}
      </span>
    );
  }

  const date = new Date(item.at);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className="text-caption whitespace-nowrap tabular-nums"
    >
      {date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}

function TimelineMarker({ item }: { item: RunTimelineItem }) {
  const iconClassName = "size-3";
  let icon: ReactNode;

  switch (item.type) {
    case "run_started":
    case "probe_changes":
      icon = <Activity className={iconClassName} />;
      break;
    case "session":
    case "recording_status":
      icon = <TerminalSquare className={iconClassName} />;
      break;
    case "solved":
      icon = <CheckCircle2 className={iconClassName} />;
      break;
    case "shutdown_requested":
      icon = <Power className={iconClassName} />;
      break;
    case "lifecycle":
      icon =
        item.phase === "failed" ? (
          <CircleAlert className={iconClassName} />
        ) : item.phase === "completed" ? (
          <CheckCircle2 className={iconClassName} />
        ) : item.phase === "archiving" ? (
          <Archive className={iconClassName} />
        ) : (
          <LoaderCircle
            className={cn(iconClassName, "motion-safe:animate-spin")}
          />
        );
      break;
  }

  return (
    <span
      data-timeline-marker
      className={cn(
        "relative z-10 flex size-6 items-center justify-center rounded-full border bg-background",
        markerToneClass(item.tone),
      )}
    >
      {icon}
    </span>
  );
}

function TimelineEvent({
  item,
  run,
}: {
  item: RunTimelineItem;
  run: ScenarioRunRecord;
}) {
  const showMachine = run.vms.length > 1;

  switch (item.type) {
    case "run_started":
      return (
        <EventCopy
          title="Run started"
          detail="The workspace was requested and the run record was created."
        />
      );
    case "probe_changes":
      return (
        <div className="space-y-1">
          <EventCopy
            title="Checks updated"
            meta={showMachine ? item.vmName : undefined}
          />
          <ProbeChanges changes={item.changes} />
        </div>
      );
    case "session":
      return (
        <div>
          <EventCopy
            title={
              item.sessionCount === 1
                ? "Terminal session"
                : `Terminal session ${item.sessionNumber}`
            }
            meta={showMachine ? item.vmName : undefined}
            detail={sessionSummary(item.session)}
          />
          <SessionArtifacts
            runId={run.id}
            vmId={item.vmId}
            session={item.session}
            replayAvailability={item.replayAvailability}
          />
        </div>
      );
    case "solved":
      return (
        <EventCopy
          title="Objectives solved"
          detail={
            item.durationMs === null
              ? "All scenario checks passed."
              : `All scenario checks passed in ${formatScenarioDurationMs(item.durationMs)}.`
          }
        />
      );
    case "shutdown_requested":
      return (
        <EventCopy
          title="Shutdown requested"
          detail="Shell access closed and workspace cleanup began."
        />
      );
    case "recording_status":
      return (
        <div
          aria-live={item.current ? "polite" : undefined}
          aria-atomic
          aria-busy={item.current || undefined}
        >
          <RecordingStatusCopy item={item} showMachine={showMachine} />
        </div>
      );
    case "lifecycle":
      return <EventCopy title={item.title} detail={item.detail} />;
  }
}

function EventCopy({
  title,
  detail,
  meta,
}: {
  title: string;
  detail?: string;
  meta?: string | undefined;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 data-timeline-title className="text-sm font-semibold">
          {title}
        </h2>
        {meta ? <span className="text-caption font-medium">{meta}</span> : null}
      </div>
      {detail ? (
        <p className="max-w-[68ch] text-sm leading-5 text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function ProbeChanges({ changes }: { changes: RunTimelineProbeChange[] }) {
  return (
    <ul
      data-timeline-surface="probe-changes"
      className="w-full divide-y border-y text-sm"
    >
      {changes.map((change) => (
        <li
          key={change.probeId}
          className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1"
        >
          <span className="min-w-0 font-medium leading-5 [overflow-wrap:anywhere]">
            {change.label}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {change.from ? (
              <>
                <ProbeStatus status={change.from} />
                <ArrowRight
                  className="size-3 text-muted-foreground"
                  aria-hidden="true"
                />
              </>
            ) : (
              <span className="sr-only">First observed as </span>
            )}
            <ProbeStatus status={change.to} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProbeStatus({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return (
    <span
      className={cn(
        "text-xs font-semibold capitalize",
        normalized === "pass"
          ? "text-success"
          : normalized === "fail"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

function RecordingStatusCopy({
  item,
  showMachine,
}: {
  item: Extract<RunTimelineItem, { type: "recording_status" }>;
  showMachine: boolean;
}) {
  const meta = showMachine ? item.vmName : undefined;
  switch (item.state) {
    case "preparing":
      return (
        <EventCopy
          title="Preparing terminal recordings"
          detail="Recording details will appear here as the workspace is saved."
          meta={meta}
        />
      );
    case "rendering":
      return (
        <EventCopy
          title="Building terminal session history"
          detail="The recording was uploaded and its sessions are being prepared."
          meta={meta}
        />
      );
    case "none":
      return (
        <EventCopy
          title="No terminal sessions recorded"
          detail="The run ended without an SSH recording for this machine."
          meta={meta}
        />
      );
    case "unavailable":
      return (
        <EventCopy
          title="Replay unavailable"
          detail="A recording was uploaded, but its session history could not be prepared."
          meta={meta}
        />
      );
  }
}

function SessionArtifacts({
  runId,
  vmId,
  session,
  replayAvailability,
}: {
  runId: string;
  vmId: string;
  session: SessionTimelineEntry;
  replayAvailability: "ready" | "pending" | "unavailable";
}) {
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayRequested, setReplayRequested] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptRequested, setTranscriptRequested] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logRequested, setLogRequested] = useState(false);
  const runSegment = encodeURIComponent(runId);
  const vmSegment = encodeURIComponent(vmId);
  const castUrl = session.castArtifactId
    ? `/api/runs/${runSegment}/artifacts/${encodeURIComponent(session.castArtifactId)}/content`
    : null;
  const transcriptUrl = `/api/runs/${runSegment}/vms/${vmSegment}/sessions/${session.index}/transcript`;
  const cast = useStreamedText(castUrl, replayRequested || logRequested);
  const transcript = useStreamedText(transcriptUrl, transcriptRequested);
  const commands = useMemo(
    () =>
      cast.content && !cast.loading ? parseReplayCommandLog(cast.content) : [],
    [cast.content, cast.loading],
  );

  return (
    <div
      data-timeline-surface="session-artifacts"
      className="mt-2 w-full divide-y border-y"
    >
      {replayAvailability === "ready" ? (
        <DisclosureRow
          density="compact"
          title={
            <span className="flex items-center gap-2">
              <Play className="size-4 text-muted-foreground" aria-hidden />
              Replay
            </span>
          }
          open={replayOpen}
          onOpenChange={(open) => {
            setReplayOpen(open);
            if (open) setReplayRequested(true);
          }}
          contentClassName="space-y-2"
        >
          {cast.error ? (
            <p className="text-sm text-destructive" role="status">
              Replay could not be loaded: {cast.error}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border bg-terminal-background">
              <AsciicastReplaySurface
                contentId={`${vmId}:${session.index}`}
                content={cast.content}
                loading={cast.loading}
                minimal
              />
            </div>
          )}
        </DisclosureRow>
      ) : (
        <p
          className={cn(
            "py-2 text-sm",
            replayAvailability === "unavailable"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          aria-live={replayAvailability === "pending" ? "polite" : undefined}
        >
          {replayAvailability === "unavailable"
            ? "Replay unavailable. The session metadata was saved without its cast file."
            : "Replay is still uploading."}
        </p>
      )}

      <DisclosureRow
        density="compact"
        title="Transcript"
        meta={session.transcriptTruncated ? "Trimmed" : undefined}
        open={transcriptOpen}
        onOpenChange={(open) => {
          setTranscriptOpen(open);
          if (open) setTranscriptRequested(true);
        }}
      >
        {transcript.error ? (
          <p className="text-sm text-destructive" role="status">
            Transcript could not be loaded: {transcript.error}
          </p>
        ) : (
          <div className="space-y-2">
            {session.transcriptTruncated ? (
              <p className="text-caption">
                The earliest output was trimmed from this long session.
              </p>
            ) : null}
            <ReadOnlyTextSurface
              content={transcript.content}
              loading={transcript.loading}
              wrapText
              compact
            />
          </div>
        )}
      </DisclosureRow>

      {castUrl ? (
        <DisclosureRow
          density="compact"
          title={
            <span className="flex items-center gap-2">
              <TerminalSquare
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              Command log
            </span>
          }
          meta={
            !cast.loading && cast.content ? `${commands.length}` : undefined
          }
          open={logOpen}
          onOpenChange={(open) => {
            setLogOpen(open);
            if (open) setLogRequested(true);
          }}
        >
          {cast.error ? (
            <p className="text-sm text-destructive" role="status">
              Command log could not be loaded: {cast.error}
            </p>
          ) : cast.loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading command log…
            </p>
          ) : commands.length ? (
            <PaginatedCollection
              items={commands}
              pageSize={COLLECTION_PAGE_SIZE.dense}
              itemLabel="commands"
            >
              {(visibleCommands) => (
                <ol className="divide-y border-y">
                  {visibleCommands.map((entry, index) => (
                    <li
                      key={`${entry.atSeconds}-${index}`}
                      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2 py-2"
                    >
                      <span className="font-mono text-[0.7rem] text-muted-foreground tabular-nums">
                        {formatReplayTimestamp(entry.atSeconds)}
                      </span>
                      <pre className="min-w-0 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
                        {entry.text}
                      </pre>
                    </li>
                  ))}
                </ol>
              )}
            </PaginatedCollection>
          ) : (
            <p className="text-sm text-muted-foreground">
              No typed input was captured in this session.
            </p>
          )}
        </DisclosureRow>
      ) : null}
    </div>
  );
}

function sessionSummary(session: SessionTimelineEntry): string {
  const duration = formatScenarioDurationMs(session.durationMs);
  if (session.exitCode === null) {
    return `${duration} · Exit status was not recorded.`;
  }
  return session.exitCode === 0
    ? `${duration} · Exited cleanly.`
    : `${duration} · Exited with code ${session.exitCode}.`;
}

function markerToneClass(tone: RunTimelineTone): string {
  switch (tone) {
    case "pending":
      return "border-primary/45 text-primary";
    case "success":
      return "border-success-border text-success";
    case "danger":
      return "border-destructive-border text-destructive";
    case "neutral":
      return "border-border text-muted-foreground";
  }
}
