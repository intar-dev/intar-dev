import { type RefObject, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  LoaderCircle,
  TerminalSquare,
} from "lucide-react";
import hetznerLogo from "@/assets/hetzner-logo.webp";
import hosttechLogo from "@/assets/hosttech-logo.svg?url";
import hosttechLogoLight from "@/assets/hosttech-logo-light.svg?url";
import namespaceLogo from "@/assets/namespace-logo.png";
import { BrandMark } from "../patterns/BrandMark";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { useMyRuns } from "../hooks/useMyRuns";
import { useSession } from "../hooks/useSession";
import { ThemeToggle } from "../theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { startGithubSignIn } from "@/lib/auth-client";

const errorMessages: Record<string, string> = {
  unable_to_create_session:
    "We couldn't complete sign-in. Beta access requires an active invite claim.",
  unable_to_create_user:
    "We couldn't create your account. Open the beta invite link an administrator sent you.",
  signup_disabled: "Sign-ups are disabled for this provider.",
  state_mismatch: "Your sign-in session expired. Please try again.",
  please_restart_the_process: "Your sign-in session expired. Please try again.",
  invalid_callback_request: "Sign-in failed. Please try again.",
  invalid_code: "GitHub sign-in was canceled or expired. Please try again.",
  no_callback_url: "Sign-in failed to return to the app. Please try again.",
  oauth_provider_not_found:
    "GitHub sign-in isn't configured. Please try again later.",
  unable_to_get_user_info: "GitHub didn't return user info. Please try again.",
  email_not_found:
    "GitHub didn't return an email. Please check your GitHub email settings.",
};

export function Landing() {
  const errorFromQuery =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("error");
  const errorMessage = friendlyMessageFor(errorFromQuery) ?? null;
  const session = useSession();
  const signedIn = Boolean(session.data?.user);
  const runs = useMyRuns({ enabled: signedIn });
  const activeRun = runs.data?.runs.find((run) => run.active) ?? null;

  const signIn = useMutation({
    mutationFn: () =>
      startGithubSignIn({
        callbackURL: `${window.location.origin}/courses`,
        errorCallbackURL: `${window.location.origin}/`,
      }),
  });

  return (
    <div className="relative isolate flex min-h-svh flex-col overflow-hidden bg-canvas">
      <div
        aria-hidden="true"
        className="dot-grid pointer-events-none absolute inset-0 -z-10 hidden lg:block"
      />
      <header className="mx-auto flex min-h-14 w-full max-w-7xl shrink-0 items-center justify-between gap-4 px-[var(--page-inset)] sm:min-h-[4.75rem]">
        <BrandMark />
        <ThemeToggle />
      </header>

      {errorMessage ? (
        <div className="mx-auto w-full max-w-7xl px-[var(--page-inset)] pt-4">
          <Alert variant="destructive">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="flex min-h-0 flex-1">
        <section className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 items-center gap-8 px-[var(--page-inset)] py-2 sm:py-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,35rem)] lg:gap-12 lg:py-0 xl:gap-16">
          <div className="flex flex-col items-start gap-6 motion-safe:animate-rise sm:gap-8">
            <SponsorMarks />

            <div className="space-y-5">
              <h1 className="text-display text-balance">
                <span className="block">Repair real systems.</span>
                <span className="block text-faint-foreground">
                  Prove the fix.
                </span>
              </h1>
              <p className="prose-measure max-w-xl text-[1.0625rem] leading-relaxed text-muted-foreground sm:text-lg">
                Diagnose a live sandbox, repair it in the shell, and watch the
                checks turn green.
              </p>
            </div>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:gap-3">
              {signedIn ? (
                <Button
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={runs.isLoading}
                  render={
                    runs.isLoading ? undefined : (
                      <Link
                        to={activeRun ? "/runs/$runId" : "/courses"}
                        params={activeRun ? { runId: activeRun.runId } : {}}
                      />
                    )
                  }
                >
                  {runs.isLoading
                    ? "Finding your work…"
                    : activeRun
                      ? "Resume run"
                      : "Browse courses"}
                  {!runs.isLoading ? <ArrowRight className="size-4" /> : null}
                </Button>
              ) : (
                <>
                  <Button
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={() => signIn.mutate()}
                    disabled={signIn.isPending}
                  >
                    {signIn.isPending
                      ? "Opening GitHub…"
                      : "Sign in with GitHub"}
                    {!signIn.isPending ? (
                      <ArrowRight className="size-4" />
                    ) : null}
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full sm:w-auto"
                    render={<Link to="/organization-sign-in" />}
                  >
                    Organization sign-in
                  </Button>
                </>
              )}
            </div>

            {signIn.error ? (
              <InlineFeedback tone="error">
                {signIn.error instanceof Error
                  ? signIn.error.message
                  : "GitHub sign-in could not be started."}
              </InlineFeedback>
            ) : null}
          </div>

          <WorkOrder />
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-7xl shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-[var(--page-inset)] py-3 text-[0.8125rem] text-faint-foreground">
        <span>Built by Stefan Ruzitschka</span>
        <span aria-hidden="true" className="text-border-strong">
          ·
        </span>
        <a href="https://github.com/intar-dev" className={footerLinkClassName}>
          GitHub
        </a>
        <a href="https://docs.intar.dev" className={footerLinkClassName}>
          Documentation
        </a>
        <a href="mailto:hello@intar.dev" className={footerLinkClassName}>
          Sponsorships
        </a>
      </footer>
    </div>
  );
}

