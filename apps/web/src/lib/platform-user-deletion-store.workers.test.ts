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
  acquireBetaRevocationCleanup,
  completeBetaRevocationCleanup,
  revokeBetaUser,
} from "@/lib/beta-access-revocation-store";
import { setPlatformUserRole } from "@/lib/beta-admin-guard";
import {
  assertPlatformUserDeletionAllowed,
  finalizePlatformUserDeletion,
  listPlatformUsers,
} from "@/lib/platform-user-deletion-store";
import {
  ensureFixtureBetaAdmin,
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const TARGET_USER_ID = "delete-target";

describe("platform user deletion store", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureBetaAdmin(env.DB, 1_000);
    await seedUser(TARGET_USER_ID, 2_000);
  });

  it("removes identity and access while retaining an anonymous audit tombstone", async () => {
    const db = drizzle(env.DB);
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: TARGET_USER_ID,
      githubAccountId: "deleted-github-account",
      githubUsername: "delete-target",
      now: 3_000,
    });
    const revocation = await revokeBetaUser({
      d1: env.DB,
      userId: TARGET_USER_ID,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "admin_deleted",
      now: 4_000,
    });
    const cleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: TARGET_USER_ID,
      revocationId: revocation.revocationId,
      now: 4_100,
    });
    expect(cleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: TARGET_USER_ID,
      revocationId: revocation.revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: 4_200,
    });
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
        userId: FIXTURE_BETA_ADMIN_ID,
        role: "owner",
        createdAt: new Date(2_000),
      },
    ]);

    await finalizePlatformUserDeletion({
      d1: env.DB,
      targetUserId: TARGET_USER_ID,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
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
      "access_allowlist",
      "account",
      "session",
      "member",
      "user_ssh_keys",
    ]) {
      await expect(
        env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id = ?`)
          .bind(TARGET_USER_ID)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    }
    await expect(
      env.DB.prepare(
        `SELECT event_type AS eventType, subject_user_id AS subjectUserId,
                github_account_id AS githubAccountId,
                actor_user_id AS actorUserId, reason
         FROM access_events
         WHERE event_type = 'user.deleted' AND subject_user_id = ?`,
      )
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({
      eventType: "user.deleted",
      subjectUserId: TARGET_USER_ID,
      githubAccountId: "deleted-github-account",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "admin_deleted",
    });
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
        actorUserId: FIXTURE_BETA_ADMIN_ID,
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

  it("deletes a sign-in identity that never had beta access", async () => {
    await finalizePlatformUserDeletion({
      d1: env.DB,
      targetUserId: TARGET_USER_ID,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      now: 6_000,
    });

    await expect(
      env.DB.prepare("SELECT deleted_at AS deletedAt FROM user WHERE id = ?")
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({ deletedAt: 6_000 });
  });

  it("requires completed beta cleanup", async () => {
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: TARGET_USER_ID,
      githubAccountId: "active-delete-target",
      githubUsername: TARGET_USER_ID,
      now: 7_000,
    });

    await expect(
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
        now: 8_000,
      }),
    ).rejects.toMatchObject({ code: "platform_user_access_active" });
    await expect(
      env.DB.prepare("SELECT deleted_at FROM user WHERE id = ?")
        .bind(TARGET_USER_ID)
        .first(),
    ).resolves.toEqual({ deleted_at: null });
  });

  it("rejects self-deletion and sole organization ownership", async () => {
    await expect(
      assertPlatformUserDeletionAllowed({
        d1: env.DB,
        targetUserId: FIXTURE_BETA_ADMIN_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
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
        actorUserId: FIXTURE_BETA_ADMIN_ID,
      }),
    ).rejects.toMatchObject({ code: "platform_user_owns_organization" });
  });

  it("serializes concurrent deletion and writes one audit event", async () => {
    const outcomes = await Promise.allSettled([
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
        now: 10_000,
      }),
      finalizePlatformUserDeletion({
        d1: env.DB,
        targetUserId: TARGET_USER_ID,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
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
