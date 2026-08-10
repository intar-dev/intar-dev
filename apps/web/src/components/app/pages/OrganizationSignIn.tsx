import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowRight, Building2, ShieldCheck } from "lucide-react";
import { BrandMark } from "../patterns/BrandMark";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { ThemeToggle } from "../theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { startOrganizationSignIn } from "@/lib/auth-client";
import { normalizeRecoveryOrganizationSlug } from "./join-recovery";

export function OrganizationSignIn() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const directSlug = useMemo(() => {
    const match = pathname.match(/^\/organizations\/([^/]+)\/sign-in$/);
    if (!match?.[1]) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return "";
    }
  }, [pathname]);
  const callbackError =
    typeof window === "undefined"
      ? null
      : (() => {
          const query = new URLSearchParams(window.location.search);
          const code = query.get("error");
          if (!code) return null;
          return (
            query.get("error_description") ??
            `Organization sign-in failed (${code.replaceAll("_", " ")}).`
          );
        })();
  const [slug, setSlug] = useState(directSlug);
  const normalizedSlug = normalizeRecoveryOrganizationSlug(slug);
  const signIn = useMutation({
    mutationFn: () => {
      if (!normalizedSlug) throw new Error("Organization slug is invalid");
      return startOrganizationSignIn(normalizedSlug, {
        callbackURL: `${window.location.origin}/organizations/${encodeURIComponent(normalizedSlug)}`,
        errorCallbackURL:
          window.location.href.split("?")[0] ?? window.location.href,
      });
    },
  });

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-[var(--page-inset)]">
        <BrandMark />
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 items-center justify-center px-[var(--page-inset)] py-12">
        <Card className="w-full max-w-lg overflow-hidden border-brand-border shadow-xl shadow-black/5">
          <CardHeader className="border-b bg-brand-subtle">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Building2 className="size-5" />
            </span>
            <div className="space-y-2">
              <p className="text-eyebrow text-brand-text">
                Organization access
              </p>
              <h1 className="text-section-title">
                Continue with organization OIDC
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Use an existing linked OIDC identity, or explicitly connect
                your organization provider from an active GitHub beta session.
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-6">
            {callbackError ? (
              <InlineFeedback tone="error">{callbackError}</InlineFeedback>
            ) : null}
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (normalizedSlug && !signIn.isPending) signIn.mutate();
              }}
            >
              <label
                htmlFor="organization-slug"
                className="text-sm font-medium"
              >
                Organization slug
              </label>
              <Input
                id="organization-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="rawkode-academy-ab12cd"
                maxLength={128}
                pattern="[a-z0-9][a-z0-9-]{0,127}"
                autoComplete="organization"
                spellCheck={false}
                autoFocus={!directSlug}
              />
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={!normalizedSlug || signIn.isPending}
              >
                {signIn.isPending
                  ? "Opening identity provider…"
                  : "Continue with organization OIDC"}
                {!signIn.isPending ? <ArrowRight className="size-4" /> : null}
              </Button>
            </form>
            {signIn.error ? (
              <InlineFeedback tone="error">
                {signIn.error instanceof Error
                  ? signIn.error.message
                  : "Organization sign-in could not be started."}
              </InlineFeedback>
            ) : null}
            <div className="flex gap-3 rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-text" />
              <div className="space-y-2">
                <p>
                  New beta users must open an invite and redeem through GitHub
                  first.
                </p>
                <p>
                  Signed in with an active GitHub beta account? Continuing here
                  explicitly connects OIDC to that account.
                </p>
                <p>
                  Already linked? Continuing signs in with the stable OIDC
                  subject. Ask your organization admin for the exact slug if
                  needed.
                </p>
              </div>
            </div>
            <Button
              variant="link"
              className="h-auto p-0"
              render={<Link to="/" />}
            >
              Back to Intar
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
