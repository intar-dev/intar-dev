import "asciinema-player/dist/bundle/asciinema-player.css";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Compartment, EditorState } from "@codemirror/state";
import { search, searchKeymap } from "@codemirror/search";
import {
  EditorView,
  keymap,
  lineNumbers,
  type KeyBinding,
} from "@codemirror/view";
import type { AsciinemaPlayerInstance } from "asciinema-player";
import { Badge } from "@/components/ui/badge";
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
  REPLAY_TERMINAL_THEME,
} from "@/lib/replay/config";

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

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "#e5e7eb",
      background: "#111827",
      fontSize: "0.79rem",
    },
    ".cm-scroller": {
      fontFamily:
        '"SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
      lineHeight: "1.65",
    },
    ".cm-content": {
      padding: "1rem 0 1.25rem",
      caretColor: "transparent",
    },
    ".cm-focused": {
      outline: "none",
    },
    ".cm-line": {
      padding: "0 1rem 0 0.875rem",
    },
    ".cm-gutters": {
      background: "#1f2937",
      color: "#9ca3af",
      border: "none",
      paddingRight: "0.25rem",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      background: "transparent",
    },
    ".cm-selectionBackground, ::selection": {
      background: "rgba(148, 163, 184, 0.3)",
    },
    ".cm-searchMatch": {
      background: "rgba(255, 255, 255, 0.08)",
      outline: "1px solid rgba(255, 255, 255, 0.14)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      background: "rgba(255, 255, 255, 0.14)",
    },
    ".cm-panels": {
      background: "#1f2937",
      color: "#e5e7eb",
      borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
    },
    ".cm-button": {
      color: "inherit",
      background: "#374151",
      border: "1px solid rgba(255, 255, 255, 0.14)",
      borderRadius: "0.375rem",
    },
    ".cm-textfield": {
      background: "#111827",
      color: "inherit",
      border: "1px solid rgba(255, 255, 255, 0.14)",
      borderRadius: "0.375rem",
    },
  },
  { dark: true },
);

