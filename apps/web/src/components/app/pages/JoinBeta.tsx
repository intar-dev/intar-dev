import { useEffect, useRef, useState } from "react";
import {
  Ban,
  Building2,
  CheckCircle2,
  CircleAlert,
  CircleUserRound,
  Clock3,
  KeyRound,
  LoaderCircle,
  LogOut,
  RotateCcw,
} from "lucide-react";
import { AuthShell } from "../patterns/AuthShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  normalizeRecoveryOrganizationSlug,
  resolveClaimRedirect,
  type ClaimRedirectKind,
} from "./join-recovery";

type ClaimState =
  | "ready"
  | "leased"
  | "authenticated"
  | "active"
  | "blocked"
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
  leaseExpiresAt?: number;
  ownsLease?: boolean;
}

interface StartClaimResponse {
  redirectUrl: string;
  redirectKind: ClaimRedirectKind;
  leaseExpiresAt: number;
}

declare global {
  interface Window {
    __INTAR_BETA_INVITE__?: string | null;
  }
}

export function JoinBeta() {
  const inviteCodeRef = useRef<string | null>(takeScrubbedInviteCode());
  const [claim, setClaim] = useState<CurrentClaim | null>(null);
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [status, setStatus] = useState<
    | "loading"
    | "idle"
    | "starting-github"
    | "starting-sso"
    | "confirming"
    | "canceling"
    | "canceled"
  >("loading");
  const [problem, setProblem] = useState<JoinProblem | null>(null);

  const refresh = async (clearProblem = true) => {
    const current = await apiJson<CurrentClaim>(
      "/api/access-invites/current",
      { method: "GET" },
    );
    setClaim(current);
    if (clearProblem) setProblem(null);
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
      setStatus("idle");
    } catch (error) {
      setProblem(problemFor(error));
      setStatus("idle");
    }
  };

  useEffect(() => {
    void initialize();
    // The invite is deliberately exchanged once per page load. It remains in
    // memory only until the server acknowledges the attempt cookie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startClaim = async (kind: ClaimRedirectKind) => {
    const recoverySlug = normalizeRecoveryOrganizationSlug(organizationSlug);
    if (kind === "sso" && !recoverySlug) {
      setProblem({
        title: "Check the organization slug",
        description:
          "Use the exact lowercase slug from the organization sign-in link.",
      });
      return;
    }

    setStatus(kind === "sso" ? "starting-sso" : "starting-github");
    setProblem(null);
    try {
      const started = await apiJson<StartClaimResponse>(
        "/api/access-invites/start",
        {
          method: "POST",
          body: JSON.stringify(
            kind === "sso"
              ? { mode: "sso-recovery", organizationSlug: recoverySlug }
              : {},
          ),
        },
      );
      const redirect = resolveClaimRedirect({
        redirectUrl: started.redirectUrl,
        redirectKind: started.redirectKind,
        expectedKind: kind,
        applicationOrigin: window.location.origin,
      });
      if (!redirect) {
        throw new JoinApiError(
          kind === "sso" ? "invalid_sso_redirect" : "invalid_oauth_redirect",
          "The sign-in destination was rejected.",
          500,
        );
      }
      window.location.assign(redirect.href);
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
      await refresh();
      setStatus("idle");
    } catch (error) {
      setProblem(problemFor(error));
      setStatus("idle");
      try {
        await refresh(false);
      } catch {
        // Keep the confirmation error if the follow-up inspection also fails.
      }
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

  const identityReady =
    (claim?.state === "authenticated" || claim?.state === "leased") &&
    Boolean(claim.user?.githubUsername);
  const startingGithub = status === "starting-github";
  const startingSso = status === "starting-sso";
  const startPending = startingGithub || startingSso;
  const recoverySlug = normalizeRecoveryOrganizationSlug(organizationSlug);

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
            Checking the invite without consuming it…
          </JoinStatus>
        ) : status === "canceled" ? (
          <JoinStatus icon={<LogOut />}>
            The attempt was canceled and the restricted session was signed out.
            The invite was not consumed.
          </JoinStatus>
        ) : problem ? (
          <JoinProblemCard problem={problem} />
        ) : claim?.state === "ready" ? (
          <>
            <JoinStatus icon={<KeyRound />}>
              This code is valid. GitHub sign-in leases it for ten minutes; it
              remains unconsumed until you confirm the identity.
            </JoinStatus>
            <Button
              className="w-full"
              disabled={startPending}
              onClick={() => void startClaim("github")}
            >
              <CircleUserRound />
              {startingGithub ? "Opening GitHub…" : "Continue with GitHub"}
            </Button>
            <OidcRecovery
              organizationSlug={organizationSlug}
              validSlug={Boolean(recoverySlug)}
              pending={startingSso}
              disabled={startPending}
              onOrganizationSlugChange={setOrganizationSlug}
              onStart={() => void startClaim("sso")}
            />
          </>
        ) : identityReady ? (
          <>
            <div className="rounded-xl border border-brand-border bg-brand-subtle p-4">
              <p className="text-caption">GitHub identity</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CircleUserRound className="size-5" aria-hidden="true" />
                <p className="font-mono text-base font-semibold">
                  @{claim.user?.githubUsername}
                </p>
                <Badge variant="warning">Not claimed</Badge>
              </div>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Check this carefully. Access will be permanently bound to this
                GitHub account ID, not the username text.
              </p>
            </div>
            <Button
              className="w-full whitespace-normal"
              disabled={status === "confirming"}
              onClick={() => void confirm()}
            >
              <CheckCircle2 />
              {status === "confirming"
                ? "Claiming beta access…"
                : `Claim beta access as @${claim.user?.githubUsername}`}
            </Button>
          </>
        ) : claim?.state === "leased" ? (
          <>
            <JoinStatus icon={<Clock3 />}>
              {claim.ownsLease === false
                ? "Another attempt holds this invite's active sign-in lease. Finish that flow or wait for the lease to expire."
                : "This browser holds the active sign-in lease. If you just returned from organization OIDC, Continue with GitHub explicitly links GitHub to that same account."}
              {claim.leaseExpiresAt
                ? ` The lease ends ${formatDateTime(claim.leaseExpiresAt)}.`
                : ""}
            </JoinStatus>
            {claim.ownsLease !== false ? (
              <Button
                className="w-full"
                disabled={startPending}
                onClick={() => void startClaim("github")}
              >
                <CircleUserRound />
                {startingGithub ? "Opening GitHub…" : "Continue with GitHub"}
              </Button>
            ) : null}
          </>
        ) : claim?.state === "active" ? (
          <>
            <JoinStatus tone="success" icon={<CheckCircle2 />}>
              {claim.user?.githubUsername
                ? `Beta access is active for @${claim.user.githubUsername}.`
                : "Beta access is active."}
              {" "}This invite was not consumed if you already had access.
            </JoinStatus>
            <Button className="w-full" render={<a href="/courses" />}>
              Open the workshop
            </Button>
          </>
        ) : claim?.state === "blocked" ? (
          <JoinStatus tone="error" icon={<Ban />}>
            This account is blocked from beta access. The invite was not
            consumed. An administrator must clear the block before a fresh
            invite can be claimed.
          </JoinStatus>
        ) : claim ? (
          <TerminalInviteState state={claim.state} />
        ) : null}

        {status !== "loading" &&
        status !== "canceled" &&
        (problem ||
          (claim &&
            claim.state !== "active" &&
            claim.state !== "redeemed" &&
            claim.state !== "expired" &&
            claim.state !== "revoked" &&
            claim.state !== "invalid")) ? (
          <div className="border-t pt-4">
            <Button
              variant="ghost"
              className="w-full"
              disabled={status === "canceling"}
              onClick={() => void cancel()}
            >
              <LogOut />
              {status === "canceling" ? "Canceling…" : "Cancel and sign out"}
            </Button>
          </div>
        ) : null}

        {problem ? (
          <Button
            variant="outline"
            className="w-full"
            disabled={status === "loading"}
            onClick={() => void initialize()}
          >
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

function OidcRecovery({
  organizationSlug,
  validSlug,
  pending,
  disabled,
  onOrganizationSlugChange,
  onStart,
}: {
  organizationSlug: string;
  validSlug: boolean;
  pending: boolean;
  disabled: boolean;
  onOrganizationSlugChange: (value: string) => void;
  onStart: () => void;
}) {
  return (
    <details className="group rounded-xl border bg-muted/20">
      <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold marker:text-muted-foreground">
        <span className="ml-1 inline-flex items-center gap-2">
          <Building2 className="size-4 text-brand-text" aria-hidden="true" />
          Recover an existing OIDC account
        </span>
      </summary>
      <div className="space-y-4 border-t px-4 py-4">
        <p className="text-sm leading-6 text-muted-foreground">
          This is only for an existing Intar account already linked to your
          organization&apos;s verified OIDC provider. It cannot create a new SSO
          identity or grant beta access. After returning, you must explicitly
          link GitHub and confirm the claim.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (validSlug && !disabled) onStart();
          }}
        >
          <div className="space-y-2">
            <label
              htmlFor="recovery-organization-slug"
              className="text-sm font-semibold"
            >
              Organization slug
            </label>
            <Input
              id="recovery-organization-slug"
              value={organizationSlug}
              maxLength={128}
              pattern="[a-z0-9][a-z0-9-]{0,127}"
              placeholder="rawkode-academy-ab12cd"
              autoComplete="organization"
              spellCheck={false}
              aria-describedby="recovery-organization-help"
              onChange={(event) =>
                onOrganizationSlugChange(event.target.value)
              }
            />
            <p id="recovery-organization-help" className="text-caption">
              Use the exact lowercase slug from your organization sign-in link.
            </p>
          </div>
          <Button
            type="submit"
            variant="outline"
            className="w-full whitespace-normal"
            disabled={!validSlug || disabled}
          >
            <Building2 />
            {pending
              ? "Opening organization provider…"
              : "Continue existing OIDC recovery"}
          </Button>
        </form>
      </div>
    </details>
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

function JoinProblemCard({ problem }: { problem: JoinProblem }) {
  return (
    <JoinStatus tone="error" icon={<CircleAlert />}>
      <span className="font-semibold">{problem.title}</span>
      <span className="mt-1 block">{problem.description}</span>
    </JoinStatus>
  );
}

function TerminalInviteState({ state }: { state: ClaimState }) {
  const content = {
    expired: [
      "Invite expired",
      "This code passed its expiry and cannot be leased or claimed. Ask an administrator for a new link.",
    ],
    revoked: [
      "Invite revoked",
      "An administrator stopped this code. Any previous lease is invalid. Ask for a new link if access is still intended.",
    ],
    redeemed: [
      "Invite already claimed",
      "This single-use code has already granted beta access to another account. It cannot be reused.",
    ],
    invalid: [
      "Invite not recognized",
      "The code is incomplete or invalid. Open the complete link provided by an administrator.",
    ],
    ready: ["Invite ready", "Continue with GitHub to begin."],
    leased: ["Invite leased", "Continue the GitHub sign-in flow."],
    authenticated: ["Identity ready", "Confirm the GitHub identity."],
    active: ["Access active", "Open the workshop."],
    blocked: ["Account blocked", "An administrator must clear the block."],
  } satisfies Record<ClaimState, [string, string]>;
  const [title, description] = content[state];
  return (
    <JoinStatus tone="error" icon={<CircleAlert />}>
      <span className="font-semibold">{title}</span>
      <span className="mt-1 block">{description}</span>
    </JoinStatus>
  );
}

class JoinApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface JoinProblem {
  title: string;
  description: string;
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method !== "GET") headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers,
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
      details?.code ?? "request_failed",
      details?.error ??
        details?.message ??
        `The invite service returned ${response.status}.`,
      response.status,
    );
  }
  return body as T;
}

