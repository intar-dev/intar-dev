/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  account,
  member,
  organization,
  session,
  ssoProvider,
  user,
} from "@/db/schema/core";
import {
  ensureFixtureAdmin,
  ensureFixtureGithubAccount,
  FIXTURE_ADMIN_ID,
} from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

import {
  deleteOrganizationOidc,
  getOrganizationOidc,
  registerOrganizationOidc,
  setOrganizationOidcPolicy,
} from "./organization-oidc";

const ACTOR_ID = "oidc-organization-admin";
const ORGANIZATION_ID = "oidc-organization";

describe("organization OIDC public client registration", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetD1Database();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(discovery()));
    const db = drizzle(env.DB);
    const now = new Date();
    await db.insert(user).values({
      id: ACTOR_ID,
      name: "OIDC organization admin",
      email: "oidc-organization-admin@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organization).values({
      id: ORGANIZATION_ID,
      name: "OIDC organization",
      slug: "oidc-organization",
      createdAt: now,
    });
    // The organization admin who manages its provider, and signs in with
    // GitHub.
    await ensureFixtureGithubAccount({ d1: env.DB, userId: ACTOR_ID });
    await db.insert(member).values({
      id: "actor-membership",
      organizationId: ORGANIZATION_ID,
      userId: ACTOR_ID,
      role: "admin",
      createdAt: now,
    });
    await ensureFixtureAdmin(env.DB);
  });

  it("registers only a public client with PKCE and no secret material", async () => {
    const result = await registerOrganizationOidc(registration());
    const [row] = await drizzle(env.DB).select().from(ssoProvider);
    expect(row?.oidcClientSecretCiphertext).toBeNull();
    expect(JSON.parse(row?.oidcConfig ?? "{}")).toMatchObject({
      tokenEndpointAuthentication: "none",
      pkce: true,
      clientId: "client-id",
    });
    expect(JSON.parse(row?.oidcConfig ?? "{}")).not.toHaveProperty(
      "clientSecret",
    );
    expect(result.pkce).toBe(true);
  });

  it.each([
    { code_challenge_methods_supported: undefined },
    { code_challenge_methods_supported: ["plain"] },
    { code_challenge_methods_supported: "S256" },
    { response_types_supported: ["token", "id_token", "code id_token"] },
  ])("rejects unsupported authorization flow %j", async (metadata) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...discovery(), ...metadata }),
    );
    await expect(
      registerOrganizationOidc(registration()),
    ).rejects.toMatchObject({
      code: "unsupported_oidc_authorization_flow",
    });
    expect(await drizzle(env.DB).select().from(ssoProvider)).toEqual([]);
  });

  it.each([
    undefined,
    ["client_secret_basic"],
    ["client_secret_post"],
    ["private_key_jwt"],
    "none",
  ])(
    "rejects token authentication without explicit public client support: %j",
    async (methods) => {
      vi.mocked(fetch).mockResolvedValue(
        Response.json({
          ...discovery(),
          token_endpoint_auth_methods_supported: methods,
        }),
      );
      await expect(
        registerOrganizationOidc(registration()),
      ).rejects.toMatchObject({
        code: "unsupported_oidc_token_authentication",
      });
      expect(await drizzle(env.DB).select().from(ssoProvider)).toEqual([]);
    },
  );

  it("stores the issuer exactly as discovery advertises it", async () => {
    // Auth0-style issuers end with a slash; ID tokens carry that exact value.
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...discovery(), issuer: "https://login.example.test/" }),
    );
    const result = await registerOrganizationOidc(registration());
    const [row] = await drizzle(env.DB).select().from(ssoProvider);
    expect(row?.issuer).toBe("https://login.example.test/");
    expect(result.issuer).toBe("https://login.example.test/");
    expect(result.scopes).toEqual(["openid", "email", "profile"]);
    expect(result.allowExternalEmailSignups).toBe(false);
  });

  it("records a platform admin's approval for other email domains", async () => {
    await registerOrganizationOidc(registration());
    const approved = await setOrganizationOidcPolicy({
      organizationId: ORGANIZATION_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      allowExternalEmailSignups: true,
      baseUrl: "https://intar.dev",
    });
    expect(approved.allowExternalEmailSignups).toBe(true);
    await expect(
      env.DB.prepare(
        "SELECT event_type AS eventType, reason FROM access_events WHERE event_type = 'sso.external_email_signups_changed'",
      ).first(),
    ).resolves.toEqual({
      eventType: "sso.external_email_signups_changed",
      reason: `${approved.providerId}:on`,
    });
    await expect(
      setOrganizationOidcPolicy({
        organizationId: ORGANIZATION_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        allowExternalEmailSignups: "yes",
        baseUrl: "https://intar.dev",
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_sso_policy" });
    await expect(
      getOrganizationOidc({ organizationId: ORGANIZATION_ID, baseUrl: "https://intar.dev" }),
    ).resolves.toMatchObject({ allowExternalEmailSignups: true });
  });

  it("audits only policy changes", async () => {
    await registerOrganizationOidc(registration());
    const save = (allowExternalEmailSignups: boolean) =>
      setOrganizationOidcPolicy({
        organizationId: ORGANIZATION_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        allowExternalEmailSignups,
        baseUrl: "https://intar.dev",
      });
    // Off is the default, then a double-submitted approval, then off again.
    for (const allow of [false, true, true, false]) await save(allow);
    await expect(
      env.DB.prepare(
        "SELECT reason FROM access_events WHERE event_type = 'sso.external_email_signups_changed' ORDER BY created_at, rowid",
      ).all<{ reason: string }>(),
    ).resolves.toMatchObject({
      results: [{ reason: expect.stringMatching(/:on$/u) }, { reason: expect.stringMatching(/:off$/u) }],
    });
  });

  it("records a policy change only for someone who is still a platform admin", async () => {
    await registerOrganizationOidc(registration());
    // An organization admin, or an admin demoted since the route's check.
    await expect(
      setOrganizationOidcPolicy({
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
        allowExternalEmailSignups: true,
        baseUrl: "https://intar.dev",
      }),
    ).rejects.toMatchObject({ status: 403, code: "admin_required" });
    await expect(
      getOrganizationOidc({ organizationId: ORGANIZATION_ID, baseUrl: "https://intar.dev" }),
    ).resolves.toMatchObject({ allowExternalEmailSignups: false });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM access_events WHERE event_type = 'sso.external_email_signups_changed'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("keeps a provider that members sign in with only, then signs out everyone with an identity at it", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const db = drizzle(env.DB);
    const now = new Date();
    for (const id of ["only-oidc-member", "left-member", "github-too"]) {
      await seedIdentityUser({ id, providerId, now });
    }
    // A session doesn't record which identity opened it, so the provider may
    // have opened this one although GitHub signs them in too.
    await db.insert(account).values([
      {
        id: "github-too-github",
        providerId: "github",
        accountId: "github-too-github-subject",
        userId: "github-too",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "remover-identity",
        providerId,
        accountId: "remover-subject",
        userId: ACTOR_ID,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // The remover stays signed in where they removed it, and only there.
    await db.insert(session).values(
      ["remover-session", "remover-elsewhere"].map((id) => ({
        id,
        token: `${id}-token`,
        userId: ACTOR_ID,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(member).values({
      id: "only-oidc-membership",
      organizationId: ORGANIZATION_ID,
      userId: "only-oidc-member",
      role: "member",
      createdAt: now,
    });

    await expect(
      deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID }),
    ).rejects.toMatchObject({ status: 409, code: "organization_oidc_in_use" });

    await db.delete(member).where(eq(member.id, "only-oidc-membership"));
    await deleteOrganizationOidc({
      organizationId: ORGANIZATION_ID,
      actorUserId: ACTOR_ID,
      currentSessionId: "remover-session",
    });
    expect(await db.select().from(ssoProvider)).toEqual([]);
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM account WHERE provider_id = ?")
        .bind(providerId)
        .first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare("SELECT id FROM session ORDER BY id").all(),
    ).resolves.toMatchObject({ results: [{ id: "remover-session" }] });
  });

  it("counts a member whose other identity can't sign them in as depending on it", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const db = drizzle(env.DB);
    const now = new Date();
    // Their other identity is at an organization that removed them.
    await db.insert(organization).values({
      id: "other-organization",
      name: "Other",
      slug: "other-organization",
      createdAt: now,
    });
    await db.insert(ssoProvider).values({
      id: "other-provider-row",
      issuer: "https://other.example.test",
      domain: "other.example.test",
      oidcConfig: "{}",
      userId: ACTOR_ID,
      providerId: "other-provider",
      organizationId: "other-organization",
      domainVerified: true,
    });
    await seedIdentityUser({ id: "removed-elsewhere", providerId, now });
    await db.insert(account).values({
      id: "removed-elsewhere-other",
      providerId: "other-provider",
      accountId: "removed-elsewhere-other-subject",
      userId: "removed-elsewhere",
      createdAt: now,
      updatedAt: now,
    });
    await env.DB.prepare(
      `INSERT INTO organization_member_removals (organization_id, user_id, removed_by, removed_at)
       VALUES ('other-organization', 'removed-elsewhere', ?1, 1)`,
    )
      .bind(ACTOR_ID)
      .run();
    await db.insert(member).values({
      id: "removed-elsewhere-membership",
      organizationId: ORGANIZATION_ID,
      userId: "removed-elsewhere",
      role: "member",
      createdAt: now,
    });

    await expect(
      deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID }),
    ).rejects.toMatchObject({ status: 409, code: "organization_oidc_in_use" });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM account WHERE provider_id = ?")
        .bind(providerId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("changes nothing when someone joins through the provider mid-removal", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const now = new Date();
    await seedIdentityUser({ id: "joining", providerId, now });
    const batch = env.DB.batch.bind(env.DB);
    // Their sign-in lands between the members check and the deletion.
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      await drizzle(env.DB).insert(member).values({
        id: "late-membership",
        organizationId: ORGANIZATION_ID,
        userId: "joining",
        role: "member",
        createdAt: now,
      });
      vi.mocked(env.DB.batch).mockRestore();
      return batch(statements);
    });

    await expect(
      deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID }),
    ).rejects.toMatchObject({ status: 409, code: "organization_oidc_in_use" });
    expect(await drizzle(env.DB).select().from(ssoProvider)).toHaveLength(1);
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM account WHERE provider_id = ?")
        .bind(providerId)
        .first(),
    ).resolves.toEqual({ count: 1 });
    // Nobody was signed out either.
    await expect(
      env.DB.prepare("SELECT expires_at AS expiresAt FROM session WHERE id = 'joining-session'")
        .first<{ expiresAt: number }>()
        .then((row) => row?.expiresAt),
    ).resolves.toBe(now.getTime() + 60_000);
  });

  it("never counts a platform admin as depending on the provider", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const now = new Date();
    await seedIdentityUser({ id: "platform-admin", providerId, now });
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'platform-admin'").run();
    // Platform admins sign in with GitHub only, even through an organization
    // that made them an admin, so removing its provider takes nothing away
    // and none of their sessions can be one it opened.
    await drizzle(env.DB).insert(member).values({
      id: "platform-admin-membership",
      organizationId: ORGANIZATION_ID,
      userId: "platform-admin",
      role: "admin",
      createdAt: now,
    });
    await deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID });
    expect(await drizzle(env.DB).select().from(ssoProvider)).toEqual([]);
    expect(
      await drizzle(env.DB).select({ id: session.id }).from(session)
        .where(eq(session.userId, "platform-admin")),
    ).toEqual([{ id: "platform-admin-session" }]);
  });

  it("tells an owner who signs in only through the provider how to keep a way in", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const now = new Date();
    await seedIdentityUser({ id: "sole-owner", providerId, now });
    await drizzle(env.DB).insert(member).values({
      id: "sole-owner-membership",
      organizationId: ORGANIZATION_ID,
      userId: "sole-owner",
      role: "owner",
      createdAt: now,
    });

    await expect(
      deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID }),
    ).rejects.toMatchObject({
      status: 409,
      code: "organization_oidc_in_use",
      message:
        "The owner signs in only through this identity provider. They need to connect GitHub from Profile before you can remove it.",
    });
  });

  it("removes nothing for a remover demoted mid-removal", async () => {
    const { providerId } = await registerOrganizationOidc(registration());
    const now = new Date();
    await seedIdentityUser({ id: "bystander", providerId, now });
    const batch = env.DB.batch.bind(env.DB);
    // The owner demotes the remover between the route's check and the batch.
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      await drizzle(env.DB)
        .update(member)
        .set({ role: "member" })
        .where(eq(member.id, "actor-membership"));
      vi.mocked(env.DB.batch).mockRestore();
      return batch(statements);
    });

    await expect(
      deleteOrganizationOidc({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID }),
    ).rejects.toMatchObject({ status: 403, code: "organization_admin_required" });
    expect(await drizzle(env.DB).select().from(ssoProvider)).toHaveLength(1);
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM session WHERE id = 'bystander-session'").first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("uses one fixed public discovery failure and one structured log event", async () => {
    const upstreamDetail = "https://private.idp.example.test returned 503";
    vi.mocked(fetch).mockRejectedValue(new Error(upstreamDetail));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failure = await registerOrganizationOidc(registration()).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      status: 400,
      code: "oidc_discovery_failed",
      message: "OIDC discovery failed",
    });
    expect(String(failure)).not.toContain(upstreamDetail);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({ event: "oidc_discovery_failed" }),
    );
  });
});

/** A user whose only identity is at `providerId`, with a live session. */
async function seedIdentityUser(input: {
  id: string;
  providerId: string;
  now: Date;
}): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: input.id,
    name: input.id,
    email: `${input.id}@example.test`,
    emailVerified: true,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(account).values({
    id: `${input.id}-identity`,
    providerId: input.providerId,
    accountId: `${input.id}-subject`,
    userId: input.id,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(session).values({
    id: `${input.id}-session`,
    token: `${input.id}-token`,
    userId: input.id,
    expiresAt: new Date(input.now.getTime() + 60_000),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function registration() {
  return {
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    issuer: "https://login.example.test",
    domain: "example.test",
    clientId: "client-id",
    baseUrl: "https://intar.dev",
  };
}

function discovery() {
  return {
    issuer: "https://login.example.test",
    authorization_endpoint: "https://login.example.test/oauth/authorize",
    token_endpoint: "https://login.example.test/oauth/token",
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    response_types_supported: ["code"],
    jwks_uri: "https://login.example.test/.well-known/jwks.json",
    userinfo_endpoint: "https://login.example.test/oauth/userinfo",
  };
}
