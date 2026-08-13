import { beforeEach, describe, expect, it, vi } from "vitest";

const accessInvitesMock = vi.hoisted(() => ({
  exchangeAccessInviteCode: vi.fn(),
  leaseAccessInvite: vi.fn(),
  releaseAccessInviteLease: vi.fn(),
  validateGithubInviteLease: vi.fn(),
}));
const accessClaimMock = vi.hoisted(() => ({
  getAccessClaimIdentity: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  createInviteOAuthHandoff: vi.fn(),
  linkSocialAccount: vi.fn(),
  signInSocial: vi.fn(),
  signInSSO: vi.fn(),
}));
const requestSecurityMock = vi.hoisted(() => ({
  canonicalApplicationOrigin: vi.fn(),
  rateLimitPublicAccessInvite: vi.fn(),
  requireSameOriginJsonMutation: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    BETTER_AUTH_SECRET:
      "test-better-auth-secret-that-is-at-least-32-bytes",
    DB: "test-db",
  },
}));
vi.mock("@/lib/access-invites", () => accessInvitesMock);
vi.mock("@/lib/access-claim", () => accessClaimMock);
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      linkSocialAccount: authMock.linkSocialAccount,
      signInSocial: authMock.signInSocial,
      signInSSO: authMock.signInSSO,
    },
  },
  createInviteOAuthHandoff: authMock.createInviteOAuthHandoff,
  INVITE_OAUTH_HANDOFF_HEADER: "x-intar-invite-oauth-handoff",
}));
vi.mock("@/lib/request-security", () => ({
  ...requestSecurityMock,
  NO_STORE_HEADERS: {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
  },
}));

import {
  newInviteAttempt,
  signInviteAttempt,
  verifyInviteAttempt,
  withInviteLease,
  type InviteAttempt,
} from "@/lib/invite-attempt";
import { POST as exchangeInvite } from "@/pages/api/access-invites/exchange";
import { POST as startInvite } from "@/pages/api/access-invites/start";

const inviteSecret = "test-better-auth-secret-that-is-at-least-32-bytes";

