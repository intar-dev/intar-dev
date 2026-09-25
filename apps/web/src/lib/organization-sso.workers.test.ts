/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { account, organization, ssoProvider, user } from "@/db/schema/core";
import { getSignupStatus } from "@/lib/signups";
import {
  createFixtureMember,
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
} from "@/test/account-fixtures";
import {
  authRequest,
  mockGithubProfiles,
  requestUrl,
  seedSessionCookie,
  setTestSignupLimit,
} from "@/test/auth-requests";
import { interleaveBefore } from "@/test/d1-interleave";
import { resetD1Database } from "@/test/d1-migrations";
import { auth } from "./auth";
import { encodeBase64Url } from "./base64url";
import {
  createSsoIntent,
  deleteUnclaimedSsoUser,
  emailOnDomain,
  SSO_INTENT_CONTEXT_KEY,
  SSO_INTENT_HEADER,
  ssoIntentFromState,
} from "./organization-sso";
import { startOrganizationSso } from "./organization-sso-start";
import {
  removeOrganizationMember,
  restoreOrganizationMember,
} from "./organizations";

const PROVIDER_ID = "org-sso-provider";
const ORGANIZATION_ID = "org-sso-organization";
const ORGANIZATION_URL = "http://localhost/organizations/org-sso";
const ERROR_URL = `${ORGANIZATION_URL}/sign-in`;

type Claims = Record<string, unknown>;
interface StartedFlow {
  providerId: string;
  state: string;
  stateCookie: string;
}

let signingKey: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

