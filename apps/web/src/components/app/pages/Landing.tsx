import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import hetznerLogo from "@/assets/hetzner-logo.webp";
import hosttechLogo from "@/assets/hosttech-logo.svg?url";
import hosttechLogoLight from "@/assets/hosttech-logo-light.svg?url";
import namespaceLogo from "@/assets/namespace-logo.png";
import { BrandMark } from "../patterns/BrandMark";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { useMyRuns } from "../hooks/useMyRuns";
import { useSession } from "../hooks/useSession";
import { useSignupStatus } from "../hooks/useSignupStatus";
import { ThemeToggle } from "../theme";
import { RunLoop } from "./landing/RunLoop";
import { RunPreview } from "./landing/RunPreview";
import { signupSpotsLine } from "./landing/signup-spots";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { startGithubSignIn } from "@/lib/auth-client";

const errorMessages: Record<string, string> = {
  signups_full:
    "No sign-up spots are open right now. Members can still sign in.",
  access_revoked: "This account no longer has access.",
  banned_user: "This account no longer has access.",
  validation_failed: "We couldn't check this sign-in. Please try again.",
  unable_to_create_session: "We couldn't complete sign-in. Please try again.",
  unable_to_create_user: "We couldn't create your account. Please try again.",
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
  const signups = useSignupStatus();
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

      <main className="flex flex-1 flex-col">
        <section className="mx-auto flex w-full max-w-7xl flex-col items-center px-[var(--page-inset)] pt-10 text-center sm:pt-14 lg:pt-16">
          <div className="flex flex-col items-center gap-6 motion-safe:animate-rise sm:gap-8">
            <p className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-caption font-medium text-muted-foreground shadow-[var(--highlight)]">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-primary"
              />
              Early access
            </p>

            <div className="space-y-5 sm:space-y-6">
              <h1 className="text-display text-balance">
                <span className="block">Repair real systems.</span>
                <span className="block text-faint-foreground">
                  Prove the fix.
                  {/* The underscore cursor from the brand mark. */}
                  <span
                    aria-hidden="true"
                    className="ml-[0.08em] inline-block h-[0.085em] w-[0.5em] bg-primary motion-safe:animate-caret"
                  />
                </span>
              </h1>
              <p className="mx-auto max-w-2xl text-[1.0625rem] leading-relaxed text-balance text-muted-foreground sm:text-lg lg:text-xl">
                Diagnose a live sandbox, repair it in the shell, and watch
                the checks turn green.
              </p>
            </div>

            {/* The spots line sits with the sign-in actions it describes. */}
            <div className="flex w-full flex-col items-center gap-3 sm:w-auto">
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-center sm:gap-3">
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

              {!signedIn && signups.isSuccess ? (
                <p className="text-caption text-muted-foreground tabular-nums">
                  {signupSpotsLine(signups.data)}
                </p>
              ) : null}
            </div>

            {signIn.error ? (
              <InlineFeedback tone="error">
                {signIn.error instanceof Error
                  ? signIn.error.message
                  : "GitHub sign-in could not be started."}
              </InlineFeedback>
            ) : null}
          </div>
        </section>

        {/* The workspace rises out of the hero on graph paper: page one shows
            its top, the rest waits below the fold. */}
        <div className="relative mx-auto w-full max-w-7xl px-[var(--page-inset)] pt-12 sm:pt-16">
          <div
            aria-hidden="true"
            className="dot-grid pointer-events-none absolute -inset-x-20 -top-6 -bottom-20 -z-10 hidden [--dot-grid-mask:radial-gradient(ellipse_60%_56%_at_50%_46%,#000_32%,transparent_78%)] lg:block"
          />
          <RunPreview className="landing-settle h-[30rem] sm:h-[32rem] lg:h-[34rem]" />
        </div>

        <RunLoop />

        <SponsorMarks />
      </main>

      <footer className="mx-auto flex w-full max-w-7xl shrink-0 flex-col items-center gap-2 px-[var(--page-inset)] pb-8 text-[0.8125rem] text-faint-foreground sm:flex-row sm:justify-between">
        <span>Built by Stefan Ruzitschka</span>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <a href="https://github.com/intar-dev" className={footerLinkClassName}>
            GitHub
          </a>
          <a href="https://docs.intar.dev" className={footerLinkClassName}>
            Documentation
          </a>
          <a href="mailto:hello@intar.dev" className={footerLinkClassName}>
            Sponsorships
          </a>
        </div>
      </footer>
    </div>
  );
}

function SponsorMarks() {
  return (
    <aside
      aria-labelledby="landing-sponsors-heading"
      className="mx-auto flex w-full max-w-7xl flex-col items-center gap-5 px-[var(--page-inset)] py-24 sm:py-32"
    >
      <p id="landing-sponsors-heading" className="text-label">
        Infrastructure by
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
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

const footerLinkClassName =
  "inline-flex items-center justify-center text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-border-strong pointer-coarse:min-h-11 pointer-coarse:min-w-11";

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
