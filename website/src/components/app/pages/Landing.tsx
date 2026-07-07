import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock3, Film, Server, SquareTerminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { startGithubSignIn } from "@/lib/auth-client";
import { ThemeToggle } from "../theme";
import { DifficultyChip, MetaChip, type ScenarioDifficulty } from "../patterns/MetaChip";
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
    number: "01",
    title: "Pick a scenario",
    body: "Choose a real, broken system — a misconfigured web server, a flaky service, a cluster that won't schedule.",
  },
  {
    number: "02",
    title: "Drop into a live sandbox",
    body: "Get one or more real VMs with a browser or native SSH terminal. No simulations — an actual box to fix.",
  },
  {
    number: "03",
    title: "Solve, with checks & hints",
    body: "Objectives turn green as you fix things. Stuck? Reveal hints in order, or the full solution when you need it.",
  },
] as const;

interface ShowcaseScenario {
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  vmCount: number;
}

const showcaseScenarios: ShowcaseScenario[] = [
  {
    title: "Nginx is down",
    tagline:
      "The company site returns connection refused. Find out why nginx won't start and bring it back.",
    difficulty: "easy",
    estimatedMinutes: 20,
    vmCount: 1,
  },
  {
    title: "Postgres won't accept writes",
    tagline:
      "Reads work, writes fail. Dig through logs and disk state to figure out what's blocking the database.",
    difficulty: "medium",
    estimatedMinutes: 35,
    vmCount: 1,
  },
  {
    title: "Kubernetes OOM loop",
    tagline:
      "A deployment keeps crash-looping under memory pressure. Diagnose the limits and stop the churn.",
    difficulty: "hard",
    estimatedMinutes: 45,
    vmCount: 3,
  },
];

// Deliberately always-dark terminal palette (independent of theme tokens).
const terminalLines = [
  { tone: "command", text: "systemctl status nginx" },
  {
    tone: "error",
    text: "● nginx.service — failed (Result: exit-code)",
  },
  { tone: "command", text: "nginx -t" },
  {
    tone: "error",
    text: 'nginx: [emerg] unknown directive "worker_proceses" in /etc/nginx/nginx.conf:1',
  },
  {
    tone: "command",
    text: "vim /etc/nginx/nginx.conf && systemctl restart nginx",
  },
  {
    tone: "success",
    text: "✓ objective complete — nginx serving traffic",
  },
] as const;

function TerminalMock() {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-md">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="size-3 rounded-full bg-destructive/50" aria-hidden="true" />
        <span className="size-3 rounded-full bg-warning/60" aria-hidden="true" />
        <span className="size-3 rounded-full bg-success/50" aria-hidden="true" />
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          learner@nginx-debug
        </span>
      </div>
      <div className="space-y-1.5 overflow-x-auto bg-[oklch(0.22_0.012_55)] p-5 font-mono text-sm text-[oklch(0.9_0.01_80)]">
        {terminalLines.map((line) => (
          <p key={line.text} className="whitespace-nowrap">
            {line.tone === "command" ? (
              <>
                <span className="text-[oklch(0.75_0.1_60)]">$ </span>
                {line.text}
              </>
            ) : (
              <span
                className={
                  line.tone === "error"
                    ? "text-[oklch(0.7_0.17_25)]"
                    : "text-[oklch(0.8_0.13_170)]"
                }
              >
                {line.text}
              </span>
            )}
          </p>
        ))}
        <p aria-hidden="true">
          <span className="text-[oklch(0.75_0.1_60)]">$ </span>
          <span className="inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-[oklch(0.9_0.01_80)]" />
        </p>
      </div>
    </div>
  );
}

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
    <div>
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <SquareTerminal className="size-5" aria-hidden="true" />
          </span>
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
          <Button size="sm" render={<Link to="/request-access" />}>
            Request access
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {errorMessage ? (
        <div className="mx-auto w-full max-w-6xl px-6 pt-6">
          <Alert variant="destructive" className="mx-auto max-w-xl">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main>
        <section className="mx-auto w-full max-w-6xl px-6 py-20 sm:py-28">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="flex flex-col items-start gap-6">
              <p className="text-eyebrow">Hands-on DevOps training</p>
              <h1 className="text-display text-balance sm:text-5xl">
                Learn DevOps by fixing real broken systems
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
                Real scenarios, live sandboxes, actual VMs to break and repair —
                not slideshows.
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
            </div>
            <TerminalMock />
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <p className="text-eyebrow">How it works</p>
          <h2 className="mt-2 text-page-title">
            From broken to fixed, in three steps
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {steps.map((step) => (
              <div
                key={step.number}
                className="rounded-2xl border bg-card p-6 shadow-xs"
              >
                <p className="font-mono text-sm text-primary">{step.number}</p>
                <h3 className="mt-3 text-card-title">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <p className="text-eyebrow">Scenario catalog</p>
          <h2 className="mt-2 text-page-title">What you'll fix</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {showcaseScenarios.map((scenario) => (
              <div
                key={scenario.title}
                className="flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <DifficultyChip difficulty={scenario.difficulty} />
                  <MetaChip icon={<Clock3 />}>
                    ~{scenario.estimatedMinutes} min
                  </MetaChip>
                  <MetaChip icon={<Server />}>
                    {scenario.vmCount === 1
                      ? "1 machine"
                      : `${scenario.vmCount} machines`}
                  </MetaChip>
                </div>
                <div className="space-y-1.5">
                  <h3 className="font-heading text-xl font-semibold tracking-tight">
                    {scenario.title}
                  </h3>
                  <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
                    {scenario.tagline}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 py-8">
          <div className="flex items-center gap-4 rounded-2xl border bg-card p-6 shadow-xs">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
              <Film className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-card-title">
                Every run ends with a replay you can share.
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Your whole terminal session is recorded — review what you did,
                or send the link to a teammate.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="flex flex-col items-center gap-6 text-center">
            <h2 className="text-eyebrow">Sponsored by</h2>
            <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-14">
              <a
                href="https://www.hetzner.com/?mtm_campaign=intar-dev&mtm_medium=referral&mtm_content=sponsoring_link"
                target="_blank"
                rel="noreferrer"
                className="rounded-sm opacity-70 grayscale outline-none ring-offset-background transition-all hover:opacity-100 hover:grayscale-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                className="rounded-sm opacity-70 grayscale outline-none ring-offset-background transition-all hover:opacity-100 hover:grayscale-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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

        <section className="mx-auto w-full max-w-6xl px-6 py-8">
          <div className="flex flex-col items-center gap-6 rounded-2xl border border-primary/20 bg-primary/5 px-6 py-14 text-center">
            <h2 className="text-page-title text-balance">
              Ready to fix something real?
            </h2>
            <p className="max-w-xl text-muted-foreground">
              intar is invite-only while we scale the sandbox fleet. Request
              access and we'll get you in.
            </p>
            <Button size="lg" render={<Link to="/request-access" />}>
              Request access
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-6 py-10 text-center text-sm text-muted-foreground">
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

function normalizeErrorCode(value?: string | null) {
  if (!value) return null;
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function friendlyMessageFor(value?: string | null) {
  const key = normalizeErrorCode(value);
  if (!key) return null;
  return errorMessages[key] ?? null;
}
