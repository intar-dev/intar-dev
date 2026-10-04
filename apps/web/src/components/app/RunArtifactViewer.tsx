import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  AsciicastReplaySurface,
  replayPlayerErrorCopy,
} from "./RunArtifactViewerReplay";

export { AsciicastReplaySurface, replayPlayerErrorCopy };

// How long Copied holds: the design system's duration-flash (1600ms).
function copiedHoldMs() {
  try {
    const token = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--duration-flash",
      ),
    );
    return token > 0 ? token : 1600;
  } catch {
    return 1600;
  }
}

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
  const headingId = useId();

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
    }, copiedHoldMs());
  };

  if (minimalCastReplay) {
    return (
      <section>
        {!viewer ? (
          <div className="flex min-h-[22rem] items-center justify-center text-center">
            <p className="text-support text-muted-foreground">Replay unavailable.</p>
          </div>
        ) : viewer.error ? (
          <div className="flex min-h-[22rem] items-center justify-center">
            <Alert variant="destructive" just>
              <AlertDescription>{viewer.error}</AlertDescription>
            </Alert>
          </div>
        ) : canReplay ? (
          <AsciicastReplaySurface
            contentId={viewer.artifact.id}
            content={viewer.content}
            loading={viewer.loading}
            label={`Terminal replay of ${viewer.artifact.filename}`}
            minimal
          />
        ) : (
          <div className="flex min-h-[22rem] items-center justify-center text-center">
            <p className="text-support text-muted-foreground">Replay unavailable.</p>
          </div>
        )}
      </section>
    );
  }

  return (
    // Only ever embedded in a run row inside a card, so it is a plain section
    // on that panel (a raised card here would sit on another raised card).
    <section aria-labelledby={headingId} className="space-y-4 border-t pt-4">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="text-label">{title}</p>
            <h4 id={headingId} className="text-card-title">
              {viewer
                ? (selectedLabel ?? viewer.artifact.filename)
                : emptyLabel}
            </h4>
            <p className="text-support text-muted-foreground">
              {viewer ? progressLabel : emptyDescription}
            </p>
          </div>

          {viewer ? (
            <dl className="flex flex-wrap items-start gap-x-3 gap-y-1 text-caption">
              <ArtifactMeta label="Size" value={formatBytes(viewer.artifact.sizeBytes)} />
              {!hideInternalMetadata ? (
                <>
                  <ArtifactMeta label="Order" value={`#${viewer.artifact.ordinal}`} />
                  <ArtifactMeta label="Kind" value={artifactKindLabel(viewer.artifact.kind)} />
                  <ArtifactMeta label="Type" value={viewer.artifact.contentType} subdued />
                </>
              ) : null}
              {!isCast || castTab === "raw" ? (
                <ArtifactMeta label="Length" value={lineCountLabel(lineCount)} subdued />
              ) : null}
            </dl>
          ) : null}
        </div>

        {viewer && !hideViewerControls ? (
          <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {canReplay ? (
                <Tabs
                  value={castTab}
                  onValueChange={(value) => setCastTab(value as CastTab)}
                >
                  <TabsList aria-label="View">
                    <TabsTrigger value="replay">Replay</TabsTrigger>
                    <TabsTrigger value="raw">Raw</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
            </div>

            <div className="flex flex-col items-start gap-2 sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyContent()}
                  disabled={!viewer.content}
                >
                  {/* Every label shares one cell, so the button keeps the
                      width of its widest state and Download never shifts. */}
                  <span className="grid *:col-start-1 *:row-start-1">
                    <span className={copyLayer(copyState === "idle")}>
                      <CopyIcon className="size-3.5" />
                      {viewer.previewTruncated ? "Copy preview" : "Copy file"}
                    </span>
                    <span className={copyLayer(copyState === "copied")}>
                      <CheckIcon
                        className={cn(
                          "size-3.5",
                          copyState === "copied" && "draw-check",
                        )}
                      />
                      Copied
                    </span>
                    <span
                      className={cn(
                        copyLayer(copyState === "error"),
                        "text-destructive",
                      )}
                    >
                      Copy failed
                    </span>
                  </span>
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
              <span className="text-caption">
                {viewer.previewTruncated
                  ? "The inline preview is capped for speed. Download the full file when needed."
                  : (
                    <>
                      Text panes support selection and{" "}
                      <code className="text-code">Cmd/Ctrl+F</code>.
                    </>
                  )}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <div className="min-h-[22rem] rounded-lg border bg-muted/20">
          {!viewer ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center px-5 py-6 text-center">
              <p className="text-support font-medium">Artifacts open inline.</p>
              <p className="mt-1 text-support text-muted-foreground">
                Logs use a read-only text viewer and cast files replay inline,
                with a raw fallback when needed.
              </p>
            </div>
          ) : viewer.error ? (
            <div className="flex min-h-[22rem] items-center justify-center px-5 py-6">
              <Alert variant="destructive" just className="max-w-xl">
                <AlertDescription>{viewer.error}</AlertDescription>
              </Alert>
            </div>
          ) : canReplay && (hideViewerControls || castTab === "replay") ? (
            <AsciicastReplaySurface
              contentId={viewer.artifact.id}
              content={viewer.content}
              loading={viewer.loading}
              label={`Terminal replay of ${viewer.artifact.filename}`}
            />
          ) : (
            <ReadOnlyTextSurface
              content={viewer.content}
              wrapText={wrapText}
              loading={viewer.loading}
            />
          )}
        </div>
      </div>

      {viewer ? (
        <div className="rounded-b-lg border-t bg-muted/40 px-4 py-3 text-caption">
          {canReplay && castTab === "replay" ? (
            <p>
              {viewer.loading
                ? "Replay starts when the full cast arrives. Use Raw for live bytes."
                : "Replay is interactive and backed by the archived cast file."}
            </p>
          ) : (
            <MetaLine
              items={[
                lineCountLabel(lineCount),
                formatBytes(viewer.receivedBytes || viewer.artifact.sizeBytes),
              ]}
            />
          )}
        </div>
      ) : null}
    </section>
  );
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
          "m-0 overflow-auto bg-terminal-background px-3 py-4 text-code text-terminal-foreground outline-none selection:bg-terminal-brand/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          wrapText ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          compact
            ? "min-h-[4rem] max-h-[22rem]"
            : "min-h-[20rem] max-h-[32rem]",
        )}
      >
        <code>{deferredContent}</code>
      </pre>
      {!deferredContent ? (
        <p className="pointer-events-none absolute inset-x-3 top-4 text-support text-terminal-muted">
          {loading ? "Waiting for text…" : "This artifact is empty."}
        </p>
      ) : null}
    </div>
  );

  if (compact) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        {textPane}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-2 text-support text-muted-foreground">
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

/** One layer of the Copy button's label stack (the active one is visible). */
function copyLayer(active: boolean) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 transition-opacity",
    active
      ? "duration-(--duration-moderate) ease-enter"
      : "invisible opacity-0 duration-(--duration-fast) ease-exit",
  );
}

function lineCountLabel(count: number) {
  return `${count} ${count === 1 ? "line" : "lines"}`;
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
      return "Console log";
    case "serial_log":
      return "Serial log";
    case "ssh_recording_segment":
      return "Session cast";
    case "ssh_recording_raw":
      return "Raw recording";
    default: {
      const words = kind.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
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