beforeAll(async () => {
  signingKey = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = {
    ...(await crypto.subtle.exportKey("jwk", signingKey.publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  } as JsonWebKey & { kid: string };
});

beforeEach(async () => {
  await resetD1Database();
  await ensureFixtureAdmin(env.DB, Date.now());
  await seedOrganizationProvider({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
  });
  await setTestSignupLimit(10);
});

describe("organization sign-up", () => {
  it("creates an account and membership for a new on-domain identity", async () => {
    const before = await getSignupStatus(env.DB);
    const callback = await signIn({
      sub: "new-subject",
      email: "new.person@example.test",
      name: "New Person",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    expect(callback.headers.get("set-cookie")).toContain("session_token");
    const created = await accountOwner("new-subject");
    expect(created).not.toBeNull();
    await expect(
      env.DB.prepare("SELECT name, email FROM user WHERE id = ?")
        .bind(created)
        .first(),
    ).resolves.toEqual({ name: "New Person", email: "new.person@example.test" });
    await expect(memberRole(created!)).resolves.toBe("member");
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: before.taken + 1,
    });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM signup_reservations").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("marks the new account's email verified, so it can be reclaimed later", async () => {
    await signIn({ sub: "verified-new", email: "verified.new@example.test" });
    await expect(
      env.DB.prepare("SELECT email_verified AS verified FROM user WHERE id = ?")
        .bind(await accountOwner("verified-new"))
        .first(),
    ).resolves.toEqual({ verified: 1 });
  });

  it("reclaims an account nobody can sign in to", async () => {
    // Left by a sign-up that stopped between its user and account inserts.
    const now = new Date();
    await drizzle(env.DB).insert(user).values({
      id: "stranded",
      name: "Stranded",
      email: "stranded@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    const callback = await signIn({
      sub: "stranded-at-idp",
      email: "stranded@example.test",
    });

    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("stranded-at-idp")).resolves.toBe("stranded");
    await expect(memberRole("stranded")).resolves.toBe("member");
    await expect(countUsers()).resolves.toBe(2);
  });

  it("signs the same identity in again without another account", async () => {
    await signIn({ sub: "returning", email: "returning@example.test" });
    const first = await accountOwner("returning");
    const callback = await signIn({
      sub: "returning",
      email: "returning@example.test",
    });
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("returning")).resolves.toBe(first);
    await expect(countUsers()).resolves.toBe(2);
  });

  it("names a new user from the email when the provider sends no name", async () => {
    await signIn({ sub: "nameless", email: "nameless@example.test" });
    await expect(
      env.DB.prepare("SELECT name FROM user WHERE id = ?")
        .bind(await accountOwner("nameless"))
        .first(),
    ).resolves.toEqual({ name: "nameless" });
  });

  it("admits other email domains only with approval and a verified email", async () => {
    const offDomain = {
      sub: "community-member",
      email: "community@personal.test",
      email_verified: true,
    };
    expectError(await signIn(offDomain), "sso_email_domain_not_allowed");
    await expect(countUsers()).resolves.toBe(1);

    await approveExternalEmails(PROVIDER_ID);
    expectError(
      await signIn({ ...offDomain, email_verified: false }),
      "sso_email_unverified",
    );
    await expect(countUsers()).resolves.toBe(1);

    const callback = await signIn(offDomain);
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    const created = await accountOwner("community-member");
    expect(created).not.toBeNull();
    // Intar vouches only for addresses on the verified domain, so only this
    // organization may ever reclaim the account.
    await expect(
      env.DB.prepare(
        "SELECT email_verified AS verified, signup_organization_id AS organizationId FROM user WHERE id = ?",
      )
        .bind(created)
        .first(),
    ).resolves.toEqual({ verified: 0, organizationId: ORGANIZATION_ID });
  });

  it("refuses a sign-up when no spot is open, leaving no user behind", async () => {
    await setTestSignupLimit(1);
    expectError(
      await signIn({ sub: "late", email: "late@example.test" }),
      "signups_full",
    );
    await expect(countUsers()).resolves.toBe(1);
    await expect(accountOwner("late")).resolves.toBeNull();
  });

  it("never links an existing account by email", async () => {
    await createFixtureMember({ d1: env.DB, userId: "alice", email: "alice@example.test" });
    expectError(
      await signIn({ sub: "alice-at-idp", email: "alice@example.test" }),
      "sso_email_in_use",
    );
    await expect(accountOwner("alice-at-idp")).resolves.toBeNull();

    // Off the verified domain too, once the provider verified the address.
    await approveExternalEmails(PROVIDER_ID);
    await createFixtureMember({ d1: env.DB, userId: "bea", email: "bea@personal.test" });
    expectError(
      await signIn({
        sub: "bea-at-idp",
        email: "bea@personal.test",
        email_verified: true,
      }),
      "sso_email_in_use",
    );
    await expect(accountOwner("bea-at-idp")).resolves.toBeNull();
  });

  it("reclaims an off-domain account nobody can sign in to under the sign-up rules", async () => {
    const now = new Date();
    // As this organization's approved provider signs it up: unverified. A
    // sign-up that stopped before its account insert leaves it like this too.
    await drizzle(env.DB).insert(user).values({
      id: "stranded-elsewhere",
      name: "Stranded",
      email: "stranded@personal.test",
      emailVerified: false,
      signupOrganizationId: ORGANIZATION_ID,
      createdAt: now,
      updatedAt: now,
    });
    const claims = {
      sub: "stranded-elsewhere-at-idp",
      email: "stranded@personal.test",
      email_verified: true,
    };
    expectError(await signIn(claims), "sso_email_domain_not_allowed");

    await approveExternalEmails(PROVIDER_ID);
    const callback = await signIn(claims);
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("stranded-elsewhere-at-idp")).resolves.toBe(
      "stranded-elsewhere",
    );
    await expect(countUsers()).resolves.toBe(2);
  });

  it("never lets an approved provider take over an account whose address it doesn't own", async () => {
    // Verified, signed up elsewhere, and left without a way in.
    const now = new Date();
    await drizzle(env.DB).insert(user).values({
      id: "stranded-verified",
      name: "Stranded",
      email: "someone@elsewhere.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await approveExternalEmails(PROVIDER_ID);

    expectError(
      await signIn({
        sub: "claims-someone",
        email: "someone@elsewhere.test",
        email_verified: true,
      }),
      "sso_email_in_use",
    );
    await expect(accountOwner("claims-someone")).resolves.toBeNull();
  });

  it("never lands someone in an unverified account another organization set up", async () => {
    // Another organization's approved provider signed up an address on this
    // provider's domain, then removed it. Connecting this organization made
    // it a member, which proves nothing.
    const now = new Date();
    await drizzle(env.DB).insert(organization).values({
      id: "planting-organization",
      name: "Planting",
      slug: "planting",
      createdAt: now,
    });
    await drizzle(env.DB).insert(user).values({
      id: "planted",
      name: "Planted",
      email: "owner.of.address@example.test",
      emailVerified: false,
      signupOrganizationId: "planting-organization",
      createdAt: now,
      updatedAt: now,
    });
    await env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('planted-membership', ?1, 'planted', 'member', ?2)`,
    )
      .bind(ORGANIZATION_ID, now.getTime())
      .run();

    expectError(
      await signIn({ sub: "real-owner", email: "owner.of.address@example.test" }),
      "sso_email_in_use",
    );
    await expect(accountOwner("real-owner")).resolves.toBeNull();
  });

  it("never signs a platform admin in through an organization", async () => {
    await signIn({ sub: "promoted", email: "promoted@example.test" });
    const userId = (await accountOwner("promoted"))!;
    // Promoted after joining as a member: the organization controls its
    // provider, and who administers it, so making them its admin or owner
    // changes nothing either.
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?1")
      .bind(userId)
      .run();
    for (const role of ["member", "admin", "owner"]) {
      await env.DB.prepare("UPDATE member SET role = ?2 WHERE user_id = ?1")
        .bind(userId, role)
        .run();
      expectError(
        await signIn({ sub: "promoted", email: "promoted@example.test" }),
        "sso_admin_sign_in_forbidden",
      );
    }
  });

  it("never lets an organization take over a platform admin's account", async () => {
    const now = new Date();
    await drizzle(env.DB).insert(user).values({
      id: "stranded-admin",
      name: "Stranded admin",
      email: "stranded.admin@example.test",
      emailVerified: true,
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
    expectError(
      await signIn({ sub: "admin-at-idp", email: "stranded.admin@example.test" }),
      "sso_email_in_use",
    );
    await expect(accountOwner("admin-at-idp")).resolves.toBeNull();
  });

  it("keeps a removed member out until an admin restores them", async () => {
    await signIn({ sub: "removed", email: "removed@example.test" });
    const userId = (await accountOwner("removed"))!;
    await removeMember(userId);

    expectError(
      await signIn({ sub: "removed", email: "removed@example.test" }),
      "sso_removed_from_organization",
    );
    await expect(memberRole(userId)).resolves.toBeNull();

    await restoreMember(userId);
    const callback = await signIn({
      sub: "removed",
      email: "removed@example.test",
    });
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(memberRole(userId)).resolves.toBe("member");
  });

  it("keeps a removed login out of any account until an admin restores them", async () => {
    await signIn({ sub: "removed-login", email: "removed.login@example.test" });
    const userId = (await accountOwner("removed-login"))!;
    await removeMember(userId);
    // The account no longer holds the login, as after the person is deleted
    // or the provider is registered again, and the address is free.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM account WHERE user_id = ?1").bind(userId),
      env.DB.prepare(
        "UPDATE user SET email = 'gone@deleted.invalid' WHERE id = ?1",
      ).bind(userId),
    ]);
    const users = await countUsers();

    expectError(
      await signIn({ sub: "removed-login", email: "removed.login@example.test" }),
      "sso_removed_from_organization",
    );
    await expect(countUsers()).resolves.toBe(users);
    await expect(accountOwner("removed-login")).resolves.toBeNull();
    // Nor can another account connect it.
    await createFixtureMember({ d1: env.DB, userId: "grace", email: "grace@personal.test" });
    expect(
      new URL(
        (await link("grace", await sessionCookieFor("grace"), {
          sub: "removed-login",
          email: "removed.login@example.test",
        })).headers.get("location")!,
      ).searchParams.get("error"),
    ).toBe("sso_removed_from_organization");
    await expect(accountOwner("removed-login")).resolves.toBeNull();

    await restoreMember(userId);
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM organization_member_removed_logins").first(),
    ).resolves.toEqual({ count: 0 });
    const callback = await signIn({
      sub: "removed-login",
      email: "removed.login@example.test",
    });
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("removed-login")).resolves.not.toBeNull();
  });

  it("leaves nothing behind when the provider is removed mid-sign-up", async () => {
    const before = await getSignupStatus(env.DB);
    // The owner removes the provider between the sign-up's checks and its
    // identity insert, deleting the provider's identities as it goes.
    const race = interleaveBefore(/^insert into "account"/iu, () =>
      env.DB.prepare("DELETE FROM sso_provider WHERE provider_id = ?1")
        .bind(PROVIDER_ID)
        .run(),
    );
    try {
      expectError(
        await signIn({ sub: "raced-signup", email: "raced.signup@example.test" }),
        "sso_flow_invalid",
      );
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    await expect(accountOwner("raced-signup")).resolves.toBeNull();
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM user WHERE email = 'raced.signup@example.test'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: before.taken,
    });
  });

  it("leaves nothing behind when the provider goes just before the session", async () => {
    // The removal commits after the session check but before its insert:
    // it deletes the new identity, and the session lands without one.
    const race = interleaveBefore(/^insert into "session"/iu, () =>
      env.DB.batch([
        env.DB.prepare("DELETE FROM account WHERE provider_id = ?1").bind(PROVIDER_ID),
        env.DB.prepare("DELETE FROM sso_provider WHERE provider_id = ?1").bind(PROVIDER_ID),
      ]),
    );
    try {
      expectError(
        await signIn({ sub: "late-signup", email: "late.signup@example.test" }),
        "sso_flow_invalid",
      );
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM user WHERE email = 'late.signup@example.test'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM session WHERE user_id NOT IN (SELECT id FROM user)",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("refuses a callback for a provider the flow did not start", async () => {
    await seedOrganizationProvider({
      organizationId: "org-sso-other-organization",
      providerId: "org-sso-other",
      domain: "other.example.test",
    });
    const flow = await startFlow({ kind: "sign-in", providerId: PROVIDER_ID });
    expectError(
      await completeCallback(
        { ...flow, providerId: "org-sso-other" },
        { sub: "mixed-up", email: "mixed@example.test" },
      ),
      "sso_flow_invalid",
    );
    await expect(countUsers()).resolves.toBe(1);
  });
});

describe("connecting an organization", () => {
  it("links the signed-in account whatever email the provider returns", async () => {
    await createFixtureMember({ d1: env.DB, userId: "bob", email: "bob@personal.test" });
    const cookie = await sessionCookieFor("bob");
    const before = await getSignupStatus(env.DB);

    const callback = await link("bob", cookie, {
      sub: "bob-at-work",
      email: "bob.work@example.test",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("bob-at-work")).resolves.toBe("bob");
    await expect(memberRole("bob")).resolves.toBe("member");
    await expect(countUsers()).resolves.toBe(2);
    // Stored without the provider's tokens.
    await expect(
      env.DB.prepare(
        "SELECT access_token AS accessToken, id_token AS idToken FROM account WHERE account_id = ?",
      )
        .bind("bob-at-work")
        .first(),
    ).resolves.toEqual({ accessToken: null, idToken: null });
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: before.taken,
    });
  });

  it("refuses an identity that belongs to another account", async () => {
    await createFixtureMember({ d1: env.DB, userId: "carol", email: "carol@personal.test" });
    await createFixtureMember({ d1: env.DB, userId: "dave", email: "dave@personal.test" });
    await insertOrganizationIdentity("carol", "shared-subject");

    expectError(
      await link("dave", await sessionCookieFor("dave"), {
        sub: "shared-subject",
        email: "shared@example.test",
      }),
      "sso_identity_linked_elsewhere",
    );
    await expect(accountOwner("shared-subject")).resolves.toBe("carol");
    await expect(memberRole("dave")).resolves.toBeNull();
  });

  it("refuses a second identity at the same organization", async () => {
    await createFixtureMember({ d1: env.DB, userId: "erin", email: "erin@personal.test" });
    await insertOrganizationIdentity("erin", "erin-first");

    expectError(
      await link("erin", await sessionCookieFor("erin"), {
        sub: "erin-second",
        email: "erin.second@example.test",
      }),
      "sso_identity_conflict",
    );
    await expect(accountOwner("erin-second")).resolves.toBeNull();
  });

  it("refuses a removed member", async () => {
    await createFixtureMember({ d1: env.DB, userId: "frank", email: "frank@personal.test" });
    await removeMember("frank");

    expectError(
      await link("frank", await sessionCookieFor("frank"), {
        sub: "frank-at-work",
        email: "frank@example.test",
      }),
      "sso_removed_from_organization",
    );
    await expect(accountOwner("frank-at-work")).resolves.toBeNull();
  });

  it("lets a platform admin connect an organization that can't sign them in", async () => {
    const cookie = await sessionCookieFor(FIXTURE_ADMIN_ID);
    const claims = { sub: "admin-at-work", email: "admin@example.test" };

    const callback = await link(FIXTURE_ADMIN_ID, cookie, claims);
    expect(callback.headers.get("location")).toBe(ORGANIZATION_URL);
    await expect(accountOwner("admin-at-work")).resolves.toBe(
      FIXTURE_ADMIN_ID,
    );
    await expect(memberRole(FIXTURE_ADMIN_ID)).resolves.toBe("member");
    // The membership is theirs; signing in stays with GitHub.
    expectError(await signIn(claims), "sso_admin_sign_in_forbidden");
  });

  it("refuses to connect sign-in methods while impersonating", async () => {
    await createFixtureMember({ d1: env.DB, userId: "gina", email: "gina@personal.test" });
    await createFixtureMember({ d1: env.DB, userId: "hana", email: "hana@personal.test" });
    const intent = await createSsoIntent({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "gina",
      expiresAt: Date.now() + 600_000,
    });
    const organizationLink = await auth.handler(
      authRequest(
        "/api/auth/sign-in/sso",
        {
          providerId: PROVIDER_ID,
          providerType: "oidc",
          callbackURL: ORGANIZATION_URL,
          errorCallbackURL: ERROR_URL,
        },
        {
          [SSO_INTENT_HEADER]: intent,
          cookie: await sessionCookieFor("gina", {
            impersonatedBy: FIXTURE_ADMIN_ID,
          }),
        },
      ),
    );
    expect(organizationLink.status).toBe(403);
    await expect(organizationLink.json()).resolves.toMatchObject({
      code: "impersonation_link_forbidden",
    });

    const githubLink = await auth.handler(
      authRequest(
        "/api/auth/link-social",
        { provider: "github", callbackURL: "http://localhost/profile" },
        {
          cookie: await sessionCookieFor("hana", {
            impersonatedBy: FIXTURE_ADMIN_ID,
          }),
        },
      ),
    );
    expect(githubLink.status).toBe(403);
    await expect(githubLink.json()).resolves.toMatchObject({
      code: "impersonation_link_forbidden",
    });
  });

  it("doesn't connect a provider that was removed during the token exchange", async () => {
    await createFixtureMember({ d1: env.DB, userId: "ivan", email: "ivan@personal.test" });
    const cookie = await sessionCookieFor("ivan");
    const flow = await startFlow({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "ivan",
      cookie,
    });

    const callback = await completeCallback(
      flow,
      { sub: "ivan-at-work", email: "ivan@example.test" },
      cookie,
      async () => {
        await env.DB.prepare("DELETE FROM sso_provider WHERE provider_id = ?")
          .bind(PROVIDER_ID)
          .run();
      },
    );

    expectError(callback, "sso_flow_invalid");
    await expect(accountOwner("ivan-at-work")).resolves.toBeNull();
    await expect(memberRole("ivan")).resolves.toBeNull();
  });

  it("doesn't connect an organization to a session that lost its way in during the exchange", async () => {
    await createFixtureMember({ d1: env.DB, userId: "jill", email: "jill@personal.test" });
    const cookie = await sessionCookieFor("jill");
    const flow = await startFlow({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "jill",
      cookie,
    });

    const callback = await completeCallback(
      flow,
      { sub: "jill-at-work", email: "jill@example.test" },
      cookie,
      async () => {
        // Its GitHub identity goes, but not its session.
        await env.DB.prepare("DELETE FROM account WHERE user_id = 'jill'").run();
      },
    );

    expectError(callback, "access_revoked");
    await expect(accountOwner("jill-at-work")).resolves.toBeNull();
    await expect(memberRole("jill")).resolves.toBeNull();
  });

  it("doesn't connect an organization once the session that started it is signed out", async () => {
    await createFixtureMember({ d1: env.DB, userId: "lena", email: "lena@personal.test" });
    const cookie = await sessionCookieFor("lena");
    const flow = await startFlow({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "lena",
      cookie,
    });

    const callback = await completeCallback(
      flow,
      { sub: "lena-at-work", email: "lena@example.test" },
      cookie,
      async () => {
        await env.DB.prepare("DELETE FROM session WHERE user_id = 'lena'").run();
      },
    );

    // Not "start again": signed out, that would be a sign-up.
    expectError(callback, "link_session_ended");
    await expect(accountOwner("lena-at-work")).resolves.toBeNull();
  });

  it("doesn't connect an organization when a sign-out lands just before the link", async () => {
    await createFixtureMember({ d1: env.DB, userId: "kim", email: "kim@personal.test" });
    const cookie = await sessionCookieFor("kim");
    const flow = await startFlow({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "kim",
      cookie,
    });
    const batch = env.DB.batch.bind(env.DB);
    // Another organization's removal signs Kim out between the callback's
    // checks and the link's batch.
    const spy = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await env.DB.prepare("DELETE FROM session WHERE user_id = 'kim'").run();
        return batch(statements);
      });

    try {
      expectError(
        await completeCallback(
          flow,
          { sub: "kim-at-work", email: "kim@example.test" },
          cookie,
        ),
        "link_session_ended",
      );
    } finally {
      spy.mockRestore();
    }
    await expect(accountOwner("kim-at-work")).resolves.toBeNull();
    await expect(memberRole("kim")).resolves.toBeNull();
  });

  it("starts through the app helper, which maps refusals to app errors", async () => {
    const started = await startOrganizationSso({
      request: new Request("http://localhost/api/organization-sign-in/start", {
        headers: { origin: "http://localhost" },
      }),
      intent: { kind: "sign-in", providerId: PROVIDER_ID },
      callbackURL: ORGANIZATION_URL,
      errorCallbackURL: ERROR_URL,
    });
    const authorization = new URL(started.redirectUrl).searchParams;
    expect(authorization.get("code_challenge_method")).toBe("S256");
    expect(authorization.get("scope")).toBe("openid email profile");
    expect(started.headers.get("set-cookie")).toBeTruthy();

    // A link intent without its signed-in account is refused by the hook.
    await expect(
      startOrganizationSso({
        request: new Request("http://localhost/api/account-links/sso/start", {
          headers: { origin: "http://localhost" },
        }),
        intent: { kind: "link", providerId: PROVIDER_ID, userId: "nobody" },
        callbackURL: ORGANIZATION_URL,
        errorCallbackURL: ERROR_URL,
      }),
    ).rejects.toMatchObject({ status: 403, code: "sso_intent_mismatch" });
  });
});

describe("connecting GitHub", () => {
  it("adds GitHub to an organization-created account without another spot", async () => {
    await signIn({ sub: "org-first", email: "org.first@example.test" });
    const userId = (await accountOwner("org-first"))!;
    const cookie = await sessionCookieFor(userId);
    const before = await getSignupStatus(env.DB);

    const callback = await connectGithub(cookie, {
      githubAccountId: "5151001",
      login: "org-first",
      email: "org.first@personal.test",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost/profile");
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM account WHERE provider_id = 'github' AND account_id = '5151001'",
      ).first(),
    ).resolves.toEqual({ userId });
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: before.taken,
    });
    // The account had no username; it takes the GitHub login.
    await expect(
      env.DB.prepare(
        "SELECT username, display_username AS displayUsername FROM user WHERE id = ?",
      )
        .bind(userId)
        .first(),
    ).resolves.toEqual({ username: "org-first", displayUsername: "org-first" });
  });

  it("keeps an account's username empty when another account has the login", async () => {
    await createFixtureMember({ d1: env.DB, userId: "taken-login", email: "taken@personal.test" });
    await signIn({ sub: "org-second", email: "org.second@example.test" });
    const userId = (await accountOwner("org-second"))!;

    const callback = await connectGithub(await sessionCookieFor(userId), {
      githubAccountId: "5151003",
      login: "Taken-Login",
      email: "org.second@personal.test",
    });

    expect(callback.headers.get("location")).toBe("http://localhost/profile");
    await expect(
      env.DB.prepare("SELECT username FROM user WHERE id = ?")
        .bind(userId)
        .first(),
    ).resolves.toEqual({ username: null });
  });

  it("returns a refused link to the profile with its code", async () => {
    // That GitHub account already belongs to another Intar account.
    await createFixtureMember({
      d1: env.DB,
      userId: "github-owner",
      githubAccountId: "5151002",
      email: "github.owner@personal.test",
    });
    await signIn({ sub: "second-linker", email: "second.linker@example.test" });
    const userId = (await accountOwner("second-linker"))!;

    const callback = await connectGithub(await sessionCookieFor(userId), {
      githubAccountId: "5151002",
      login: "github-owner",
      email: "second.linker@personal.test",
    });

    expectProfileError(callback, "account_already_linked_to_different_user");
    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId FROM account WHERE provider_id = 'github' AND account_id = '5151002'",
      ).first(),
    ).resolves.toEqual({ userId: "github-owner" });
  });

  it("returns a link the account insert refuses to the profile with its code", async () => {
    await signIn({ sub: "raced-linker", email: "raced.linker@example.test" });
    const userId = (await accountOwner("raced-linker"))!;
    const { internalAdapter } = await auth.$context;
    const findAccount = internalAdapter.findAccountByProviderId.bind(internalAdapter);
    // Another tab connects a GitHub account after this callback's checks,
    // just before its insert.
    const lookup = vi
      .spyOn(internalAdapter, "findAccountByProviderId")
      .mockImplementationOnce(async (...args) => {
        await env.DB.prepare(
          `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
           VALUES ('raced-github', '5151005', 'github', ?1, 1, 1)`,
        )
          .bind(userId)
          .run();
        return findAccount(...args);
      });

    try {
      const callback = await connectGithub(await sessionCookieFor(userId), {
        githubAccountId: "5151004",
        login: "raced-linker",
        email: "raced.linker@personal.test",
      });

      expectProfileError(callback, "github_already_connected");
      await expect(
        env.DB.prepare(
          "SELECT account_id AS accountId FROM account WHERE user_id = ?1 AND provider_id = 'github'",
        )
          .bind(userId)
          .all(),
      ).resolves.toMatchObject({ results: [{ accountId: "5151005" }] });
    } finally {
      lookup.mockRestore();
    }
  });

  it("doesn't connect GitHub once the session that started it is signed out", async () => {
    await signIn({ sub: "signed-out-linker", email: "signed.out.linker@example.test" });
    const userId = (await accountOwner("signed-out-linker"))!;

    const callback = await connectGithub(
      await sessionCookieFor(userId),
      {
        githubAccountId: "5151006",
        login: "signed-out-linker",
        email: "signed.out.linker@personal.test",
      },
      // Another tab's disconnect, a removal, or a provider deletion signs
      // the person out while they are at GitHub.
      async () => {
        await env.DB.prepare("DELETE FROM session WHERE user_id = ?1")
          .bind(userId)
          .run();
      },
    );

    expectProfileError(callback, "link_session_ended");
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM account WHERE provider_id = 'github' AND account_id = '5151006'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("doesn't connect GitHub when a sign-out lands just before the link", async () => {
    await signIn({ sub: "fenced-linker", email: "fenced.linker@example.test" });
    const userId = (await accountOwner("fenced-linker"))!;
    const cookie = await sessionCookieFor(userId);
    // Another tab's disconnect signs the person out after the callback's
    // session check, just before Better Auth stores the GitHub identity.
    const race = interleaveBefore(/^insert into "account"/iu, () =>
      env.DB.prepare("DELETE FROM session WHERE user_id = ?1").bind(userId).run(),
    );
    try {
      await expect(
        connectGithub(cookie, {
          githubAccountId: "5151007",
          login: "fenced-linker",
          email: "fenced.linker@personal.test",
        }),
      ).rejects.toMatchObject({ body: { code: "link_session_ended" } });
      expect(race.fired()).toBe(true);
    } finally {
      race.restore();
    }
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM account WHERE provider_id = 'github' AND account_id = '5151007'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("tells an account revoked during Connect GitHub that it lost access", async () => {
    await signIn({ sub: "revoked-linker", email: "revoked.linker@example.test" });
    const userId = (await accountOwner("revoked-linker"))!;

    const callback = await connectGithub(
      await sessionCookieFor(userId),
      {
        githubAccountId: "5151008",
        login: "revoked-linker",
        email: "revoked.linker@personal.test",
      },
      // A revocation bans the account and signs it out.
      async () => {
        await env.DB.batch([
          env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?1").bind(userId),
          env.DB.prepare("DELETE FROM session WHERE user_id = ?1").bind(userId),
        ]);
      },
    );

    expectProfileError(callback, "access_revoked");
  });

  it("doesn't connect GitHub to an account that lost its way in meanwhile", async () => {
    await signIn({ sub: "stranded-linker", email: "stranded.linker@example.test" });
    const userId = (await accountOwner("stranded-linker"))!;

    const callback = await connectGithub(
      await sessionCookieFor(userId),
      {
        githubAccountId: "5151004",
        login: "stranded-linker",
        email: "stranded.linker@personal.test",
      },
      async () => {
        // Its organization identity goes, but not its session.
        await env.DB.prepare("DELETE FROM account WHERE user_id = ?1")
          .bind(userId)
          .run();
      },
    );

    expectProfileError(callback, "access_revoked");
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM account WHERE provider_id = 'github' AND account_id = '5151004'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("connects an organization only from a recent sign-in", async () => {
    await createFixtureMember({ d1: env.DB, userId: "stale-linker", email: "stale.linker@personal.test" });
    const cookie = await seedSessionCookie({
      id: "stale-linker-session",
      token: "stale-linker-token",
      userId: "stale-linker",
      now: Date.now() - 2 * 24 * 60 * 60_000,
    });
    const intent = await createSsoIntent({
      kind: "link",
      providerId: PROVIDER_ID,
      userId: "stale-linker",
      expiresAt: Date.now() + 600_000,
    });

    const started = await auth.handler(
      authRequest(
        "/api/auth/sign-in/sso",
        { providerId: PROVIDER_ID, providerType: "oidc", callbackURL: ORGANIZATION_URL },
        { [SSO_INTENT_HEADER]: intent, cookie },
      ),
    );
    expect(started.status).toBe(403);
    await expect(started.json()).resolves.toMatchObject({
      code: "session_not_fresh",
    });
  });

  it("leaves an existing account's email verification to its sign-up", async () => {
    await signIn({ sub: "unverified", email: "unverified@example.test" });
    const userId = (await accountOwner("unverified"))!;
    await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
      .bind(userId)
      .run();

    await signIn({
      sub: "unverified",
      email: "unverified@example.test",
      email_verified: true,
    });
    await expect(
      env.DB.prepare("SELECT email_verified AS verified FROM user WHERE id = ?")
        .bind(userId)
        .first(),
    ).resolves.toEqual({ verified: 0 });
  });

  it("audits identities connected to existing accounts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const linked = () =>
      info.mock.calls.filter(
        ([line]) =>
          (JSON.parse(String(line)) as { event?: string }).event ===
          "security.identity_linked",
      ).length;
    try {
      await signIn({ sub: "audited", email: "audited@example.test" });
      expect(linked()).toBe(0);
      const userId = (await accountOwner("audited"))!;
      const cookie = await sessionCookieFor(userId);
      await connectGithub(cookie, {
        githubAccountId: "5151009",
        login: "audited",
        email: "audited@personal.test",
      });
      expect(linked()).toBe(1);

      // A reclaim connects the identity to an account that already existed.
      const now = new Date();
      await drizzle(env.DB).insert(user).values({
        id: "audited-stranded",
        name: "Stranded",
        email: "audited.stranded@example.test",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      await signIn({ sub: "audited-stranded", email: "audited.stranded@example.test" });
      expect(linked()).toBe(2);

      // Connecting the organization again (a repeated Test sign-in, say)
      // links nothing new.
      const connected = await link(userId, cookie, {
        sub: "audited",
        email: "audited@example.test",
      });
      expect(connected.headers.get("location")).toBe(ORGANIZATION_URL);
      expect(linked()).toBe(2);
    } finally {
      info.mockRestore();
    }
  });

  it("connects GitHub only from a recent sign-in", async () => {
    await signIn({ sub: "stale-session", email: "stale.session@example.test" });
    const userId = (await accountOwner("stale-session"))!;
    const cookie = await seedSessionCookie({
      id: "stale-session-row",
      token: "stale-session-token",
      userId,
      now: Date.now() - 2 * 24 * 60 * 60_000,
    });

    const started = await auth.handler(
      authRequest(
        "/api/auth/link-social",
        { provider: "github", callbackURL: "http://localhost/profile" },
        { cookie },
      ),
    );
    expect(started.status).toBe(403);
    await expect(started.json()).resolves.toMatchObject({
      code: "session_not_fresh",
    });
  });

  it("leaves usernames to GitHub: an account can't pick its own", async () => {
    await signIn({ sub: "org-user", email: "org.user@example.test" });
    const userId = (await accountOwner("org-user"))!;

    const response = await auth.handler(
      authRequest(
        "/api/auth/update-user",
        { username: "torvalds" },
        { cookie: await sessionCookieFor(userId) },
      ),
    );

    expect(response.status).toBe(404);
    await expect(
      env.DB.prepare("SELECT username FROM user WHERE id = ?")
        .bind(userId)
        .first(),
    ).resolves.toEqual({ username: null });
  });
});

describe("organization SSO helpers", () => {
  it("reads a stored intent the same way for the whole callback", () => {
    // Better Auth expires the OAuth state that carries it, so an intent that
    // expires between two hooks of one callback still holds for both.
    const intent = { kind: "sign-in", providerId: PROVIDER_ID, expiresAt: Date.now() - 1 };
    expect(
      ssoIntentFromState({ serverContext: { [SSO_INTENT_CONTEXT_KEY]: intent } }),
    ).toEqual(intent);
  });

  it("matches the verified domain and its subdomains only", () => {
    expect(emailOnDomain("a@example.test", "example.test")).toBe(true);
    expect(emailOnDomain("a@eu.example.test", "example.test")).toBe(true);
    expect(emailOnDomain("a@notexample.test", "example.test")).toBe(false);
    expect(emailOnDomain("a@example.test.evil", "example.test")).toBe(false);
    expect(emailOnDomain("not-an-email", "example.test")).toBe(false);
  });

  it("removes only a user without identities or sessions", async () => {
    const now = new Date();
    for (const id of ["unclaimed", "claimed"]) {
      await drizzle(env.DB).insert(user).values({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    }
    await insertOrganizationIdentity("claimed", "claimed-subject");

    await deleteUnclaimedSsoUser("unclaimed");
    await deleteUnclaimedSsoUser("claimed");

    await expect(
      env.DB.prepare(
        "SELECT id FROM user WHERE id IN ('unclaimed', 'claimed') ORDER BY id",
      ).all(),
    ).resolves.toMatchObject({ results: [{ id: "claimed" }] });
  });
});

async function seedOrganizationProvider(input: {
  organizationId: string;
  providerId: string;
  domain?: string;
}): Promise<void> {
  await drizzle(env.DB).insert(organization).values({
    id: input.organizationId,
    name: input.organizationId,
    slug: input.organizationId,
    createdAt: new Date(),
  });
  await drizzle(env.DB).insert(ssoProvider).values({
    id: `${input.providerId}-row`,
    // Registered before the issuer fix: typed without the trailing slash.
    issuer: "https://login.example.test",
    domain: input.domain ?? "example.test",
    oidcConfig: JSON.stringify({
      issuer: "https://login.example.test/",
      clientId: `${input.providerId}-client`,
      authorizationEndpoint: "https://login.example.test/oauth/authorize",
      tokenEndpoint: `https://login.example.test/${input.providerId}/token`,
      tokenEndpointAuthentication: "none",
      jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
      pkce: true,
      scopes: ["openid", "email", "profile"],
    }),
    oidcClientSecretCiphertext: null,
    userId: FIXTURE_ADMIN_ID,
    providerId: input.providerId,
    organizationId: input.organizationId,
    domainVerified: true,
  });
}