function SponsorMarks() {
  return (
    <aside
      aria-labelledby="landing-sponsors-heading"
      className="flex w-full flex-col items-start gap-2 border-b pb-6 sm:pb-8"
    >
      <p
        id="landing-sponsors-heading"
        className="text-caption font-medium"
      >
        Infrastructure by
      </p>
      <div className="flex w-full flex-wrap items-center gap-x-8 gap-y-2">
        <a
          href="https://www.hetzner.com/?mtm_campaign=intar-dev&mtm_medium=referral&mtm_content=sponsoring_link"
          target="_blank"
          rel="noreferrer"
          className={sponsorLinkClassName}
        >
          <img
            src={hetznerLogo.src}
            width={hetznerLogo.width}
            height={hetznerLogo.height}
            alt="Hetzner"
            className="h-9 w-auto rounded-md"
          />
        </a>
        <a
          href="https://namespace.so"
          target="_blank"
          rel="noreferrer"
          className={sponsorLinkClassName}
        >
          <img
            src={namespaceLogo.src}
            width={namespaceLogo.width}
            height={namespaceLogo.height}
            alt="namespace"
            className="h-7 w-auto dark:invert"
          />
        </a>
        <a
          href="https://www.hosttech.eu"
          target="_blank"
          rel="noreferrer"
          className={sponsorLinkClassName}
        >
          <img
            src={hosttechLogoLight}
            width={1000}
            height={195.1}
            alt="hosttech"
            className="h-6 w-auto dark:hidden"
          />
          <img
            src={hosttechLogo}
            width={1000}
            height={195.1}
            alt="hosttech"
            className="hidden h-6 w-auto dark:block"
          />
        </a>
      </div>
    </aside>
  );
}

type WorkOrderLine =
  | { at: number; command: string; speed: number }
  | { at: number; output: string; tone: "danger" | "muted" | "success" };

