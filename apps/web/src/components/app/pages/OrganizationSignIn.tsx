import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowRight, Building2, ShieldCheck } from "lucide-react";
import { useCallbackErrorCode } from "../hooks/useCallbackErrorCode";
import { useSessionAccess } from "../hooks/useSession";
import { useSignOut } from "../hooks/useSignOut";
import { BrandMark } from "../patterns/BrandMark";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { ThemeToggle } from "../theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { appBootstrapQueryKey } from "@/lib/app-bootstrap";
import { AuthFlowError, startOrganizationSignIn } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";
import {
  normalizeOrganizationSlug,
  organizationSignInErrorMessage,
  organizationSignInStartErrorMessage,
} from "./sign-in-helpers";

export function OrganizationSignIn() {
  const { session, access } = useSessionAccess();
  const stranded = access === "stranded";
  const signedInAs =
    access === "active" && session?.user
      ? (session.user.username ?? session.user.email ?? "your account")
      : null;
  // Organization providers never sign in a platform admin.
  const platformAdmin = isAdminUser(session?.user);
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
  const [callbackCode, clearCallbackCode] = useCallbackErrorCode();
  const callbackError = callbackCode
    ? organizationSignInErrorMessage(callbackCode)
    : null;
  // The field keeps what was typed, so rewriting it never moves the cursor;
  // capitals and surrounding spaces are tidied only for the request.
  const [slug, setSlug] = useState(directSlug);
  const normalizedSlug = normalizeOrganizationSlug(slug);
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: () => {
      if (!normalizedSlug) throw new Error("Organization slug is invalid");
      return startOrganizationSignIn(normalizedSlug, {
        connect: signedInAs !== null,
      });
    },
    onMutate: clearCallbackCode,
    // The page's session was stale; refresh it so the page says what the
    // next click does.
    onError: (error) => {
      if (
        error instanceof AuthFlowError &&
        (error.code === "signed_out" ||
          error.code === "already_signed_in" ||
          error.code === "access_revoked")
      ) {
        void queryClient.invalidateQueries({ queryKey: appBootstrapQueryKey });
      }
    },
  });
  const signOut = useSignOut();
  const actionLabel = signedInAs
    ? "Connect organization"
    : "Continue with organization";

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-[var(--page-inset)]">
        <BrandMark />
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 items-center justify-center px-[var(--page-inset)] py-12">
        <Card className="w-full max-w-lg overflow-hidden border-brand-border pt-0 shadow-xl shadow-black/5">
          <CardHeader className="gap-4 border-b bg-brand-subtle pt-(--card-spacing)">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Building2 className="size-5" />
            </span>
            <div className="space-y-2">
              <p className="text-label text-brand-text">Organization access</p>
              <h1 className="text-page-title">
                {signedInAs
                  ? "Connect your organization"
                  : "Continue with your organization"}
              </h1>
              <p className="text-support text-muted-foreground">
                {stranded ? (
                  "This session can no longer be used. Sign out, then continue with your organization's identity provider."
                ) : signedInAs && platformAdmin ? (
                  <>
                    Continuing adds{" "}
                    <span className="font-medium text-foreground">
                      {signedInAs}
                    </span>{" "}
                    to your organization. Platform admins sign in with GitHub
                    only, so its identity provider won't sign you in. You can
                    disconnect it from your profile.
                  </>
                ) : signedInAs ? (
                  <>
                    Continuing lets your organization's identity provider sign
                    in as{" "}
                    <span className="font-medium text-foreground">
                      {signedInAs}
                    </span>
                    . Only connect an organization you belong to. You can
                    disconnect it from your profile.
                  </>
                ) : (
                  "Sign in with your organization's identity provider. First time? We'll create your account."
                )}
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {callbackError ? (
              <InlineFeedback tone="error">{callbackError}</InlineFeedback>
            ) : null}
            {stranded ? (
              // The server refuses a new sign-in from this session too.
              <Button
                size="lg"
                className="w-full"
                disabled={signOut.isPending}
                onClick={() => signOut.mutate()}
              >
                {signOut.isPending ? "Signing out…" : "Sign out"}
              </Button>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (normalizedSlug && !signIn.isPending) signIn.mutate();
                }}
              >
                <div className="space-y-2">
                  <label
                    htmlFor="organization-slug"
                    className="block text-label"
                  >
                    Organization slug
                  </label>
                  <Input
                    id="organization-slug"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    placeholder="example-org-ab12cd"
                    maxLength={128}
                    autoComplete="organization"
                    spellCheck={false}
                    autoFocus={!directSlug}
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={!normalizedSlug || signIn.isPending}
                >
                  {signIn.isPending
                    ? "Opening identity provider…"
                    : actionLabel}
                  {!signIn.isPending ? <ArrowRight className="size-4" /> : null}
                </Button>
              </form>
            )}
            {signIn.error ? (
              <InlineFeedback tone="error">
                {organizationSignInStartErrorMessage(signIn.error)}
              </InlineFeedback>
            ) : signOut.error ? (
              <InlineFeedback tone="error">
                {signOut.error.message}
              </InlineFeedback>
            ) : null}
            <div className="flex gap-3 rounded-xl bg-muted/40 p-4 text-support text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand-text" />
              <div className="space-y-2">
                {signedInAs ? (
                  <p>
                    Not {signedInAs}?{" "}
                    <Button
                      variant="link"
                      className="h-auto p-0 align-baseline"
                      disabled={signOut.isPending}
                      onClick={() => signOut.mutate()}
                    >
                      Sign out
                    </Button>{" "}
                    first to use a different account.
                  </p>
                ) : stranded ? null : (
                  <p>
                    Already use Intar with GitHub? Sign in with GitHub first,
                    then connect your organization here, so everything stays in
                    one account.
                  </p>
                )}
                <p>
                  Ask your organization admin for the exact slug or member
                  sign-in link if needed.
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