async function approveExternalEmails(providerId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sso_provider_policies (provider_id, allow_external_email_signups, updated_by, updated_at)
     VALUES (?1, 1, ?2, ?3)`,
  )
    .bind(providerId, FIXTURE_ADMIN_ID, Date.now())
    .run();
}

async function insertOrganizationIdentity(
  userId: string,
  subject: string,
): Promise<void> {
  const now = new Date();
  await drizzle(env.DB).insert(account).values({
    id: `${userId}-${subject}`,
    providerId: PROVIDER_ID,
    accountId: subject,
    userId,
    createdAt: now,
    updatedAt: now,
  });
}

const ORGANIZATION_OWNER_ID = "org-sso-owner";

/** Removes the person the way an organization admin does. */
async function removeMember(userId: string): Promise<void> {
  await ensureOrganizationOwner();
  const memberId = `${userId}-membership`;
  // Members join by signing in; someone who never did joins here first.
  await env.DB.prepare(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     VALUES (?1, ?2, ?3, 'member', ?4)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
  )
    .bind(memberId, ORGANIZATION_ID, userId, Date.now())
    .run();
  const membership = await env.DB.prepare(
    "SELECT id FROM member WHERE organization_id = ?1 AND user_id = ?2",
  )
    .bind(ORGANIZATION_ID, userId)
    .first<{ id: string }>();
  await removeOrganizationMember({
    organizationId: ORGANIZATION_ID,
    memberId: membership!.id,
    actorUserId: ORGANIZATION_OWNER_ID,
  });
}

async function restoreMember(userId: string): Promise<void> {
  await restoreOrganizationMember({
    organizationId: ORGANIZATION_ID,
    userId,
    actorUserId: ORGANIZATION_OWNER_ID,
  });
}

async function ensureOrganizationOwner(): Promise<void> {
  const exists = await env.DB.prepare("SELECT 1 FROM user WHERE id = ?1")
    .bind(ORGANIZATION_OWNER_ID)
    .first();
  if (exists) return;
  await createFixtureMember({ d1: env.DB, userId: ORGANIZATION_OWNER_ID, email: "owner@personal.test" });
  await env.DB.prepare(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     VALUES ('org-sso-owner-membership', ?1, ?2, 'owner', ?3)`,
  )
    .bind(ORGANIZATION_ID, ORGANIZATION_OWNER_ID, Date.now())
    .run();
}

