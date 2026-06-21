import { useMutation, useQuery } from "@tanstack/react-query";
import { useSession } from "../hooks/useSession";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
  const redirectHost = clientQuery.data?.redirect_uris[0]
    ? new URL(clientQuery.data.redirect_uris[0]).host
    : null;

  return (
    <div className="px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-3xl items-center justify-center">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Authorize access</CardTitle>
            <CardDescription>
              Review the client and the scopes it is requesting before continuing
              the OAuth flow.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
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
              <Alert variant="destructive">
                <AlertTitle>Unable to load client</AlertTitle>
                <AlertDescription>{clientError}</AlertDescription>
              </Alert>
            ) : null}

            {consentError ? (
              <Alert variant="destructive">
                <AlertTitle>Consent failed</AlertTitle>
                <AlertDescription>{consentError}</AlertDescription>
              </Alert>
            ) : null}

            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {clientName}
                </h2>
                {redirectHost ? <Badge variant="outline">{redirectHost}</Badge> : null}
              </div>

              <div className="space-y-1 text-sm text-muted-foreground">
                <p>
                  Client ID: <span className="font-mono text-foreground">{clientId}</span>
                </p>
                {session?.user ? (
                  <p>
                    Signed in as{" "}
                    <span className="font-medium text-foreground">
                      {session.user.email}
                    </span>
                  </p>
                ) : null}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Requested scopes
              </h3>
              {scopes.length ? (
                <div className="flex flex-wrap gap-2">
                  {scopes.map((scope) => (
                    <Badge key={scope} variant="secondary">
                      {scope}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No scopes were requested.
                </p>
              )}
            </section>

            {clientQuery.data?.client_uri ? (
              <section className="space-y-1 text-sm text-muted-foreground">
                <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Client URL
                </h3>
                <p className="break-all">{clientQuery.data.client_uri}</p>
              </section>
            ) : null}
          </CardContent>

          <CardFooter className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              disabled={!canRespond}
              onClick={() => consentMutation.mutate(false)}
            >
              {consentMutation.isPending ? "Working..." : "Deny"}
            </Button>
            <Button
              type="button"
              className="w-full sm:w-auto"
              disabled={!canRespond}
              onClick={() => consentMutation.mutate(true)}
            >
              {consentMutation.isPending ? "Working..." : "Allow access"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
