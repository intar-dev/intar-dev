/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  account,
  member,
  organization,
  session,
  user,
  userSshKeys,
} from "@/db/schema";
import {
  acquireAccessRevocationCleanup,
  completeAccessRevocationCleanup,
  revokeAccount,
} from "@/lib/access-revocation-store";
import { setPlatformUserRole } from "@/lib/platform-admin-authority";
import {
  assertPlatformUserDeletionAllowed,
  finalizePlatformUserDeletion,
  listPlatformUsers,
} from "@/lib/platform-user-deletion-store";
import {
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
  ensureFixtureMember,
} from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const TARGET_USER_ID = "delete-target";

describe("platform user deletion store", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureAdmin(env.DB, 1_000);
    await seedUser(TARGET_USER_ID, 2_000);
  });

  it("removes identity and access while retaining an anonymous audit tombstone", async () => {
    const db = drizzle(env.DB);
    await ensureFixtureMember({
      d1: env.DB,
      userId: TARGET_USER_ID,
      githubAccountId: "deleted-github-account",
      now: 3_000,
    });
    await env.DB.prepare(
      "INSERT INTO signup_reservations (user_id, created_at, expires_at) VALUES (?, 3000, 603000)",
    )
      .bind(TARGET_USER_ID)
      .run();
    const revocationId = await revokeAndFinishCleanup(TARGET_USER_ID, 4_000);
    await db.insert(session).values({
      id: "deleted-user-session",
      token: "deleted-user-session-token",
      userId: TARGET_USER_ID,
      expiresAt: new Date(50_000),
      createdAt: new Date(4_000),
      updatedAt: new Date(4_000),
    });
    await db.insert(userSshKeys).values({
      id: "deleted-user-ssh-key",
      userId: TARGET_USER_ID,
      label: "Deleted laptop",
      keyType: "ssh-ed25519",
      publicKeyOpenssh: `ssh-ed25519 ${"A".repeat(68)}`,
      fingerprintSha256: "SHA256:deleted-user-key",
      createdAt: 4_000,
      updatedAt: 4_000,
    });
    await db.insert(organization).values({
      id: "co-owned-organization",
      name: "Co-owned organization",
      slug: "co-owned-organization",
      createdAt: new Date(2_000),
    });
    await db.insert(member).values([
      {
        id: "target-membership",
        organizationId: "co-owned-organization",
        userId: TARGET_USER_ID,
        role: "member",
        createdAt: new Date(2_000),
      },
      {
        id: "admin-membership",
        organizationId: "co-owned-organization",
        userId: FIXTURE_ADMIN_ID,
        role: "owner",
        createdAt: new Date(2_000),
      },
    ]);
    await env.DB.prepare(
      `INSERT INTO organization_member_removals (organization_id, user_id, removed_by, removed_at)
       VALUES ('co-owned-organization', ?1, ?2, 4000)`,
    )
      .bind(TARGET_USER_ID, FIXTURE_ADMIN_ID)
      .run();

    await finalizePlatformUserDeletion({
      d1: env.DB,
      targetUserId: TARGET_USER_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      now: 5_000,
    });

    const tombstone = await env.DB.prepare(
      `SELECT name, email, image, username, display_username AS displayUsername,
              role, banned, ban_reason AS banReason, deleted_at AS deletedAt
       FROM user WHERE id = ?`,
    )
      .bind(TARGET_USER_ID)
      .first<Record<string, unknown>>();
    expect(tombstone).toMatchObject({
      name: "Deleted user",
      image: null,
      username: null,
      displayUsername: null,
      role: null,
      banned: 1,
      banReason: "Deleted by administrator",
      deletedAt: 5_000,
    });
    expect(tombstone?.email).toMatch(
      /^deleted-[a-z0-9]+@deleted\.invalid$/u,
    );
    for (const table of [
      "account",
      "session",
      "member",
      "user_ssh_keys",
      "signup_reservations",
    ]) {
      await expect(
        env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ?`)
          .bind(TARGET_USER_ID)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    }
    // The removal outlives the account, so it still holds for their logins.
    await expect(
      env.DB.prepare(
        "SELECT organization_id AS organizationId FROM organization_member_removals WHERE user_id = ?",
      )
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({ organizationId: "co-owned-organization" });
    await expect(
      env.DB.prepare(
        `SELECT event_type AS eventType, subject_user_id AS subjectUserId,
                github_account_id AS githubAccountId,
                actor_user_id AS actorUserId, revocation_id AS revocationId,
                reason
         FROM access_events
         WHERE event_type = 'user.deleted' AND subject_user_id = ?`,
      )
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({
      eventType: "user.deleted",
      subjectUserId: TARGET_USER_ID,
      githubAccountId: "deleted-github-account",
      actorUserId: FIXTURE_ADMIN_ID,
      revocationId,
      reason: "admin_deleted",
    });
    // The revocation row stays as the audit record of the tombstone.
    await expect(
      env.DB.prepare(
        `SELECT revocation_id AS revocationId, cleanup_completed_at AS cleanupCompletedAt
         FROM access_revocations WHERE user_id = ?`,
      )
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({ revocationId, cleanupCompletedAt: 4_200 });
    await expect(
      env.DB.prepare("SELECT id FROM organization WHERE id = ?")
        .bind("co-owned-organization")
      .first(),
    ).resolves.toEqual({ id: "co-owned-organization" });
    expect(
      (await listPlatformUsers(env.DB)).some(({ id }) => id === TARGET_USER_ID),
    ).toBe(false);
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "admin",
        now: 5_100,
      }),
    ).rejects.toMatchObject({ code: "user_not_found" });

    await db.insert(user).values({
      id: "returning-user",
      name: "Returning user",
      email: "delete-target@example.test",
      emailVerified: true,
      username: "delete-target",
      role: "user",
      createdAt: new Date(6_000),
      updatedAt: new Date(6_000),
    });
    await expect(
      db.insert(account).values({
        id: "returning-github-link",
        accountId: "deleted-github-account",
        providerId: "github",
        userId: "returning-user",
        createdAt: new Date(6_000),
        updatedAt: new Date(6_000),
      }),
    ).resolves.toBeDefined();
  });

  it("keeps the organization identity of someone without GitHub in the audit trail", async () => {
    await drizzle(env.DB).insert(account).values({
      id: "target-organization-identity",
      providerId: "org-idp",
      accountId: "target-subject",
      userId: TARGET_USER_ID,
      createdAt: new Date(2_500),
      updatedAt: new Date(2_500),
    });
    await revokeAndFinishCleanup(TARGET_USER_ID, 4_000);

    await finalizePlatformUserDeletion({
      d1: env.DB,
      targetUserId: TARGET_USER_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      now: 5_000,
    });

    const events = await env.DB.prepare(
      `SELECT event_type AS eventType, github_account_id AS githubAccountId,
              sso_provider_id AS ssoProviderId, sso_account_id AS ssoAccountId
       FROM access_events WHERE subject_user_id = ?1
       ORDER BY created_at, event_type`,
    )
      .bind(TARGET_USER_ID)
      .all();
    expect(events.results.length).toBeGreaterThan(1);
    for (const event of events.results) {
      expect(event).toMatchObject({
        githubAccountId: null,
        ssoProviderId: "org-idp",
        ssoAccountId: "target-subject",
      });
    }
    expect(events.results.map((event) => event.eventType)).toContain(
      "user.deleted",
    );
  });

  it("refuses to delete a user whose access is active", async () => {
    await ensureFixtureMember({
      d1: env.DB,
      userId: TARGET_USER_ID,
      githubAccountId: "active-delete-target",
      now: 7_000,
    });

    await expect(
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        now: 8_000,
      }),
    ).rejects.toMatchObject({ code: "platform_user_access_active" });
    await expectNotDeleted(TARGET_USER_ID);
  });

  it("refuses to delete a user until the revocation cleanup finishes", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB,
      userId: TARGET_USER_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      reason: "admin_deleted",
      now: 7_000,
    });
    await expect(
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        now: 7_100,
      }),
    ).rejects.toMatchObject({ code: "platform_user_cleanup_incomplete" });

    await acquireAccessRevocationCleanup({
      d1: env.DB,
      userId: TARGET_USER_ID,
      revocationId,
      now: 7_200,
    });
    await expect(
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        now: 7_300,
      }),
    ).rejects.toMatchObject({ code: "platform_user_cleanup_incomplete" });
    await expectNotDeleted(TARGET_USER_ID);
  });

  it("lists each user's access and revocation cleanup", async () => {
    const listed = async () =>
      (await listPlatformUsers(env.DB)).find(({ id }) => id === TARGET_USER_ID);
    await expect(listed()).resolves.toMatchObject({
      access: "active",
      revokedAt: null,
      cleanupCompletedAt: null,
    });

    const { revocationId } = await revokeAccount({
      d1: env.DB,
      userId: TARGET_USER_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      reason: "admin_revoked",
      now: 7_000,
    });
    await expect(listed()).resolves.toMatchObject({
      access: "revoked",
      revokedAt: 7_000,
      cleanupCompletedAt: null,
    });

    const cleanup = await acquireAccessRevocationCleanup({
      d1: env.DB,
      userId: TARGET_USER_ID,
      revocationId,
      now: 7_100,
    });
    if (cleanup.status !== "acquired") throw new Error("expected a cleanup attempt");
    await completeAccessRevocationCleanup({
      d1: env.DB,
      userId: TARGET_USER_ID,
      revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: 7_200,
    });
    await expect(listed()).resolves.toMatchObject({
      access: "revoked",
      revokedAt: 7_000,
      cleanupCompletedAt: 7_200,
    });
    expect(
      (await listPlatformUsers(env.DB)).find(({ id }) => id === FIXTURE_ADMIN_ID),
    ).toMatchObject({ access: "active", revokedAt: null });
  });

  it("rejects self-deletion and sole organization ownership", async () => {
    await expect(
      assertPlatformUserDeletionAllowed({
        d1: env.DB,
        targetUserId: FIXTURE_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "platform_user_self_delete_forbidden" });

    const db = drizzle(env.DB);
    await db.insert(organization).values({
      id: "sole-owned-organization",
      name: "Sole owned organization",
      slug: "sole-owned-organization",
      createdAt: new Date(9_000),
    });
    await db.insert(member).values({
      id: "sole-owner-membership",
      organizationId: "sole-owned-organization",
      userId: TARGET_USER_ID,
      role: "owner",
      createdAt: new Date(9_000),
    });

    await expect(
      assertPlatformUserDeletionAllowed({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "platform_user_owns_organization" });
  });

  it("serializes concurrent deletion and writes one audit event", async () => {
    await revokeAndFinishCleanup(TARGET_USER_ID, 9_000);

    const outcomes = await Promise.allSettled([
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        now: 10_000,
      }),
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        now: 10_000,
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    await expect(
      env.DB.prepare(
        `SELECT count(*) AS count FROM access_events
         WHERE event_type = 'user.deleted' AND subject_user_id = ?`,
      )
        .bind(TARGET_USER_ID)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });
});

async function revokeAndFinishCleanup(
  userId: string,
  now: number,
): Promise<string> {
  const { revocationId } = await revokeAccount({
    d1: env.DB,
    userId,
    actorUserId: FIXTURE_ADMIN_ID,
    reason: "admin_deleted",
    now,
  });
  const cleanup = await acquireAccessRevocationCleanup({
    d1: env.DB,
    userId,
    revocationId,
    now: now + 100,
  });
  if (cleanup.status !== "acquired") throw new Error("expected a cleanup attempt");
  await completeAccessRevocationCleanup({
    d1: env.DB,
    userId,
    revocationId,
    cleanupAttemptId: cleanup.cleanupAttemptId,
    now: now + 200,
  });
  return revocationId;
}

async function expectNotDeleted(userId: string): Promise<void> {
  await expect(
    env.DB.prepare("SELECT deleted_at FROM user WHERE id = ?")
      .bind(userId)
      .first(),
  ).resolves.toEqual({ deleted_at: null });
}

async function seedUser(userId: string, now: number): Promise<void> {
  await drizzle(env.DB).insert(user).values({
    id: userId,
    name: "Delete Target",
    email: "delete-target@example.test",
    emailVerified: true,
    image: "https://example.test/avatar.png",
    username: "delete-target",
    displayUsername: "Delete Target",
    role: "user",
    banned: false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
}
