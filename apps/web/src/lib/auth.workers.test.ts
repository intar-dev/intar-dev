/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import type { Session, User } from "better-auth";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessInviteCodes } from "@/db/schema/application";
import {
  account,
  organization,
  session,
  ssoProvider,
  user,
} from "@/db/schema/core";
import {
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
} from "@/db/schema/oauth";
import {
  acquireBetaRevocationCleanup,
  completeBetaRevocationCleanup,
  revokeBetaUser,
} from "@/lib/beta-access-revocation-store";
import {
  BETA_INVITE_LIFETIME_MS,
  createBetaInvite,
  redeemBetaInvite,
  revokeBetaInvite,
} from "@/lib/beta-invites";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureBetaAdmin,
  FIXTURE_BETA_ADMIN_ID,
  FIXTURE_INVITE_ENCRYPTION_KEY,
} from "@/test/beta-access-fixtures";
import {
  auth,
  authCookiePolicy,
  assertNoAdditionalBetterAuthTrustedOrigins,
  captureBetaAdmissionEpoch,
  captureOAuthIssuanceAdmission,
  createAdmissionBoundRefreshToken,
  createInviteOAuthHandoff,
  createSsoLinkOAuthHandoff,
  enforceCreatedAuthorizationCodeAdmission,
  enforceCreatedGithubAccountAdmission,
  enforceCreatedSessionAdmission,
  enforceOAuthIssuanceAdmission,
  getBetaOAuthAccessTokenClaims,
  INVITE_OAUTH_HANDOFF_HEADER,
  readAdmissionBoundRefreshToken,
  trustedBrowserOrigin,
} from "./auth";
import { encryptOidcClientSecret } from "./oidc-sso-secret";

