import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  TerminalSquare,
} from "lucide-react";
import hetznerLogo from "@/assets/hetzner-logo.webp";
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
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex min-h-14 w-full max-w-7xl shrink-0 items-center justify-between gap-4 px-[var(--page-inset)] sm:min-h-16">
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
        <section className="mx-auto grid min-h-0 w-full max-w-7xl flex-1 items-center gap-6 px-[var(--page-inset)] py-2 sm:py-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(24rem,0.95fr)] lg:gap-12 lg:py-0 xl:gap-16">
          <div className="flex flex-col items-start gap-4 sm:gap-6">
            <SponsorMarks />

            <div className="space-y-5">
              <h1 className="text-display max-w-[12ch] text-balance">
                Repair real systems. Prove the fix.
              </h1>
              <p className="prose-measure max-w-xl text-body text-muted-foreground">
                Diagnose a live sandbox, repair it in the shell, and watch the
                checks turn green.
              </p>
            </div>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
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
                      ? "Resume lab"
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

      <footer className="mx-auto flex w-full max-w-7xl shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-[var(--page-inset)] py-2 text-support text-muted-foreground">
        <span>Built by Stefan Ruzitschka</span>
        <span aria-hidden="true">·</span>
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
      className="flex w-full flex-col items-start gap-2 border-b pb-4 sm:gap-3 sm:pb-5"
    >
      <p
        id="landing-sponsors-heading"
        className="text-caption text-muted-foreground"
      >
        Infrastructure by
      </p>
      <div className="flex w-full flex-wrap items-center gap-x-6 gap-y-3">
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
            className="h-12 w-auto rounded-md"
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
            className="h-10 w-auto dark:invert"
          />
        </a>
      </div>
    </aside>
  );
}

function WorkOrder() {
  return (
    <section className="terminal-surface hidden overflow-hidden rounded-xl border shadow-xl shadow-black/10 lg:block">
      <header className="flex items-center justify-between gap-4 border-b border-terminal-border px-4 py-3">
        <div className="flex items-center gap-2 text-support font-semibold">
          <TerminalSquare className="size-4 text-terminal-brand" />
          Work order · web-204
        </div>
        <span className="font-mono text-caption text-terminal-muted">RUN-0417</span>
      </header>
      <div className="space-y-6 p-4 sm:p-6">
        <div>
          <p className="font-mono text-caption text-terminal-brand">INCIDENT</p>
          <h2 className="mt-2 text-page-title">
            The service is healthy. The website is not.
          </h2>
          <p className="mt-2 text-support text-terminal-muted">
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

        <div className="rounded-lg bg-terminal-background p-4 text-code">
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
    <li className="grid grid-cols-[1.25rem_2rem_minmax(0,1fr)_auto] items-center gap-2 py-3 text-support">
      {icon}
      <span className="font-mono text-caption text-terminal-muted">{number}</span>
      <span className="font-semibold">{label}</span>
      <span className="hidden text-caption text-terminal-muted sm:block">
        {detail}
      </span>
    </li>
  );
}

const footerLinkClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center underline decoration-border underline-offset-4 transition-colors hover:text-foreground";

const sponsorLinkClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-1 opacity-90 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
