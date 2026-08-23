import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleUserRound,
  KeyRound,
  LoaderCircle,
  LogOut,
  RotateCcw,
} from "lucide-react";
import { AuthShell } from "../patterns/AuthShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveGithubClaimRedirect } from "./sign-in-helpers";

type ClaimState =
  | "ready"
  | "authenticated"
  | "active"
  | "github_required"
  | "expired"
  | "redeemed"
  | "revoked"
  | "invalid";

interface CurrentClaim {
  state: ClaimState;
  user?: {
    id: string;
    githubUsername: string;
  };
  expiresAt?: number;
}

interface StartClaimResponse {
  redirectUrl: string;
  redirectKind: "github";
}

interface JoinProblem {
  title: string;
  description: string;
}

declare global {
  interface Window {
    __INTAR_BETA_INVITE__?: string | null;
  }
}

export function JoinBeta() {
  const inviteCodeRef = useRef<string | null>(takeScrubbedInviteCode());
  const [claim, setClaim] = useState<CurrentClaim | null>(null);
  const [status, setStatus] = useState<
    "loading" | "idle" | "starting" | "confirming" | "canceling" | "canceled"
  >("loading");
  const [problem, setProblem] = useState<JoinProblem | null>(null);

  const refresh = async () => {
    const current = await apiJson<CurrentClaim>("/api/access-invites/current", {
      method: "GET",
    });
    setClaim(current);
    return current;
  };

  const initialize = async () => {
    setStatus("loading");
    setProblem(null);
    try {
      if (inviteCodeRef.current) {
        await apiJson<void>("/api/access-invites/exchange", {
          method: "POST",
          body: JSON.stringify({ code: inviteCodeRef.current }),
        });
        inviteCodeRef.current = null;
      }
      await refresh();
    } catch (error) {
      setProblem(problemFor(error));
    } finally {
      setStatus("idle");
    }
  };

  useEffect(() => {
    void initialize();
    // The fragment is exchanged once, then only the signed HttpOnly attempt
    // cookie survives the page load and GitHub redirect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setStatus("starting");
    setProblem(null);
    try {
      const response = await apiJson<StartClaimResponse>(
        "/api/access-invites/start",
        { method: "POST", body: "{}" },
      );
      const redirect = resolveGithubClaimRedirect({
        ...response,
        applicationOrigin: window.location.origin,
      });
      if (!redirect) throw new Error("The GitHub sign-in address was rejected.");
      window.location.assign(redirect);
    } catch (error) {
      setProblem(problemFor(error));
      setStatus("idle");
    }
  };

  const confirm = async () => {
    setStatus("confirming");
    setProblem(null);
    try {
      await apiJson<void>("/api/access-invites/confirm", {
        method: "POST",
        body: "{}",
      });
      window.location.assign("/courses");
    } catch (error) {
      setProblem(problemFor(error));
      setStatus("idle");
      await refresh().catch(() => undefined);
    }
  };

  const cancel = async () => {
    setStatus("canceling");
    setProblem(null);
    try {
      await apiJson<void>("/api/access-invites/cancel", {
        method: "POST",
        body: "{}",
      });
      setClaim(null);
      setStatus("canceled");
    } catch (error) {
      setProblem(problemFor(error));
      setStatus("idle");
    }
  };

  const canCancel =
    status !== "loading" &&
    status !== "canceled" &&
    claim?.state !== "active" &&
    claim?.state !== "expired" &&
    claim?.state !== "redeemed" &&
    claim?.state !== "revoked" &&
    claim?.state !== "invalid";

  return (
    <AuthShell
      standalone
      eyebrow="Private beta"
      title={titleFor(claim, status, problem)}
      description={descriptionFor(claim, status, problem)}
    >
      <div aria-live="polite" className="space-y-6">
        {status === "loading" ? (
          <JoinStatus icon={<LoaderCircle className="motion-safe:animate-spin" />}>
            Checking the invite…
          </JoinStatus>
        ) : status === "canceled" ? (
          <JoinStatus icon={<LogOut />}>
            The claim was canceled and the session was signed out.
          </JoinStatus>
        ) : problem ? (
          <JoinStatus tone="error" icon={<CircleAlert />}>
            <span className="font-semibold">{problem.title}</span>
            <span className="mt-1 block">{problem.description}</span>
          </JoinStatus>
        ) : claim?.state === "ready" ? (
          <>
            <JoinStatus icon={<KeyRound />}>
              This single-use link is ready. Sign in with the GitHub account
              that should receive beta access.
            </JoinStatus>
            <Button className="w-full" disabled={status !== "idle"} onClick={() => void start()}>
              <CircleUserRound />
              {status === "starting" ? "Opening GitHub…" : "Continue with GitHub"}
            </Button>
          </>
        ) : claim?.state === "authenticated" ? (
          <>
            <div className="border-y py-4">
              <p className="text-caption">GitHub account</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CircleUserRound className="size-5" aria-hidden="true" />
                <p className="font-mono text-base font-semibold">
                  @{claim.user?.githubUsername}
                </p>
                <Badge variant="warning">Confirm</Badge>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Access will stay bound to this GitHub account.
              </p>
            </div>
            <Button
              className="w-full whitespace-normal"
              disabled={status !== "idle"}
              onClick={() => void confirm()}
            >
              <CheckCircle2 />
              {status === "confirming"
                ? "Joining beta…"
                : `Join beta as @${claim.user?.githubUsername}`}
            </Button>
          </>
        ) : claim?.state === "github_required" ? (
          <JoinStatus tone="error" icon={<CircleAlert />}>
            This session is not signed in with GitHub. Sign out, then open the
            invite again and continue with GitHub.
          </JoinStatus>
        ) : claim?.state === "active" ? (
          <>
            <JoinStatus tone="success" icon={<CheckCircle2 />}>
              {claim.user?.githubUsername
                ? `Beta access is active for @${claim.user.githubUsername}.`
                : "Beta access is active."}
            </JoinStatus>
            <Button className="w-full" render={<a href="/courses" />}>
              Open courses
            </Button>
          </>
        ) : claim ? (
          <TerminalState state={claim.state} />
        ) : null}

        {canCancel ? (
          <div className="border-t pt-4">
            <Button
              variant="ghost"
              className="w-full"
              disabled={status === "canceling"}
              onClick={() => void cancel()}
            >
              <LogOut />
              {status === "canceling" ? "Signing out…" : "Use another account"}
            </Button>
          </div>
        ) : null}

        {problem ? (
          <Button variant="outline" className="w-full" onClick={() => void initialize()}>
            <RotateCcw />
            Check again
          </Button>
        ) : null}
        {status === "canceled" ? (
          <Button variant="outline" className="w-full" render={<a href="/" />}>
            Return to intar.dev
          </Button>
        ) : null}
      </div>
    </AuthShell>
  );
}

function TerminalState({ state }: { state: ClaimState }) {
  const copy = {
    expired: "This invite expired. Ask a platform administrator for a new link.",
    redeemed: "This invite was already used. Ask for a new link.",
    revoked: "This invite was revoked. Ask for a new link.",
    invalid: "This invite is invalid. Check that you opened the complete link.",
    ready: "",
    authenticated: "",
    active: "",
    github_required: "",
  }[state];
  return (
    <JoinStatus tone="error" icon={<CircleAlert />}>
      {copy}
    </JoinStatus>
  );
}

function JoinStatus({
  icon,
  tone = "neutral",
  children,
}: {
  icon: React.ReactNode;
  tone?: "neutral" | "success" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "success"
          ? "flex items-start gap-3 rounded-xl border border-success-border bg-success-subtle p-4 text-success"
          : tone === "error"
            ? "flex items-start gap-3 rounded-xl border border-destructive-border bg-destructive-subtle p-4 text-destructive"
            : "flex items-start gap-3 rounded-xl border bg-muted/40 p-4 text-foreground"
      }
    >
      <span className="mt-0.5 shrink-0 [&>svg]:size-5" aria-hidden="true">
        {icon}
      </span>
      <p className="text-sm leading-6">{children}</p>
    </div>
  );
}

