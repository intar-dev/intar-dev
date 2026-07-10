import { useMemo, useState } from "react";
import { ChevronDown, Play, TerminalSquare } from "lucide-react";
import {
  AsciicastReplaySurface,
  ReadOnlyTextSurface,
} from "@/components/app/RunArtifactViewer";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { MetaChip } from "@/components/app/patterns/MetaChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  formatReplayTimestamp,
  parseReplayCommandLog,
} from "@/lib/replay-command-log";
import { formatScenarioDurationMs } from "@/components/app/run/run-support";
import type {
  ScenarioRunVmRecord,
  SessionTimelineEntry,
} from "@/components/app/run/run-types";
import { useStreamedText } from "@/components/app/run/useStreamedText";
import { cn } from "@/lib/utils";

/** Gaps shorter than this render as an immediate reconnect. */
const MIN_VISIBLE_GAP_MS = 1_000;

/**
 * The completed-run replay area: one compact row per SSH session in
 * chronological order, with the reconnect gap called out between rows. The
 * plain-text transcript is the default, inline view; the asciinema replay
 * opens in a dialog and is only fetched once it is requested. Session
 * metadata comes from `vm.sessionTimeline` (already part of the polled run
 * record).
 */
export function SessionTimeline({
  runId,
  vm,
}: {
  runId: string;
  vm: ScenarioRunVmRecord | null;
}) {
  const sessions = vm?.sessionTimeline ?? null;

  if (vm?.hasRecording && !sessions) {
    return (
      <div className="flex w-full flex-col items-center justify-center gap-3 rounded-md border bg-muted/20 px-6 py-8 text-center">
        <div className="h-2 w-44 overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
        <p className="text-sm font-medium">Rendering session timeline</p>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          The recorded sessions are being rendered on the host. They appear
          here automatically once they are ready.
        </p>
      </div>
    );
  }

  if (!sessions?.length) {
    return (
      <EmptyState
        icon={<TerminalSquare />}
        title="No terminal sessions"
        description="No SSH sessions were recorded for this machine."
      />
    );
  }

  return (
    <div className="space-y-1">
      {sessions.map((session, index) => {
        const previous = index > 0 ? sessions[index - 1] : undefined;
        return (
          <div key={session.index} className="space-y-1">
            {previous ? (
              <ReconnectDivider previous={previous} next={session} />
            ) : null}
            <SessionRow
              runId={runId}
              vmId={vm?.id ?? ""}
              session={session}
              sessionCount={sessions.length}
            />
          </div>
        );
      })}
    </div>
  );
}

function ReconnectDivider({
  previous,
  next,
}: {
  previous: SessionTimelineEntry;
  next: SessionTimelineEntry;
}) {
  const gapMs =
    next.startTimestampMs - (previous.startTimestampMs + previous.durationMs);
  return (
    <div className="flex items-center gap-3 px-2 py-1" role="separator">
      <span className="h-px flex-1 border-t border-dashed" />
      <span className="text-caption text-muted-foreground">
        {gapMs >= MIN_VISIBLE_GAP_MS
          ? `Reconnected after ${formatScenarioDurationMs(gapMs)}`
          : "Reconnected immediately"}
      </span>
      <span className="h-px flex-1 border-t border-dashed" />
    </div>
  );
}

function SessionRow({
  runId,
  vmId,
  session,
  sessionCount,
}: {
  runId: string;
  vmId: string;
  session: SessionTimelineEntry;
  sessionCount: number;
}) {
  const runSegment = encodeURIComponent(runId);
  const vmSegment = encodeURIComponent(vmId);
  const transcriptUrl = `/api/runs/${runSegment}/vms/${vmSegment}/sessions/${session.index}/transcript`;
  const castUrl = session.castArtifactId
    ? `/api/runs/${runSegment}/artifacts/${encodeURIComponent(session.castArtifactId)}/content`
    : null;

  const startedAt = new Date(session.startTimestampMs);
  const transcript = useStreamedText(transcriptUrl, true);

  return (
    <section className="rounded-lg border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {sessionCount === 1 ? "Terminal session" : `Session ${session.index}`}
          </span>
          <MetaChip variant="outline">
            {startedAt.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </MetaChip>
          <MetaChip>{formatScenarioDurationMs(session.durationMs)}</MetaChip>
          {session.exitCode !== null && session.exitCode !== 0 ? (
            <Badge variant="destructive">exit {session.exitCode}</Badge>
          ) : null}
        </div>
        <ReplayDialog
          castUrl={castUrl}
          contentId={`${vmId}:${session.index}`}
          title={
            sessionCount === 1
              ? "Terminal session replay"
              : `Session ${session.index} replay`
          }
        />
      </header>
      <div className="p-2">
        {transcript.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {transcript.error}
          </div>
        ) : (
          <>
            {session.transcriptTruncated ? (
              <p className="pb-1.5 text-caption text-muted-foreground">
                Long session — the earliest output was trimmed from this
                transcript.
              </p>
            ) : null}
            <ReadOnlyTextSurface
              content={transcript.content}
              loading={transcript.loading}
              wrapText
              compact
            />
          </>
        )}
      </div>
    </section>
  );
}

function ReplayDialog({
  castUrl,
  contentId,
  title,
}: {
  castUrl: string | null;
  contentId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  // Fetch once on first open; reopening reuses the streamed content.
  const [requested, setRequested] = useState(false);
  const cast = useStreamedText(castUrl, requested);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRequested(true);
        }
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            <Play className="size-3.5" />
            Replay
          </Button>
        }
      />
      <DialogContent className="sm:max-w-5xl">
        <DialogTitle className="font-heading text-base">{title}</DialogTitle>
        {castUrl === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            The replay for this session is still uploading.
          </p>
        ) : cast.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {cast.error}
          </div>
        ) : (
          <ReplayDialogBody cast={cast} contentId={contentId} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReplayDialogBody({
  cast,
  contentId,
}: {
  cast: ReturnType<typeof useStreamedText>;
  contentId: string;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const commands = useMemo(
    () =>
      cast.content && !cast.loading ? parseReplayCommandLog(cast.content) : [],
    [cast.content, cast.loading],
  );

  return (
    <div className="space-y-3">
      <AsciicastReplaySurface
        contentId={contentId}
        content={cast.content}
        loading={cast.loading}
        minimal
      />
      {commands.length ? (
        <div className="rounded-md border">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
            onClick={() => setLogOpen((current) => !current)}
            aria-expanded={logOpen}
          >
            <span className="flex items-center gap-2 text-sm">
              <TerminalSquare className="size-4 text-muted-foreground" />
              Command log
              <span className="text-caption text-muted-foreground">
                {commands.length} input{commands.length === 1 ? "" : "s"}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                logOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
          {logOpen ? (
            <ol className="max-h-60 space-y-1.5 overflow-y-auto border-t p-3">
              {commands.map((entry, index) => (
                <li
                  key={`${entry.atSeconds}-${index}`}
                  className="flex items-start gap-3 rounded-md bg-muted/30 px-3 py-1.5"
                >
                  <span className="mt-0.5 font-mono text-[0.7rem] text-muted-foreground tabular-nums">
                    {formatReplayTimestamp(entry.atSeconds)}
                  </span>
                  <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
                    {entry.text}
                  </pre>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
