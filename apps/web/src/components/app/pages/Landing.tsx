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
import { ThemeToggle } from "../theme";
import { RunPreview } from "./landing/RunPreview";
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

  // From sm up the whole page, run preview included, fits one viewport;
  // below 40rem of height it falls back to scrolling.
  return (
    <div className="relative isolate flex min-h-svh flex-col overflow-hidden bg-canvas sm:h-svh sm:min-h-[40rem]">
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

      <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-8 px-[var(--page-inset)] pt-4 pb-6 sm:gap-6 sm:pt-2 sm:pb-2 lg:gap-8 lg:pt-4">
        <section className="grid items-end gap-6 motion-safe:animate-rise lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-12">
          <h1 className="text-display text-balance">
            <span className="block">Repair real systems.</span>
            <span className="block text-faint-foreground">Prove the fix.</span>
          </h1>

          <div className="flex flex-col items-start gap-6">
            <p className="prose-measure text-[1.0625rem] leading-relaxed text-muted-foreground sm:text-lg">
              Diagnose a live sandbox, repair it in the shell, and watch the
              checks turn green.
            </p>

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
        </section>

        <RunPreview className="hidden min-h-0 flex-1 motion-safe:animate-rise sm:flex" />
      </main>

      <footer className="mx-auto flex w-full max-w-7xl shrink-0 flex-wrap items-center justify-between gap-x-8 gap-y-3 px-[var(--page-inset)] py-3 text-[0.8125rem] text-faint-foreground">
        <SponsorMarks />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
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
        </div>
      </footer>
    </div>
  );
}

function SponsorMarks() {
  return (
    <aside
      aria-labelledby="landing-sponsors-heading"
      className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-6"
    >
      <p
        id="landing-sponsors-heading"
        className="text-caption font-medium"
      >
        Infrastructure by
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
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
            className="h-8 w-auto rounded-md"
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
            className="h-6 w-auto dark:invert"
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
            className="h-5 w-auto dark:hidden"
          />
          <img
            src={hosttechLogo}
            width={1000}
            height={195.1}
            alt="hosttech"
            className="hidden h-5 w-auto dark:block"
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
