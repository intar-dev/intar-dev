import "asciinema-player/dist/bundle/asciinema-player.css";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { AsciinemaPlayerInstance } from "asciinema-player";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  REPLAY_IDLE_TIME_LIMIT_SECONDS,
  REPLAY_TERMINAL_FONT_FAMILY,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_THEME,
} from "@/lib/replay/config";
import { cn } from "@/lib/utils";

export interface RunArtifactFile {
  id: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadStatus: string;
  uploadedAt: number | null;
}

export interface RunArtifactViewerState {
  artifact: RunArtifactFile;
  loading: boolean;
  error: string | null;
  content: string;
  receivedBytes: number;
  /** True when the inline text is a bounded preview of a larger artifact. */
  previewTruncated?: boolean;
  /** Same-origin URL for downloading the complete artifact. */
  downloadUrl?: string;
}

interface RunArtifactViewerProps {
  viewer: RunArtifactViewerState | null;
  title?: string;
  selectedLabel?: string | null;
  emptyLabel?: string;
  emptyDescription?: string;
  hideInternalMetadata?: boolean;
  hideViewerControls?: boolean;
  minimalCastReplay?: boolean;
}

type CastTab = "replay" | "raw";

export function RunArtifactViewer({
  viewer,
  title = "File viewer",
  selectedLabel,
  emptyLabel = "Select an artifact",
  emptyDescription = "Open a log or cast from the run ledger to inspect it here.",
  hideInternalMetadata = false,
  hideViewerControls = false,
  minimalCastReplay = false,
}: RunArtifactViewerProps) {
  const [wrapText, setWrapText] = useState(true);
  const [castTab, setCastTab] = useState<CastTab>("replay");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const copyResetTimeoutRef = useRef<number | null>(null);

  const artifactId = viewer?.artifact.id ?? null;
  const isCast = viewer ? isCastArtifact(viewer.artifact) : false;
  const canReplay = isCast && !viewer?.previewTruncated;
  const lineCount = useMemo(
    () => countLines(viewer?.content ?? ""),
    [viewer?.content],
  );
  const progressLabel = viewer
    ? viewer.loading
      ? `Streaming ${formatBytes(viewer.receivedBytes)} of ${formatBytes(viewer.artifact.sizeBytes)}`
      : viewer.previewTruncated
        ? `Previewing ${formatBytes(viewer.receivedBytes)} of ${formatBytes(viewer.artifact.sizeBytes)}`
        : "Stream complete"
    : "No file selected";

  useEffect(() => {
    setWrapText(true);
    setCopyState("idle");
    if (viewer) {
      setCastTab(
        isCastArtifact(viewer.artifact) && !viewer.previewTruncated
          ? "replay"
          : "raw",
      );
    }
  }, [artifactId, viewer?.previewTruncated]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
    };
  }, []);

  const copyContent = async () => {
    if (!viewer?.content) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyState("error");
      return;
    }

    try {
      await navigator.clipboard.writeText(viewer.content);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimeoutRef.current = null;
    }, 1800);
  };

  if (minimalCastReplay) {
    return (
      <section>
        {!viewer ? (
          <div className="flex min-h-[22rem] items-center justify-center text-center">
            <p className="text-sm text-muted-foreground">Replay unavailable.</p>
          </div>
        ) : viewer.error ? (
          <div className="flex min-h-[22rem] items-center justify-center">
            <div className="max-w-lg text-sm text-destructive">
              {viewer.error}
            </div>
          </div>
        ) : canReplay ? (
          <AsciicastReplaySurface
            contentId={viewer.artifact.id}
            content={viewer.content}
            loading={viewer.loading}
            minimal
          />
        ) : (
          <div className="flex min-h-[22rem] items-center justify-center text-center">
            <p className="text-sm text-muted-foreground">Replay unavailable.</p>
          </div>
        )}
      </section>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <CardDescription>{title}</CardDescription>
            <div className="space-y-1">
              <CardTitle className="text-base sm:text-lg">
                {viewer
                  ? (selectedLabel ?? viewer.artifact.filename)
                  : emptyLabel}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                {viewer ? progressLabel : emptyDescription}
              </p>
            </div>
          </div>

          {viewer ? (
            <dl className="flex max-w-2xl flex-wrap items-start gap-x-4 gap-y-2 text-xs">
              <ArtifactMeta label="Size" value={formatBytes(viewer.artifact.sizeBytes)} />
              {!hideInternalMetadata ? (
                <>
                  <ArtifactMeta label="Order" value={`#${viewer.artifact.ordinal}`} />
                  <ArtifactMeta label="Kind" value={artifactKindLabel(viewer.artifact.kind)} />
                  <ArtifactMeta label="Type" value={viewer.artifact.contentType} subdued />
                </>
              ) : null}
              {!isCast || castTab === "raw" ? (
                <ArtifactMeta label="Length" value={`${lineCount} lines`} subdued />
              ) : null}
            </dl>
          ) : null}
        </div>

        {viewer && !hideViewerControls ? (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {canReplay ? (
                <>
                  <ToolbarTab
                    active={castTab === "replay"}
                    onClick={() => setCastTab("replay")}
                  >
                    Replay
                  </ToolbarTab>
                  <ToolbarTab
                    active={castTab === "raw"}
                    onClick={() => setCastTab("raw")}
                  >
                    Raw
                  </ToolbarTab>
                </>
              ) : null}
            </div>

            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant={
                    copyState === "copied"
                      ? "secondary"
                      : copyState === "error"
                        ? "destructive"
                        : "outline"
                  }
                  size="sm"
                  onClick={() => void copyContent()}
                  disabled={!viewer.content}
                >
                  {copyState === "copied" ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                  {copyState === "copied"
                    ? "Copied"
                    : copyState === "error"
                      ? "Copy failed"
                      : viewer.previewTruncated
                        ? "Copy preview"
                        : "Copy file"}
                </Button>
                {viewer.downloadUrl ? (
                  <Button
                    variant="outline"
                    size="sm"
                    render={
                      <a
                        href={viewer.downloadUrl}
                        download={viewer.artifact.filename}
                      />
                    }
                  >
                    Download full file
                  </Button>
                ) : null}
                <span
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="sr-only"
                >
                  {copyState === "copied"
                    ? "File content copied."
                    : copyState === "error"
                      ? "File content could not be copied."
                      : ""}
                </span>
                <Button
                  type="button"
                  variant={wrapText ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={wrapText}
                  onClick={() => setWrapText((current) => !current)}
                  disabled={canReplay && castTab === "replay"}
                >
                  Wrap {wrapText ? "On" : "Off"}
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {viewer.previewTruncated
                  ? "The inline preview is capped for speed. Download the full file when needed."
                  : "Text panes support selection and `Cmd/Ctrl+F`."}
              </span>
            </div>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="pt-0">
        <div className="min-h-[22rem] rounded-lg border bg-muted/20">
          {!viewer ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center px-6 py-8 text-center">
              <p className="text-sm font-medium">Artifacts open inline.</p>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Logs use a read-only text viewer and cast files replay inline,
                with a raw fallback when needed.
              </p>
            </div>
          ) : viewer.error ? (
            <div className="flex min-h-[22rem] items-center justify-center px-6 py-8">
              <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
                {viewer.error}
              </div>
            </div>
          ) : canReplay && (hideViewerControls || castTab === "replay") ? (
            <AsciicastReplaySurface
              contentId={viewer.artifact.id}
              content={viewer.content}
              loading={viewer.loading}
            />
          ) : (
            <ReadOnlyTextSurface
              content={viewer.content}
              wrapText={wrapText}
              loading={viewer.loading}
            />
          )}
        </div>
      </CardContent>

      {viewer ? (
        <CardFooter className="flex flex-col items-start gap-1 border-t bg-muted/10 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>{progressLabel}</span>
          <span>
            {canReplay && castTab === "replay"
              ? viewer.loading
                ? "Replay starts when the full cast arrives. Use Raw for live bytes."
                : "Replay is interactive and backed by the archived cast file."
              : `${lineCount} lines • ${formatBytes(viewer.receivedBytes || viewer.artifact.sizeBytes)}`}
          </span>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function AsciicastReplaySurface({
  contentId,
  content,
  loading,
  minimal = false,
}: {
  /** Stable identity of the cast (e.g. artifact id); resets error state. */
  contentId: string;
  content: string;
  loading: boolean;
  minimal?: boolean;
}) {
  const [playerError, setPlayerError] = useState<string | null>(null);

  const handlePlayerReady = useCallback(() => {
    setPlayerError(null);
  }, []);
  const handlePlayerError = useCallback((message: string) => {
    setPlayerError(message);
  }, []);

  useEffect(() => {
    setPlayerError(null);
  }, [contentId]);

  if (playerError) {
    return (
      <div className={minimal ? "p-0" : "p-4"}>
        <div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted/20 px-6">
          <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-4 text-sm text-destructive">
            {replayPlayerErrorCopy(playerError, minimal)}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={minimal ? "p-0" : "p-4"}>
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-md bg-muted/20 px-6 text-center">
          <div className="h-2 w-44 overflow-hidden rounded-full bg-secondary">
            <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
          </div>
          <p className="text-sm font-medium">
            {minimal ? "Preparing replay" : "Preparing replay surface"}
          </p>
          {!minimal ? (
            <p className="max-w-md text-sm leading-6 text-muted-foreground">
              Cast playback waits for the complete `.cast` stream so timing and
              frame boundaries stay correct. The Raw tab remains available
              while bytes are arriving.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={minimal ? "p-0" : "p-4"}>
      <div
        className={
          minimal ? "" : "overflow-hidden rounded-md border bg-background"
        }
      >
        <MountedAsciicastPlayer
          key={contentId}
          content={content}
          onReady={handlePlayerReady}
          onError={handlePlayerError}
        />
      </div>
    </div>
  );
}

function MountedAsciicastPlayer({
  content,
  onReady,
  onError,
}: {
  content: string;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<AsciinemaPlayerInstance | null>(null);

  useEffect(() => {
    if (!content.trim() || !containerRef.current) {
      return;
    }

    let cancelled = false;

    const mountPlayer = async () => {
      try {
        const mod = await import("asciinema-player");
        if (cancelled || !containerRef.current) {
          return;
        }

        const player = mod.create(
          { data: content },
          containerRef.current,
          {
            autoPlay: false,
            preload: true,
            controls: true,
            // The cast plays at its recorded geometry: the player fills the
            // container width and derives its height from the cast's rows,
            // preserving the original aspect ratio.
            fit: "width",
            terminalLineHeight: REPLAY_TERMINAL_LINE_HEIGHT,
            idleTimeLimit: REPLAY_IDLE_TIME_LIMIT_SECONDS,
            terminalFontFamily: REPLAY_TERMINAL_FONT_FAMILY,
            theme: REPLAY_TERMINAL_THEME,
          },
        );
        playerRef.current = player;
        player.addEventListener("ready", () => {
          if (!cancelled && playerRef.current === player) {
            onReady();
          }
        });
        // The player throws from addEventListener for unknown event names,
        // and its error event is named "error" (not "errored").
        player.addEventListener("error", () => {
          if (!cancelled && playerRef.current === player) {
            onError("asciinema player failed to initialize this recording");
          }
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        onError(
          error instanceof Error
            ? error.message
            : "failed to initialize cast replay",
        );
      }
    };

    void mountPlayer();

    return () => {
      cancelled = true;
      const player = playerRef.current;
      playerRef.current = null;
      player?.dispose?.();
    };
  }, [content, onError, onReady]);

  return (
    <div
      ref={containerRef}
      className="run-artifact-player w-full overflow-hidden rounded-md bg-terminal-background [&_.ap-player]:w-full"
    />
  );
}

export function replayPlayerErrorCopy(error: string, minimal: boolean) {
  return minimal ? "Replay could not be loaded. Try again soon." : error;
}

export function ReadOnlyTextSurface({
  content,
  loading,
  wrapText,
  compact = false,
}: {
  content: string;
  loading: boolean;
  wrapText: boolean;
  /** Slim variant for inline embeds: no outer padding or status bar. */
  compact?: boolean;
}) {
  const deferredContent = useDeferredValue(content);

  const textPane = (
    <div className="relative">
      <pre
        tabIndex={0}
        aria-label="Artifact text content"
        aria-busy={loading}
        className={cn(
          "m-0 overflow-auto bg-terminal-background px-3 py-4 font-mono text-[0.79rem] leading-[1.65] text-terminal-foreground outline-none selection:bg-terminal-brand/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          wrapText ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          compact
            ? "min-h-[4rem] max-h-[22rem]"
            : "min-h-[20rem] max-h-[32rem]",
        )}
      >
        <code>{deferredContent}</code>
      </pre>
      {!deferredContent ? (
        <p className="pointer-events-none absolute inset-x-3 top-4 text-sm text-terminal-muted">
          {loading ? "Waiting for text…" : "This artifact is empty."}
        </p>
      ) : null}
    </div>
  );

  if (compact) {
    return (
      <div className="overflow-hidden rounded-md border bg-background">
        {textPane}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-md border bg-background">
        <div className="border-b px-4 py-2 text-sm text-muted-foreground">
          {loading ? "Streaming text" : "Archived text"}
        </div>
        {textPane}
      </div>
    </div>
  );
}

function ArtifactMeta({
  label,
  value,
  subdued = false,
}: {
  label: string;
  value: string;
  subdued?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-all",
          subdued ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ToolbarTab({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function isCastArtifact(artifact: RunArtifactFile) {
  return (
    artifact.kind === "ssh_recording_segment" ||
    artifact.contentType.includes("asciicast") ||
    artifact.filename.endsWith(".cast")
  );
}

function artifactKindLabel(kind: string) {
  switch (kind) {
    case "console_log":
      return "Console Log";
    case "serial_log":
      return "Serial Log";
    case "ssh_recording_segment":
      return "Session Cast";
    case "ssh_recording_raw":
      return "Raw Recording";
    default:
      return kind.replace(/_/g, " ");
  }
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function countLines(content: string) {
  if (!content) {
    return 0;
  }
  return content.split(/\r\n|\r|\n/).length;
}
