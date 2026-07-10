import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { AuthShell } from "../patterns/AuthShell";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface OAuthClientSummary {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
}

interface OAuthConsentResult {
  url: string;
}

function getOAuthQuery() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.location.search.replace(/^\?/, "");
}

function parseScopes(scopeValue?: string | null) {
  return (scopeValue ?? "")
    .split(" ")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function safeHost(value?: string | null) {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const message =
    ("message" in payload && typeof payload.message === "string"
      ? payload.message
      : null) ??
    ("error_description" in payload && typeof payload.error_description === "string"
      ? payload.error_description
      : null) ??
    ("error" in payload && typeof payload.error === "string"
      ? payload.error
      : null);

  return message ?? fallback;
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchOAuthClient(input: {
  clientId: string;
  oauthQuery: string;
}): Promise<OAuthClientSummary> {
  const response = await fetch("/api/auth/oauth2/public-client-prelogin", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      oauth_query: input.oauthQuery,
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, "Unable to load OAuth client details."));
  }

  return payload as unknown as OAuthClientSummary;
}

async function submitConsent(input: {
  accept: boolean;
  oauthQuery: string;
}): Promise<OAuthConsentResult> {
  const response = await fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accept: input.accept,
      oauth_query: input.oauthQuery,
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || !payload) {
    throw new Error(getErrorMessage(payload, "Unable to complete OAuth consent."));
  }

  const url =
    "url" in payload && typeof payload.url === "string" ? payload.url : null;
  if (!url) {
    throw new Error("OAuth consent completed without a redirect URL.");
  }

  return { url };
}

export function OAuthConsent() {
  const oauthQuery = getOAuthQuery();
  const searchParams = new URLSearchParams(oauthQuery);
  const clientId = searchParams.get("client_id");
  const scopes = parseScopes(searchParams.get("scope"));
  const { data: session, isLoading: sessionLoading } = useSession();

  const clientQuery = useQuery({
    queryKey: ["oauth-client-prelogin", clientId, oauthQuery],
    enabled: Boolean(clientId && oauthQuery),
    queryFn: () =>
      fetchOAuthClient({
        clientId: clientId!,
        oauthQuery,
      }),
  });

  const consentMutation = useMutation({
    mutationFn: (accept: boolean) =>
      submitConsent({
        accept,
        oauthQuery,
      }),
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });

  const consentError =
    consentMutation.error instanceof Error ? consentMutation.error.message : null;
  const clientError =
    clientQuery.error instanceof Error ? clientQuery.error.message : null;
  const hasSignedInUser = Boolean(session?.user);
  const oauthQueryMissing = !oauthQuery || !clientId;
  const canRespond =
    hasSignedInUser && !oauthQueryMissing && !consentMutation.isPending;
  const clientName = clientQuery.data?.client_name ?? clientId ?? "OAuth client";
  const redirectHost = safeHost(clientQuery.data?.redirect_uris[0]);

  return (
    <AuthShell
      eyebrow="Authorization relay"
      title="Authorize access"
      description="Review who is asking, which capabilities they need, and where you will return."
    >
      <div className="space-y-6">
          {oauthQueryMissing ? (
            <Alert variant="destructive">
              <AlertTitle>Missing OAuth request</AlertTitle>
              <AlertDescription>
                This consent screen was opened without a signed OAuth request.
                Restart the sign-in flow from the external application.
              </AlertDescription>
            </Alert>
          ) : null}

          {!oauthQueryMissing && !sessionLoading && !hasSignedInUser ? (
            <Alert variant="destructive">
              <AlertTitle>Session required</AlertTitle>
              <AlertDescription>
                Your Intar session is no longer active. Sign in again and restart
                authorization from the external application.
              </AlertDescription>
            </Alert>
          ) : null}

          {clientError ? (
            <InlineFeedback tone="error">{clientError}</InlineFeedback>
          ) : null}

          {consentError ? (
            <InlineFeedback tone="error">{consentError}</InlineFeedback>
          ) : null}

          {!oauthQueryMissing ? (
            <section className="space-y-6 rounded-lg border bg-background p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  className="mt-0.5 size-5 shrink-0 text-brand-text"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1">
                  <h2 className="text-section-title break-words">{clientName}</h2>
                  <p className="text-sm text-muted-foreground">
                    External OAuth client
                  </p>
                </div>
              </div>

              <dl className="divide-y border-y text-sm">
                <ConsentDetail label="Client ID">
                  <code className="break-all">{clientId}</code>
                </ConsentDetail>
                {session?.user ? (
                  <ConsentDetail label="Signed in as">
                    <span className="break-all">{session.user.email}</span>
                  </ConsentDetail>
                ) : null}
                {redirectHost ? (
                  <ConsentDetail label="Returns to">
                    <span className="inline-flex items-center gap-1 break-all">
                      {redirectHost}
                      <ArrowUpRight className="size-3.5 shrink-0" />
                    </span>
                  </ConsentDetail>
                ) : null}
              </dl>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-section-title">Requested access</h2>
              <span className="text-metadata tabular-nums">
                {scopes.length} {scopes.length === 1 ? "scope" : "scopes"}
              </span>
            </div>
            {scopes.length ? (
              <ul className="divide-y border-y">
                {scopes.map((scope) => (
                  <li
                    key={scope}
                    className="flex min-h-11 items-center gap-3 py-2 text-sm"
                  >
                    <CheckCircle2
                      className="size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <code className="break-all">{scope}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                No scopes were requested.
              </p>
            )}
          </section>

          {clientQuery.data?.client_uri ? (
            <p className="text-sm text-muted-foreground">
              Client website:{" "}
              <span className="break-all text-foreground">
                {clientQuery.data.client_uri}
              </span>
            </p>
          ) : null}

          {consentMutation.isPending ? (
            <InlineFeedback tone="pending">
              Recording your authorization choice…
            </InlineFeedback>
          ) : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" render={<Link to="/" />}>
              Back to intar.dev
            </Button>
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              disabled={!canRespond}
              onClick={() => consentMutation.mutate(false)}
            >
              Deny access
            </Button>
            <Button
              type="button"
              disabled={!canRespond}
              onClick={() => consentMutation.mutate(true)}
            >
              Allow access
            </Button>
            </div>
          </div>
      </div>
    </AuthShell>
  );
}

function ConsentDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium sm:text-right">{children}</dd>
    </div>
  );
}
