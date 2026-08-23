import { beforeEach, describe, expect, it, vi } from "vitest";

const betaInvitesMock = vi.hoisted(() => ({
  getBetaInvite: vi.fn(),
  inspectBetaInviteCode: vi.fn(),
}));
const accessClaimMock = vi.hoisted(() => ({
  getAccessClaimIdentity: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  createInviteOAuthHandoff: vi.fn(),
  signInSocial: vi.fn(),
}));
const requestSecurityMock = vi.hoisted(() => ({
  canonicalApplicationOrigin: vi.fn(),
  rateLimitPublicAccessInvite: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    BETTER_AUTH_SECRET:
      "test-better-auth-secret-that-is-at-least-32-bytes",
    DB: "test-db",
  },
}));
vi.mock("@/lib/beta-invites", () => betaInvitesMock);
vi.mock("@/lib/access-claim", () => accessClaimMock);
vi.mock("@/lib/auth", () => ({
  auth: { api: { signInSocial: authMock.signInSocial } },
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
  type InviteAttempt,
} from "@/lib/invite-attempt";
import { POST as exchangeInvite } from "@/pages/api/access-invites/exchange";
import { POST as startInvite } from "@/pages/api/access-invites/start";

const secret = "test-better-auth-secret-that-is-at-least-32-bytes";

describe("simple beta invite routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessClaimMock.getAccessClaimIdentity.mockResolvedValue(null);
    requestSecurityMock.canonicalApplicationOrigin.mockReturnValue(
      "https://intar.test",
    );
    requestSecurityMock.rateLimitPublicAccessInvite.mockResolvedValue(undefined);
    betaInvitesMock.getBetaInvite.mockResolvedValue({
      inviteId: "invite-1",
      expiresAt: Date.now() + 60_000,
    });
  });

  it("exchanges a bearer token for a signed HttpOnly attempt", async () => {
    betaInvitesMock.inspectBetaInviteCode.mockResolvedValue({
      inviteId: "invite-1",
      expiresAt: Date.now() + 60_000,
    });
    const request = requestFor("/api/access-invites/exchange", {
      code: `intar_beta_${"A".repeat(43)}`,
    });

    const response = await exchangeInvite(routeContext(request));
    const attempt = await readResponseAttempt(response);

    expect(response.status).toBe(200);
    expect(attempt).toMatchObject({ inviteId: "invite-1", version: 1 });
    expect(attempt).not.toHaveProperty("leaseId");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("preserves the attempt identity when the same link is exchanged again", async () => {
    const existing = newInviteAttempt("invite-1");
    betaInvitesMock.inspectBetaInviteCode.mockResolvedValue({
      inviteId: "invite-1",
      expiresAt: Date.now() + 60_000,
    });
    const request = await requestWithAttempt(
      "/api/access-invites/exchange",
      { code: `intar_beta_${"B".repeat(43)}` },
      existing,
    );

    const response = await exchangeInvite(routeContext(request));

    await expect(readResponseAttempt(response)).resolves.toEqual(existing);
  });

  it("starts GitHub with the signed attempt and no database lease", async () => {
    const attempt = newInviteAttempt("invite-1");
    authMock.createInviteOAuthHandoff.mockResolvedValue("signed-handoff");
    authMock.signInSocial.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://github.com/login/oauth/authorize?client_id=test",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "better-auth.state=test; Path=/; HttpOnly",
          },
        },
      ),
    );
    const request = await requestWithAttempt(
      "/api/access-invites/start",
      {},
      attempt,
    );

    const response = await startInvite(routeContext(request));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redirectKind: "github",
      redirectUrl: expect.stringContaining("github.com/login/oauth/authorize"),
    });
    expect(authMock.createInviteOAuthHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteId: attempt.inviteId,
        attemptId: attempt.attemptId,
      }),
    );
    expect(betaInvitesMock.getBetaInvite).toHaveBeenCalledWith({
      d1: "test-db",
      inviteId: attempt.inviteId,
    });
  });

  it("rejects an OIDC-only session before opening GitHub", async () => {
    accessClaimMock.getAccessClaimIdentity.mockResolvedValue({
      userId: "oidc-user",
      githubAccountId: null,
      githubUsername: null,
      accessState: null,
    });
    const request = await requestWithAttempt(
      "/api/access-invites/start",
      {},
      newInviteAttempt("invite-1"),
    );

    const response = await startInvite(routeContext(request));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_session_required",
    });
    expect(authMock.signInSocial).not.toHaveBeenCalled();
  });
});

function requestFor(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://intar.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://intar.test",
    },
    body: JSON.stringify(body),
  });
}

async function requestWithAttempt(
  path: string,
  body: Record<string, unknown>,
  attempt: InviteAttempt,
): Promise<Request> {
  const request = requestFor(path, body);
  const headers = new Headers(request.headers);
  headers.set(
    "cookie",
    `__Host-intar-beta-invite=${await signInviteAttempt(attempt, secret)}`,
  );
  return new Request(request, { headers });
}

async function readResponseAttempt(
  response: Response,
): Promise<InviteAttempt | null> {
  const value = response.headers
    .get("set-cookie")
    ?.match(/^__Host-intar-beta-invite=([^;]+)/u)?.[1];
  expect(value).toBeTruthy();
  return verifyInviteAttempt(value ?? "", secret);
}

function routeContext(request: Request) {
  return { request } as never;
}