describe("auth policy", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureBetaAdmin(env.DB, Date.now());
  });

  it("uses host-only secure cookies and trusts only the app origin", () => {
    expect(auth.options.advanced).toMatchObject({
      useSecureCookies: false,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: false,
      },
    });
    expect(authCookiePolicy("https://intar.dev")).toEqual({
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: true,
      },
    });

    expect(auth.options.trustedOrigins).toEqual(["http://localhost"]);
    expect(trustedBrowserOrigin("https://intar.dev/auth")).toBe(
      "https://intar.dev",
    );
    expect(() => trustedBrowserOrigin("http://intar.dev")).toThrow(
      "better_auth_browser_origin_invalid",
    );
    expect(() =>
      assertNoAdditionalBetterAuthTrustedOrigins("https://tenant-idp.example"),
    ).toThrow("better_auth_additional_trusted_origins_forbidden");
    expect(() =>
      assertNoAdditionalBetterAuthTrustedOrigins("  "),
    ).not.toThrow();

    expect(auth.options.logger).toEqual({ disabled: true });
    expect(auth.options.onAPIError).toMatchObject({ throw: true });
  });

  it("loads an encrypted organization OIDC provider through Better Auth sign-in", async () => {
    const organizationId = "encrypted-oidc-organization";
    const providerRowId = "encrypted-oidc-provider-row";
    const providerId = "encrypted-oidc-provider";
    const clientSecret = "encrypted-provider-client-secret";
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      clientSecret,
      identity: {
        id: providerRowId,
        providerId,
        organizationId,
      },
    });
    const now = new Date();
    await drizzle(env.DB).insert(organization).values({
      id: organizationId,
      name: "Encrypted OIDC organization",
      slug: "encrypted-oidc-organization",
      createdAt: now,
    });
    await drizzle(env.DB).insert(ssoProvider).values({
      id: providerRowId,
      issuer: "https://login.example.test",
      domain: "example.test",
      oidcConfig: JSON.stringify({
        issuer: "https://login.example.test",
        clientId: "encrypted-oidc-client",
        authorizationEndpoint: "https://login.example.test/oauth/authorize",
        tokenEndpoint: "https://login.example.test/oauth/token",
        tokenEndpointAuthentication: "client_secret_basic",
        jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
        userInfoEndpoint: "https://login.example.test/oauth/userinfo",
        pkce: true,
        scopes: ["openid", "email", "profile"],
      }),
      oidcClientSecretCiphertext: ciphertext,
      userId: FIXTURE_BETA_ADMIN_ID,
      providerId,
      organizationId,
      domainVerified: true,
    });

    const crossOriginCallback = await auth.handler(
      authRequest("/api/auth/sign-in/sso", {
        providerId,
        providerType: "oidc",
        callbackURL: "https://login.example.test/steal",
        errorCallbackURL: "https://login.example.test/steal-error",
      }),
    );
    expect(crossOriginCallback.status).toBe(403);

    const response = await auth.handler(
      authRequest("/api/auth/sign-in/sso", {
        providerId,
        providerType: "oidc",
        callbackURL: "http://localhost/organizations/encrypted-oidc-organization",
        errorCallbackURL:
          "http://localhost/organizations/encrypted-oidc-organization/sign-in",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { redirect?: unknown; url?: unknown };
    expect(body).toMatchObject({ redirect: true });
    expect(body.url).toEqual(
      expect.stringContaining("https://login.example.test/oauth/authorize"),
    );
    expect(String(body.url)).toContain("client_id=encrypted-oidc-client");
    expect(JSON.stringify(body)).not.toContain(clientSecret);
    expect(JSON.stringify(body)).not.toContain(ciphertext);
  });

  it("uses an encrypted provider through the Better Auth callback lock path", async () => {
    const now = Date.now();
    const userId = "encrypted-oidc-link-user";
    const organizationId = "encrypted-oidc-link-organization";
    const providerRowId = "encrypted-oidc-link-provider-row";
    const providerId = "encrypted-oidc-link-provider";
    const clientSecret = "encrypted-link-client-secret";
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      clientSecret,
      identity: {
        id: providerRowId,
        providerId,
        organizationId,
      },
    });
    await seedActiveBetaUser({
      id: userId,
      accountId: "encrypted-oidc-link-github",
      username: userId,
      now,
    });
    await drizzle(env.DB).insert(organization).values({
      id: organizationId,
      name: "Encrypted OIDC link organization",
      slug: organizationId,
      createdAt: new Date(now),
    });
    await drizzle(env.DB).insert(ssoProvider).values({
      id: providerRowId,
      issuer: "https://login.example.test",
      domain: "example.test",
      oidcConfig: JSON.stringify({
        issuer: "https://login.example.test",
        clientId: "encrypted-oidc-link-client",
        authorizationEndpoint: "https://login.example.test/oauth/authorize",
        tokenEndpoint: "https://login.example.test/oauth/token",
        tokenEndpointAuthentication: "client_secret_basic",
        jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
        userInfoEndpoint: "https://login.example.test/oauth/userinfo",
        pkce: true,
      }),
      oidcClientSecretCiphertext: ciphertext,
      userId: FIXTURE_BETA_ADMIN_ID,
      providerId,
      organizationId,
      domainVerified: true,
    });
    const admission = await captureBetaAdmissionEpoch(userId);
    const handoff = await createSsoLinkOAuthHandoff({
      ...admission,
      providerId,
      expiresAt: now + 600_000,
    });
    const sessionToken = "encrypted-oidc-link-session";
    await drizzle(env.DB).insert(session).values({
      id: "encrypted-oidc-link-session-row",
      token: sessionToken,
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const sessionCookie = await signedSessionCookie(sessionToken);
    const started = await auth.handler(
      authRequest(
        "/api/auth/sign-in/sso",
        {
          providerId,
          providerType: "oidc",
          callbackURL: "http://localhost/organizations/encrypted-oidc-link",
          errorCallbackURL:
            "http://localhost/organizations/encrypted-oidc-link/sign-in",
        },
        {
          cookie: sessionCookie,
          [INVITE_OAUTH_HANDOFF_HEADER]: handoff,
        },
      ),
    );
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as { url?: string };
    const state = startedBody.url
      ? new URL(startedBody.url).searchParams.get("state")
      : null;
    const stateCookie = started.headers.get("set-cookie")?.split(";", 1)[0];
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (request): Promise<Response> => {
        const url =
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url;
        if (url === "https://login.example.test/oauth/token") {
          return Response.json({
            access_token: "encrypted-oidc-link-token",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (url === "https://login.example.test/oauth/userinfo") {
          return Response.json({
            sub: "encrypted-oidc-link-subject",
            email: `${userId}@example.test`,
            name: "Encrypted OIDC Link User",
          });
        }
        throw new Error(`unexpected OIDC callback fetch: ${url}`);
      },
    );
    let callback: Response;
    try {
      callback = await auth.handler(
        new Request(
          `http://localhost/api/auth/sso/callback/${providerId}?code=test-code&state=${encodeURIComponent(state!)}`,
          { headers: { cookie: `${sessionCookie}; ${stateCookie}` } },
        ),
      );
    } finally {
      fetchSpy.mockRestore();
    }

    expect(callback!.status).toBe(302);
    expect(callback!.headers.get("location")).toBe(
      "http://localhost/organizations/encrypted-oidc-link",
    );
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM account WHERE provider_id = ? AND account_id = ?",
      )
        .bind(providerId, "encrypted-oidc-link-subject")
        .first(),
    ).resolves.toEqual({ userId });
  });

  it("rejects credential auth and stock identity administration", async () => {
    const [
      signUp,
      signIn,
      usernameSignIn,
      changePassword,
      deleteUser,
      createOrganization,
      registerSso,
      directLink,
      genericJwt,
      adminCreateUser,
      adminSetPassword,
    ] =
      await Promise.all([
        auth.handler(
          authRequest("/api/auth/sign-up/email", {
            name: "Attacker",
            email: "attacker@example.com",
            password: "correct-horse-battery-staple",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/sign-in/email", {
            email: "attacker@example.com",
            password: "correct-horse-battery-staple",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/sign-in/username", {
            username: "legacy-user",
            password: "correct-horse-battery-staple",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/change-password", {
            currentPassword: "correct-horse-battery-staple",
            newPassword: "another-correct-horse-battery-staple",
          }),
        ),
        auth.handler(authRequest("/api/auth/delete-user", {})),
        auth.handler(
          authRequest("/api/auth/organization/create", {
            name: "Bypass",
            slug: "bypass",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/sso/register", {
            issuer: "https://attacker.example",
            domain: "example.com",
            providerId: "bypass",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/link-social", {
            provider: "github",
            callbackURL: "http://localhost/join",
          }),
        ),
        auth.handler(new Request("http://localhost/api/auth/token")),
        auth.handler(
          authRequest("/api/auth/admin/create-user", {
            email: "created@example.test",
            name: "Created",
            password: "correct-horse-battery-staple",
          }),
        ),
        auth.handler(
          authRequest("/api/auth/admin/set-user-password", {
            userId: "victim",
            newPassword: "correct-horse-battery-staple",
          }),
        ),
      ]);

    expect(auth.options).toMatchObject({
      disabledPaths: expect.arrayContaining([
        "/token",
        "/sign-up/email",
        "/sign-in/email",
        "/sign-in/username",
        "/change-password",
        "/delete-user",
        "/unlink-account",
        "/admin/create-user",
        "/admin/ban-user",
        "/admin/unban-user",
        "/admin/set-role",
        "/admin/update-user",
        "/admin/set-user-password",
        "/organization/create",
        "/organization/update-member-role",
        "/sso/register",
        "/sso/verify-domain",
      ]),
      emailAndPassword: { enabled: false, disableSignUp: true },
      account: {
        accountLinking: {
          enabled: true,
          disableImplicitLinking: false,
          allowDifferentEmails: true,
          updateUserInfoOnLink: true,
        },
      },
    });
    for (const response of [
      signUp,
      signIn,
      usernameSignIn,
      changePassword,
      deleteUser,
      createOrganization,
      registerSso,
      genericJwt,
      adminCreateUser,
      adminSetPassword,
    ]) {
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not Found");
    }
    expect(directLink.status).toBe(403);
    await expect(directLink.json()).resolves.toMatchObject({
      code: "explicit_github_link_required",
    });
  });

  it("maps GitHub profiles but rejects untrusted creation and silent linking before mutation", async () => {
    const github = auth.options.socialProviders?.github;
    const mappedUser = github?.mapProfileToUser?.({
      login: "beta-candidate",
    } as never);
    expect(mappedUser).toMatchObject({
      username: "beta-candidate",
      displayUsername: "beta-candidate",
    });

    const validate = auth.options.user?.validateUserInfo;
    expect(validate).toBeTypeOf("function");

    await expect(
      validate?.(
        {
          user: { name: "Candidate" },
          source: {
            action: "create-user",
            method: "oauth",
            oauth: { providerId: "github", profile: {} },
          },
        },
      ),
    ).resolves.toMatchObject({ error: "valid_beta_invite_required" });

    await expect(
      validate?.(
        {
          user: { id: "existing-user" },
          source: {
            action: "link-account",
            method: "oauth",
            oauth: { providerId: "github", profile: {} },
          },
        },
      ),
    ).resolves.toMatchObject({ error: "explicit_github_link_required" });

    await expect(
      validate?.(
        {
          user: { name: "SSO Candidate" },
          source: {
            action: "create-user",
            method: "sso-oidc",
            sso: { providerId: "example-sso", profile: {} },
          },
        },
      ),
    ).resolves.toMatchObject({ error: "github_identity_required" });
  });

  it("accepts only a signed server handoff for an active GitHub invite", async () => {
    const now = Date.now();
    const fixtureAdmin = await ensureFixtureBetaAdmin(env.DB, now - 120_000);
    await drizzle(env.DB).insert(accessInviteCodes).values({
      id: "invite-auth-test",
      codeHash: "a".repeat(64),
      codePrefix: "auth-test",
      tokenCiphertext: `v1.${"A".repeat(16)}.${"B".repeat(32)}`,
      kind: "standard",
      state: "pending",
      createdBy: fixtureAdmin,
      createdAt: now - 60_000,
      expiresAt: now - 60_000 + 14 * 24 * 60 * 60_000,
      claimExpiresAt: now - 60_000 + BETA_INVITE_LIFETIME_MS,
      updatedAt: now,
    });

    const handoff = await createInviteOAuthHandoff({
      inviteId: "invite-auth-test",
      attemptId: "attempt-auth-test",
      expiresAt: now + 600_000,
    });
    const forged = `${handoff.slice(0, -1)}${handoff.endsWith("a") ? "b" : "a"}`;

    const forgedResponse = await auth.handler(
      authRequest(
        "/api/auth/sign-in/social",
        {
          provider: "github",
          callbackURL: "http://localhost/join",
          errorCallbackURL: "http://localhost/join",
          additionalData: {
            intarBetaAuth: {
              inviteId: "invite-auth-test",
              attemptId: "attempt-auth-test",
            },
          },
        },
        { [INVITE_OAUTH_HANDOFF_HEADER]: forged },
      ),
    );
    expect(forgedResponse.status).toBe(403);

    const validResponse = await auth.handler(
      authRequest(
        "/api/auth/sign-in/social",
        {
          provider: "github",
          callbackURL: "http://localhost/join",
          errorCallbackURL: "http://localhost/join",
          // Client data may ride OAuth state but is never read as authority.
          additionalData: {
            intarBetaAuth: {
              inviteId: "attacker-controlled",
              attemptId: "attacker-controlled",
            },
          },
        },
        { [INVITE_OAUTH_HANDOFF_HEADER]: handoff },
      ),
    );
    expect(validResponse.status).toBe(200);
    await expect(validResponse.json()).resolves.toMatchObject({
      redirect: true,
      url: expect.stringContaining("github.com/login/oauth/authorize"),
    });
  });

  it("links a same-email OIDC user only through a live GitHub invite callback", async () => {
    const now = Date.now();
    const target = await seedOidcOnlyUser({
      id: "same-email-invite-target",
      email: "same-email-invite@example.test",
      now,
    });
    const flow = await beginGithubInviteFlow("same-email-live", now);

    const callback = await completeGithubCallback({
      ...flow,
      email: target.email,
      githubAccountId: "4242001",
      githubLogin: "same-email-github",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost/join");
    await expect(
      env.DB.prepare(
        `SELECT account_id AS accountId, user_id AS userId
         FROM account
         WHERE provider_id = 'github' AND account_id = ?`,
      )
        .bind("4242001")
        .first(),
    ).resolves.toEqual({
      accountId: "4242001",
      userId: target.id,
    });
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM session WHERE user_id = ? LIMIT 1",
      )
        .bind(target.id)
        .first(),
    ).resolves.toEqual({ userId: target.id });
    await expect(
      env.DB.prepare(
        "SELECT user_id FROM access_allowlist WHERE user_id = ? LIMIT 1",
      )
        .bind(target.id)
        .first(),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT state, redeemer_user_id AS redeemerUserId
         FROM access_invite_codes WHERE id = ?`,
      )
        .bind(flow.inviteId)
        .first(),
    ).resolves.toEqual({ state: "pending", redeemerUserId: null });
  });

  it("rejects a same-email implicit GitHub link without an invite flow", async () => {
    const target = await seedOidcOnlyUser({
      id: "same-email-no-flow-target",
      email: "same-email-no-flow@example.test",
      now: Date.now(),
    });
    const flow = await beginGithubFlowWithoutInvite();

    const callback = await completeGithubCallback({
      ...flow,
      email: target.email,
      githubAccountId: "4242002",
      githubLogin: "same-email-no-flow",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242002");
  });

  it("rejects a same-email implicit GitHub link after its invite expires", async () => {
    const now = Date.now();
    const target = await seedOidcOnlyUser({
      id: "same-email-expired-target",
      email: "same-email-expired@example.test",
      now,
    });
    const flow = await beginGithubInviteFlow("same-email-expired", now);
    const expiredAt = Date.now() - 1;
    await drizzle(env.DB)
      .update(accessInviteCodes)
      .set({
        claimExpiresAt: expiredAt,
      })
      .where(eq(accessInviteCodes.id, flow.inviteId));

    const callback = await completeGithubCallback({
      ...flow,
      email: target.email,
      githubAccountId: "4242003",
      githubLogin: "same-email-expired",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242003");
  });

  it("rejects a same-email implicit GitHub link after its invite is revoked", async () => {
    const now = Date.now();
    const target = await seedOidcOnlyUser({
      id: "same-email-revoked-target",
      email: "same-email-revoked@example.test",
      now,
    });
    const flow = await beginGithubInviteFlow("same-email-revoked", now);
    await revokeBetaInvite({
      d1: env.DB,
      inviteId: flow.inviteId,
      expectedVersion: flow.inviteVersion,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      now: now + 1,
    });

    const callback = await completeGithubCallback({
      ...flow,
      email: target.email,
      githubAccountId: "4242004",
      githubLogin: "same-email-revoked",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242004");
  });

  it.each(["active", "blocked"] as const)(
    "rejects a same-email implicit GitHub link for a %s beta target",
    async (accessState) => {
      const now = Date.now();
      const target = await seedOidcOnlyUser({
        id: `same-email-${accessState}-target`,
        email: `same-email-${accessState}@example.test`,
        now,
      });
      await grantBetaAccessWithoutLinkedGithub({
        userId: target.id,
        githubAccountId: `historical-${accessState}-github`,
        githubUsername: `historical-${accessState}`,
        now,
      });
      if (accessState === "blocked") {
        await revokeBetaUser({
          d1: env.DB,
          userId: target.id,
          actorUserId: FIXTURE_BETA_ADMIN_ID,
          reason: "same_email_policy_test",
          now: now + 4,
        });
      }
      const flow = await beginGithubInviteFlow(
        `same-email-${accessState}-access`,
        now + 5,
      );

      const callback = await completeGithubCallback({
        ...flow,
        email: target.email,
        githubAccountId: accessState === "active" ? "4242005" : "4242006",
        githubLogin: `same-email-${accessState}`,
      });

      expectOauthCallbackError(callback, "explicit_github_link_required");
      await expectGithubLinkAndSessionAbsent(
        target.id,
        accessState === "active" ? "4242005" : "4242006",
      );
    },
  );

  it("rejects a same-email target that already has another GitHub account", async () => {
    const now = Date.now();
    const target = await seedOidcOnlyUser({
      id: "same-email-existing-github-target",
      email: "same-email-existing-github@example.test",
      now,
    });
    await drizzle(env.DB).insert(account).values({
      id: "same-email-existing-github-row",
      providerId: "github",
      accountId: "already-linked-github",
      userId: target.id,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const flow = await beginGithubInviteFlow(
      "same-email-existing-github",
      now,
    );

    const callback = await completeGithubCallback({
      ...flow,
      email: target.email,
      githubAccountId: "4242007",
      githubLogin: "same-email-second-github",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242007");
    await expect(
      env.DB.prepare(
        `SELECT account_id AS accountId
         FROM account
         WHERE user_id = ? AND provider_id = 'github'`,
      )
        .bind(target.id)
        .all(),
    ).resolves.toMatchObject({
      results: [{ accountId: "already-linked-github" }],
    });
  });

  it("rejects previously issued invite-recovery handoff kinds", async () => {
    const expiresAt = Date.now() + 300_000;
    const legacyHandoffs = [
      {
        kind: "github-recovery-link",
        inviteId: "legacy-recovery-invite",
        leaseId: "legacy-recovery-lease",
        userId: "legacy-recovery-user",
        aud: "intar.beta-auth-handoff.v1",
        expiresAt,
        version: 1,
      },
      {
        kind: "sso-recovery",
        inviteId: "legacy-recovery-invite",
        leaseId: "legacy-recovery-lease",
        providerId: "legacy-recovery-provider",
        aud: "intar.beta-auth-handoff.v1",
        expiresAt,
        version: 1,
      },
    ];

    for (const payload of legacyHandoffs) {
      const response = await auth.handler(
        authRequest(
          payload.kind === "sso-recovery"
            ? "/api/auth/sign-in/sso"
            : "/api/auth/link-social",
          payload.kind === "sso-recovery"
            ? {
                providerId: payload.providerId,
                providerType: "oidc",
                callbackURL: "http://localhost/join",
              }
            : {
                provider: "github",
                callbackURL: "http://localhost/join",
              },
          {
            [INVITE_OAUTH_HANDOFF_HEADER]: await signLegacyHandoff(payload),
          },
        ),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_beta_oauth_handoff",
      });
    }
  });

  it("confines a pre-access session to inspection, sign-out, and invite callbacks", async () => {
    const now = Date.now();
    const userId = "restricted-session-user";
    const token = "restricted-session-token";
    await drizzle(env.DB).insert(user).values({
      id: userId,
      name: "Restricted Admin",
      email: "restricted@example.test",
      emailVerified: true,
      role: "admin",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await drizzle(env.DB).insert(session).values({
      id: "restricted-session-id",
      token,
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const cookie = await signedSessionCookie(token);

    const inspection = await auth.handler(
      authGetRequest("/api/auth/get-session", cookie),
    );
    expect(inspection.status).toBe(200);
    await expect(inspection.json()).resolves.toMatchObject({
      user: { id: userId },
    });

    const denied = await Promise.all([
      auth.handler(authGetRequest("/api/auth/admin/list-users", cookie)),
      auth.handler(authGetRequest("/api/auth/organization/list", cookie)),
      auth.handler(
        authGetRequest(
          "/api/auth/oauth2/authorize?client_id=blocked&response_type=code",
          cookie,
        ),
      ),
    ]);
    for (const response of denied) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "restricted_beta_session",
      });
    }

    const signOut = await auth.handler(
      authRequest("/api/auth/sign-out", {}, { cookie }),
    );
    expect(signOut.status).toBe(200);
    await expect(signOut.json()).resolves.toMatchObject({ success: true });
  });

  it("dynamically rejects a blocked user's OAuth credentials after authenticating the request", async () => {
    const now = Date.now();
    const fixtureAdmin = await ensureFixtureBetaAdmin(env.DB, now - 1_000);
    const userId = "blocked-oauth-user";
    await drizzle(env.DB).insert(user).values({
      id: userId,
      name: "Blocked OAuth User",
      email: "blocked-oauth@example.test",
      emailVerified: true,
      username: "blocked-oauth-user",
      displayUsername: "blocked-oauth-user",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await drizzle(env.DB).insert(account).values({
      id: "blocked-oauth-github-link",
      providerId: "github",
      accountId: "blocked-oauth-github-id",
      userId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const invite = await createBetaInvite({
      d1: env.DB,
      actorUserId: fixtureAdmin,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now,
    });
    await redeemBetaInvite({
      d1: env.DB,
      inviteId: invite.id,
      attemptId: "blocked-oauth-attempt",
      userId,
      githubAccountId: "blocked-oauth-github-id",
      githubUsername: "blocked-oauth-user",
      now: now + 1,
    });
    const blockedAdmission = await captureBetaAdmissionEpoch(userId);
    await revokeBetaUser({
      d1: env.DB,
      userId,
      actorUserId: fixtureAdmin,
      reason: "oauth_revocation_test",
      now: now + 2,
    });

    const clientId = "oauth-test-client";
    const clientSecret = "oauth-test-client-secret";
    const accessToken = "blocked-user-access-token";
    const storedRefreshToken = "blocked-user-refresh-token";
    const refreshToken = await createAdmissionBoundRefreshToken({
      admission: blockedAdmission,
      token: storedRefreshToken,
    });
    await drizzle(env.DB).insert(oauthClient).values({
      id: "oauth-test-client-row",
      clientId,
      clientSecret: await hashOAuthToken(clientSecret),
      redirectUris: ["http://localhost/callback"],
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      scopes: ["openid", "profile", "offline_access"],
      requirePKCE: false,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await drizzle(env.DB).insert(oauthRefreshToken).values({
      id: "blocked-refresh-row",
      token: await hashOAuthToken(refreshToken),
      clientId,
      userId,
      scopes: ["openid", "profile", "offline_access"],
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });
    await drizzle(env.DB).insert(oauthAccessToken).values({
      id: "blocked-access-row",
      token: await hashOAuthToken(accessToken),
      clientId,
      userId,
      scopes: ["openid", "profile"],
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });

    const introspectionBody = new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
    const unauthenticated = await auth.handler(
      formRequest("/api/auth/oauth2/introspect", introspectionBody),
    );
    expect(unauthenticated.status).not.toBe(200);

    const authorization = basicAuthorization(clientId, clientSecret);
    const introspection = await auth.handler(
      formRequest("/api/auth/oauth2/introspect", introspectionBody, {
        authorization,
      }),
    );
    expect(introspection.status).toBe(200);
    await expect(introspection.json()).resolves.toEqual({ active: false });

    const userInfo = await auth.handler(
      new Request("http://localhost/api/auth/oauth2/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(userInfo.status).toBeGreaterThanOrEqual(400);
    await expect(userInfo.json()).resolves.toMatchObject({
      error: "invalid_token",
    });

    const refresh = await auth.handler(
      formRequest(
        "/api/auth/oauth2/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        { authorization },
      ),
    );
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    await expect(refresh.json()).resolves.toMatchObject({
      code: "beta_access_revoked",
    });
    const storedRefresh = await env.DB.prepare(
      "SELECT revoked, rotated_at FROM oauth_refresh_token WHERE id = ?",
    )
      .bind("blocked-refresh-row")
      .first<{ revoked: number | null; rotated_at: number | null }>();
    expect(storedRefresh).toEqual({ revoked: null, rotated_at: null });
  });

  it("suppresses and removes OAuth credentials minted across revoke and fresh readmission", async () => {
    const now = Date.now();
    const userId = "oauth-issuance-race-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "oauth-issuance-race-github",
      username: "oauth-issuance-race-user",
      now,
    });
    const expected = await captureBetaAdmissionEpoch(userId);
    const boundStaleRefreshToken = await createAdmissionBoundRefreshToken({
      admission: expected,
      token: "stale-race-refresh-token",
    });
    await revokeAndReadmitBetaUser(userId, now + 10_000);
    const current = await captureBetaAdmissionEpoch(userId);
    expect(current).not.toEqual(expected);

    const clientId = "oauth-issuance-race-client";
    await seedOAuthClient(clientId, now);
    const staleAccessToken = "stale-race-access-token";
    const currentAccessToken = "current-race-access-token";
    const currentRefreshToken = "current-race-refresh-token";
    await Promise.all([
      drizzle(env.DB).insert(oauthAccessToken).values({
        id: "stale-race-access-row",
        token: await hashOAuthToken(staleAccessToken),
        clientId,
        userId,
        scopes: ["openid"],
        createdAt: new Date(now + 20_000),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthRefreshToken).values({
        id: "stale-race-refresh-row",
        token: await hashOAuthToken(boundStaleRefreshToken),
        clientId,
        userId,
        scopes: ["openid", "offline_access"],
        createdAt: new Date(now + 20_000),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthAccessToken).values({
        id: "current-race-access-row",
        token: await hashOAuthToken(currentAccessToken),
        clientId,
        userId,
        scopes: ["openid"],
        createdAt: new Date(now + 20_001),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthRefreshToken).values({
        id: "current-race-refresh-row",
        token: await hashOAuthToken(currentRefreshToken),
        clientId,
        userId,
        scopes: ["openid", "offline_access"],
        createdAt: new Date(now + 20_001),
        expiresAt: new Date(now + 3_600_000),
      }),
    ]);

    await expect(
      captureOAuthIssuanceAdmission({
        grantType: "refresh_token",
        refreshAdmission: (
          await readAdmissionBoundRefreshToken(boundStaleRefreshToken)
        ).admission,
        userId,
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_oauth_authorization_epoch_mismatch" },
    });
    const tamperedRefreshToken = `${boundStaleRefreshToken.slice(0, -1)}${
      boundStaleRefreshToken.endsWith("a") ? "b" : "a"
    }`;
    await expect(
      readAdmissionBoundRefreshToken(tamperedRefreshToken),
    ).rejects.toThrow("invalid admission-bound refresh token");

    await expect(
      enforceOAuthIssuanceAdmission({
        expected,
        returned: {
          access_token: staleAccessToken,
          refresh_token: boundStaleRefreshToken,
        },
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_access_changed_during_oauth_issuance" },
    });
    const remaining = await env.DB.prepare(
      `SELECT id FROM oauth_access_token WHERE user_id = ?
       UNION ALL
       SELECT id FROM oauth_refresh_token WHERE user_id = ?
       ORDER BY id`,
    )
      .bind(userId, userId)
      .all<{ id: string }>();
    expect(remaining.results.map(({ id }) => id)).toEqual([
      "current-race-access-row",
      "current-race-refresh-row",
    ]);

    // A JWT access token has no opaque row to remove. The same final fence
    // still suppresses the entire credential response before it reaches the
    // caller.
    await expect(
      enforceOAuthIssuanceAdmission({
        expected,
        returned: { access_token: "header.payload.signature" },
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_access_changed_during_oauth_issuance" },
    });
  });

  it("rejects resource audiences so OAuth access tokens remain opaque and revocable", async () => {
    const now = Date.now();
    const userId = "oauth-resource-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "oauth-resource-github",
      username: "oauth-resource-user",
      now,
    });
    const oauthUser = await env.DB.prepare("SELECT * FROM user WHERE id = ?")
      .bind(userId)
      .first<User>();

    await expect(
      getBetaOAuthAccessTokenClaims({
        resources: ["https://resource.example.test"],
        scopes: ["openid"],
        user: oauthUser!,
      }),
    ).rejects.toMatchObject({
      body: {
        code: "oauth_resource_tokens_disabled",
        error: "invalid_target",
      },
    });
    await expect(
      getBetaOAuthAccessTokenClaims({
        scopes: ["openid"],
        user: oauthUser!,
      }),
    ).resolves.toEqual({});
  });

  it("rotates only an admission-bound refresh token for the same active admission", async () => {
    const now = Date.now();
    const userId = "oauth-refresh-epoch-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "oauth-refresh-epoch-github",
      username: "oauth-refresh-epoch-user",
      now,
    });
    const admission = await captureBetaAdmissionEpoch(userId);
    const clientId = "oauth-refresh-epoch-client";
    const clientSecret = `${clientId}-secret`;
    await seedOAuthClient(clientId, now);
    const storedToken = "oauth-refresh-epoch-inner-token";
    const presentedToken = await createAdmissionBoundRefreshToken({
      admission,
      token: storedToken,
    });
    await drizzle(env.DB).insert(oauthRefreshToken).values({
      id: "oauth-refresh-epoch-row",
      token: await hashOAuthToken(presentedToken),
      clientId,
      userId,
      scopes: ["openid", "offline_access"],
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });

    const response = await auth.handler(
      formRequest(
        "/api/auth/oauth2/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: presentedToken,
        }),
        { authorization: basicAuthorization(clientId, clientSecret) },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      id_token: string;
      refresh_token: string;
    };
    expect(body.access_token).toBeTruthy();
    expect(body.id_token.split(".")).toHaveLength(3);
    await expect(
      readAdmissionBoundRefreshToken(body.refresh_token),
    ).resolves.toMatchObject({ admission });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM jwks").first<{
        count: number;
      }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("deletes a session inserted after cleanup when its captured admission is stale", async () => {
    const now = Date.now();
    const userId = "session-issuance-race-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "session-issuance-race-github",
      username: "session-issuance-race-user",
      now,
    });
    const expected = await captureBetaAdmissionEpoch(userId);
    await revokeAndReadmitBetaUser(userId, now + 10_000);
    const staleSession: Session = {
      id: "stale-session-race-row",
      token: "stale-session-race-token",
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now + 20_000),
      updatedAt: new Date(now + 20_000),
      ipAddress: null,
      userAgent: null,
    };
    await drizzle(env.DB).insert(session).values(staleSession);

    await expect(
      enforceCreatedSessionAdmission({ session: staleSession, expected }),
    ).rejects.toMatchObject({
      body: { code: "beta_access_changed_during_session_creation" },
    });
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE id = ?")
        .bind(staleSession.id)
        .first(),
    ).resolves.toBeNull();
  });

  it("carries the session admission fence on the Better Auth hook context", async () => {
    const now = Date.now();
    const userId = "context-fenced-session-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "context-fenced-session-github",
      username: "context-fenced-session-user",
      now,
    });
    const createdSession: Session = {
      id: "context-fenced-session-row",
      token: "context-fenced-session-token",
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now + 10_000),
      updatedAt: new Date(now + 10_000),
      ipAddress: null,
      userAgent: null,
    };
    const hooks = auth.options.databaseHooks?.session?.create;
    const before = hooks?.before;
    const after = hooks?.after;
    if (!before || !after) throw new Error("session create hooks are required");
    const hookContext = {} as Parameters<typeof before>[1];

    // Database after hooks can be queued beyond Better Auth's request-state
    // ALS scope. The exact endpoint-context object remains stable across both
    // callbacks and is the fence carrier.
    await expect(before(createdSession, hookContext)).resolves.toBeUndefined();
    await drizzle(env.DB).insert(session).values(createdSession);
    await expect(after(createdSession, hookContext)).resolves.toBeUndefined();
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE id = ?")
        .bind(createdSession.id)
        .first<{ id: string }>(),
    ).resolves.toEqual({ id: createdSession.id });
  });

  it("removes a linked account when its hook-context fence is missing", async () => {
    const now = Date.now();
    const userId = "missing-account-fence-user";
    await drizzle(env.DB).insert(user).values({
      id: userId,
      name: "Missing Account Fence",
      email: "missing-account-fence@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const linkedAccount = {
      id: "missing-account-fence-row",
      providerId: "github",
      accountId: "missing-account-fence-github",
      userId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    await drizzle(env.DB).insert(account).values(linkedAccount);
    const after = auth.options.databaseHooks?.account?.create?.after;
    if (!after) throw new Error("account create after hook is required");
    const hookContext = {} as Parameters<typeof after>[1];

    await expect(after(linkedAccount, hookContext)).rejects.toMatchObject({
      body: { code: "valid_beta_invite_required" },
    });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = ?")
        .bind(linkedAccount.id)
        .first(),
    ).resolves.toBeNull();
  });

  it("deletes a GitHub link inserted after its invite is revoked", async () => {
    const now = Date.now();
    const userId = "github-link-race-user";
    await drizzle(env.DB).insert(user).values({
      id: userId,
      name: "GitHub Link Race User",
      email: "github-link-race@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const invite = await createBetaInvite({
      d1: env.DB,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now,
    });
    const linkedAccount = {
      id: "github-link-race-row",
      providerId: "github",
      accountId: "github-link-race-account",
      userId,
      createdAt: new Date(now + 2),
      updatedAt: new Date(now + 2),
    };
    await drizzle(env.DB).insert(account).values(linkedAccount);
    await revokeBetaInvite({
      d1: env.DB,
      inviteId: invite.id,
      expectedVersion: invite.version,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      now: now + 3,
    });

    await expect(
      enforceCreatedGithubAccountAdmission({
        account: linkedAccount,
        expected: {
          kind: "github-invite",
          inviteId: invite.id,
          attemptId: "github-link-race-attempt",
          userId,
        },
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_invite_changed_during_github_link" },
    });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = ?")
        .bind(linkedAccount.id)
        .first(),
    ).resolves.toBeNull();
  });

  it("binds authorization codes to the admission that created them", async () => {
    const now = Date.now();
    const userId = "authorization-code-race-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "authorization-code-race-github",
      username: "authorization-code-race-user",
      now,
    });
    const context = await auth.$context;
    await context.internalAdapter.createVerificationValue({
      identifier: "authorization-code-race-hash",
      value: JSON.stringify({
        type: "authorization_code",
        query: { client_id: "client", scope: "openid" },
        sessionId: "authorization-code-session",
        userId,
      }),
      expiresAt: new Date(now + 600_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const stored = await env.DB.prepare(
      "SELECT value FROM verification WHERE identifier = ?",
    )
      .bind("authorization-code-race-hash")
      .first<{ value: string }>();
    expect(stored?.value).toContain('"intarBetaAdmission"');

    await revokeAndReadmitBetaUser(userId, now + 10_000);
    await expect(
      captureOAuthIssuanceAdmission({
        grantType: "authorization_code",
        userId,
        verificationValue: JSON.parse(stored!.value),
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_oauth_authorization_epoch_mismatch" },
    });

    await env.DB.prepare(
      `INSERT INTO verification
         (id, identifier, value, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "paused-authorization-code-row",
        "paused-authorization-code-hash",
        stored!.value,
        now + 600_000,
        now,
        now,
      )
      .run();
    await expect(
      enforceCreatedAuthorizationCodeAdmission({
        id: "paused-authorization-code-row",
        value: stored!.value,
      }),
    ).rejects.toMatchObject({
      body: { code: "beta_access_changed_during_oauth_authorization" },
    });
    await expect(
      env.DB.prepare("SELECT id FROM verification WHERE id = ?")
        .bind("paused-authorization-code-row")
        .first(),
    ).resolves.toBeNull();
  });

  it("rejects an explicit SSO-link handoff after revoke and fresh readmission", async () => {
    const now = Date.now();
    const userId = "stale-sso-link-user";
    await seedActiveBetaUser({
      id: userId,
      accountId: "stale-sso-link-github",
      username: "stale-sso-link-user",
      now,
    });
    const admission = await captureBetaAdmissionEpoch(userId);
    const handoff = await createSsoLinkOAuthHandoff({
      ...admission,
      providerId: "stale-sso-provider",
      expiresAt: now + 600_000,
    });
    await revokeAndReadmitBetaUser(userId, now + 10_000);
    await drizzle(env.DB).insert(ssoProvider).values({
      id: "stale-sso-provider-row",
      issuer: "https://sso.example.test",
      domain: "example.test",
      oidcConfig: JSON.stringify({
        clientId: "client",
        clientSecret: "secret",
        discoveryEndpoint:
          "https://sso.example.test/.well-known/openid-configuration",
      }),
      userId: FIXTURE_BETA_ADMIN_ID,
      providerId: "stale-sso-provider",
      domainVerified: true,
    });
    await drizzle(env.DB).insert(session).values({
      id: "stale-sso-current-session-row",
      token: "stale-sso-current-session-token",
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now + 20_000),
      updatedAt: new Date(now + 20_000),
    });
    const cookie = await signedSessionCookie("stale-sso-current-session-token");
    const response = await auth.handler(
      authRequest(
        "/api/auth/sign-in/sso",
        {
          providerId: "stale-sso-provider",
          providerType: "oidc",
          callbackURL: "http://localhost/organizations/example",
        },
        {
          cookie,
          [INVITE_OAUTH_HANDOFF_HEADER]: handoff,
        },
      ),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_beta_oauth_handoff",
    });
  });

  it("refuses to mint an already-expired OAuth handoff", async () => {
    await expect(
      createInviteOAuthHandoff({
        inviteId: "invite-expired",
        attemptId: "attempt-expired",
        expiresAt: Date.now() - 1,
      }),
    ).rejects.toThrow("handoff expiry is outside the allowed window");
  });
});

