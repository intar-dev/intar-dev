import { type RefObject, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Lightbulb,
  LoaderCircle,
  Terminal as TerminalIcon,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusToken } from "../../patterns/StatusToken";

// A static replica of the live run workspace (ScenarioRun + RunLearningPanel +
// WebSshTerminal) playing the broken-nginx scenario from the first course. The
// shell mirrors the real guest: the provisioned motd lists the probe labels,
// bash runs as `ubuntu` with Debian's colored prompt, and the checks flip in
// the order kino would verify them.

type CheckKey = "nginx-running" | "port-80-open" | "default-site-enabled";

const CHECKS: readonly { key: CheckKey; title: string; label: string }[] = [
  {
    key: "nginx-running",
    title: "Start the web server",
    label: "The web server is running",
  },
  {
    key: "port-80-open",
    title: "Make the site reachable",
    label: "The site is reachable",
  },
  {
    key: "default-site-enabled",
    title: "Restore the default site",
    label: "The default site is restored",
  },
];

interface ScriptStep {
  command: string;
  output?: readonly string[];
  verifies?: readonly CheckKey[];
}

const SCRIPT: readonly ScriptStep[] = [
  { command: "systemctl is-active nginx", output: ["inactive"] },
  {
    command: "sudo systemctl enable --now nginx",
    output: [
      "Synchronizing state of nginx.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.",
      "Executing: /usr/lib/systemd/systemd-sysv-install enable nginx",
      "Created symlink '/etc/systemd/system/multi-user.target.wants/nginx.service' → '/usr/lib/systemd/system/nginx.service'.",
    ],
    verifies: ["nginx-running"],
  },
  { command: "ls /etc/nginx/sites-enabled/" },
  {
    command:
      "sudo ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/",
    verifies: ["default-site-enabled"],
  },
  { command: "sudo systemctl reload nginx", verifies: ["port-80-open"] },
  { command: "curl -sI localhost | head -1", output: ["HTTP/1.1 200 OK"] },
];

const FIRST_COMMAND_MS = 900;
const CHAR_MS = 38;
const ENTER_MS = 220;
const OUTPUT_MS = 320;
const THINK_MS = 1_000;
const CHECKING_AFTER_MS = 450;
const VERIFIED_AFTER_MS = 1_500;
const HOLD_MS = 4_500;
const LEASE_SECONDS = 89 * 60 + 41;

interface TimedStep extends ScriptStep {
  typeAt: number;
  enterAt: number;
  outputAt: number;
  promptAt: number;
}

const TIMELINE: readonly TimedStep[] = (() => {
  let cursor = FIRST_COMMAND_MS;
  return SCRIPT.map((step) => {
    const typeAt = cursor;
    const enterAt = typeAt + step.command.length * CHAR_MS + ENTER_MS;
    const outputAt = enterAt + OUTPUT_MS;
    const promptAt = outputAt;
    cursor = promptAt + THINK_MS;
    return { ...step, typeAt, enterAt, outputAt, promptAt };
  });
})();

const CHECK_TIMES = new Map(
  TIMELINE.flatMap((step) =>
    (step.verifies ?? []).map((key) => [
      key,
      {
        checking: step.enterAt + CHECKING_AFTER_MS,
        verified: step.enterAt + VERIFIED_AFTER_MS,
      },
    ]),
  ),
);

const LAST_STEP = TIMELINE[TIMELINE.length - 1]!;
const SOLVED_AT = LAST_STEP.outputAt;
const LOOP_MS = SOLVED_AT + HOLD_MS;
// Reduced motion (and the visual suite) show the finished session.
const STATIC_MS = LOOP_MS - 1;

type CheckStatus = "needs_repair" | "checking" | "verified";

function checkStatus(key: CheckKey, t: number): CheckStatus {
  const times = CHECK_TIMES.get(key);
  if (!times || t < times.checking) return "needs_repair";
  return t < times.verified ? "checking" : "verified";
}

type TerminalRow =
  | { kind: "text"; text: string }
  | { kind: "prompt"; text: string; cursor: "none" | "solid" | "blink" }
  | { kind: "cursor" };

