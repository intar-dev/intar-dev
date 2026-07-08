import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { startGithubSignIn } from "@/lib/auth-client";
import { ThemeToggle } from "../theme";
import hetznerLogo from "@/assets/hetzner-logo.jpg";
import namespaceLogo from "@/assets/namespace-logo.png";

const errorMessages: Record<string, string> = {
  unable_to_create_session:
    "We couldn't complete sign-in. Your GitHub username isn't on the allowlist yet.",
  unable_to_create_user:
    "We couldn't create your account. Ask an admin to add you to the allowlist.",
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

  const signIn = useMutation({
    mutationFn: () =>
      startGithubSignIn({
        callbackURL: `${window.location.origin}/scenarios`,
        errorCallbackURL: `${window.location.origin}/`,
      }),
  });

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-6">
        <span className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="font-heading text-lg font-bold tracking-tight">
            intar
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signIn.mutate()}
            disabled={signIn.isPending}
          >
            {signIn.isPending ? "Opening GitHub…" : "Sign in"}
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {errorMessage ? (
        <div className="mx-auto w-full max-w-3xl px-6 pt-6">
          <Alert variant="destructive">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-12 px-6 py-16">
        <section className="flex flex-col items-start gap-4">
          <p className="text-eyebrow">Hands-on DevOps training</p>
          <h1 className="text-page-title text-balance">
            Learn DevOps by fixing{" "}
            <span className="text-gradient-brand">real broken systems</span>
          </h1>
          <p className="text-muted-foreground leading-7">
            Real scenarios, live sandboxes, actual VMs to break and repair —
            not slideshows.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <p className="text-eyebrow">Sponsored by</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <a
              href="https://www.hetzner.com/?mtm_campaign=intar-dev&mtm_medium=referral&mtm_content=sponsoring_link"
              target="_blank"
              rel="noreferrer"
              className={sponsorCardClassName}
            >
              <img
                src={hetznerLogo.src}
                width={hetznerLogo.width}
                height={hetznerLogo.height}
                alt="Hetzner"
                className="h-9 w-auto rounded-[4px]"
              />
              <span className="text-sm text-muted-foreground">
                Cloud & dedicated server hosting
              </span>
            </a>
            <a
              href="https://namespace.so"
              target="_blank"
              rel="noreferrer"
              className={sponsorCardClassName}
            >
              <img
                src={namespaceLogo.src}
                width={namespaceLogo.width}
                height={namespaceLogo.height}
                alt="namespace"
                className="h-7 w-auto dark:invert"
              />
              <span className="text-sm text-muted-foreground">
                High-performance build infrastructure
              </span>
            </a>
          </div>
        </section>

        <section className="space-y-4 text-muted-foreground leading-7">
          <p>
            Pick a scenario — a misconfigured web server, a flaky service, a
            cluster that won't schedule — and drop into a live sandbox with one
            or more real VMs, reachable from your browser or a native SSH
            terminal. No simulations: an actual box to fix.
          </p>
          <p>
            Objectives turn green as you repair the system. Stuck? Reveal
            hints in order, or the full solution when you need it.
          </p>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-6 py-10 text-center text-sm text-muted-foreground">
        <span>Built by</span>
        <a
          href="https://icepuma.dev"
          target="_blank"
          rel="noreferrer"
          className={footerLinkClassName}
        >
          Stefan Ruzitschka
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/intar-dev"
          target="_blank"
          rel="noreferrer"
          className={footerLinkClassName}
        >
          intar-dev on GitHub
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://docs.intar.dev"
          target="_blank"
          rel="noreferrer"
          className={footerLinkClassName}
        >
          Documentation
        </a>
        <span aria-hidden="true">·</span>
        <span>For sponsorships reach out via</span>
        <a href="mailto:marketing@intar.dev" className={footerLinkClassName}>
          marketing@intar.dev
        </a>
      </footer>
    </div>
  );
}

const footerLinkClassName =
  "underline decoration-border underline-offset-4 transition-colors hover:text-foreground";

const sponsorCardClassName =
  "flex items-center gap-4 rounded-2xl border bg-card px-5 py-4 shadow-xs outline-none ring-offset-background transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