function takeScrubbedInviteCode() {
  if (typeof window === "undefined") return null;
  const invite = window.__INTAR_BETA_INVITE__;
  delete window.__INTAR_BETA_INVITE__;
  return typeof invite === "string" && invite.length > 0 ? invite : null;
}

function problemFor(error: unknown): JoinProblem {
  const code = error instanceof JoinApiError ? error.code : "request_failed";
  switch (code) {
    case "attempt_not_found":
    case "invite_missing":
    case "invite_attempt_required":
      return {
        title: "Open a beta invite link",
        description:
          "This page has no invite attempt to resume. Use the complete fragment link provided by an administrator.",
      };
    case "invite_attempt_expired":
    case "invite_expired":
      return {
        title: "Invite attempt expired",
        description:
          "Reopen the original link if its code is still valid, or ask an administrator for a fresh one.",
      };
    case "invite_revoked":
      return {
        title: "Invite revoked",
        description: "This code and any active lease no longer work.",
      };
    case "invite_redeemed":
      return {
        title: "Invite already claimed",
        description: "A single-use code cannot be used by a second account.",
      };
    case "access_invite_unavailable":
      return {
        title: "Invite unavailable",
        description:
          "The code is invalid, expired, revoked, or already claimed. Ask an administrator for a fresh link.",
      };
    case "invite_leased":
    case "lease_conflict":
    case "access_invite_lease_unavailable":
      return {
        title: "Invite sign-in already started",
        description:
          "Another attempt holds the ten-minute lease. Finish that flow or wait for the lease to expire.",
      };
    case "access_invite_lease_invalid":
      return {
        title: "Invite lease expired",
        description:
          "The ten-minute GitHub sign-in lease is no longer valid. Reopen the invite link and start again.",
      };
    case "access_invite_claim_conflict":
      return {
        title: "Invite could not be claimed",
        description:
          "The code changed or another confirmation won the race. No partial beta access was granted.",
      };
    case "fresh_beta_invite_required":
      return {
        title: "Fresh invite required",
        description:
          "This code predates the administrator's block clearance. Ask for a newly created invite link.",
      };
    case "blocked_user":
    case "beta_user_blocked":
      return {
        title: "Account blocked",
        description:
          "The invite was not consumed. An administrator must clear the block, then issue a fresh invite.",
      };
    case "invite_lease_required":
      return {
        title: "GitHub step required",
        description:
          "Continue with GitHub before confirming this invite. OIDC recovery alone cannot complete the claim.",
      };
    case "github_identity_required":
      return {
        title: "GitHub link incomplete",
        description:
          "Return to the invite and continue with GitHub to explicitly link the account before confirming.",
      };
    case "authentication_required":
      return {
        title: "GitHub sign-in required",
        description:
          "The restricted identity session is missing or expired. Reopen the invite and continue with GitHub.",
      };
    case "origin_rejected":
    case "csrf_rejected":
    case "invalid_origin":
    case "cross_site_request":
      return {
        title: "Request rejected",
        description:
          "Reload this exact intar.dev page before trying again. Cross-site claim requests are not accepted.",
      };
    case "rate_limited":
      return {
        title: "Too many attempts",
        description: "Wait before checking or starting this invite again.",
      };
    case "organization_slug_required":
    case "invalid_organization_slug":
      return {
        title: "Check the organization slug",
        description:
          "Use the exact lowercase slug from the organization sign-in link.",
      };
    case "organization_sso_unavailable":
      return {
        title: "OIDC recovery unavailable",
        description:
          "This organization has no verified OIDC provider available for account recovery. Continue with GitHub or contact the organization administrator.",
      };
    case "invalid_sso_redirect":
      return {
        title: "OIDC destination rejected",
        description:
          "The server returned a non-HTTPS or mismatched recovery destination. The invite was not consumed.",
      };
    case "invalid_oauth_redirect":
      return {
        title: "Sign-in destination rejected",
        description:
          "The server returned an unexpected OAuth destination. No claim was completed.",
      };
    default:
      return {
        title: "Invite could not be checked",
        description:
          error instanceof Error && error.message
            ? error.message
            : "The invite service is unavailable. Try again without sharing the link.",
      };
  }
}

