/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import type { Session, User } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { accessInviteCodes } from "@/db/schema/application";
import { account, session, ssoProvider, user } from "@/db/schema/core";
import {
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
} from "@/db/schema/oauth";
import {
  acquireBetaRevocationCleanup,
  allowBetaReinvite,
  completeBetaRevocationCleanup,
  confirmAccessInvite,
  createAccessInvite,
  leaseAccessInvite,
  revokeAccessInvite,
  revokeBetaUser,
} from "@/lib/access-invites";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureBetaAdmin,
  FIXTURE_BETA_ADMIN_ID,
} from "@/test/beta-access-fixtures";
import {
  auth,
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
} from "./auth";

describe("auth policy", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureBetaAdmin(env.DB, Date.now());
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

  it("accepts only a signed server handoff for the leased GitHub flow", async () => {
    const now = Date.now();
    const fixtureAdmin = await ensureFixtureBetaAdmin(env.DB, now - 120_000);
    const leasedAt = now - 1_000;
    const leaseExpiresAt = leasedAt + 600_000;
    await drizzle(env.DB).insert(accessInviteCodes).values({
      id: "invite-auth-test",
      codeHash: "a".repeat(64),
      codePrefix: "auth-test",
      kind: "standard",
      state: "leased",
      createdBy: fixtureAdmin,
      createdAt: now - 60_000,
      expiresAt: now - 60_000 + 172_800_000,
      leaseId: "lease-auth-test",
      leasedAt,
      leaseExpiresAt,
      updatedAt: now,
    });

    const handoff = await createInviteOAuthHandoff({
      inviteId: "invite-auth-test",
      leaseId: "lease-auth-test",
      leaseExpiresAt,
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
              leaseId: "lease-auth-test",
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
              leaseId: "attacker-controlled",
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

  it("confines a pre-access session to inspection, sign-out, and the join recovery seam", async () => {
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
    await drizzle(env.DB).insert(accessInviteCodes).values({
      id: "blocked-oauth-invite",
      codeHash: "c".repeat(64),
      codePrefix: "oauth-test",
      kind: "standard",
      state: "leased",
      createdBy: fixtureAdmin,
      createdAt: now,
      expiresAt: now + 172_800_000,
      leaseId: "blocked-oauth-lease",
      leasedAt: now,
      leaseExpiresAt: now + 600_000,
      updatedAt: now,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: "blocked-oauth-invite",
      leaseId: "blocked-oauth-lease",
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

  it("deletes a GitHub link inserted after its exact invite lease is revoked", async () => {
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
    const invite = await createAccessInvite({
      d1: env.DB,
      kind: "standard",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      label: "github-link-race",
      now,
    });
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: now + 1,
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
    await revokeAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      expectedVersion: lease.version,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "github_link_race",
      now: now + 3,
    });

    await expect(
      enforceCreatedGithubAccountAdmission({
        account: linkedAccount,
        expected: {
          kind: "github-invite",
          inviteId: invite.id,
          leaseId: lease.leaseId,
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
        leaseId: "lease-expired",
        leaseExpiresAt: Date.now() - 1,
      }),
    ).rejects.toThrow("handoff expiry is outside the allowed window");
  });
});

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
  const invite = await createAccessInvite({
    d1: env.DB,
    kind: "standard",
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    label: `auth-test-${input.id}`,
    now: input.now + 1,
  });
  const lease = await leaseAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    now: input.now + 2,
  });
  await confirmAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    leaseId: lease.leaseId,
    userId: input.id,
    githubAccountId: input.accountId,
    githubUsername: input.username,
    now: input.now + 3,
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
  await allowBetaReinvite({
    d1: env.DB,
    userId,
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    revocationId: revoked.revocationId,
    now: now + 2,
  });
  const invite = await createAccessInvite({
    d1: env.DB,
    kind: "standard",
    actorUserId: FIXTURE_BETA_ADMIN_ID,
    label: `readmit-${userId}`,
    now: now + 3,
  });
  const lease = await leaseAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    now: now + 4,
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
  await confirmAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    leaseId: lease.leaseId,
    userId,
    githubAccountId: github!.account_id,
    githubUsername: identity!.username,
    now: now + 5,
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