async function signIn(claims: Claims): Promise<Response> {
  return completeCallback(
    await startFlow({ kind: "sign-in", providerId: PROVIDER_ID }),
    claims,
  );
}

async function link(
  userId: string,
  cookie: string,
  claims: Claims,
): Promise<Response> {
  return completeCallback(
    await startFlow({ kind: "link", providerId: PROVIDER_ID, userId, cookie }),
    claims,
    cookie,
  );
}

async function startFlow(
  input:
    | { kind: "sign-in"; providerId: string }
    | { kind: "link"; providerId: string; userId: string; cookie: string },
): Promise<StartedFlow> {
  const intent = await createSsoIntent(
    input.kind === "link"
      ? {
          kind: "link",
          providerId: input.providerId,
          userId: input.userId,
          expiresAt: Date.now() + 600_000,
        }
      : {
          kind: "sign-in",
          providerId: input.providerId,
          expiresAt: Date.now() + 600_000,
        },
  );
  const response = await auth.handler(
    authRequest(
      "/api/auth/sign-in/sso",
      {
        providerId: input.providerId,
        providerType: "oidc",
        callbackURL: ORGANIZATION_URL,
        errorCallbackURL: ERROR_URL,
        scopes: ["openid", "email", "profile"],
      },
      {
        [SSO_INTENT_HEADER]: intent,
        ...(input.kind === "link" ? { cookie: input.cookie } : {}),
      },
    ),
  );
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  const stateCookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!state || !stateCookie) throw new Error("OIDC state is required");
  return { providerId: input.providerId, state, stateCookie };
}

