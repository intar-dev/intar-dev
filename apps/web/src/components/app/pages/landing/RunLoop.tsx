import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";

// The loop every lecture follows, told with the same broken-nginx run the
// workspace above replays.
export function RunLoop() {
  return (
    <section
      aria-labelledby="landing-loop-heading"
      className="mx-auto w-full max-w-7xl px-[var(--page-inset)] pt-24 sm:pt-32"
    >
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-label">How a run works</p>
        <h2
          id="landing-loop-heading"
          className="mt-3 text-feature-title text-balance"
        >
          Broken on purpose. Fixed by you.
        </h2>
      </div>
      {/* Three columns need xl width for the snippets; below that each step
          is a row with its snippet beside the copy, and a stack on phones. */}
      <ol className="mt-10 grid gap-4 sm:mt-12 xl:grid-cols-3">
        <LoopStep
          number="01"
          title="Diagnose"
          body="Read the briefing, then inspect the sandbox until you know what failed."
        >
          <MiniTerminal
            lines={[
              { command: "systemctl is-active nginx" },
              { output: "inactive", failed: true },
              { command: "ls /etc/nginx/sites-enabled/" },
              { command: "" },
            ]}
          />
        </LoopStep>
        <LoopStep
          number="02"
          title="Repair"
          body="Fix it in a real Linux shell, in the browser or over SSH. Hints are there when you get stuck."
        >
          <MiniTerminal
            lines={[
              { command: "sudo systemctl enable --now nginx" },
              { command: "cd /etc/nginx/sites-enabled" },
              { command: "sudo ln -s ../sites-available/default" },
              { command: "sudo systemctl reload nginx" },
            ]}
          />
        </LoopStep>
        <LoopStep
          number="03"
          title="Prove"
          body="Checks probe the system every few seconds and turn green as your fix lands. No self-grading."
        >
          <MiniChecks />
        </LoopStep>
      </ol>
    </section>
  );
}

function LoopStep({
  number,
  title,
  body,
  children,
}: {
  number: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-6 rounded-2xl border bg-card p-6 shadow-[var(--highlight),var(--shadow-raised)] md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:items-center md:gap-8 xl:flex xl:items-stretch xl:gap-6">
      <div className="space-y-2">
        <h3 className="flex items-baseline gap-3 text-[1.125rem] leading-snug font-semibold tracking-[-0.012em]">
          <span aria-hidden="true" className="font-mono text-sm text-brand-text">
            {number}
          </span>
          {title}
        </h3>
        <p className="text-support text-muted-foreground">{body}</p>
      </div>
      <div className="mt-auto md:mt-0 xl:mt-auto">{children}</div>
    </li>
  );
}

type MiniTerminalLine =
  | { command: string }
  | { output: string; failed?: boolean };

function MiniTerminal({ lines }: { lines: readonly MiniTerminalLine[] }) {
  return (
    <div className="min-h-32 rounded-xl border border-terminal-border bg-terminal-background px-4 py-3 font-mono text-[0.8125rem] leading-[1.7] text-terminal-foreground">
      {lines.map((line, index) =>
        "command" in line ? (
          <p key={index} className="break-all whitespace-pre-wrap">
            <span className="text-terminal-muted">$ </span>
            {line.command}
          </p>
        ) : (
          <p
            key={index}
            className={
              line.failed ? "text-terminal-destructive" : "text-terminal-muted"
            }
          >
            {line.output}
          </p>
        ),
      )}
    </div>
  );
}

const CHECK_TITLES = [
  "Start the web server",
  "Make the site reachable",
  "Restore the default site",
] as const;

function MiniChecks() {
  return (
    <div className="min-h-32 rounded-xl border bg-canvas px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-foreground">Checks</span>
        <span className="text-faint-foreground tabular-nums">3/3 verified</span>
      </div>
      <span aria-hidden="true" className="mt-2.5 flex gap-1">
        {CHECK_TITLES.map((title) => (
          <span key={title} className="h-1 flex-1 rounded-full bg-success" />
        ))}
      </span>
      <ul className="mt-2">
        {CHECK_TITLES.map((title) => (
          <li
            key={title}
            className="flex items-center gap-2 text-[0.8125rem] leading-[1.7]"
          >
            <CheckCircle2
              className="size-3.5 shrink-0 text-success"
              aria-hidden="true"
            />
            {title}
          </li>
        ))}
      </ul>
    </div>
  );
}
