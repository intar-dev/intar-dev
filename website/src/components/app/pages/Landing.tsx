import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  TerminalSquare,
} from "lucide-react";
import hetznerLogo from "@/assets/hetzner-logo.jpg";
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
    "We couldn't complete sign-in. Your GitHub username isn't on the allowlist yet.",
  unable_to_create_user:
    "We couldn't create your account. Your GitHub username may not have workshop access yet.",
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

const allowlistErrors = new Set([
  "unable_to_create_session",
  "unable_to_create_user",
]);

export function Landing() {
  const errorFromQuery =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("error");
  const normalizedError = normalizeErrorCode(errorFromQuery);
  const errorMessage = friendlyMessageFor(errorFromQuery) ?? null;
  const session = useSession();
  const signedIn = Boolean(session.data?.user);
  const runs = useMyRuns({ enabled: signedIn });
  const activeRun = runs.data?.runs.find((run) => run.active) ?? null;

  const signIn = useMutation({
    mutationFn: () =>
      startGithubSignIn({
        callbackURL: `${window.location.origin}/scenarios`,
        errorCallbackURL: `${window.location.origin}/`,
      }),
  });

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-[var(--page-inset)]">
        <BrandMark />
        <div className="flex items-center gap-1">
          {signedIn ? (
            <Button
              variant="ghost"
              size="sm"
              render={
                <Link
                  to={activeRun ? "/runs/$runId" : "/scenarios"}
                  params={activeRun ? { runId: activeRun.runId } : {}}
                />
              }
            >
              {activeRun ? "Resume lab" : "Open workshop"}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signIn.mutate()}
              disabled={signIn.isPending}
            >
              {signIn.isPending ? "Opening GitHub…" : "Sign in"}
            </Button>
          )}
          <ThemeToggle />
        </div>
      </header>

      {errorMessage ? (
        <div className="mx-auto w-full max-w-7xl px-[var(--page-inset)] pt-4">
          <Alert variant="destructive">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{errorMessage}</span>
              {normalizedError && allowlistErrors.has(normalizedError) ? (
                <Link
                  to="/request-access"
                  className="font-semibold underline underline-offset-4"
                >
                  Request access
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-[var(--page-inset)] py-16 sm:py-24 lg:grid-cols-[minmax(0,1.05fr)_minmax(24rem,0.95fr)] lg:gap-16 lg:py-28">
          <div className="flex flex-col items-start gap-8">
            <div className="space-y-6">
              <p className="text-eyebrow">Hands-on DevOps training</p>
              <h1 className="text-display max-w-[12ch] text-balance">
                Repair real systems. Build operational instinct.
              </h1>
              <p className="prose-measure text-body max-w-2xl text-muted-foreground sm:text-lg sm:leading-8">
                Enter a live sandbox, diagnose the failure, and prove the repair
                against continuously running checks. No slides. No simulation.
              </p>
            </div>

            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              {signedIn ? (
                <Button
                  size="lg"
                  className="w-full sm:w-auto"
                  disabled={runs.isLoading}
                  render={
                    runs.isLoading ? undefined : (
                      <Link
                        to={activeRun ? "/runs/$runId" : "/scenarios"}
                        params={activeRun ? { runId: activeRun.runId } : {}}
                      />
                    )
                  }
                >
                  {runs.isLoading
                    ? "Finding your work…"
                    : activeRun
                      ? "Resume lab"
                      : "Browse scenarios"}
                  {!runs.isLoading ? <ArrowRight className="size-4" /> : null}
                </Button>
              ) : (
                <>
                  <Button
                    size="lg"
                    className="w-full sm:w-auto"
                    render={<Link to="/request-access" />}
                  >
                    Request access
                    <ArrowRight className="size-4" />
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => signIn.mutate()}
                    disabled={signIn.isPending}
                  >
                    {signIn.isPending ? "Opening GitHub…" : "Sign in"}
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

        <section
          aria-labelledby="proof-heading"
          className="border-y bg-card/45"
        >
          <div className="mx-auto w-full max-w-7xl px-[var(--page-inset)] py-12 sm:py-16">
            <div className="grid gap-8 lg:grid-cols-[0.8fr_1fr_1fr_1fr] lg:gap-0">
              <div className="lg:pr-8">
                <p className="text-eyebrow">Workshop method</p>
                <h2 id="proof-heading" className="mt-3 text-section-title">
                  Learn through the repair loop.
                </h2>
              </div>
              {[
                [
                  "Brief the incident",
                  "Start with objectives, system context, and a real machine you can inspect.",
                ],
                [
                  "Work in the shell",
                  "Use browser SSH or your native terminal. The environment behaves like infrastructure, because it is.",
                ],
                [
                  "Verify continuously",
                  "Checks change as the system changes, then the completed run becomes a replay you can study.",
                ],
              ].map(([title, description], index) => (
                <article
                  key={title}
                  className="border-t pt-6 lg:border-t-0 lg:border-l lg:px-8 lg:pt-0"
                >
                  <span className="font-heading text-xs font-semibold text-brand-text tabular-nums">
                    0{index + 1}
                  </span>
                  <h3 className="mt-3 text-card-title">{title}</h3>
                  <p className="mt-2 text-body text-muted-foreground">
                    {description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-[var(--page-inset)] py-12 sm:py-16">
          <div className="flex flex-col gap-6 border-y py-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-eyebrow">Workshop infrastructure</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Supported by teams that make real sandboxes practical.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
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
                  className="h-8 w-auto rounded"
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
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-[var(--page-inset)] py-8 text-sm text-muted-foreground">
        <span>Built by Stefan Ruzitschka</span>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/intar-dev" className={footerLinkClassName}>
          GitHub
        </a>
        <a href="https://docs.intar.dev" className={footerLinkClassName}>
          Documentation
        </a>
        <a href="mailto:marketing@intar.dev" className={footerLinkClassName}>
          Sponsorships
        </a>
      </footer>
    </div>
  );
}

function WorkOrder() {
  return (
    <section className="terminal-surface overflow-hidden rounded-xl border shadow-xl shadow-black/10">
      <header className="flex items-center justify-between gap-4 border-b border-terminal-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <TerminalSquare className="size-4 text-terminal-brand" />
          Work order · web-204
        </div>
        <span className="font-mono text-xs text-terminal-muted">RUN-0417</span>
      </header>
      <div className="space-y-6 p-4 sm:p-6">
        <div>
          <p className="font-mono text-xs text-terminal-brand">INCIDENT</p>
          <h2 className="mt-2 font-heading text-2xl font-bold tracking-tight">
            The service is healthy. The website is not.
          </h2>
          <p className="mt-2 text-sm leading-6 text-terminal-muted">
            Trace the request path, repair the configuration, and restore the
            public endpoint.
          </p>
        </div>

        <ol className="space-y-1 border-y border-terminal-border py-2">
          <WorkOrderStep
            icon={<CheckCircle2 className="size-4 text-terminal-success" />}
            number="01"
            label="Briefing read"
            detail="context loaded"
          />
          <WorkOrderStep
            icon={<CircleDot className="size-4 text-terminal-warning" />}
            number="02"
            label="Repair system"
            detail="shell active"
          />
          <WorkOrderStep
            icon={<span className="size-2 rounded-full bg-terminal-muted" />}
            number="03"
            label="Verify checks"
            detail="0 / 3 passing"
          />
        </ol>

        <div className="rounded-lg bg-terminal-background p-4 font-mono text-sm leading-7">
          <p className="text-terminal-muted">$ curl -I http://web-01</p>
          <p className="text-terminal-destructive">HTTP/1.1 502 Bad Gateway</p>
          <p className="text-terminal-foreground">
            <span className="text-terminal-brand">$</span>{" "}
            <span className="motion-safe:animate-pulse">_</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function WorkOrderStep({
  icon,
  number,
  label,
  detail,
}: {
  icon: React.ReactNode;
  number: string;
  label: string;
  detail: string;
}) {
  return (
    <li className="grid grid-cols-[1.25rem_2rem_minmax(0,1fr)_auto] items-center gap-2 py-2 text-sm">
      {icon}
      <span className="font-mono text-xs text-terminal-muted">{number}</span>
      <span className="font-semibold">{label}</span>
      <span className="hidden text-xs text-terminal-muted sm:block">
        {detail}
      </span>
    </li>
  );
}

const footerLinkClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center underline decoration-border underline-offset-4 transition-colors hover:text-foreground";

const sponsorLinkClassName =
  "rounded-lg p-2 outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
