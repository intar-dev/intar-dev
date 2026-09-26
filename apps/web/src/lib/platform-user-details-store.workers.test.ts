/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { canSignIn } from "@/lib/account-access";
import {
  acquireAccessRevocationCleanup,
  completeAccessRevocationCleanup,
  revokeAccount,
} from "@/lib/access-revocation-store";
import { listPlatformUsers } from "@/lib/platform-user-deletion-store";
import { PLATFORM_USER_HISTORY_LIMIT } from "@/lib/platform-user-details";
import { ensureFixtureAdmin, FIXTURE_ADMIN_ID } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { getPlatformUserDetails } from "./platform-user-details-store";

beforeEach(async () => {
  await resetD1Database();
  await ensureFixtureAdmin(env.DB, 1);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, role, signup_organization_id, created_at, updated_at)
       VALUES ('person', 'Person', 'person@example.test', 'user', 'org-a', 10, 10),
              ('github-person', 'GitHub person', 'github.person@example.test', 'user', NULL, 11, 11),
              ('orphan', 'Orphan', 'orphan@example.test', 'user', 'org-gone', 12, 12),
              ('org-admin', 'Org admin', 'org.admin@example.test', 'admin', NULL, 13, 13),
              ('bystander', 'Bystander', 'bystander@example.test', 'user', NULL, 14, 14)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Org A', 'org-a', 1), ('org-b', 'Org B', 'org-b', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified)
       VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'person', 'org-a-idp', 'org-a', 1),
              ('org-b-idp-row', 'https://idp.b.test', 'b.test', '{}', 'person', 'org-b-idp', 'org-b', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, access_token, refresh_token, id_token, created_at, updated_at)
       VALUES ('person-a', 'person-a-subject', 'org-a-idp', 'person', 'secret-access', 'secret-refresh', 'secret-id-token', 20, 20),
              ('person-b', 'person-b-subject', 'org-b-idp', 'person', NULL, NULL, NULL, 21, 21),
              ('person-github', 'person-github-id', 'github', 'person', NULL, NULL, NULL, 22, 22),
              ('person-gone', 'person-gone-subject', 'removed-idp', 'person', NULL, NULL, NULL, 23, 23),
              ('github-person-github', 'github-person-id', 'github', 'github-person', NULL, NULL, NULL, 30, 30),
              ('org-admin-github', 'org-admin-github-id', 'github', 'org-admin', NULL, NULL, NULL, 40, 40),
              ('org-admin-a', 'org-admin-a-subject', 'org-a-idp', 'org-admin', NULL, NULL, NULL, 41, 41)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization_member_removals (organization_id, user_id, removed_by, removed_at)
       VALUES ('org-b', 'person', 'bystander', 50)`,
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('person-owns-a', 'org-a', 'person', 'owner', 60),
              ('bystander-joins-a', 'org-a', 'bystander', 'member', 61),
              ('bystander-owns-b', 'org-b', 'bystander', 'owner', 62)`,
    ),
    env.DB.prepare(
      `INSERT INTO session (id, token, user_id, ip_address, user_agent, expires_at, created_at, updated_at)
       VALUES ('person-session', 'secret-session-token', 'person', '203.0.113.7', 'SecretAgent/1.0', 9999999999999, 1, 1)`,
    ),
  ]);
});

