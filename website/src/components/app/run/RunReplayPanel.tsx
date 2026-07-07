import { useMemo, useState } from "react";
import { ChevronDown, TerminalSquare } from "lucide-react";
import {
  RunArtifactViewer,
  type RunArtifactViewerState,
} from "@/components/app/RunArtifactViewer";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatReplayTimestamp,
  parseReplayCommandLog,
} from "@/lib/replay-command-log";
import { cn } from "@/lib/utils";

// Replay player plus a collapsible log of everything the learner typed,
// parsed from the cast's input events.
export function RunReplayPanel({
  viewer,
}: {
  viewer: RunArtifactViewerState | null;
}) {
  const [open, setOpen] = useState(false);
  const commands = useMemo(
    () => (viewer?.content ? parseReplayCommandLog(viewer.content) : []),
    [viewer?.content],
  );

  return (
    <div className="space-y-4">
      <RunArtifactViewer viewer={viewer} minimalCastReplay />
      {commands.length ? (
        <Card>
          <CardHeader className="pb-3">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left"
              onClick={() => setOpen((current) => !current)}
              aria-expanded={open}
            >
              <span className="flex items-center gap-2">
                <TerminalSquare className="size-4 text-muted-foreground" />
                <span>
                  <CardTitle className="text-base">Command log</CardTitle>
                  <CardDescription>
                    {commands.length} input{commands.length === 1 ? "" : "s"}{" "}
                    typed during this run.
                  </CardDescription>
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
          </CardHeader>
          {open ? (
            <CardContent>
              <ol className="space-y-1.5">
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
            </CardContent>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