type StartedGithubFlow = {
  cookie: string;
  inviteId?: string;
  inviteVersion?: number;
  state: string;
};

async function seedOidcOnlyUser(input: {
  id: string;
  email: string;
  now: number;
}): Promise<{ id: string; email: string }> {
  await drizzle(env.DB).insert(user).values({
    id: input.id,
    name: input.id,
    email: input.email,
    emailVerified: true,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  await drizzle(env.DB).insert(account).values({
    id: `${input.id}-oidc-row`,
    providerId: "har-oidc",
    accountId: `${input.id}-oidc-subject`,
    userId: input.id,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  return { id: input.id, email: input.email };
}

async function beginGithubInviteFlow(
  attemptId: string,
  now: number,
): Promise<StartedGithubFlow & { inviteId: string; inviteVersion: number }> {
  const invite = await createBetaInvite({
    d1: env.DB,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
    now: now - 2_000,
  });
  const handoff = await createInviteOAuthHandoff({
    inviteId: invite.id,
    attemptId,
    expiresAt: now + 600_000,
  });
  const started = await beginGithubFlow(handoff);
  return {
    ...started,
    inviteId: invite.id,
    inviteVersion: invite.version,
  };
}

async function beginGithubFlowWithoutInvite(): Promise<StartedGithubFlow> {
  return beginGithubFlow();
}

async function beginGithubFlow(handoff?: string): Promise<StartedGithubFlow> {
  const response = await auth.handler(
    authRequest(
      "/api/auth/sign-in/social",
      {
        provider: "github",
        callbackURL: "http://localhost/join",
        errorCallbackURL: "http://localhost/join",
      },
      handoff ? { [INVITE_OAUTH_HANDOFF_HEADER]: handoff } : undefined,
    ),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new Error("GitHub authorization URL is required");
  const state = new URL(body.url).searchParams.get("state");
  if (!state) throw new Error("GitHub OAuth state is required");
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("GitHub OAuth state cookie is required");
  const cookie = setCookie.split(";", 1)[0];
  if (!cookie) throw new Error("GitHub OAuth state cookie is invalid");
  return { cookie, state };
}

async function completeGithubCallback(
  input: StartedGithubFlow & {
    email: string;
    githubAccountId: string;
    githubLogin: string;
  },
): Promise<Response> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (request): Promise<Response> => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: `token-${input.githubAccountId}`,
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({
          id: Number(input.githubAccountId),
          login: input.githubLogin,
          name: input.githubLogin,
          email: input.email,
          avatar_url: null,
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return Response.json([
          {
            email: input.email,
            primary: true,
            verified: true,
            visibility: null,
          },
        ]);
      }
      throw new Error(`unexpected fetch in GitHub callback test: ${url}`);
    },
  );
  try {
    return await auth.handler(
      new Request(
        `http://localhost/api/auth/callback/github?code=test-code&state=${encodeURIComponent(input.state)}`,
        { headers: { cookie: input.cookie } },
      ),
    );
  } finally {
    fetchSpy.mockRestore();
  }
}

function expectOauthCallbackError(response: Response, code: string): void {
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  expect(new URL(location!).searchParams.get("error")).toBe(code);
}

async function expectGithubLinkAndSessionAbsent(
  userId: string,
  githubAccountId: string,
): Promise<void> {
  await expect(
    env.DB.prepare(
      `SELECT id FROM account
       WHERE provider_id = 'github' AND account_id = ? LIMIT 1`,
    )
      .bind(githubAccountId)
      .first(),
  ).resolves.toBeNull();
  await expect(
    env.DB.prepare("SELECT id FROM session WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first(),
  ).resolves.toBeNull();
}

async function grantBetaAccessWithoutLinkedGithub(input: {
  userId: string;
  githubAccountId: string;
  githubUsername: string;
  now: number;
}): Promise<void> {
  const githubRowId = `${input.userId}-temporary-github-row`;
  await drizzle(env.DB).insert(account).values({
    id: githubRowId,
    providerId: "github",
    accountId: input.githubAccountId,
    userId: input.userId,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  const invite = await createBetaInvite({
    d1: env.DB,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
    now: input.now,
  });
  await redeemBetaInvite({
    d1: env.DB,
    inviteId: invite.id,
    attemptId: `access-attempt-${input.userId}`,
    userId: input.userId,
    githubAccountId: input.githubAccountId,
    githubUsername: input.githubUsername,
    now: input.now + 1,
  });
  await drizzle(env.DB).delete(account).where(eq(account.id, githubRowId));
}

function authRequest(
  path: string,
  body: object,
  extraHeaders?: HeadersInit,
): Request {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function authGetRequest(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { cookie, origin: "http://localhost" },
  });
}

async function signedSessionCookie(token: string): Promise<string> {
  const context = await auth.$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(
    `${token}.${encodedSignature}`,
  )}`;
}

async function signLegacyHandoff(payload: object): Promise<string> {
  const context = await auth.$context;
  const encoded = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`intar.beta-auth-handoff.v1.${encoded}`),
  );
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function bytesToBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function formRequest(
  path: string,
  body: URLSearchParams,
  headers?: HeadersInit,
): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/x-www-form-urlencoded");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: requestHeaders,
    body: body.toString(),
  });
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function hashOAuthToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

async function seedActiveBetaUser(input: {
  id: string;
  accountId: string;
  username: string;
  now: number;
}): Promise<void> {
  await seedGithubIdentity(input);
  const invite = await createBetaInvite({
    d1: env.DB,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
    now: input.now + 1,
  });
  await redeemBetaInvite({
    d1: env.DB,
    inviteId: invite.id,
    attemptId: `auth-attempt-${input.id}`,
    userId: input.id,
    githubAccountId: input.accountId,
    githubUsername: input.username,
    now: input.now + 2,
  });
}

async function seedGithubIdentity(input: {
  id: string;
  accountId: string;
  username: string;
  role?: string;
  now: number;
}): Promise<void> {
  await drizzle(env.DB).insert(user).values({
    id: input.id,
    name: input.username,
    email: `${input.username}@example.test`,
    emailVerified: true,
    username: input.username,
    displayUsername: input.username,
    role: input.role,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  await drizzle(env.DB).insert(account).values({
    id: `${input.id}-github-link`,
    providerId: "github",
    accountId: input.accountId,
    userId: input.id,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
}

async function revokeAndReadmitBetaUser(
  userId: string,
  now: number,
): Promise<void> {
  const revoked = await revokeBetaUser({
    d1: env.DB,
    userId,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    reason: "admission_epoch_test",
    now,
  });
  const cleanup = await acquireBetaRevocationCleanup({
    d1: env.DB,
    userId,
    revocationId: revoked.revocationId,
    now,
  });
  expect(cleanup.status).toBe("acquired");
  await completeBetaRevocationCleanup({
    d1: env.DB,
    userId,
    revocationId: revoked.revocationId,
    cleanupAttemptId: cleanup.cleanupAttemptId,
    now: now + 1,
  });
  const invite = await createBetaInvite({
    d1: env.DB,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
    now: now + 3,
  });
  const github = await env.DB.prepare(
    `SELECT account_id FROM account
     WHERE user_id = ? AND provider_id = 'github' LIMIT 1`,
  )
    .bind(userId)
    .first<{ account_id: string }>();
  const identity = await env.DB.prepare(
    "SELECT username FROM user WHERE id = ?",
  )
    .bind(userId)
    .first<{ username: string }>();
  await redeemBetaInvite({
    d1: env.DB,
    inviteId: invite.id,
    attemptId: `readmit-attempt-${userId}`,
    userId,
    githubAccountId: github!.account_id,
    githubUsername: identity!.username,
    now: now + 4,
  });
}

async function seedOAuthClient(clientId: string, now: number): Promise<void> {
  await drizzle(env.DB).insert(oauthClient).values({
    id: `${clientId}-row`,
    clientId,
    clientSecret: await hashOAuthToken(`${clientId}-secret`),
    redirectUris: ["http://localhost/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: ["openid", "offline_access"],
    requirePKCE: false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
}