async function completeCallback(
  flow: StartedFlow,
  claims: Claims,
  sessionCookie?: string,
  // Runs while the plugin exchanges the code, after it loaded the provider.
  duringTokenExchange?: () => Promise<void>,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signIdToken({
    iss: "https://login.example.test/",
    aud: `${flow.providerId}-client`,
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input): Promise<Response> => {
      const url = requestUrl(input);
      if (url === `https://login.example.test/${flow.providerId}/token`) {
        await duringTokenExchange?.();
        return Response.json({
          access_token: "provider-access-token",
          id_token: idToken,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url === "https://login.example.test/.well-known/jwks.json") {
        return Response.json({ keys: [jwk] });
      }
      throw new Error(`unexpected OIDC fetch: ${url}`);
    });
  try {
    return await auth.handler(
      new Request(
        `http://localhost/api/auth/sso/callback/${flow.providerId}?code=code&state=${encodeURIComponent(flow.state)}`,
        {
          headers: {
            cookie: [sessionCookie, flow.stateCookie].filter(Boolean).join("; "),
          },
        },
      ),
    );
  } finally {
    fetchSpy.mockRestore();
  }
}

/** A link that returned to Profile with `code`. */
function expectProfileError(callback: Response, code: string): void {
  expectErrorRedirect(callback, "http://localhost/profile", code);
}

// Profile's Connect GitHub: Better Auth's link flow through GitHub's callback.
async function connectGithub(
  cookie: string,
  profile: { githubAccountId: string; login: string; email: string },
  /** Runs while the person is at GitHub, between the start and the callback. */
  meanwhile?: () => Promise<void>,
): Promise<Response> {
  const started = await auth.handler(
    authRequest(
      "/api/auth/link-social",
      {
        provider: "github",
        callbackURL: "http://localhost/profile",
        errorCallbackURL: "http://localhost/profile",
      },
      { cookie },
    ),
  );
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const stateCookie = started.headers.get("set-cookie")!.split(";", 1)[0]!;
  await meanwhile?.();

  const fetchSpy = mockGithubProfiles({
    "github-code": {
      githubAccountId: profile.githubAccountId,
      githubLogin: profile.login,
      email: profile.email,
    },
  });
  try {
    return await auth.handler(
      new Request(
        `http://localhost/api/auth/callback/github?code=github-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${cookie}; ${stateCookie}` } },
      ),
    );
  } finally {
    fetchSpy.mockRestore();
  }
}

async function signIdToken(payload: Claims): Promise<string> {
  const header = encodeJson({ alg: "RS256", kid: "test-key" });
  const body = encodeJson(payload);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function sessionCookieFor(
  userId: string,
  options?: { impersonatedBy?: string },
): Promise<string> {
  return seedSessionCookie({
    id: `${userId}-session`,
    token: `${userId}-session-token`,
    userId,
    now: Date.now(),
    ...options,
  });
}

function expectError(response: Response, code: string): void {
  expectErrorRedirect(response, ERROR_URL, code);
}

function expectErrorRedirect(response: Response, url: string, code: string): void {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(url);
  expect(location.searchParams.get("error")).toBe(code);
}

async function accountOwner(subject: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT user_id AS userId FROM account WHERE provider_id = ? AND account_id = ?",
  )
    .bind(PROVIDER_ID, subject)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}

async function memberRole(userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM member WHERE organization_id = ? AND user_id = ?",
  )
    .bind(ORGANIZATION_ID, userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

async function countUsers(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS count FROM user").first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

function encodeJson(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