function terminalRows(t: number): TerminalRow[] {
  const rows: TerminalRow[] = CHECKS.map((check) => ({
    kind: "text",
    text: `- ${check.label}`,
  }));
  let idle = true;
  for (const step of TIMELINE) {
    if (t < step.typeAt) break;
    const typed = Math.min(
      step.command.length,
      Math.floor((t - step.typeAt) / CHAR_MS),
    );
    const entered = t >= step.enterAt;
    rows.push({
      kind: "prompt",
      text: step.command.slice(0, typed),
      cursor: entered ? "none" : "solid",
    });
    if (!entered) {
      idle = false;
      break;
    }
    if (t < step.outputAt) {
      rows.push({ kind: "cursor" });
      idle = false;
      break;
    }
    for (const line of step.output ?? []) rows.push({ kind: "text", text: line });
  }
  if (idle) rows.push({ kind: "prompt", text: "", cursor: "blink" });
  return rows;
}

function prefersStaticPreview() {
  return (
    typeof window === "undefined" ||
    typeof IntersectionObserver === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function usePreviewClock(target: RefObject<HTMLElement | null>, still: boolean) {
  const [t, setT] = useState(still ? STATIC_MS : 0);
  useEffect(() => {
    const element = target.current;
    if (!element || still) return;
    let timer: number | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      window.clearInterval(timer);
      timer = undefined;
      if (!entry?.isIntersecting) return;
      const start = performance.now();
      setT(0);
      timer = window.setInterval(() => {
        setT((performance.now() - start) % LOOP_MS);
      }, 40);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [still, target]);
  return t;
}

export function RunPreview({ className }: { className?: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  // Decided once: a still page never grows or shifts after load.
  const [still] = useState(prefersStaticPreview);
  const t = usePreviewClock(frameRef, still);
  const statuses = CHECKS.map((check) => ({
    ...check,
    status: checkStatus(check.key, t),
  }));
  const passed = statuses.filter((check) => check.status === "verified").length;
  const solved = t >= SOLVED_AT;
  const remaining = LEASE_SECONDS - Math.floor(t / 1_000);

  return (
    <figure className={cn("m-0", className)}>
      <figcaption className="sr-only">
        Example run: the learner starts nginx, restores the default site, and
        reloads the server while the three checks turn verified.
      </figcaption>
      <div
        ref={frameRef}
        aria-hidden="true"
        className="grid h-[30rem] min-w-0 grid-cols-1 overflow-hidden rounded-2xl border bg-canvas shadow-[var(--highlight),var(--shadow-overlay)] select-none lg:h-[31.5rem] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
      >
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <header className="flex shrink-0 items-center gap-2 px-3 pt-2 pb-1">
            <span
              className={buttonVariants({ variant: "ghost", className: "-ml-2 shrink-0" })}
            >
              <ArrowLeft className="size-4" />
              Lecture
            </span>
            <p className="min-w-0 flex-1 truncate text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em]">
              Broken Nginx
            </p>
            <span className="mr-1 inline-flex min-w-max shrink-0 items-center gap-2 max-sm:hidden">
              <StatusToken
                tone={solved ? "success" : "live"}
                word={solved ? "Solved" : "Running"}
                pulse={!solved}
              />
              <span className="h-3 w-px bg-border" />
              <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                <Clock3 className="size-3.5" />
                {formatLease(remaining)} left
              </span>
            </span>
            <span
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "gap-2 px-3 lg:hidden",
              })}
            >
              <Lightbulb className="size-4" />
              Checks {passed}/{CHECKS.length}
            </span>
            <span
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "max-md:hidden",
              })}
            >
              SSH command
            </span>
            <span
              className={buttonVariants({
                variant: "destructive",
                size: "sm",
                className: "max-md:hidden",
              })}
            >
              End run…
            </span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col px-3 pt-1 pb-3">
            <PreviewTerminal rows={terminalRows(t)} />
          </div>
        </div>
        <div className="hidden min-h-0 min-w-0 flex-col pt-2 pr-3 pb-3 lg:flex">
          <div className="min-h-0 flex-1 space-y-5 overflow-hidden rounded-xl border bg-card px-4 py-4 shadow-[var(--highlight),var(--shadow-raised)]">
            <PreviewChecks checks={statuses} passed={passed} />
            <section>
              <h2 className="text-card-title">Lecture theory: Broken Nginx</h2>
              <div className="mt-3 space-y-3 text-sm leading-6">
                <p>
                  Nginx is a web server. It accepts HTTP requests and returns
                  website content. For a website to work, the Nginx service
                  must run and an enabled site configuration must be valid.
                </p>
                <h3 className="text-base font-semibold text-balance">
                  Service state
                </h3>
                <p>
                  On a systemd system, a service can be enabled, running, both,
                  or neither. Enabled means systemd starts it during boot.
                  Running means it is active now.
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </figure>
  );
}

