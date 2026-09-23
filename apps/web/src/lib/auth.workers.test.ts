/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import type { Session, User } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { getSignupStatus, setSignupLimit } from "@/lib/signups";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import {
  auth,
  authCookiePolicy,
  assertNoAdditionalBetterAuthTrustedOrigins,
  createSsoLinkOAuthHandoff,
  enforceActiveOAuthIssuance,
  enforceCreatedSessionStillActive,
  getOAuthAccessTokenClaims,
  SSO_LINK_HANDOFF_HEADER,
  trustedBrowserOrigin,
} from "./auth";

describe("auth policy", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureAdmin(env.DB, Date.now());
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

  it("uses PKCE S256 for a public organization OIDC provider through Better Auth sign-in", async () => {
    const organizationId = "public-oidc-organization";
    const providerRowId = "public-oidc-provider-row";
    const providerId = "public-oidc-provider";
    const now = new Date();
    await drizzle(env.DB).insert(organization).values({
      id: organizationId,
      name: "Public OIDC organization",
      slug: "public-oidc-organization",
      createdAt: now,
    });
    await drizzle(env.DB)
      .insert(ssoProvider)
      .values({
        id: providerRowId,
        issuer: "https://login.example.test",
        domain: "example.test",
        oidcConfig: JSON.stringify({
          issuer: "https://login.example.test",
          clientId: "public-oidc-client",
          authorizationEndpoint: "https://login.example.test/oauth/authorize",
          tokenEndpoint: "https://login.example.test/oauth/token",
          tokenEndpointAuthentication: "none",
          jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
          userInfoEndpoint: "https://login.example.test/oauth/userinfo",
          pkce: false,
          scopes: ["openid", "email", "profile"],
        }),
        oidcClientSecretCiphertext: null,
        userId: FIXTURE_ADMIN_ID,
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
        callbackURL: "http://localhost/organizations/public-oidc-organization",
        errorCallbackURL:
          "http://localhost/organizations/public-oidc-organization/sign-in",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      redirect?: unknown;
      url?: unknown;
    };
    expect(body).toMatchObject({ redirect: true });
    expect(body.url).toEqual(
      expect.stringContaining("https://login.example.test/oauth/authorize"),
    );
    expect(String(body.url)).toContain("client_id=public-oidc-client");
    const authorization = new URL(String(body.url)).searchParams;
    expect(authorization.get("response_type")).toBe("code");
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.has("client_secret")).toBe(false);
    expect(authorization.has("code_verifier")).toBe(false);
  });

  it.each(["valid", "missing", "invalid-signature", "wrong-audience"])(
    "links OIDC from a member's GitHub session with PKCE S256 and checks the ID token: %s",
    async (tokenCase) => {
      const now = Date.now();
      const userId = "public-oidc-link-user";
      const organizationId = "public-oidc-link-organization";
      const providerRowId = "public-oidc-link-provider-row";
      const providerId = "public-oidc-link-provider";
      await seedMember({
        id: userId,
        githubAccountId: "public-oidc-link-github",
        now,
      });
      await drizzle(env.DB)
        .insert(organization)
        .values({
          id: organizationId,
          name: "Public OIDC link organization",
          slug: organizationId,
          createdAt: new Date(now),
        });
      await drizzle(env.DB)
        .insert(ssoProvider)
        .values({
          id: providerRowId,
          issuer: "https://login.example.test",
          domain: "example.test",
          oidcConfig: JSON.stringify({
            issuer: "https://login.example.test",
            clientId: "public-oidc-link-client",
            authorizationEndpoint: "https://login.example.test/oauth/authorize",
            tokenEndpoint: "https://login.example.test/oauth/token",
            tokenEndpointAuthentication: "none",
            jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
            userInfoEndpoint: "https://login.example.test/oauth/userinfo",
            pkce: false,
          }),
          oidcClientSecretCiphertext: null,
          userId: FIXTURE_ADMIN_ID,
          providerId,
          organizationId,
          domainVerified: true,
        });
      const handoff = await createSsoLinkOAuthHandoff({
        userId,
        providerId,
        expiresAt: now + 600_000,
      });
      const sessionCookie = await seedSessionCookie({
        id: "public-oidc-link-session-row",
        token: "public-oidc-link-session",
        userId,
        now,
      });
      const started = await auth.handler(
        authRequest(
          "/api/auth/sign-in/sso",
          {
            providerId,
            providerType: "oidc",
            callbackURL: "http://localhost/organizations/public-oidc-link",
            errorCallbackURL:
              "http://localhost/organizations/public-oidc-link/sign-in",
          },
          {
            cookie: sessionCookie,
            [SSO_LINK_HANDOFF_HEADER]: handoff,
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

      const signingKey = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      );
      const encode = (value: unknown) =>
        bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
      const tokenPayload = `${encode({ alg: "RS256", kid: "test-key" })}.${encode(
        {
          iss: "https://login.example.test",
          aud:
            tokenCase === "wrong-audience"
              ? "another-client"
              : "public-oidc-link-client",
          sub: "public-oidc-link-subject",
          email: `${userId}@example.test`,
          name: "Public OIDC Link User",
          iat: Math.floor(now / 1000),
          exp: Math.floor(now / 1000) + 3600,
        },
      )}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        signingKey.privateKey,
        new TextEncoder().encode(tokenPayload),
      );
      if (tokenCase === "invalid-signature") new Uint8Array(signature).fill(0);
      const idToken =
        tokenCase === "missing"
          ? undefined
          : `${tokenPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
      const jwk = {
        ...(await crypto.subtle.exportKey("jwk", signingKey.publicKey)),
        kid: "test-key",
        alg: "RS256",
        use: "sig",
      };

      let tokenRequest: Request | undefined;
      let tokenParams: URLSearchParams | undefined;
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (request, init): Promise<Response> => {
          const url = requestUrl(request);
          if (url === "https://login.example.test/oauth/token") {
            tokenRequest = new Request(request, init);
            tokenParams = new URLSearchParams(await tokenRequest.text());
            return Response.json({
              access_token: "public-oidc-link-token",
              id_token: idToken,
              expires_in: 3600,
              token_type: "Bearer",
            });
          }
          if (url === "https://login.example.test/.well-known/jwks.json") {
            return Response.json({ keys: [jwk] });
          }
          throw new Error(`unexpected OIDC callback fetch: ${url}`);
        });
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

      expect(tokenRequest!.method).toBe("POST");
      expect(tokenRequest!.headers.has("authorization")).toBe(false);
      expect(tokenParams!.has("client_secret")).toBe(false);
      expect(tokenParams!.get("client_id")).toBe("public-oidc-link-client");
      expect(tokenParams!.get("grant_type")).toBe("authorization_code");
      expect(tokenParams!.get("redirect_uri")).toBe(
        `http://localhost/api/auth/sso/callback/${providerId}`,
      );
      const verifier = tokenParams!.get("code_verifier");
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier!),
      );
      const challenge = bytesToBase64Url(new Uint8Array(digest));
      expect(challenge).toBe(
        new URL(startedBody.url!).searchParams.get("code_challenge"),
      );
      if (tokenCase !== "valid") {
        expect(callback!.status).toBe(302);
        expect(
          new URL(callback!.headers.get("location")!).searchParams.get("error"),
        ).toBe("invalid_provider");
        await expect(
          env.DB.prepare("SELECT id FROM account WHERE provider_id = ?")
            .bind(providerId)
            .first(),
        ).resolves.toBeNull();
        return;
      }
      expect(callback!.status).toBe(302);
      expect(callback!.headers.get("location")).toBe(
        "http://localhost/organizations/public-oidc-link",
      );
      await expect(
        env.DB.prepare(
          "SELECT user_id AS userId FROM account WHERE provider_id = ? AND account_id = ?",
        )
          .bind(providerId, "public-oidc-link-subject")
          .first(),
      ).resolves.toEqual({ userId });
      await expect(
        env.DB.prepare(
          "SELECT role FROM member WHERE organization_id = ? AND user_id = ?",
        )
          .bind(organizationId, userId)
          .first(),
      ).resolves.toEqual({ role: "member" });
    },
  );

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
      adminListUsers,
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
            callbackURL: "http://localhost/courses",
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
          authGetRequest("/api/auth/admin/list-users", "missing-session"),
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
        "/admin/list-users",
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
      adminListUsers,
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

  it("maps GitHub profiles and gates identities before mutation", async () => {
    const github = auth.options.socialProviders?.github;
    const mappedUser = github?.mapProfileToUser?.({
      login: "new-member",
    } as never);
    expect(mappedUser).toMatchObject({
      username: "new-member",
      displayUsername: "new-member",
    });

    const validate = auth.options.user?.validateUserInfo;
    expect(validate).toBeTypeOf("function");

    // No saved limit means sign-ups are closed.
    await expect(
      validate?.({
        user: { name: "Candidate" },
        source: {
          action: "create-user",
          method: "oauth",
          oauth: { providerId: "github", profile: {} },
        },
      }),
    ).resolves.toMatchObject({ error: "signups_full" });

    await setTestSignupLimit(2);
    await expect(
      validate?.({
        user: { name: "Candidate" },
        source: {
          action: "create-user",
          method: "oauth",
          oauth: { providerId: "github", profile: {} },
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      validate?.({
        user: { name: "Candidate" },
        source: {
          action: "create-user",
          method: "oauth",
          oauth: { providerId: "gitlab", profile: {} },
        },
      }),
    ).resolves.toMatchObject({ error: "unsupported_oauth_provider" });

    await expect(
      validate?.({
        user: { id: "missing-user" },
        source: {
          action: "link-account",
          method: "oauth",
          oauth: { providerId: "github", profile: {} },
        },
      }),
    ).resolves.toMatchObject({ error: "access_revoked" });

    await expect(
      validate?.({
        user: { name: "SSO Candidate" },
        source: {
          action: "create-user",
          method: "sso-oidc",
          sso: { providerId: "example-sso", profile: {} },
        },
      }),
    ).resolves.toMatchObject({ error: "github_identity_required" });

    await expect(
      validate?.({
        user: { id: FIXTURE_ADMIN_ID },
        source: {
          action: "link-account",
          method: "sso-oidc",
          sso: { providerId: "example-sso", profile: {} },
        },
      }),
    ).resolves.toMatchObject({ error: "explicit_sso_link_required" });
  });

  it("signs up a new member with GitHub while a spot is open", async () => {
    await setTestSignupLimit(2);
    const flow = await beginGithubFlow();

    const callback = await completeGithubCallback({
      ...flow,
      email: "new-member@example.test",
      githubAccountId: "4242101",
      githubLogin: "new-member",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost/courses");
    const created = await env.DB.prepare(
      `SELECT identity.id AS userId, github.account_id AS githubAccountId
       FROM user AS identity
       JOIN account AS github
         ON github.user_id = identity.id AND github.provider_id = 'github'
       WHERE identity.email = ?`,
    )
      .bind("new-member@example.test")
      .first<{ userId: string; githubAccountId: string }>();
    expect(created?.githubAccountId).toBe("4242101");
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = ? LIMIT 1")
        .bind(created!.userId)
        .first(),
    ).resolves.not.toBeNull();
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM signup_reservations").first(),
    ).resolves.toEqual({ count: 0 });
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      limit: 2,
      taken: 2,
      remaining: 0,
      open: false,
    });
  });

  it("refuses a GitHub sign-up at the limit without creating a user", async () => {
    await setTestSignupLimit(1);
    const flow = await beginGithubFlow();

    const callback = await completeGithubCallback({
      ...flow,
      email: "late-member@example.test",
      githubAccountId: "4242102",
      githubLogin: "late-member",
    });

    expectOauthCallbackError(callback, "signups_full");
    await expect(
      env.DB.prepare("SELECT id FROM user WHERE email = ?")
        .bind("late-member@example.test")
        .first(),
    ).resolves.toBeNull();
    await expectGithubAccountAbsent("4242102");
  });

  it("admits exactly one of two concurrent sign-ups for the last spot", async () => {
    await setTestSignupLimit(2);
    const first = await beginGithubFlow();
    const second = await beginGithubFlow();
    const fetchSpy = mockGithubProfiles({
      "code-first": {
        email: "race-first@example.test",
        githubAccountId: "4242111",
        githubLogin: "race-first",
      },
      "code-second": {
        email: "race-second@example.test",
        githubAccountId: "4242112",
        githubLogin: "race-second",
      },
    });
    let callbacks: Response[];
    try {
      callbacks = await Promise.all([
        auth.handler(githubCallbackRequest(first, "code-first")),
        auth.handler(githubCallbackRequest(second, "code-second")),
      ]);
    } finally {
      fetchSpy.mockRestore();
    }

    const outcomes = callbacks.map((callback) => {
      expect(callback.status).toBe(302);
      return new URL(callback.headers.get("location")!).searchParams.get(
        "error",
      );
    });
    expect(outcomes.toSorted()).toEqual(["signups_full", null].toSorted());
    const members = await env.DB.prepare(
      `SELECT count(*) AS count FROM account
       WHERE provider_id = 'github' AND account_id IN ('4242111', '4242112')`,
    ).first<{ count: number }>();
    expect(members?.count).toBe(1);
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: 2,
      remaining: 0,
    });
  });

  it("links an account-less leftover user once a spot opens", async () => {
    const now = Date.now();
    const leftoverId = "leftover-user";
    await drizzle(env.DB).insert(user).values({
      id: leftoverId,
      name: "Leftover",
      email: "leftover@example.test",
      emailVerified: true,
      username: "leftover",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await setTestSignupLimit(1);

    const refused = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: "leftover@example.test",
      githubAccountId: "4242121",
      githubLogin: "leftover",
    });
    expectOauthCallbackError(refused, "signups_full");
    await expectGithubLinkAndSessionAbsent(leftoverId, "4242121");

    await setTestSignupLimit(2);
    const linked = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: "leftover@example.test",
      githubAccountId: "4242121",
      githubLogin: "leftover",
    });
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toBe("http://localhost/courses");
    await expect(
      env.DB.prepare(
        `SELECT user_id AS userId FROM account
         WHERE provider_id = 'github' AND account_id = ?`,
      )
        .bind("4242121")
        .first(),
    ).resolves.toEqual({ userId: leftoverId });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM user").first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("rejects a same-email implicit GitHub link to a user with other accounts", async () => {
    const target = await seedOidcOnlyUser({
      id: "same-email-oidc-target",
      email: "same-email-oidc@example.test",
      now: Date.now(),
    });
    await setTestSignupLimit(10);

    const callback = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: target.email,
      githubAccountId: "4242131",
      githubLogin: "same-email-oidc",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242131");
  });

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
    await setTestSignupLimit(10);

    const callback = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: target.email,
      githubAccountId: "4242132",
      githubLogin: "same-email-second-github",
    });

    expectOauthCallbackError(callback, "explicit_github_link_required");
    await expectGithubLinkAndSessionAbsent(target.id, "4242132");
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

  it("rejects a same-email implicit GitHub link to a revoked user", async () => {
    const now = Date.now();
    const targetId = "same-email-revoked-target";
    await drizzle(env.DB).insert(user).values({
      id: targetId,
      name: "Revoked leftover",
      email: "same-email-revoked@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await banMember(targetId);
    await setTestSignupLimit(10);

    const callback = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: "same-email-revoked@example.test",
      githubAccountId: "4242133",
      githubLogin: "same-email-revoked",
    });

    expectOauthCallbackError(callback, "access_revoked");
    await expectGithubLinkAndSessionAbsent(targetId, "4242133");
  });

  it("lets members sign in while sign-ups are full", async () => {
    const now = Date.now();
    await seedMember({ id: "full-cap-member", githubAccountId: "4242141", now });
    await setTestSignupLimit(1);
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      open: false,
    });

    const callback = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: "full-cap-member@example.test",
      githubAccountId: "4242141",
      githubLogin: "full-cap-member",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost/courses");
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = ? LIMIT 1")
        .bind("full-cap-member")
        .first(),
    ).resolves.not.toBeNull();
  });

  it("refuses GitHub sign-in for a revoked member", async () => {
    const now = Date.now();
    await seedMember({ id: "revoked-member", githubAccountId: "4242151", now });
    await banMember("revoked-member");
    await setTestSignupLimit(10);

    const callback = await completeGithubCallback({
      ...(await beginGithubFlow()),
      email: "revoked-member@example.test",
      githubAccountId: "4242151",
      githubLogin: "revoked-member",
    });

    expectOauthCallbackError(callback, "access_revoked");
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = ? LIMIT 1")
        .bind("revoked-member")
        .first(),
    ).resolves.toBeNull();
  });

  it("reserves a spot in the account hook and refuses links it cannot fence", async () => {
    const now = Date.now();
    await drizzle(env.DB).insert(user).values({
      id: "hook-user",
      name: "Hook user",
      email: "hook-user@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const hooks = auth.options.databaseHooks?.account?.create;
    const before = hooks?.before;
    const after = hooks?.after;
    if (!before || !after) throw new Error("account create hooks are required");
    const hookContext = {} as Parameters<typeof before>[1];
    const githubAccount = {
      id: "hook-github-row",
      providerId: "github",
      accountId: "hook-github",
      userId: "hook-user",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    await expect(before(githubAccount, null)).rejects.toMatchObject({
      body: { code: "account_context_missing" },
    });
    // Sign-ups are closed: the authoritative cap refuses the link.
    await expect(before(githubAccount, hookContext)).rejects.toMatchObject({
      body: { code: "signups_full", message: "No sign-up spots are open right now" },
    });

    await setTestSignupLimit(2);
    await expect(before(githubAccount, hookContext)).resolves.toBeUndefined();
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM signup_reservations").all(),
    ).resolves.toMatchObject({ results: [{ userId: "hook-user" }] });
    await drizzle(env.DB).insert(account).values(githubAccount);
    await expect(after(githubAccount)).resolves.toBeUndefined();
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM signup_reservations").first(),
    ).resolves.toEqual({ count: 0 });

    await expect(
      before({ ...githubAccount, accountId: "hook-second-github" }, hookContext),
    ).rejects.toMatchObject({ body: { code: "explicit_github_link_required" } });
    await expect(
      before(
        { ...githubAccount, providerId: "tenant-oidc", accountId: "subject" },
        hookContext,
      ),
    ).rejects.toMatchObject({ body: { code: "explicit_sso_link_required" } });
  });

  it("refuses to create a session for a banned account", async () => {
    const now = Date.now();
    await seedMember({ id: "banned-session-user", githubAccountId: "4242161", now });
    await banMember("banned-session-user");
    const context = await auth.$context;

    await expect(
      context.internalAdapter.createSession("banned-session-user"),
    ).rejects.toMatchObject({ body: { code: "access_revoked" } });
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = ?")
        .bind("banned-session-user")
        .first(),
    ).resolves.toBeNull();
  });

  it("deletes a session inserted after its account was revoked", async () => {
    const now = Date.now();
    const userId = "session-issuance-race-user";
    await seedMember({ id: userId, githubAccountId: "4242171", now });
    const created: Session = {
      id: "session-race-row",
      token: "session-race-token",
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: null,
      userAgent: null,
    };
    await drizzle(env.DB).insert(session).values(created);

    await expect(enforceCreatedSessionStillActive(created)).resolves.toBeUndefined();
    await banMember(userId);
    await expect(enforceCreatedSessionStillActive(created)).rejects.toMatchObject({
      body: { code: "access_revoked" },
    });
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE id = ?")
        .bind(created.id)
        .first(),
    ).resolves.toBeNull();
  });

  it("confines a revoked account's session to sign-out and callbacks", async () => {
    const now = Date.now();
    const userId = "revoked-session-user";
    await seedMember({ id: userId, githubAccountId: "4242181", role: "admin", now });
    const cookie = await seedSessionCookie({
      id: "revoked-session-row",
      token: "revoked-session-token",
      userId,
      now,
    });
    await banMember(userId);

    const inspection = await auth.handler(inspectionRequest(cookie));
    expect(inspection.status).toBe(200);
    await expect(inspection.json()).resolves.toMatchObject({
      user: { id: userId },
    });

    const stockUserList = await auth.handler(
      authGetRequest("/api/auth/admin/list-users", cookie),
    );
    expect(stockUserList.status).toBe(404);
    await expect(stockUserList.text()).resolves.toBe("Not Found");

    const denied = await Promise.all([
      auth.handler(authGetRequest("/api/auth/organization/list", cookie)),
      auth.handler(
        authGetRequest(
          "/api/auth/oauth2/authorize?client_id=blocked&response_type=code",
          cookie,
        ),
      ),
      auth.handler(
        authRequest(
          "/api/auth/sign-in/social",
          { provider: "github", callbackURL: "http://localhost/courses" },
          { cookie },
        ),
      ),
    ]);
    for (const response of denied) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "access_revoked",
      });
    }

    const signOut = await auth.handler(
      authRequest("/api/auth/sign-out", {}, { cookie }),
    );
    expect(signOut.status).toBe(200);
    await expect(signOut.json()).resolves.toMatchObject({ success: true });
  });

  it("answers session inspection without reading account state", async () => {
    const now = Date.now();
    await seedMember({ id: "inspection-member", githubAccountId: "4242191", now });
    await seedMember({ id: "inspection-revoked", githubAccountId: "4242192", now });
    const memberCookie = await seedSessionCookie({
      id: "inspection-member-session",
      token: "inspection-member-token",
      userId: "inspection-member",
      now,
    });
    const revokedCookie = await seedSessionCookie({
      id: "inspection-revoked-session",
      token: "inspection-revoked-token",
      userId: "inspection-revoked",
      now,
    });
    await banMember("inspection-revoked");
    const handoff = await createSsoLinkOAuthHandoff({
      userId: "inspection-member",
      providerId: "inspection-provider",
      expiresAt: now + 600_000,
    });

    for (const [cookie, header] of [
      [memberCookie, undefined],
      [memberCookie, handoff],
      [revokedCookie, undefined],
      [null, "not-a-handoff"],
    ] as const) {
      const statements = await capturePreparedSql(async () => {
        const response = await auth.handler(inspectionRequest(cookie, header));
        expect(response.status).toBe(200);
      });
      // Better Auth's own session lookup still runs. Account state reads use
      // coalesce(banned), which that lookup does not.
      if (cookie) {
        expect(statements.some((sql) => /session/iu.test(sql))).toBe(true);
      }
      expect(statements.filter((sql) => /coalesce\(/iu.test(sql))).toEqual([]);
      expect(
        statements.filter((sql) => /from\s+["`]?account["`]?/iu.test(sql)),
      ).toEqual([]);
    }
  });

  it("accepts an SSO-link handoff only for its signed-in member and OIDC provider", async () => {
    const now = Date.now();
    const userId = "handoff-member";
    await seedMember({ id: userId, githubAccountId: "4242201", now });
    await seedMember({ id: "handoff-other", githubAccountId: "4242202", now });
    await seedOidcProvider("handoff-provider");
    const cookie = await seedSessionCookie({
      id: "handoff-member-session",
      token: "handoff-member-token",
      userId,
      now,
    });
    const otherCookie = await seedSessionCookie({
      id: "handoff-other-session",
      token: "handoff-other-token",
      userId: "handoff-other",
      now,
    });
    const handoff = await createSsoLinkOAuthHandoff({
      userId,
      providerId: "handoff-provider",
      expiresAt: now + 600_000,
    });
    const forged = `${handoff.slice(0, -1)}${handoff.endsWith("a") ? "b" : "a"}`;
    const ssoBody = {
      providerId: "handoff-provider",
      providerType: "oidc",
      callbackURL: "http://localhost/organizations/example",
    };

    const accepted = await auth.handler(
      authRequest("/api/auth/sign-in/sso", ssoBody, {
        cookie,
        [SSO_LINK_HANDOFF_HEADER]: handoff,
      }),
    );
    expect(accepted.status).toBe(200);

    const rejected = await Promise.all([
      auth.handler(
        authRequest("/api/auth/sign-in/sso", ssoBody, {
          cookie,
          [SSO_LINK_HANDOFF_HEADER]: forged,
        }),
      ),
      auth.handler(
        authRequest("/api/auth/sign-in/sso", ssoBody, {
          cookie: otherCookie,
          [SSO_LINK_HANDOFF_HEADER]: handoff,
        }),
      ),
      auth.handler(
        authRequest(
          "/api/auth/sign-in/sso",
          { ...ssoBody, providerId: "another-provider" },
          { cookie, [SSO_LINK_HANDOFF_HEADER]: handoff },
        ),
      ),
      auth.handler(
        authRequest("/api/auth/sign-in/sso", ssoBody, {
          [SSO_LINK_HANDOFF_HEADER]: handoff,
        }),
      ),
      auth.handler(
        authRequest(
          "/api/auth/sign-in/social",
          { provider: "github", callbackURL: "http://localhost/courses" },
          { cookie, [SSO_LINK_HANDOFF_HEADER]: handoff },
        ),
      ),
    ]);
    for (const response of rejected) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_sso_link_handoff",
      });
    }
  });

  it("rejects handoffs signed for another audience or flow", async () => {
    const now = Date.now();
    const userId = "legacy-handoff-member";
    await seedMember({ id: userId, githubAccountId: "4242211", now });
    await seedOidcProvider("legacy-handoff-provider");
    const cookie = await seedSessionCookie({
      id: "legacy-handoff-session",
      token: "legacy-handoff-token",
      userId,
      now,
    });
    const expiresAt = now + 300_000;
    const handoffs = [
      // The retired beta handoff carried the same flow under another audience.
      await signHandoff("intar.beta-auth-handoff.v1", {
        kind: "sso-link",
        userId,
        providerId: "legacy-handoff-provider",
        sourceInviteId: "legacy-invite",
        sourceLeaseId: "legacy-lease",
        grantedAt: now - 1_000,
        aud: "intar.beta-auth-handoff.v1",
        expiresAt,
        version: 1,
      }),
      await signHandoff("intar.sso-link-handoff.v1", {
        kind: "github-invite",
        inviteId: "legacy-invite",
        attemptId: "legacy-attempt",
        userId,
        providerId: "legacy-handoff-provider",
        aud: "intar.sso-link-handoff.v1",
        expiresAt,
        version: 1,
      }),
    ];

    for (const handoff of handoffs) {
      const response = await auth.handler(
        authRequest(
          "/api/auth/sign-in/sso",
          {
            providerId: "legacy-handoff-provider",
            providerType: "oidc",
            callbackURL: "http://localhost/organizations/example",
          },
          { cookie, [SSO_LINK_HANDOFF_HEADER]: handoff },
        ),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_sso_link_handoff",
      });
    }
  });

  it("rejects an SSO-link handoff once the account is revoked", async () => {
    const now = Date.now();
    const userId = "revoked-sso-link-user";
    await seedMember({ id: userId, githubAccountId: "4242221", now });
    await seedOidcProvider("revoked-sso-provider");
    const handoff = await createSsoLinkOAuthHandoff({
      userId,
      providerId: "revoked-sso-provider",
      expiresAt: now + 600_000,
    });
    const cookie = await seedSessionCookie({
      id: "revoked-sso-session-row",
      token: "revoked-sso-session-token",
      userId,
      now,
    });
    await banMember(userId);

    const response = await auth.handler(
      authRequest(
        "/api/auth/sign-in/sso",
        {
          providerId: "revoked-sso-provider",
          providerType: "oidc",
          callbackURL: "http://localhost/organizations/example",
        },
        { cookie, [SSO_LINK_HANDOFF_HEADER]: handoff },
      ),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_sso_link_handoff",
    });
  });

  it("refuses to mint an already-expired OAuth handoff", async () => {
    await expect(
      createSsoLinkOAuthHandoff({
        userId: "handoff-user",
        providerId: "handoff-provider",
        expiresAt: Date.now() - 1,
      }),
    ).rejects.toThrow("handoff expiry is outside the allowed window");
  });

  it("dynamically rejects a revoked user's OAuth credentials after authenticating the request", async () => {
    const now = Date.now();
    const userId = "revoked-oauth-user";
    await seedMember({ id: userId, githubAccountId: "4242231", now });

    const clientId = "oauth-test-client";
    const clientSecret = `${clientId}-secret`;
    const accessToken = "revoked-user-access-token";
    const refreshToken = "revoked-user-refresh-token";
    await seedOAuthClient(clientId, now, ["openid", "profile", "offline_access"]);
    await drizzle(env.DB).insert(oauthRefreshToken).values({
      id: "revoked-refresh-row",
      token: await hashOAuthToken(refreshToken),
      clientId,
      userId,
      scopes: ["openid", "profile", "offline_access"],
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });
    await drizzle(env.DB).insert(oauthAccessToken).values({
      id: "revoked-access-row",
      token: await hashOAuthToken(accessToken),
      clientId,
      userId,
      scopes: ["openid", "profile"],
      createdAt: new Date(now),
      expiresAt: new Date(now + 3_600_000),
    });
    await banMember(userId);

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
      code: "access_revoked",
    });
    const storedRefresh = await env.DB.prepare(
      "SELECT revoked, rotated_at FROM oauth_refresh_token WHERE id = ?",
    )
      .bind("revoked-refresh-row")
      .first<{ revoked: number | null; rotated_at: number | null }>();
    expect(storedRefresh).toEqual({ revoked: null, rotated_at: null });
  });

  it("removes exactly the OAuth tokens issued while the account was revoked", async () => {
    const now = Date.now();
    const userId = "oauth-issuance-race-user";
    await seedMember({ id: userId, githubAccountId: "4242241", now });
    const clientId = "oauth-issuance-race-client";
    await seedOAuthClient(clientId, now);
    const issuedAccessToken = "issued-race-access-token";
    const issuedRefreshToken = "issued-race-refresh-token";
    const otherAccessToken = "other-race-access-token";
    const otherRefreshToken = "other-race-refresh-token";
    await Promise.all([
      drizzle(env.DB).insert(oauthAccessToken).values({
        id: "issued-race-access-row",
        token: await hashOAuthToken(issuedAccessToken),
        clientId,
        userId,
        scopes: ["openid"],
        createdAt: new Date(now),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthRefreshToken).values({
        id: "issued-race-refresh-row",
        token: await hashOAuthToken(issuedRefreshToken),
        clientId,
        userId,
        scopes: ["openid", "offline_access"],
        createdAt: new Date(now),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthAccessToken).values({
        id: "other-race-access-row",
        token: await hashOAuthToken(otherAccessToken),
        clientId,
        userId,
        scopes: ["openid"],
        createdAt: new Date(now),
        expiresAt: new Date(now + 3_600_000),
      }),
      drizzle(env.DB).insert(oauthRefreshToken).values({
        id: "other-race-refresh-row",
        token: await hashOAuthToken(otherRefreshToken),
        clientId,
        userId,
        scopes: ["openid", "offline_access"],
        createdAt: new Date(now),
        expiresAt: new Date(now + 3_600_000),
      }),
    ]);
    const returned = {
      access_token: issuedAccessToken,
      refresh_token: issuedRefreshToken,
    };

    // An account that is still active held access for the whole issuance.
    await expect(
      enforceActiveOAuthIssuance({ userId, returned }),
    ).resolves.toBeUndefined();
    await expect(countOAuthTokens(userId)).resolves.toBe(4);

    await banMember(userId);
    await expect(
      enforceActiveOAuthIssuance({ userId, returned }),
    ).rejects.toMatchObject({ body: { code: "access_revoked" } });
    const remaining = await env.DB.prepare(
      `SELECT id FROM oauth_access_token WHERE user_id = ?
       UNION ALL
       SELECT id FROM oauth_refresh_token WHERE user_id = ?
       ORDER BY id`,
    )
      .bind(userId, userId)
      .all<{ id: string }>();
    expect(remaining.results.map(({ id }) => id)).toEqual([
      "other-race-access-row",
      "other-race-refresh-row",
    ]);

    // A JWT access token has no opaque row to remove. The same final check
    // still suppresses the entire credential response before it reaches the
    // caller.
    await expect(
      enforceActiveOAuthIssuance({
        userId,
        returned: { access_token: "header.payload.signature" },
      }),
    ).rejects.toMatchObject({ body: { code: "access_revoked" } });
  });

  it("rejects resource audiences so OAuth access tokens remain opaque and revocable", async () => {
    const now = Date.now();
    const userId = "oauth-resource-user";
    await seedMember({ id: userId, githubAccountId: "4242251", now });
    const oauthUser = await env.DB.prepare("SELECT * FROM user WHERE id = ?")
      .bind(userId)
      .first<User>();

    await expect(
      getOAuthAccessTokenClaims({
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
      getOAuthAccessTokenClaims({
        scopes: ["openid"],
        user: oauthUser!,
      }),
    ).resolves.toEqual({});
  });

  it("accepts a refresh token from the retired dotted format and rotates it to a plain one", async () => {
    const now = Date.now();
    const userId = "oauth-legacy-refresh-user";
    await seedMember({ id: userId, githubAccountId: "4242261", now });
    const clientId = "oauth-legacy-refresh-client";
    const clientSecret = `${clientId}-secret`;
    await seedOAuthClient(clientId, now);
    // The retired admission envelope: signed JSON and signature, dot-joined.
    // The provider stores and looks up the hash of the full presented string.
    const presentedToken = await signHandoff("intar.beta-refresh-token.v1", {
      admission: {
        userId,
        sourceInviteId: "legacy-invite",
        sourceLeaseId: "legacy-lease",
        grantedAt: now - 1_000,
      },
      aud: "intar.beta-refresh-token.v1",
      token: "legacy-inner-refresh-token",
      version: 1,
    });
    expect(presentedToken.split(".")).toHaveLength(2);
    await drizzle(env.DB).insert(oauthRefreshToken).values({
      id: "oauth-legacy-refresh-row",
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
    expect(body.refresh_token).toMatch(/^[A-Za-z]{32}$/u);
    const legacyRow = await env.DB.prepare(
      "SELECT revoked FROM oauth_refresh_token WHERE id = ?",
    )
      .bind("oauth-legacy-refresh-row")
      .first<{ revoked: number | null }>();
    expect(legacyRow?.revoked).not.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM oauth_refresh_token WHERE token = ?",
      )
        .bind(await hashOAuthToken(body.refresh_token))
        .first(),
    ).resolves.toEqual({ userId });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM jwks").first<{
        count: number;
      }>(),
    ).resolves.toEqual({ count: 1 });
  });
});

type StartedGithubFlow = {
  cookie: string;
  state: string;
};

type GithubProfile = {
  email: string;
  githubAccountId: string;
  githubLogin: string;
};

async function seedMember(input: {
  id: string;
  githubAccountId: string;
  role?: string;
  now: number;
}): Promise<void> {
  await drizzle(env.DB).insert(user).values({
    id: input.id,
    name: input.id,
    email: `${input.id}@example.test`,
    emailVerified: true,
    username: input.id,
    displayUsername: input.id,
    role: input.role,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  await drizzle(env.DB).insert(account).values({
    id: `${input.id}-github-link`,
    providerId: "github",
    accountId: input.githubAccountId,
    userId: input.id,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
}

async function banMember(userId: string): Promise<void> {
  await revokeFixtureAccount({ d1: env.DB, userId });
}

async function setTestSignupLimit(limit: number): Promise<void> {
  const { version } = await getSignupStatus(env.DB);
  await setSignupLimit({
    d1: env.DB,
    actorUserId: FIXTURE_ADMIN_ID,
    limit,
    expectedVersion: version,
  });
}

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

async function seedOidcProvider(providerId: string): Promise<void> {
  await drizzle(env.DB).insert(ssoProvider).values({
    id: `${providerId}-row`,
    issuer: "https://sso.example.test",
    domain: "example.test",
    oidcConfig: JSON.stringify({
      issuer: "https://sso.example.test",
      clientId: `${providerId}-client`,
      authorizationEndpoint: "https://sso.example.test/oauth/authorize",
      tokenEndpoint: "https://sso.example.test/oauth/token",
      tokenEndpointAuthentication: "none",
      jwksEndpoint: "https://sso.example.test/.well-known/jwks.json",
      pkce: true,
    }),
    oidcClientSecretCiphertext: null,
    userId: FIXTURE_ADMIN_ID,
    providerId,
    domainVerified: true,
  });
}

async function seedSessionCookie(input: {
  id: string;
  token: string;
  userId: string;
  now: number;
}): Promise<string> {
  await drizzle(env.DB).insert(session).values({
    id: input.id,
    token: input.token,
    userId: input.userId,
    expiresAt: new Date(input.now + 7 * 24 * 60 * 60_000),
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  return signedSessionCookie(input.token);
}

async function beginGithubFlow(): Promise<StartedGithubFlow> {
  const response = await auth.handler(
    authRequest("/api/auth/sign-in/social", {
      provider: "github",
      callbackURL: "http://localhost/courses",
      errorCallbackURL: "http://localhost/",
    }),
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

function githubCallbackRequest(flow: StartedGithubFlow, code: string): Request {
  return new Request(
    `http://localhost/api/auth/callback/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`,
    { headers: { cookie: flow.cookie } },
  );
}

/**
 * Serves GitHub's token and profile endpoints for each authorization code, so
 * concurrent callbacks each receive their own identity.
 */
function mockGithubProfiles(profiles: Record<string, GithubProfile>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      if (request.url === "https://github.com/login/oauth/access_token") {
        const code = new URLSearchParams(
          new TextDecoder().decode(await request.arrayBuffer()),
        ).get("code");
        if (!code || !profiles[code]) {
          throw new Error(`unexpected GitHub authorization code: ${code}`);
        }
        return Response.json({
          access_token: `token-${code}`,
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      }
      const code = request.headers
        .get("authorization")
        ?.replace(/^Bearer token-/u, "");
      const profile = code ? profiles[code] : undefined;
      if (profile && request.url === "https://api.github.com/user") {
        return Response.json({
          id: Number(profile.githubAccountId),
          login: profile.githubLogin,
          name: profile.githubLogin,
          email: profile.email,
          avatar_url: null,
        });
      }
      if (profile && request.url === "https://api.github.com/user/emails") {
        return Response.json([
          {
            email: profile.email,
            primary: true,
            verified: true,
            visibility: null,
          },
        ]);
      }
      throw new Error(`unexpected fetch in GitHub callback test: ${request.url}`);
    },
  );
}

async function completeGithubCallback(
  input: StartedGithubFlow & GithubProfile,
): Promise<Response> {
  const code = `code-${input.githubAccountId}`;
  const fetchSpy = mockGithubProfiles({ [code]: input });
  try {
    return await auth.handler(githubCallbackRequest(input, code));
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

async function expectGithubAccountAbsent(githubAccountId: string): Promise<void> {
  await expect(
    env.DB.prepare(
      `SELECT id FROM account
       WHERE provider_id = 'github' AND account_id = ? LIMIT 1`,
    )
      .bind(githubAccountId)
      .first(),
  ).resolves.toBeNull();
}

async function expectGithubLinkAndSessionAbsent(
  userId: string,
  githubAccountId: string,
): Promise<void> {
  await expectGithubAccountAbsent(githubAccountId);
  await expect(
    env.DB.prepare("SELECT id FROM session WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first(),
  ).resolves.toBeNull();
}

function requestUrl(request: RequestInfo | URL): string {
  return typeof request === "string"
    ? request
    : request instanceof URL
      ? request.href
      : request.url;
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

function inspectionRequest(
  cookie: string | null,
  handoffHeader?: string,
): Request {
  const headers = new Headers({ origin: "http://localhost" });
  if (cookie) headers.set("cookie", cookie);
  if (handoffHeader !== undefined) {
    headers.set(SSO_LINK_HANDOFF_HEADER, handoffHeader);
  }
  return new Request("http://localhost/api/auth/get-session", { headers });
}

/**
 * Records the SQL text of every prepared statement while `run` executes. The
 * wrapper shadows the binding's prototype method, so it observes the queries
 * that the app code and its ORM issue through the same binding.
 */
async function capturePreparedSql(run: () => Promise<void>): Promise<string[]> {
  const binding = env.DB as D1Database;
  const prepare = binding.prepare.bind(binding);
  const statements: string[] = [];
  (binding as { prepare: D1Database["prepare"] }).prepare = ((query: string) => {
    statements.push(query);
    return prepare(query);
  }) as D1Database["prepare"];
  try {
    await run();
  } finally {
    delete (binding as { prepare?: D1Database["prepare"] }).prepare;
  }
  return statements;
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

/** Signs `payload` the way the app signs its handoffs, for any audience. */
async function signHandoff(audience: string, payload: object): Promise<string> {
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
    new TextEncoder().encode(`${audience}.${encoded}`),
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
  return bytesToBase64Url(new Uint8Array(digest));
}

async function countOAuthTokens(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM oauth_access_token WHERE user_id = ?1)
          + (SELECT count(*) FROM oauth_refresh_token WHERE user_id = ?1) AS count`,
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function seedOAuthClient(
  clientId: string,
  now: number,
  scopes = ["openid", "offline_access"],
): Promise<void> {
  await drizzle(env.DB).insert(oauthClient).values({
    id: `${clientId}-row`,
    clientId,
    clientSecret: await hashOAuthToken(`${clientId}-secret`),
    redirectUris: ["http://localhost/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes,
    requirePKCE: false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
}