function titleFor(
  claim: CurrentClaim | null,
  status: string,
  problem: JoinProblem | null,
) {
  if (status === "loading") return "Checking your beta invite";
  if (status === "canceled") return "Invite attempt canceled";
  if (problem) return problem.title;
  if (claim?.state === "active") return "Beta access is active";
  if (claim?.state === "blocked") return "This account is blocked";
  if (
    (claim?.state === "authenticated" || claim?.state === "leased") &&
    claim.user?.githubUsername
  ) {
    return "Confirm the GitHub account";
  }
  if (claim?.state === "ready") return "Claim your beta invite";
  if (claim?.state === "leased") return "GitHub sign-in is in progress";
  return "Beta invite unavailable";
}

function descriptionFor(
  claim: CurrentClaim | null,
  status: string,
  problem: JoinProblem | null,
) {
  if (status === "loading") {
    return "Opening a link never consumes it. We first establish a private, short-lived attempt.";
  }
  if (status === "canceled") {
    return "You can reopen the original link while it remains pending and unexpired.";
  }
  if (problem) return problem.description;
  if (claim?.state === "active") {
    return "Every protected capability now checks this active entitlement dynamically.";
  }
  if (claim?.state === "blocked") {
    return "Retained invite links cannot bypass a beta-access revocation.";
  }
  if (
    (claim?.state === "authenticated" || claim?.state === "leased") &&
    claim.user?.githubUsername
  ) {
    return "The invite remains unconsumed until you explicitly claim it as the resolved GitHub identity.";
  }
  if (claim?.state === "ready") {
    return "Sign in with the GitHub account that should permanently receive access.";
  }
  if (claim?.state === "leased") {
    return "Only the attempt holding the active ten-minute lease can complete sign-in.";
  }
  return "This code cannot grant beta access in its current state.";
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
