import { useMemo, useState } from "react";
import { ChevronDown, TerminalSquare } from "lucide-react";
import {
  AsciicastReplaySurface,
  ReadOnlyTextSurface,
} from "@/components/app/RunArtifactViewer";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { MetaChip } from "@/components/app/patterns/MetaChip";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  formatReplayTimestamp,
  parseReplayCommandLog,
} from "@/lib/replay-command-log";
import { formatScenarioDurationMs } from "@/components/app/run/run-support";
import type {
  ScenarioReplayArtifact,
  ScenarioRunVmRecord,
  SessionTimelineEntry,
} from "@/components/app/run/run-types";
import { useStreamedText } from "@/components/app/run/useStreamedText";
import { cn } from "@/lib/utils";

/** Gaps shorter than this render as an immediate reconnect. */
const MIN_VISIBLE_GAP_MS = 1_000;

/**
 * The completed-run replay area: one card per SSH session in chronological
 * order, with the reconnect gap called out between cards. Session metadata
 * comes from `vm.sessionTimeline` (already part of the polled run record);
 * each session's cast and transcript are fetched lazily when their tab is
 * shown.
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
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-md bg-[#121314] px-6 text-center">
        <div className="h-2 w-44 overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
        <p className="text-sm font-medium text-white/85">
          Rendering session timeline
        </p>
        <p className="max-w-md text-sm leading-6 text-white/55">
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
            <SessionCard
              runId={runId}
              vmId={vm?.id ?? ""}
              session={session}
              sessionCount={sessions.length}
              castArtifact={
                vm?.replayArtifacts.find(
                  (artifact) =>
                    artifact.kind === "ssh_recording_segment" &&
                    artifact.filename === session.castFilename,
                ) ?? null
              }
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
    <div className="flex items-center gap-3 px-2 py-2" role="separator">
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

function SessionCard({
  runId,
  vmId,
  session,
  sessionCount,
  castArtifact,
}: {
  runId: string;
  vmId: string;
  session: SessionTimelineEntry;
  sessionCount: number;
  castArtifact: ScenarioReplayArtifact | null;
}) {
  const [activeTab, setActiveTab] = useState<"replay" | "transcript">("replay");
  const [visitedTranscript, setVisitedTranscript] = useState(false);

  const startedAt = new Date(session.startTimestampMs);
  const runSegment = encodeURIComponent(runId);
  const vmSegment = encodeURIComponent(vmId);

  const castUrl = castArtifact
    ? `/api/runs/${runSegment}/artifacts/${encodeURIComponent(castArtifact.id)}/content`
    : null;
  const transcriptUrl = `/api/runs/${runSegment}/vms/${vmSegment}/sessions/${session.index}/transcript`;

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-heading text-base">
            {sessionCount === 1 ? "Terminal session" : `Session ${session.index}`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </CardHeader>
      <CardContent>
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const tab = value === "transcript" ? "transcript" : "replay";
            setActiveTab(tab);
            if (tab === "transcript") {
              setVisitedTranscript(true);
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="replay">Replay</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>
          <TabsContent value="replay">
            <SessionReplayTab
              castUrl={castUrl}
              enabled={activeTab === "replay"}
              contentId={`${vmId}:${session.index}`}
            />
          </TabsContent>
          <TabsContent value="transcript">
            <SessionTranscriptTab
              transcriptUrl={transcriptUrl}
              enabled={visitedTranscript}
              truncated={session.transcriptTruncated}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function SessionReplayTab({
  castUrl,
  enabled,
  contentId,
}: {
  castUrl: string | null;
  enabled: boolean;
  contentId: string;
}) {
  const cast = useStreamedText(castUrl, enabled);
  const [logOpen, setLogOpen] = useState(false);
  const commands = useMemo(
    () => (cast.content && !cast.loading ? parseReplayCommandLog(cast.content) : []),
    [cast.content, cast.loading],
  );

  if (!castUrl) {
    // The timeline landed before this session's cast finished uploading;
    // the next poll of the run record fills it in.
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted/20 px-6">
        <p className="text-sm text-muted-foreground">
          The replay for this session is still uploading.
        </p>
      </div>
    );
  }

  if (cast.error) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted/20 px-6">
        <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
          {cast.error}
        </div>
      </div>
    );
  }

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
            <ol className="space-y-1.5 border-t p-3">
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

function SessionTranscriptTab({
  transcriptUrl,
  enabled,
  truncated,
}: {
  transcriptUrl: string;
  enabled: boolean;
  truncated: boolean;
}) {
  const transcript = useStreamedText(transcriptUrl, enabled);

  if (transcript.error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        {transcript.error}
      </div>
    );
  }

  return (
    <div>
      {truncated ? (
        <p className="pb-2 text-caption text-muted-foreground">
          Long session — the earliest output was trimmed from this transcript.
        </p>
      ) : null}
      <ReadOnlyTextSurface
        content={transcript.content}
        loading={transcript.loading}
        wrapText
      />
    </div>
  );
}
