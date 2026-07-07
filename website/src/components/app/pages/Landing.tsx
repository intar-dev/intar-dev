import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ScrollText, ShieldCheck, Terminal } from "lucide-react";
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

const steps = [
  {
    icon: ShieldCheck,
    title: "Pick a scenario",
    body: "Choose a real, broken system — a misconfigured web server, a flaky service, a cluster that won't schedule.",
  },
  {
    icon: Terminal,
    title: "Drop into a live sandbox",
    body: "Get one or more real VMs with a browser or native SSH terminal. No simulations — an actual box to fix.",
  },
  {
    icon: ScrollText,
    title: "Solve, with checks & hints",
    body: "Objectives turn green as you fix things. Stuck? Reveal hints in order, or the full solution when you need it.",
  },
] as const;

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
    <div className="px-4 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex items-center justify-between py-5">
          <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <img
              src="/favicon.svg"
              alt=""
              aria-hidden="true"
              className="size-6"
            />
            intar
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
          <Alert variant="destructive" className="mx-auto max-w-xl">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <main>
          <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 py-16 text-center sm:py-24">
            <h1 className="flex items-center gap-3 text-6xl font-semibold leading-none tracking-tight sm:gap-4 sm:text-7xl lg:text-8xl">
              <img
                src="/favicon.svg"
                alt=""
                aria-hidden="true"
                className="h-[1em] w-[1em]"
              />
              intar
            </h1>
            <p className="mx-auto max-w-xl text-lg leading-8 text-muted-foreground sm:text-xl">
              Hands-on DevOps training through real scenarios. Fix real broken
              systems in live sandboxes — not slideshows.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button size="lg" render={<Link to="/request-access" />}>
                Request access
                <ArrowRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => signIn.mutate()}
                disabled={signIn.isPending}
              >
                {signIn.isPending ? "Opening GitHub…" : "Sign in with GitHub"}
              </Button>
            </div>
          </section>

          <section className="mx-auto grid max-w-5xl gap-4 pb-16 sm:grid-cols-3">
            {steps.map((step) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.title}
                  className="rounded-2xl border bg-card/60 p-6 text-left"
                >
                  <span className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </span>
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              );
            })}
          </section>
        </main>

        <section className="py-10 sm:py-12">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 sm:gap-8">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Sponsored by
            </h2>
            <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-14">
              <a
                href="https://www.hetzner.com/?mtm_campaign=intar-dev&mtm_medium=referral&mtm_content=sponsoring_link"
                target="_blank"
                rel="noreferrer"
                className="rounded-sm outline-none ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <img
                  src={hetznerLogo.src}
                  width={hetznerLogo.width}
                  height={hetznerLogo.height}
                  alt="Hetzner"
                  className="h-12 w-auto rounded-[4px] sm:h-16"
                />
              </a>
              <a
                href="https://namespace.so"
                target="_blank"
                rel="noreferrer"
                className="rounded-sm outline-none ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <img
                  src={namespaceLogo.src}
                  width={namespaceLogo.width}
                  height={namespaceLogo.height}
                  alt="namespace"
                  className="h-9 w-auto sm:h-12 dark:invert"
                />
              </a>
            </div>
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 py-8 text-center text-sm text-muted-foreground">
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
    </div>
  );
}

const footerLinkClassName =
  "underline decoration-border underline-offset-4 transition-colors hover:text-foreground";

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