// One incident, played start to finish: the symptom, the evidence, the fix,
// and the proof. Reduced motion (and the visual test suite) keep the static
// incident frame the page has always shown.
const WORK_ORDER_SCRIPT: readonly WorkOrderLine[] = [
  { at: 400, command: "curl -I http://web-01", speed: 32 },
  { at: 1300, output: "HTTP/1.1 502 Bad Gateway", tone: "danger" },
  { at: 2300, command: "sudo nginx -T | grep proxy_pass", speed: 30 },
  { at: 3550, output: "proxy_pass http://127.0.0.1:8081;", tone: "muted" },
  {
    at: 4500,
    command: "sudo sed -i 's/8081/8080/' /etc/nginx/sites-enabled/app",
    speed: 20,
  },
  { at: 6200, command: "sudo systemctl reload nginx", speed: 26 },
  { at: 7600, command: "curl -I http://web-01", speed: 28 },
  { at: 8450, output: "HTTP/1.1 200 OK", tone: "success" },
];
const WORK_ORDER_LOOP_MS = 15_000;
const WORK_ORDER_STATIC_MS = 1_500;
const OUTPUT_TONES = {
  danger: "text-terminal-destructive",
  muted: "text-terminal-muted",
  success: "text-terminal-success",
} as const;

interface RenderedLine {
  command: boolean;
  text: string;
  tone: string;
  caret: "none" | "solid" | "blink";
}

function workOrderLines(t: number): RenderedLine[] {
  const lines: RenderedLine[] = [];
  // The idle prompt shows before the first command, after output, and after a
  // command that prints nothing. It waits while a command's output is pending.
  let prompt = true;
  for (const [index, line] of WORK_ORDER_SCRIPT.entries()) {
    if (t < line.at) break;
    if ("command" in line) {
      const typed = Math.min(
        line.command.length,
        Math.floor((t - line.at) / line.speed),
      );
      const executed = t >= line.at + line.command.length * line.speed + 200;
      const next = WORK_ORDER_SCRIPT[index + 1];
      lines.push({
        command: true,
        text: line.command.slice(0, typed),
        tone: "text-terminal-foreground",
        caret: executed
          ? "none"
          : typed === line.command.length
            ? "blink"
            : "solid",
      });
      prompt = executed && !(next && "output" in next);
    } else {
      lines.push({
        command: false,
        text: line.output,
        tone: OUTPUT_TONES[line.tone],
        caret: "none",
      });
      prompt = true;
    }
  }
  if (prompt) {
    lines.push({
      command: true,
      text: "",
      tone: "text-terminal-foreground",
      caret: "blink",
    });
  }
  return lines;
}

