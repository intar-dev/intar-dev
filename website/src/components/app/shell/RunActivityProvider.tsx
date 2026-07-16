import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMyRuns, type MyRunEntry } from "../hooks/useMyRuns";

type RunNoticeTone = "info" | "success" | "error";

export interface RunActivityNotice {
  id: string;
  title: string;
  description?: string;
  tone?: RunNoticeTone;
  runId?: string;
  actionLabel?: string;
}

interface RunActivityContextValue {
  notify: (notice: RunActivityNotice) => void;
}

const RunActivityContext = createContext<RunActivityContextValue | null>(null);
const MAX_VISIBLE_NOTICES = 3;

export function RunActivityProvider({ children }: { children: ReactNode }) {
  const runs = useMyRuns();
  const [notices, setNotices] = useState<RunActivityNotice[]>([]);
  const [announcement, setAnnouncement] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const announcementSequenceRef = useRef(0);
  const previousRunsRef = useRef<Map<string, MyRunEntry> | null>(null);
  const announcedRef = useRef(new Set<string>());

  const notify = useCallback((notice: RunActivityNotice) => {
    setNotices((current) => [
      ...current.filter((entry) => entry.id !== notice.id),
      notice,
    ]);
    announcementSequenceRef.current += 1;
    setAnnouncement({
      id: announcementSequenceRef.current,
      text: [notice.title, notice.description].filter(Boolean).join(" "),
    });
  }, []);

  useEffect(() => {
    const entries = runs.data?.runs;
    if (!entries) return;

    const next = new Map(entries.map((run) => [run.runId, run]));
    const previous = previousRunsRef.current;
    previousRunsRef.current = next;
    if (!previous) return;

    for (const run of entries) {
      const before = previous.get(run.runId);
      if (!before) {
        if (run.activity === "foreground" && isWorkspaceReady(run.phase)) {
          notifyOnce(announcedRef.current, `ready:${run.runId}`, notify, {
            id: `ready:${run.runId}`,
            title: "Workspace ready.",
            description: `${run.title} is ready for repair.`,
            tone: "success",
            runId: run.runId,
            actionLabel: "Open run",
          });
        } else if (run.activity === "settled") {
          notifyOnce(
            announcedRef.current,
            `settled:${run.runId}`,
            notify,
            run.phase === "failed"
              ? failedRunNotice(run)
              : completionNotice(run),
          );
        }
        continue;
      }

      const becameReady =
        run.activity === "foreground" &&
        isWorkspaceReady(run.phase) &&
        !isWorkspaceReady(before.phase);
      if (becameReady) {
        notifyOnce(announcedRef.current, `ready:${run.runId}`, notify, {
          id: `ready:${run.runId}`,
          title: "Workspace ready.",
          description: `${run.title} is ready for repair.`,
          tone: "success",
          runId: run.runId,
          actionLabel: "Open run",
        });
      }

      const becameSettled =
        before.activity !== "settled" && run.activity === "settled";
      if (becameSettled) {
        notifyOnce(
          announcedRef.current,
          `settled:${run.runId}`,
          notify,
          run.phase === "failed"
            ? failedRunNotice(run)
            : completionNotice(run),
        );
      } else if (
        before.phase !== "failed" &&
        run.phase === "failed" &&
        run.activity === "settled"
      ) {
        notifyOnce(
          announcedRef.current,
          `failed:${run.runId}`,
          notify,
          failedRunNotice(run),
        );
      }
    }
  }, [notify, runs.data?.runs]);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <RunActivityContext.Provider value={value}>
      {children}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement ? (
          <span key={announcement.id}>{announcement.text}</span>
        ) : null}
      </p>
      <div className="pointer-events-none fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[70] flex flex-col items-end gap-2 sm:left-auto sm:w-[24rem]">
        {notices.slice(-MAX_VISIBLE_NOTICES).map((notice) => (
          <RunNotice
            key={notice.id}
            notice={notice}
            onDismiss={() =>
              setNotices((current) =>
                current.filter((entry) => entry.id !== notice.id),
              )
            }
          />
        ))}
      </div>
    </RunActivityContext.Provider>
  );
}

export function useRunActivity() {
  const value = useContext(RunActivityContext);
  if (!value) {
    throw new Error("useRunActivity must be used inside RunActivityProvider");
  }
  return value;
}

function RunNotice(props: {
  notice: RunActivityNotice;
  onDismiss: () => void;
}) {
  const tone = props.notice.tone ?? "info";
  const Icon =
    tone === "success" ? CheckCircle2 : tone === "error" ? AlertCircle : Info;
  return (
    <section
      className={cn(
        "pointer-events-auto w-full rounded-lg border bg-card p-3 shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
        tone === "success" && "border-success/35",
        tone === "error" && "border-destructive/35",
      )}
      aria-label={props.notice.title}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-1 size-4 shrink-0",
            tone === "success"
              ? "text-success"
              : tone === "error"
                ? "text-destructive"
                : "text-primary",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{props.notice.title}</p>
          {props.notice.description ? (
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {props.notice.description}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-m-1 min-h-11 min-w-11 shrink-0 text-muted-foreground"
          onClick={props.onDismiss}
          aria-label={`Dismiss ${props.notice.title}`}
        >
          <X className="size-4" />
        </Button>
      </div>
      {props.notice.runId ? (
        <div className="mt-2 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            render={
              <Link
                to="/runs/$runId"
                params={{ runId: props.notice.runId }}
              />
            }
          >
            {props.notice.actionLabel ?? "View run"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function completionNotice(run: MyRunEntry): RunActivityNotice {
  if (run.replayState === "ready") {
    return {
      id: `settled:${run.runId}`,
      title: "Run saved. Replay is ready.",
      tone: "success",
      runId: run.runId,
      actionLabel: "View replay",
    };
  }
  if (run.replayState === "failed") {
    return {
      id: `settled:${run.runId}`,
      title: "Run saved, but the replay could not be prepared.",
      tone: "error",
      runId: run.runId,
      actionLabel: "View run",
    };
  }
  return {
    id: `settled:${run.runId}`,
    title: "Run saved. No terminal session was recorded.",
    tone: "success",
    runId: run.runId,
    actionLabel: "View run",
  };
}

function failedRunNotice(run: MyRunEntry): RunActivityNotice {
  return {
    id: `failed:${run.runId}`,
    title: "Run ended with an error.",
    description:
      "Open the run to review what failed and the available next action.",
    tone: "error",
    runId: run.runId,
    actionLabel: "View run",
  };
}

function notifyOnce(
  announced: Set<string>,
  key: string,
  notify: (notice: RunActivityNotice) => void,
  notice: RunActivityNotice,
) {
  if (announced.has(key)) return;
  announced.add(key);
  notify(notice);
}

function isWorkspaceReady(phase: string) {
  return (
    phase === "active_partial" ||
    phase === "active_full" ||
    phase === "solved"
  );
}