function titleFor(
  claim: CurrentClaim | null,
  status: string,
  problem: JoinProblem | null,
): string {
  if (status === "loading") return "Checking your invite";
  if (status === "canceled") return "Claim canceled";
  if (problem) return problem.title;
  if (claim?.state === "authenticated") return "Confirm your GitHub account";
  if (claim?.state === "active") return "You have beta access";
  return "Join the intar.dev beta";
}

function descriptionFor(
  claim: CurrentClaim | null,
  status: string,
  problem: JoinProblem | null,
): string {
  if (status === "loading") return "This does not consume the invite.";
  if (status === "canceled") return "The invite remains available if it is still active.";
  if (problem) return "Resolve the issue below, then try again.";
  if (claim?.state === "authenticated") {
    return "Check the account before granting access.";
  }
  return "One link admits one GitHub account.";
}

function takeScrubbedInviteCode(): string | null {
  if (typeof window === "undefined") return null;
  const invite = window.__INTAR_BETA_INVITE__;
  delete window.__INTAR_BETA_INVITE__;
  return typeof invite === "string" && invite ? invite : null;
}

class JoinApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JoinApiError";
  }
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method !== "GET") headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | { code?: string; error?: string; message?: string }
    | T
    | null;
  if (!response.ok) {
    const details = body as {
      code?: string;
      error?: string;
      message?: string;
    } | null;
    throw new JoinApiError(
      details?.code ?? "invite_request_failed",
      details?.error ?? details?.message ?? `Invite request failed (${response.status})`,
    );
  }
  return body as T;
}

function problemFor(error: unknown): JoinProblem {
  const code = error instanceof JoinApiError ? error.code : "invite_request_failed";
  const description =
    error instanceof Error && error.message
      ? error.message
      : "The invite could not be checked.";
  const titles: Record<string, string> = {
    access_invite_unavailable: "Invite unavailable",
    access_invite_claim_conflict: "Invite already used",
    beta_revocation_cleanup_incomplete: "Access cleanup is still running",
    github_session_required: "GitHub sign-in required",
    authentication_required: "Sign in with GitHub",
  };
  return { title: titles[code] ?? "Invite could not be completed", description };
}