// Vite dedupes CodeMirror at build time, but the published searchKeymap type can
// still resolve through a nested @codemirror/view install during type-checking.
const readOnlySearchKeymap = searchKeymap as unknown as readonly KeyBinding[];

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
  const lineCount = useMemo(
    () => countLines(viewer?.content ?? ""),
    [viewer?.content],
  );
  const progressLabel = viewer
    ? viewer.loading
      ? `Streaming ${formatBytes(viewer.receivedBytes)} of ${formatBytes(viewer.artifact.sizeBytes)}`
      : "Stream complete"
    : "No file selected";

  useEffect(() => {
    setWrapText(true);
    setCopyState("idle");
    if (viewer) {
      setCastTab(isCastArtifact(viewer.artifact) ? "replay" : "raw");
    }
  }, [artifactId]);

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
        ) : isCast ? (
          <AsciicastReplaySurface viewer={viewer} minimal />
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
            <div className="flex flex-wrap items-center gap-2">
              <MetaPill label={formatBytes(viewer.artifact.sizeBytes)} />
              {!hideInternalMetadata ? (
                <>
                  <MetaPill label={`#${viewer.artifact.ordinal}`} />
                  <MetaPill label={artifactKindLabel(viewer.artifact.kind)} />
                  <MetaPill label={viewer.artifact.contentType} subdued />
                </>
              ) : null}
              {!isCast || castTab === "raw" ? (
                <MetaPill label={`${lineCount} lines`} subdued />
              ) : null}
            </div>
          ) : null}
        </div>

        {viewer && !hideViewerControls ? (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {isCast ? (
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
                      : "Copy file"}
                </Button>
                <Button
                  type="button"
                  variant={wrapText ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={wrapText}
                  onClick={() => setWrapText((current) => !current)}
                  disabled={isCast && castTab === "replay"}
                >
                  Wrap {wrapText ? "On" : "Off"}
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                Text panes support selection and `Cmd/Ctrl+F`.
              </span>
            </div>
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="pt-0">
        <div className="min-h-[22rem] rounded-lg border bg-muted/20">
          {!viewer ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center px-6 py-10 text-center">
              <p className="text-sm font-medium">Artifacts open inline.</p>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Logs use a read-only text viewer and cast files replay inline,
                with a raw fallback when needed.
              </p>
            </div>
          ) : viewer.error ? (
            <div className="flex min-h-[22rem] items-center justify-center px-6 py-10">
              <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
                {viewer.error}
              </div>
            </div>
          ) : isCast && (hideViewerControls || castTab === "replay") ? (
            <AsciicastReplaySurface viewer={viewer} />
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
            {isCast && castTab === "replay"
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

function AsciicastReplaySurface({
  viewer,
  minimal = false,
}: {
  viewer: RunArtifactViewerState;
  minimal?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<AsciinemaPlayerInstance | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  useEffect(() => {
    setPlayerError(null);
  }, [viewer.artifact.id]);

  useEffect(() => {
    if (viewer.loading || !viewer.content.trim() || !containerRef.current) {
      return;
    }

    let cancelled = false;

    const mountPlayer = async () => {
      try {
        const mod = await import("asciinema-player");
        if (cancelled || !containerRef.current) {
          return;
        }

        playerRef.current?.dispose?.();
        containerRef.current.innerHTML = "";

        playerRef.current = mod.create(
          { data: viewer.content },
          containerRef.current,
          {
            autoPlay: false,
            preload: true,
            controls: true,
            fit: "width",
            idleTimeLimit: REPLAY_IDLE_TIME_LIMIT_SECONDS,
            terminalFontFamily: REPLAY_TERMINAL_FONT_FAMILY,
            theme: REPLAY_TERMINAL_THEME,
          },
        );
        playerRef.current.addEventListener("ready", () => {
          setPlayerError(null);
        });
        // The player throws from addEventListener for unknown event names,
        // and its error event is named "error" (not "errored") - the wrong
        // name unmounted every successfully created player.
        playerRef.current.addEventListener("error", () => {
          setPlayerError(
            "asciinema player failed to initialize this recording",
          );
        });
      } catch (error) {
        setPlayerError(
          error instanceof Error
            ? error.message
            : "failed to initialize cast replay",
        );
      }
    };

    void mountPlayer();

    return () => {
      cancelled = true;
      playerRef.current?.dispose?.();
      playerRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [viewer.content, viewer.loading]);

  if (playerError) {
    return (
      <div className="flex min-h-[22rem] items-center justify-center px-6 py-10">
        <div className="max-w-lg rounded-lg border border-destructive/40 bg-destructive/10 px-5 py-4 text-sm text-destructive">
          {playerError}
        </div>
      </div>
    );
  }

  if (viewer.loading) {
    return (
      <div className="flex min-h-[22rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="h-2 w-44 overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-1/3 rounded-full bg-primary motion-safe:animate-pulse" />
        </div>
        <p className="text-sm font-medium">
          {minimal ? "Preparing replay" : "Preparing replay surface"}
        </p>
        {!minimal ? (
          <p className="max-w-md text-sm leading-6 text-muted-foreground">
            Cast playback waits for the complete `.cast` stream so timing and
            frame boundaries stay correct. The Raw tab remains available while
            bytes are arriving.
          </p>
        ) : null}
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
        <div className="min-h-[20rem] px-0 py-0 sm:px-0 sm:py-0">
          <div
            ref={containerRef}
            className="run-artifact-player mx-auto min-h-[18rem] w-full [&_.ap-player]:mx-auto [&_.ap-player]:max-w-full"
          />
        </div>
      </div>
    </div>
  );
}

function ReadOnlyTextSurface({
  content,
  loading,
  wrapText,
}: {
  content: string;
  loading: boolean;
  wrapText: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef(new Compartment());
  const deferredContent = useDeferredValue(content);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) {
      return;
    }

    editorRef.current = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: deferredContent,
        extensions: [
          lineNumbers(),
          search({ top: true }),
          keymap.of(readOnlySearchKeymap),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          wrapCompartmentRef.current.of(
            wrapText ? EditorView.lineWrapping : [],
          ),
          editorTheme,
        ],
      }),
    });

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [deferredContent, wrapText]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const current = editor.state.doc.toString();
    if (current === deferredContent) {
      return;
    }

    if (deferredContent.startsWith(current)) {
      editor.dispatch({
        changes: {
          from: current.length,
          to: current.length,
          insert: deferredContent.slice(current.length),
        },
      });
      return;
    }

    editor.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: deferredContent,
      },
    });
  }, [deferredContent]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(
        wrapText ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrapText]);

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-md border bg-background">
        <div className="border-b px-4 py-2 text-sm text-muted-foreground">
          {loading ? "Streaming text" : "Archived text"}
        </div>
        <div
          ref={containerRef}
          className="min-h-[20rem] max-h-[32rem] overflow-auto"
        />
      </div>
    </div>
  );
}

function MetaPill({
  label,
  subdued = false,
}: {
  label: string;
  subdued?: boolean;
}) {
  return <Badge variant={subdued ? "outline" : "secondary"}>{label}</Badge>;
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
    artifact.kind === "ssh_recording" ||
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
    case "ssh_recording":
      return "Replay Cast";
    case "ssh_recording_segment":
      return "Cast Segment";
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
