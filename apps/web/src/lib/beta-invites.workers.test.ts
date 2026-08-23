/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessInviteCodes,
  account,
  user,
} from "@/db/schema";
import {
  acquireBetaRevocationCleanup,
  completeBetaRevocationCleanup,
  revokeBetaUser,
} from "@/lib/beta-access-revocation-store";
import {
  BETA_INVITE_LIFETIME_MS,
  copyBetaInvite,
  createBetaInvite,
  inspectBetaInviteCode,
  listBetaInvites,
  redeemBetaInvite,
  revokeBetaInvite,
} from "@/lib/beta-invites";
import { createAppId } from "@/lib/id";
import {
  ensureFixtureBetaAdmin,
  FIXTURE_BETA_ADMIN_ID,
  FIXTURE_INVITE_ENCRYPTION_KEY,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

describe("simple beta invites", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureBetaAdmin(env.DB, 1_000);
  });

  it("stores a hash and row-bound ciphertext for exactly 7 days", async () => {
    const created = await createBetaInvite({
      d1: env.DB,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now: 10_000,
    });
    const row = await env.DB.prepare(
      `SELECT code_hash, token_ciphertext, kind, state, label,
              lease_id, replaces_invite_id, expires_at, claim_expires_at,
              created_at
       FROM access_invite_codes WHERE id = ?`,
    )
      .bind(created.id)
      .first<Record<string, unknown>>();

    expect(created.expiresAt - created.createdAt).toBe(BETA_INVITE_LIFETIME_MS);
    expect(row).toMatchObject({
      kind: "standard",
      state: "pending",
      label: null,
      lease_id: null,
      replaces_invite_id: null,
    });
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.token_ciphertext).toMatch(/^v1\./u);
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(
      14 * 24 * 60 * 60_000,
    );
    expect(Number(row?.claim_expires_at) - Number(row?.created_at)).toBe(
      BETA_INVITE_LIFETIME_MS,
    );
    expect(JSON.stringify(row)).not.toContain(created.code);
  });

  it("copies the same active link repeatedly and audits every copy", async () => {
    const created = await newInvite(20_000);

    const first = await copyBetaInvite({
      d1: env.DB,
      inviteId: created.id,
      expectedVersion: created.version,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now: 20_100,
    });
    const second = await copyBetaInvite({
      d1: env.DB,
      inviteId: created.id,
      expectedVersion: created.version,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now: 20_200,
    });

    expect(first).toBe(created.code);
    expect(second).toBe(created.code);
    await expect(
      env.DB.prepare(
        `SELECT count(*) AS count FROM access_events
         WHERE invite_id = ? AND event_type = 'invite.copied'`,
      )
        .bind(created.id)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 2 });
  });

  it("rejects legacy, expired, and revoked links", async () => {
    const legacyId = "legacy-active-invite";
    await drizzle(env.DB).insert(accessInviteCodes).values({
      id: legacyId,
      codeHash: "b".repeat(64),
      codePrefix: "intar_beta_legacy",
      kind: "standard",
      state: "pending",
      createdBy: FIXTURE_BETA_ADMIN_ID,
      createdAt: 1_000,
      expiresAt: 1_000 + 172_800_000,
      version: 1,
      updatedAt: 1_000,
    });
    const expired = await newInvite(30_000);
    const revoked = await newInvite(40_000);
    await revokeBetaInvite({
      d1: env.DB,
      inviteId: revoked.id,
      expectedVersion: revoked.version,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      now: 40_100,
    });

    await expect(
      inspectBetaInviteCode({ d1: env.DB, code: expired.code, now: expired.expiresAt }),
    ).rejects.toMatchObject({ code: "access_invite_unavailable" });
    await expect(
      inspectBetaInviteCode({ d1: env.DB, code: revoked.code, now: 40_200 }),
    ).rejects.toMatchObject({ code: "access_invite_unavailable" });
    await expect(
      copyBetaInvite({
        d1: env.DB,
        inviteId: revoked.id,
        expectedVersion: revoked.version + 1,
        actorUserId: FIXTURE_BETA_ADMIN_ID,
        encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
        now: 40_200,
      }),
    ).rejects.toMatchObject({ code: "access_invite_unavailable" });
    await expect(
      env.DB.prepare(
        "SELECT token_ciphertext FROM access_invite_codes WHERE id = ?",
      )
        .bind(revoked.id)
        .first(),
    ).resolves.toEqual({ token_ciphertext: null });
    expect(
      (await listBetaInvites({ d1: env.DB, now: 50_000 })).find(
        ({ id }) => id === legacyId,
      )?.state,
    ).toBe("revoked");
  });

  it("admits exactly one concurrent claimant and erases the ciphertext", async () => {
    const created = await newInvite(50_000);
    await seedGithubIdentity("claimant-a", "github-a", 50_010);
    await seedGithubIdentity("claimant-b", "github-b", 50_010);

    const outcomes = await Promise.allSettled([
      redeemBetaInvite({
        d1: env.DB,
        inviteId: created.id,
        attemptId: "attempt-a",
        userId: "claimant-a",
        githubAccountId: "github-a",
        githubUsername: "claimant-a",
        now: 50_100,
      }),
      redeemBetaInvite({
        d1: env.DB,
        inviteId: created.id,
        attemptId: "attempt-b",
        userId: "claimant-b",
        githubAccountId: "github-b",
        githubUsername: "claimant-b",
        now: 50_100,
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await expect(
      env.DB.prepare(
        `SELECT state, token_ciphertext, redeemer_user_id
         FROM access_invite_codes WHERE id = ?`,
      )
        .bind(created.id)
        .first(),
    ).resolves.toMatchObject({ state: "redeemed", token_ciphertext: null });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM access_allowlist WHERE source_invite_id = ?",
      )
        .bind(created.id)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("reactivates a revoked identity with a fresh invite after cleanup", async () => {
    await seedGithubIdentity("returning-user", "returning-github", 60_000);
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: "returning-user",
      githubAccountId: "returning-github",
      githubUsername: "returning-user",
      now: 60_010,
    });
    const revoked = await revokeBetaUser({
      d1: env.DB,
      userId: "returning-user",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "admin_revoked",
      now: 60_100,
    });
    const invite = await newInvite(60_200);

    await expect(
      redeemBetaInvite({
        d1: env.DB,
        inviteId: invite.id,
        attemptId: "attempt-before-cleanup",
        userId: "returning-user",
        githubAccountId: "returning-github",
        githubUsername: "returning-user",
        now: 60_300,
      }),
    ).rejects.toMatchObject({ code: "beta_revocation_cleanup_incomplete" });

    const cleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "returning-user",
      revocationId: revoked.revocationId,
      now: 60_400,
    });
    expect(cleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "returning-user",
      revocationId: revoked.revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: 60_500,
    });

    await expect(
      redeemBetaInvite({
        d1: env.DB,
        inviteId: invite.id,
        attemptId: "attempt-after-cleanup",
        userId: "returning-user",
        githubAccountId: "returning-github",
        githubUsername: "returning-user",
        now: 60_600,
      }),
    ).resolves.toMatchObject({ state: "active", sourceInviteId: invite.id });
    await expect(
      env.DB.prepare(
        `SELECT count(*) AS count FROM access_events
         WHERE event_type = 'access.reinvite_allowed'`,
      ).first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("keeps invite administration limited to active platform admins", async () => {
    await seedGithubIdentity("ordinary-member", "ordinary-github", 70_000);
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId: "ordinary-member",
      githubAccountId: "ordinary-github",
      githubUsername: "ordinary-member",
      now: 70_010,
    });
    const invite = await newInvite(70_100);

    await expect(
      createBetaInvite({
        d1: env.DB,
        actorUserId: "ordinary-member",
        encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
        now: 70_200,
      }),
    ).rejects.toMatchObject({ code: "beta_admin_authority_required" });
    await expect(
      copyBetaInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: invite.version,
        actorUserId: "ordinary-member",
        encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
        now: 70_300,
      }),
    ).rejects.toMatchObject({ code: "beta_admin_authority_required" });
    await expect(
      revokeBetaInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: invite.version,
        actorUserId: "ordinary-member",
        now: 70_400,
      }),
    ).rejects.toMatchObject({ code: "beta_admin_authority_required" });

    expect(
      (await listBetaInvites({ d1: env.DB, now: 70_500 })).find(
        ({ id }) => id === invite.id,
      )?.state,
    ).toBe("active");
    await expect(
      env.DB.prepare(
        `SELECT count(*) AS count FROM access_events
         WHERE invite_id = ? AND event_type in ('invite.copied', 'invite.revoked')`,
      )
        .bind(invite.id)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  async function newInvite(now: number) {
    return createBetaInvite({
      d1: env.DB,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
      now,
    });
  }
});

async function seedGithubIdentity(
  userId: string,
  accountId: string,
  now: number,
): Promise<void> {
  const db = drizzle(env.DB);
  const existing = await env.DB.prepare("SELECT id FROM user WHERE id = ?")
    .bind(userId)
    .first();
  if (!existing) {
    await db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@example.test`,
      emailVerified: true,
      username: userId,
      role: "user",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }
  const linked = await env.DB.prepare(
    "SELECT id FROM account WHERE user_id = ? AND provider_id = 'github'",
  )
    .bind(userId)
    .first();
  if (!linked) {
    await db.insert(account).values({
      id: createAppId(),
      accountId,
      providerId: "github",
      userId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }
}