describe("access invite routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessClaimMock.getAccessClaimIdentity.mockResolvedValue(null);
    accessInvitesMock.releaseAccessInviteLease.mockResolvedValue(true);
    requestSecurityMock.canonicalApplicationOrigin.mockReturnValue(
      "https://intar.test",
    );
    requestSecurityMock.rateLimitPublicAccessInvite.mockResolvedValue(
      undefined,
    );
  });

  it("rejects SSO recovery before acquiring or validating an invite lease", async () => {
    const attempt = newInviteAttempt("invite-sso-disabled");
    const request = await inviteRequest(
      "/api/access-invites/start",
      { mode: "sso-recovery", organizationSlug: "example" },
      attempt,
    );

    const response = await startInvite(routeContext(request));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "beta invitations can only be claimed with GitHub",
      code: "github_invite_claim_required",
    });
    expect(accessClaimMock.getAccessClaimIdentity).not.toHaveBeenCalled();
    expect(accessInvitesMock.leaseAccessInvite).not.toHaveBeenCalled();
    expect(accessInvitesMock.validateGithubInviteLease).not.toHaveBeenCalled();
    expect(accessInvitesMock.releaseAccessInviteLease).not.toHaveBeenCalled();
    expect(authMock.createInviteOAuthHandoff).not.toHaveBeenCalled();
    expect(authMock.linkSocialAccount).not.toHaveBeenCalled();
    expect(authMock.signInSocial).not.toHaveBeenCalled();
    expect(authMock.signInSSO).not.toHaveBeenCalled();
  });

  it("does not let an OIDC-only session use the GitHub invite path to link accounts", async () => {
    accessClaimMock.getAccessClaimIdentity.mockResolvedValue({
      userId: "oidc-only-user",
      name: "OIDC Only",
      githubAccountId: null,
      githubUsername: null,
      accessState: null,
    });
    const request = await inviteRequest(
      "/api/access-invites/start",
      {},
      newInviteAttempt("invite-oidc-session"),
    );

    const response = await startInvite(routeContext(request));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "cancel and sign out before claiming this invite with GitHub",
      code: "github_session_required",
    });
    expect(accessInvitesMock.leaseAccessInvite).not.toHaveBeenCalled();
    expect(accessInvitesMock.validateGithubInviteLease).not.toHaveBeenCalled();
    expect(accessInvitesMock.releaseAccessInviteLease).not.toHaveBeenCalled();
    expect(authMock.createInviteOAuthHandoff).not.toHaveBeenCalled();
    expect(authMock.linkSocialAccount).not.toHaveBeenCalled();
    expect(authMock.signInSocial).not.toHaveBeenCalled();
    expect(authMock.signInSSO).not.toHaveBeenCalled();
  });

  it("preserves the complete signed lease attempt when the same invite is exchanged again", async () => {
    const now = Date.now();
    const existing = withInviteLease(
      newInviteAttempt("invite-same", now),
      {
        leaseId: "lease-same",
        leaseExpiresAt: now + 10 * 60 * 1_000,
      },
    );
    accessInvitesMock.exchangeAccessInviteCode.mockResolvedValue({
      inviteId: existing.inviteId,
      expiresAt: now + 14 * 24 * 60 * 60 * 1_000,
    });
    const request = await inviteRequest(
      "/api/access-invites/exchange",
      { code: "intar_beta_same" },
      existing,
    );

    const response = await exchangeInvite(routeContext(request));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "ready",
      expiresAt: now + 14 * 24 * 60 * 60 * 1_000,
    });
    await expect(readResponseAttempt(response)).resolves.toEqual(existing);
    expect(accessInvitesMock.exchangeAccessInviteCode).toHaveBeenCalledWith({
      d1: "test-db",
      code: "intar_beta_same",
    });
  });

  it("creates a fresh unleased attempt when a different invite is exchanged", async () => {
    const now = Date.now();
    const existing = withInviteLease(
      newInviteAttempt("invite-first", now),
      {
        leaseId: "lease-first",
        leaseExpiresAt: now + 10 * 60 * 1_000,
      },
    );
    accessInvitesMock.exchangeAccessInviteCode.mockResolvedValue({
      inviteId: "invite-second",
      expiresAt: now + 14 * 24 * 60 * 60 * 1_000,
    });
    const request = await inviteRequest(
      "/api/access-invites/exchange",
      { code: "intar_beta_second" },
      existing,
    );

    const response = await exchangeInvite(routeContext(request));
    const exchanged = await readResponseAttempt(response);

    expect(response.status).toBe(200);
    expect(exchanged).toMatchObject({
      version: 1,
      inviteId: "invite-second",
    });
    expect(exchanged?.attemptId).not.toBe(existing.attemptId);
    expect(exchanged).not.toHaveProperty("leaseId");
    expect(exchanged).not.toHaveProperty("leaseExpiresAt");
  });
});

async function inviteRequest(
  path: string,
  body: Record<string, unknown>,
  attempt?: InviteAttempt,
): Promise<Request> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://intar.test",
  });
  if (attempt) {
    headers.set(
      "cookie",
      `__Host-intar-beta-invite=${await signInviteAttempt(
        attempt,
        inviteSecret,
      )}`,
    );
  }
  return new Request(`https://intar.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readResponseAttempt(
  response: Response,
): Promise<InviteAttempt | null> {
  const setCookie = response.headers.get("set-cookie");
  const value = setCookie?.match(
    /^__Host-intar-beta-invite=([^;]+)/u,
  )?.[1];
  expect(value).toBeTruthy();
  return verifyInviteAttempt(value ?? "", inviteSecret);
}

function routeContext(request: Request) {
  return { request } as never;
}