function prefersStaticWorkOrder() {
  return (
    typeof window === "undefined" ||
    typeof IntersectionObserver === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useWorkOrderClock(
  target: RefObject<HTMLElement | null>,
  still: boolean,
) {
  const [t, setT] = useState(WORK_ORDER_STATIC_MS);
  useEffect(() => {
    const element = target.current;
    if (!element || still) return;
    let timer: number | undefined;
    let start = 0;
    const observer = new IntersectionObserver(([entry]) => {
      window.clearInterval(timer);
      timer = undefined;
      if (!entry?.isIntersecting) return;
      start = performance.now();
      timer = window.setInterval(() => {
        setT((performance.now() - start) % WORK_ORDER_LOOP_MS);
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

function WorkOrder() {
  const sectionRef = useRef<HTMLElement>(null);
  // Decided once: a still page never grows or shifts after load.
  const [still] = useState(prefersStaticWorkOrder);
  const t = useWorkOrderClock(sectionRef, still);
  const lines = workOrderLines(t);
  const repaired = t >= 7150;
  const passing = t < 8700 ? 0 : t < 9000 ? 1 : t < 9300 ? 2 : 3;
  const verifying = t >= 8450 && t < 9300;
  const resolved = t >= 9300;

  return (
    <section
      ref={sectionRef}
      aria-label="Work order"
      className="hidden overflow-hidden rounded-2xl border border-terminal-border bg-terminal-surface text-terminal-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.04),var(--shadow-overlay)] motion-safe:animate-rise lg:block"
    >
      <header className="flex h-12 items-center justify-between gap-4 border-b border-terminal-border px-5">
        <div className="flex items-center gap-2 text-[0.8125rem] font-semibold">
          <TerminalSquare className="size-4 text-terminal-brand" aria-hidden="true" />
          Work order · web-204
        </div>
        <span className="font-mono text-caption text-terminal-muted">RUN-0417</span>
      </header>
      <div className="space-y-5 p-5">
        <div className="space-y-2">
          <p
            className={
              resolved
                ? "flex items-center gap-2 text-caption font-semibold text-terminal-success transition-colors duration-300"
                : "flex items-center gap-2 text-caption font-semibold text-terminal-destructive transition-colors duration-300"
            }
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            {resolved ? "Resolved" : "Incident"}
          </p>
          <h2 className="text-[1.25rem] leading-snug font-semibold tracking-[-0.015em]">
            The service is healthy. The website is not.
          </h2>
          <p className="text-support text-terminal-muted">
            Trace the request path, repair the configuration, and restore the
            public endpoint.
          </p>
        </div>

        <ol className="border-y border-terminal-border">
          <WorkOrderStep
            state="done"
            number="01"
            label="Briefing read"
            detail="context loaded"
          />
          <WorkOrderStep
            state={repaired ? "done" : "active"}
            number="02"
            label="Repair system"
            detail={repaired ? "config repaired" : "shell active"}
          />
          <WorkOrderStep
            state={resolved ? "done" : verifying ? "checking" : "pending"}
            number="03"
            label="Verify checks"
            detail={`${passing} / 3 passing`}
          />
        </ol>

        <p className="sr-only">
          Example session: the site answers 502 Bad Gateway until the proxy
          port is corrected and nginx reloads, then it answers 200 OK.
        </p>
        <div
          aria-hidden="true"
          className={
            still
              ? "overflow-hidden rounded-xl border border-terminal-border bg-terminal-background px-4 py-3.5 font-mono text-[0.78125rem] leading-[1.75]"
              : "h-[14.25rem] overflow-hidden rounded-xl border border-terminal-border bg-terminal-background px-4 py-3.5 font-mono text-[0.78125rem] leading-[1.75]"
          }
        >
          {lines.map((line, index) => (
            <p key={index} className={`whitespace-pre ${line.tone}`}>
              {line.command ? <span className="text-terminal-brand">$ </span> : null}
              {line.text}
              {line.caret !== "none" ? (
                <span
                  className={
                    line.caret === "blink"
                      ? "ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[0.2em] bg-terminal-foreground motion-safe:animate-caret"
                      : "ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[0.2em] bg-terminal-foreground"
                  }
                />
              ) : null}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkOrderStep({
  state,
  number,
  label,
  detail,
}: {
  state: "done" | "active" | "checking" | "pending";
  number: string;
  label: string;
  detail: string;
}) {
  return (
    <li className="grid h-12 grid-cols-[1.25rem_1.75rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-terminal-border text-support last:border-b-0">
      <span className="flex size-5 items-center justify-center" aria-hidden="true">
        {state === "done" ? (
          <CheckCircle2
            key="done"
            className="size-[1.125rem] text-terminal-success motion-safe:animate-pop"
          />
        ) : state === "active" ? (
          <span className="size-2 rounded-full bg-terminal-brand text-terminal-brand motion-safe:animate-live" />
        ) : state === "checking" ? (
          <LoaderCircle className="size-4 text-terminal-info motion-safe:animate-spin" />
        ) : (
          <span className="size-3 rounded-full border-[1.5px] border-terminal-muted/50" />
        )}
      </span>
      <span className="font-mono text-caption text-terminal-muted">{number}</span>
      <span className="font-medium">{label}</span>
      <span className="hidden text-caption text-terminal-muted tabular-nums sm:block">
        {detail}
      </span>
    </li>
  );
}

const footerLinkClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-border-strong";

const sponsorLinkClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-1 opacity-80 transition-opacity duration-200 hover:opacity-100 focus-visible:opacity-100";

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