function PreviewTerminal({ rows }: { rows: readonly TerminalRow[] }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)]">
      <div className="flex shrink-0 items-center gap-3 border-b px-2 py-1.5">
        <p className="inline-flex h-7 min-w-0 items-center gap-2 rounded-md bg-muted px-2.5 text-[0.8125rem] font-medium ring-1 ring-border dark:bg-accent/60">
          <TerminalIcon className="size-3.5 shrink-0 text-faint-foreground" />
          <span className="truncate">webserver shell</span>
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
        </p>
      </div>
      {/* Matches the xterm canvas: 14px Geist Mono, 1.35 line height, the
          shared always-dark palette, and a block cursor in the brand orange.
          Rows fill from the top and scroll off the top once the pane is full. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden bg-terminal-background py-2 pr-2 pl-3 font-mono text-[14px] leading-[1.35] text-terminal-foreground">
        <div className="flex-[1_0_auto]">
          {rows.map((row, index) => (
            <p key={index} className="min-h-[1.35em] break-all whitespace-pre-wrap">
              {row.kind === "text" ? (
                row.text
              ) : row.kind === "cursor" ? (
                <Cursor blink={false} />
              ) : (
                <>
                  <span className="font-bold text-terminal-success">ubuntu@webserver</span>
                  :<span className="font-bold text-terminal-info">~</span>$ {row.text}
                  {row.cursor !== "none" ? (
                    <Cursor blink={row.cursor === "blink"} />
                  ) : null}
                </>
              )}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function Cursor({ blink }: { blink: boolean }) {
  return (
    <span
      className={cn(
        "inline-block h-[1.35em] w-[0.6em] align-top bg-terminal-brand",
        blink && "motion-safe:animate-caret",
      )}
    />
  );
}

const SEGMENT_TONES: Record<CheckStatus, string> = {
  verified: "bg-success",
  checking: "bg-info/60",
  needs_repair: "bg-border-strong/70",
};

const LABEL_TONES: Record<CheckStatus, string> = {
  verified: "text-success",
  checking: "text-info",
  needs_repair: "text-warning",
};

const STATUS_LABELS: Record<CheckStatus, string> = {
  verified: "Verified",
  checking: "Checking",
  needs_repair: "Needs repair",
};

function PreviewChecks({
  checks,
  passed,
}: {
  checks: readonly { key: CheckKey; title: string; status: CheckStatus }[];
  passed: number;
}) {
  return (
    <section className="border-b pb-2">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">Checks</p>
        <span className="shrink-0 text-xs text-faint-foreground tabular-nums">
          {passed}/{checks.length} verified
        </span>
      </div>
      <span className="mt-3 flex gap-1">
        {checks.map((check) => (
          <span
            key={check.key}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-500 ease-standard",
              SEGMENT_TONES[check.status],
            )}
          />
        ))}
      </span>
      <ol className="-mx-2 mt-3 space-y-0.5">
        {checks.map((check) => (
          <li
            key={check.key}
            className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-3 rounded-lg px-2 py-2"
          >
            <span className="mt-1">
              {check.status === "verified" ? (
                <CheckCircle2 className="size-4 text-success motion-safe:animate-pop" />
              ) : check.status === "checking" ? (
                <LoaderCircle className="size-4 text-info motion-safe:animate-spin" />
              ) : (
                <CircleDashed className="size-4 text-warning" />
              )}
            </span>
            <span className="flex min-w-0 items-start justify-between gap-x-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium leading-6">
                {check.title}
              </span>
              <span
                className={cn(
                  "text-xs leading-6 font-medium whitespace-nowrap transition-colors duration-300",
                  LABEL_TONES[check.status],
                )}
              >
                {STATUS_LABELS[check.status]}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatLease(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