describe("getPlatformUserDetails", () => {
  it("is null for a missing or deleted user", async () => {
    await expect(getPlatformUserDetails(env.DB, "missing")).resolves.toBeNull();
    await expect(getPlatformUserDetails(env.DB, " ")).resolves.toBeNull();
    await env.DB.prepare("UPDATE user SET deleted_at = 1 WHERE id = 'bystander'").run();
    await expect(getPlatformUserDetails(env.DB, "bystander")).resolves.toBeNull();
  });

  it("names where each person signed up", async () => {
    expect((await getPlatformUserDetails(env.DB, "person"))?.origin).toEqual({
      kind: "organization",
      organization: { id: "org-a", name: "Org A" },
    });
    expect((await getPlatformUserDetails(env.DB, "github-person"))?.origin).toEqual({
      kind: "github",
    });
    expect((await getPlatformUserDetails(env.DB, "orphan"))?.origin).toEqual({
      kind: "organization",
      organization: null,
    });
  });

  it("says why each sign-in method can't sign the person in", async () => {
    const details = await getPlatformUserDetails(env.DB, "person");
    expect(details?.signInMethods).toEqual([
      {
        providerId: "org-a-idp",
        kind: "organization",
        organization: { id: "org-a", name: "Org A" },
        linkedAt: 20,
        blocker: null,
      },
      {
        providerId: "org-b-idp",
        kind: "organization",
        organization: { id: "org-b", name: "Org B" },
        linkedAt: 21,
        blocker: "removed_from_organization",
      },
      {
        providerId: "github",
        kind: "github",
        organization: null,
        linkedAt: 22,
        blocker: null,
      },
      {
        providerId: "removed-idp",
        kind: "organization",
        organization: null,
        linkedAt: 23,
        blocker: "provider_removed",
      },
    ]);
    expect(details?.canSignIn).toBe(true);
    expect(
      (await getPlatformUserDetails(env.DB, "org-admin"))?.signInMethods.map(
        (method) => [method.providerId, method.blocker],
      ),
    ).toEqual([
      ["github", null],
      ["org-a-idp", "admin_requires_github"],
    ]);
  });

  it("agrees with canSignIn for every method of an active account", async () => {
    for (const userId of ["person", "github-person", "org-admin"]) {
      const details = await getPlatformUserDetails(env.DB, userId);
      for (const method of details?.signInMethods ?? []) {
        expect([userId, method.providerId, method.blocker === null]).toEqual([
          userId,
          method.providerId,
          await canSignIn(userId, method.providerId, env.DB),
        ]);
      }
    }
  });

  it("can't sign in an admin who has only an organization's provider", async () => {
    await env.DB.prepare("DELETE FROM account WHERE id = 'org-admin-github'").run();
    const details = await getPlatformUserDetails(env.DB, "org-admin");
    expect(details?.canSignIn).toBe(false);
    expect(details?.signInMethods).toMatchObject([
      { providerId: "org-a-idp", blocker: "admin_requires_github" },
    ]);
  });

  it("keeps the admin role's blocker while a revoked admin has no access", async () => {
    await revokeAccount({
      d1: env.DB, userId: "org-admin", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    const details = await getPlatformUserDetails(env.DB, "org-admin");
    expect(details).toMatchObject({ access: "revoked", canSignIn: false, role: "admin" });
    expect(details?.signInMethods.map((method) => method.blocker)).toEqual([
      null,
      "admin_requires_github",
    ]);
  });

  it("lists memberships, whether a restore keeps them, and removals", async () => {
    const details = await getPlatformUserDetails(env.DB, "person");
    expect(details?.memberships).toEqual([
      {
        organization: { id: "org-a", name: "Org A" },
        role: "owner",
        soleOwner: true,
        joinedAt: 60,
      },
    ]);
    expect(details?.removals).toEqual([
      {
        organization: { id: "org-b", name: "Org B" },
        removedAt: 50,
        removedBy: { id: "bystander", name: "Bystander" },
      },
    ]);
    expect((await getPlatformUserDetails(env.DB, "bystander"))?.memberships).toEqual([
      {
        organization: { id: "org-a", name: "Org A" },
        role: "member",
        soleOwner: false,
        joinedAt: 61,
      },
      {
        organization: { id: "org-b", name: "Org B" },
        role: "owner",
        soleOwner: true,
        joinedAt: 62,
      },
    ]);
  });

  it("follows a revocation's cleanup from pending to completed", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "person", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked", now: 100,
    });
    expect((await getPlatformUserDetails(env.DB, "person"))?.revocation).toEqual({
      revocationId,
      revokedAt: 100,
      revokedBy: { id: FIXTURE_ADMIN_ID, name: "Fixture administrator" },
      reason: "admin_revoked",
      cleanup: "pending",
      cleanupStartedAt: null,
      cleanupCompletedAt: null,
    });
    const attempt = await acquireAccessRevocationCleanup({
      d1: env.DB, userId: "person", revocationId, now: 110,
    });
    if (attempt.status !== "acquired") throw new Error("expected a cleanup attempt");
    expect((await getPlatformUserDetails(env.DB, "person"))?.revocation).toMatchObject({
      cleanup: "running",
      cleanupStartedAt: 110,
    });
    await completeAccessRevocationCleanup({
      d1: env.DB, userId: "person", revocationId, cleanupAttemptId: attempt.cleanupAttemptId, now: 120,
    });
    expect(await getPlatformUserDetails(env.DB, "person")).toMatchObject({
      access: "revoked",
      canSignIn: false,
      revocation: { cleanup: "completed", cleanupCompletedAt: 120 },
    });
  });

  it("returns the person's own access history, newest first and bounded", async () => {
    const statements = [
      env.DB.prepare(
        `INSERT INTO access_events (id, event_type, subject_user_id, actor_user_id, reason, created_at)
         VALUES ('other-person', 'access.blocked', 'bystander', ?1, 'admin_revoked', 5000),
                ('no-subject', 'signups.limit_changed', NULL, ?1, 'limit:5', 5001)`,
      ).bind(FIXTURE_ADMIN_ID),
    ];
    for (let index = 0; index <= PLATFORM_USER_HISTORY_LIMIT; index += 1) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO access_events (id, event_type, subject_user_id, actor_user_id, reason, created_at)
           VALUES (?1, 'access.blocked', 'person', ?2, 'admin_revoked', ?3)`,
        ).bind(`event-${String(index).padStart(3, "0")}`, index === 0 ? "gone" : FIXTURE_ADMIN_ID, 1000 + index),
      );
    }
    await env.DB.batch(statements);

    const history = (await getPlatformUserDetails(env.DB, "person"))?.history;
    expect(history?.truncated).toBe(true);
    expect(history?.events).toHaveLength(PLATFORM_USER_HISTORY_LIMIT);
    expect(history?.events[0]).toEqual({
      id: `event-${String(PLATFORM_USER_HISTORY_LIMIT).padStart(3, "0")}`,
      type: "access.blocked",
      at: 1000 + PLATFORM_USER_HISTORY_LIMIT,
      actor: { id: FIXTURE_ADMIN_ID, name: "Fixture administrator" },
      reason: "admin_revoked",
    });
    // The oldest is cut off; nobody else's events show up.
    expect(history?.events.map((event) => event.id)).not.toContain("event-000");
    expect(history?.events.map((event) => event.id)).not.toContain("other-person");

    await env.DB.prepare("DELETE FROM access_events WHERE id <> 'event-000'").run();
    expect((await getPlatformUserDetails(env.DB, "person"))?.history).toEqual({
      events: [{ id: "event-000", type: "access.blocked", at: 1000, actor: null, reason: "admin_revoked" }],
      truncated: false,
    });
  });

  it("counts SSH keys and apps without returning secrets", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_ssh_keys (id, user_id, key_type, public_key_openssh, fingerprint_sha256)
         VALUES ('person-key', 'person', 'ssh-ed25519', 'ssh-ed25519 AAAA person', 'SHA256:person')`,
      ),
      env.DB.prepare(
        `INSERT INTO oauth_client (id, client_id, client_secret, user_id, redirect_uris)
         VALUES ('person-app-row', 'person-app', 'secret-client-secret', 'person', '["http://localhost/callback"]')`,
      ),
    ]);
    const details = await getPlatformUserDetails(env.DB, "person");
    expect(details).toMatchObject({ sshKeyCount: 1, appCount: 1 });
    const serialized = JSON.stringify(details);
    for (const secret of [
      "secret-access",
      "secret-refresh",
      "secret-id-token",
      "person-a-subject",
      "person-github-id",
      "secret-session-token",
      "203.0.113.7",
      "SecretAgent",
      "secret-client-secret",
      "ssh-ed25519 AAAA",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("listPlatformUsers", () => {
  it("names each person's sign-up origin and current revocation", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "github-person", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    const users = await listPlatformUsers(env.DB);
    const byId = new Map(users.map((listed) => [listed.id, listed]));
    expect(byId.get("person")).toMatchObject({
      origin: { kind: "organization", organization: { id: "org-a", name: "Org A" } },
      revocationId: null,
    });
    expect(byId.get("github-person")).toMatchObject({
      origin: { kind: "github" },
      access: "revoked",
      revocationId,
    });
    expect(byId.get("orphan")).toMatchObject({
      origin: { kind: "organization", organization: null },
    });
    expect(byId.get("person")).not.toHaveProperty("signupOrganizationId");
  });
});
