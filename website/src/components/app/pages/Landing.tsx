import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col">
        <main className="flex flex-1 items-center py-6">
          <div className="w-full space-y-6">
            {errorMessage ? (
              <Alert variant="destructive" className="max-w-xl">
                <AlertTitle>Sign-in failed</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : null}

            <section className="mx-auto flex max-w-3xl flex-col items-center gap-5 text-center sm:gap-6">
              <h1 className="flex items-center gap-3 text-6xl font-semibold leading-none tracking-tight sm:gap-4 sm:text-7xl lg:text-8xl">
                <img
                  src="/favicon.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-[1em] w-[1em]"
                />
                intar
              </h1>
              <p className="mx-auto max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                Hands-on DevOps training through real scenarios.
              </p>
            </section>
          </div>
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

        <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-6 text-center text-sm text-muted-foreground">
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
