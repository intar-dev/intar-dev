/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/database-migrations";
import {
  ACCESS_INVITE_LIFETIME_MS,
  acquireBetaRevocationCleanup,
  allowBetaReinvite,
  completeBetaRevocationCleanup,
  confirmAccessInvite,
  createAccessInvite,
  exchangeAccessInviteCode,
  leaseAccessInvite,
  listAccessInvites,
  recordBetaRevocationCleanupFailure,
  recordBetaRevocationCleanupStall,
  removeAccessInvite,
  replaceAccessInvite,
  revokeAccessInvite,
  revokeBetaUser,
  validateGithubInviteLease,
} from "./access-invites";

beforeEach(async () => {
  await resetDatabase();
  await seedGithubUser({
    id: "admin-a",
    accountId: "1000",
    username: "platform-admin",
    role: "admin",
  });
  await bootstrapAdmin("admin-a", 0);
});

describe("beta invitation storage invariants", () => {
  it("is a clean replacement and enforces stable provider identity indexes", async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'access_%' ORDER BY name`,
    ).all<{ name: string }>();
    expect(tables.results.map(({ name }) => name)).toEqual([
      "access_allowlist",
      "access_events",
      "access_invite_codes",
      "access_invite_removals",
    ]);
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
    ).all<{ name: string }>();
    expect(triggers.results).toEqual([]);

    await seedUserOnly({ id: "index-user", username: "index-user" });
    await expect(
      env.DB.prepare(
        `INSERT INTO account (
           id, account_id, provider_id, user_id, created_at, updated_at
         ) VALUES ('duplicate-subject', '1000', 'github', 'index-user', 1, 1)`,
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO account (
           id, account_id, provider_id, user_id, created_at, updated_at
         ) VALUES ('second-github', '1001', 'github', 'admin-a', 1, 1)`,
      ).run(),
    ).rejects.toThrow();
  });

  it("atomically revokes, archives, and audits a pending invite", async () => {
    const invite = await standardInvite(3_000, "remove-pending");

    await removeAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      expectedVersion: invite.version,
      actorUserId: "admin-a",
      now: 4_000,
    });

    const stored = await env.DB.prepare(
      `SELECT state, lease_id, revoked_by, revocation_reason, revoked_at, version
       FROM access_invite_codes WHERE id = ?`,
    )
      .bind(invite.id)
      .first();
    expect(stored).toEqual({
      state: "revoked",
      lease_id: null,
      revoked_by: "admin-a",
      revocation_reason: "admin_removed",
      revoked_at: 4_000,
      version: 2,
    });
    expect(
      (await listAccessInvites({ d1: env.DB })).some(
        (candidate) => candidate.id === invite.id,
      ),
    ).toBe(false);
    await expect(
      exchangeAccessInviteCode({ d1: env.DB, code: invite.code, now: 4_100 }),
    ).rejects.toMatchObject({ code: "access_invite_unavailable" });

    const events = await env.DB.prepare(
      `SELECT event_type, actor_user_id, reason
       FROM access_events WHERE invite_id = ? ORDER BY event_type`,
    )
      .bind(invite.id)
      .all<{
        event_type: string;
        actor_user_id: string | null;
        reason: string | null;
      }>();
    expect(events.results).toEqual(
      expect.arrayContaining([
        {
          event_type: "invite.removed",
          actor_user_id: "admin-a",
          reason: "admin_removed",
        },
        {
          event_type: "invite.revoked",
          actor_user_id: "admin-a",
          reason: "admin_removed",
        },
      ]),
    );

    const countsBeforeRetry = await inviteAndEventCounts();
    await expect(
      removeAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: invite.version,
        actorUserId: "admin-a",
        now: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(await inviteAndEventCounts()).toEqual(countsBeforeRetry);
    await expect(
      env.DB.prepare(
        `SELECT invite_id, invite_version, removed_by, removed_at
         FROM access_invite_removals WHERE invite_id = ?`,
      )
        .bind(invite.id)
        .first(),
    ).resolves.toEqual({
      invite_id: invite.id,
      invite_version: invite.version,
      removed_by: "admin-a",
      removed_at: 4_000,
    });
  });

  it("removes a leased invite and invalidates the exact sign-in lease", async () => {
    const invite = await standardInvite(6_000, "remove-leased");
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 6_100,
    });

    await removeAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      expectedVersion: lease.version,
      actorUserId: "admin-a",
      now: 6_200,
    });

    await expect(
      validateGithubInviteLease({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        providerId: "github",
        now: 6_300,
      }),
    ).rejects.toMatchObject({ code: "access_invite_lease_invalid" });
    await expect(
      env.DB.prepare(
        `SELECT state, lease_id, leased_at, lease_expires_at, version
         FROM access_invite_codes WHERE id = ?`,
      )
        .bind(invite.id)
        .first(),
    ).resolves.toEqual({
      state: "revoked",
      lease_id: null,
      leased_at: null,
      lease_expires_at: null,
      version: 3,
    });
  });

  it("archives terminal invites without changing redeemed access", async () => {
    await seedGithubUser({
      id: "redeemed-user",
      accountId: "3900",
      username: "redeemed-user",
    });
    const redeemedInvite = await standardInvite(7_000, "remove-redeemed");
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: redeemedInvite.id,
      now: 7_100,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: redeemedInvite.id,
      leaseId: lease.leaseId,
      userId: "redeemed-user",
      githubAccountId: "3900",
      githubUsername: "redeemed-user",
      now: 7_200,
    });
    const redeemedVersion = await inviteVersion(redeemedInvite.id);

    await removeAccessInvite({
      d1: env.DB,
      inviteId: redeemedInvite.id,
      expectedVersion: redeemedVersion,
      actorUserId: "admin-a",
      now: 7_300,
    });

    await expect(
      env.DB.prepare(
        "SELECT state, version FROM access_invite_codes WHERE id = ?",
      )
        .bind(redeemedInvite.id)
        .first(),
    ).resolves.toEqual({ state: "redeemed", version: redeemedVersion });
    await expect(
      env.DB.prepare(
        "SELECT state, source_invite_id FROM access_allowlist WHERE user_id = ?",
      )
        .bind("redeemed-user")
        .first(),
    ).resolves.toEqual({
      state: "active",
      source_invite_id: redeemedInvite.id,
    });

    const revokedInvite = await standardInvite(8_000, "remove-revoked");
    const revoked = await revokeAccessInvite({
      d1: env.DB,
      inviteId: revokedInvite.id,
      expectedVersion: revokedInvite.version,
      actorUserId: "admin-a",
      reason: "superseded",
      now: 8_100,
    });
    await removeAccessInvite({
      d1: env.DB,
      inviteId: revoked.id,
      expectedVersion: revoked.version,
      actorUserId: "admin-a",
      now: 8_200,
    });
    await expect(
      env.DB.prepare(
        "SELECT state, version, revocation_reason FROM access_invite_codes WHERE id = ?",
      )
        .bind(revoked.id)
        .first(),
    ).resolves.toEqual({
      state: "revoked",
      version: revoked.version,
      revocation_reason: "superseded",
    });
  });

  it("rejects stale or unauthorized removal without hiding an invite", async () => {
    const invite = await standardInvite(9_000, "guarded-removal");
    await expect(
      removeAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: invite.version + 1,
        actorUserId: "admin-a",
        now: 9_100,
      }),
    ).rejects.toMatchObject({ code: "access_invite_stale_version" });

    await seedGithubUser({
      id: "admin-b",
      accountId: "3950",
      username: "platform-admin-b",
      role: "admin",
    });
    await bootstrapAdmin("admin-b", 9_200);
    await env.DB.prepare(
      "UPDATE user SET role = 'user' WHERE id = 'admin-a'",
    ).run();
    const before = await inviteAndEventCounts();
    await expect(
      removeAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: invite.version,
        actorUserId: "admin-a",
        now: 9_300,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_invite_remover_forbidden",
    });
    expect(await inviteAndEventCounts()).toEqual(before);
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM access_invite_removals WHERE invite_id = ?",
      )
        .bind(invite.id)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("linearizes removal against a concurrent claim", async () => {
    await seedGithubUser({
      id: "race-user",
      accountId: "3990",
      username: "race-user",
    });
    const invite = await standardInvite(9_500, "remove-claim-race");
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 9_600,
    });

    const outcomes = await Promise.allSettled([
      confirmAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        userId: "race-user",
        githubAccountId: "3990",
        githubUsername: "race-user",
        now: 9_700,
      }),
      removeAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        expectedVersion: lease.version,
        actorUserId: "admin-a",
        now: 9_700,
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );

    const [stored, access, removal] = await Promise.all([
      env.DB.prepare(
        "SELECT state FROM access_invite_codes WHERE id = ?",
      )
        .bind(invite.id)
        .first<{ state: string }>(),
      env.DB.prepare(
        "SELECT state FROM access_allowlist WHERE user_id = 'race-user'",
      ).first<{ state: string }>(),
      env.DB.prepare(
        "SELECT invite_id FROM access_invite_removals WHERE invite_id = ?",
      )
        .bind(invite.id)
        .first<{ invite_id: string }>(),
    ]);
    if (stored?.state === "revoked") {
      expect(access).toBeNull();
      expect(removal).toEqual({ invite_id: invite.id });
    } else {
      expect(stored?.state).toBe("redeemed");
      expect(access).toEqual({ state: "active" });
      expect(removal).toBeNull();
    }
  });

  it("stores only a hash, returns the raw code once, and does not mutate on exchange", async () => {
    const created = await standardInvite(1_000, "summer-beta");

    expect(created.expiresAt - created.createdAt).toBe(
      14 * 24 * 60 * 60 * 1_000,
    );

    const stored = await env.DB.prepare(
      `SELECT code_hash, code_prefix, state, version
       FROM access_invite_codes WHERE id = ?`,
    )
      .bind(created.id)
      .first<{
        code_hash: string;
        code_prefix: string;
        state: string;
        version: number;
      }>();
    expect(stored).toMatchObject({
      code_prefix: created.codePrefix,
      state: "pending",
      version: 1,
    });
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain(created.code);

    await expect(
      exchangeAccessInviteCode({ d1: env.DB, code: created.code, now: 2_000 }),
    ).resolves.toMatchObject({ inviteId: created.id, version: 1 });

    const afterExchange = await env.DB.prepare(
      "SELECT state, version FROM access_invite_codes WHERE id = ?",
    )
      .bind(created.id)
      .first<{ state: string; version: number }>();
    expect(afterExchange).toEqual({ state: "pending", version: 1 });

    const listJson = JSON.stringify(await listAccessInvites({ d1: env.DB }));
    const auditJson = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM access_events").all()).results,
    );
    expect(listJson).not.toContain(created.code);
    expect(listJson).not.toContain(stored?.code_hash);
    expect(auditJson).not.toContain(created.code);
    await removeAccessInvite({
      d1: env.DB,
      inviteId: created.id,
      expectedVersion: created.version,
      actorUserId: "admin-a",
      now: 2_100,
    });
    await expect(
      env.DB.prepare(
        "SELECT id, state FROM access_invite_codes WHERE id = ?",
      )
        .bind(created.id)
        .first(),
    ).resolves.toEqual({ id: created.id, state: "revoked" });
  });

  it("gives one lease to 100 concurrent starters", async () => {
    const invite = await standardInvite(10_000);
    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, () =>
        leaseAccessInvite({ d1: env.DB, inviteId: invite.id, now: 11_000 }),
      ),
    );

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await env.DB.prepare(
      "SELECT state, version FROM access_invite_codes WHERE id = ?",
    )
      .bind(invite.id)
      .first<{ state: string; version: number }>();
    expect(stored).toEqual({ state: "leased", version: 2 });
  });

  it("atomically admits exactly one of 50 concurrent claimers", async () => {
    const invite = await standardInvite(20_000);
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 21_000,
    });
    const identities = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const id = `claimant-${index}`;
        const accountId = String(20_000 + index);
        const username = `claimant-${index}`;
        await seedGithubUser({ id, accountId, username });
        return { id, accountId, username };
      }),
    );

    const claims = await Promise.allSettled(
      identities.map((identity) =>
        confirmAccessInvite({
          d1: env.DB,
          inviteId: invite.id,
          leaseId: lease.leaseId,
          userId: identity.id,
          githubAccountId: identity.accountId,
          githubUsername: identity.username,
          now: 22_000,
        }),
      ),
    );
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );

    const accessCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM access_allowlist WHERE state = 'active'",
    ).first<{ count: number }>();
    const redeemed = await env.DB.prepare(
      `SELECT state, redeemer_user_id
       FROM access_invite_codes WHERE id = ?`,
    )
      .bind(invite.id)
      .first<{ state: string; redeemer_user_id: string }>();
    expect(accessCount?.count).toBe(2);
    expect(redeemed?.state).toBe("redeemed");
    expect(identities.some(({ id }) => id === redeemed?.redeemer_user_id)).toBe(
      true,
    );
  });

  it("redeems only one of two leased codes presented by the same user", async () => {
    await seedGithubUser({
      id: "two-code-user",
      accountId: "2500",
      username: "two-code-user",
    });
    const invites = await Promise.all([
      standardInvite(25_000),
      standardInvite(25_001),
    ]);
    const leases = await Promise.all(
      invites.map((invite) =>
        leaseAccessInvite({
          d1: env.DB,
          inviteId: invite.id,
          now: 26_000,
        }),
      ),
    );

    const claims = await Promise.allSettled(
      invites.map((invite, index) =>
        confirmAccessInvite({
          d1: env.DB,
          inviteId: invite.id,
          leaseId: leases[index]!.leaseId,
          userId: "two-code-user",
          githubAccountId: "2500",
          githubUsername: "two-code-user",
          now: 27_000,
        }),
      ),
    );
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const states = await env.DB.prepare(
      `SELECT state FROM access_invite_codes
       WHERE id IN (?, ?) ORDER BY state`,
    )
      .bind(invites[0]!.id, invites[1]!.id)
      .all<{ state: string }>();
    expect(states.results.map(({ state }) => state)).toEqual([
      "leased",
      "redeemed",
    ]);
  });

  it("rolls the invitation transition back when the user is already blocked", async () => {
    await seedGithubUser({
      id: "blocked-user",
      accountId: "3000",
      username: "blocked-user",
    });
    const first = await standardInvite(30_000);
    const firstLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: first.id,
      now: 31_000,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: first.id,
      leaseId: firstLease.leaseId,
      userId: "blocked-user",
      githubAccountId: "3000",
      githubUsername: "blocked-user",
      now: 32_000,
    });
    await revokeBetaUser({
      d1: env.DB,
      userId: "blocked-user",
      actorUserId: "admin-a",
      reason: "policy_violation",
      now: 33_000,
    });

    const second = await standardInvite(34_000);
    const secondLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: second.id,
      now: 35_000,
    });
    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: second.id,
        leaseId: secondLease.leaseId,
        userId: "blocked-user",
        githubAccountId: "3000",
        githubUsername: "blocked-user",
        now: 36_000,
      }),
    ).rejects.toMatchObject({ code: "access_invite_claim_conflict" });

    const secondState = await env.DB.prepare(
      "SELECT state, redeemer_user_id FROM access_invite_codes WHERE id = ?",
    )
      .bind(second.id)
      .first<{ state: string; redeemer_user_id: string | null }>();
    expect(secondState).toEqual({ state: "leased", redeemer_user_id: null });
  });

  it("keeps a lease valid for its full ten minutes after code expiry", async () => {
    const createdAt = 100_000;
    const invite = await standardInvite(createdAt);
    const leasedAt = createdAt + ACCESS_INVITE_LIFETIME_MS - 1;
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: leasedAt,
    });
    const afterCodeExpiry = createdAt + ACCESS_INVITE_LIFETIME_MS + 5_000;
    await seedGithubUser({
      id: "edge-user",
      accountId: "4000",
      username: "edge-user",
    });

    await expect(
      validateGithubInviteLease({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        providerId: "github",
        now: afterCodeExpiry,
      }),
    ).resolves.toMatchObject({ leaseId: lease.leaseId });
    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        userId: "edge-user",
        githubAccountId: "4000",
        githubUsername: "edge-user",
        now: afterCodeExpiry,
      }),
    ).resolves.toMatchObject({ state: "active" });
  });

  it("atomically replaces an active lease using the admin-visible version", async () => {
    const original = await standardInvite(50_000, "wave-a");
    await leaseAccessInvite({
      d1: env.DB,
      inviteId: original.id,
      now: 51_000,
    });
    const replacement = await replaceAccessInvite({
      d1: env.DB,
      inviteId: original.id,
      expectedVersion: 2,
      actorUserId: "admin-a",
      label: "wave-b",
      now: 52_000,
    });

    const originalState = await env.DB.prepare(
      `SELECT state, lease_id, replaced_by_invite_id, version
       FROM access_invite_codes WHERE id = ?`,
    )
      .bind(original.id)
      .first<{
        state: string;
        lease_id: string | null;
        replaced_by_invite_id: string;
        version: number;
      }>();
    expect(originalState).toEqual({
      state: "revoked",
      lease_id: null,
      replaced_by_invite_id: replacement.id,
      version: 3,
    });
    expect(replacement.version).toBe(1);
    expect(replacement.expiresAt - replacement.createdAt).toBe(
      14 * 24 * 60 * 60 * 1_000,
    );

    await expect(
      replaceAccessInvite({
        d1: env.DB,
        inviteId: original.id,
        expectedVersion: 2,
        actorUserId: "admin-a",
        now: 53_000,
      }),
    ).rejects.toMatchObject({ code: "access_invite_stale_version" });
    const replacementCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM access_invite_codes",
    ).first<{ count: number }>();
    expect(replacementCount?.count).toBe(3);
  });

  it("rejects a demoted standard-invite issuer without an invite or event", async () => {
    await seedGithubUser({
      id: "admin-b",
      accountId: "8100",
      username: "platform-admin-b",
      role: "admin",
    });
    await bootstrapAdmin("admin-b", 54_000);
    const revocable = await standardInvite(54_100, "revoker-guard");
    await env.DB.prepare(
      "UPDATE user SET role = 'user' WHERE id = 'admin-a'",
    ).run();
    const before = await inviteAndEventCounts();

    await expect(
      createAccessInvite({
        d1: env.DB,
        kind: "standard",
        actorUserId: "admin-a",
        now: 55_000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_invite_issuer_forbidden",
    });
    expect(await inviteAndEventCounts()).toEqual(before);
    await expect(
      revokeAccessInvite({
        d1: env.DB,
        inviteId: revocable.id,
        expectedVersion: revocable.version,
        actorUserId: "admin-a",
        reason: "demoted_actor",
        now: 55_100,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_invite_revoker_forbidden",
    });
    expect(await inviteAndEventCounts()).toEqual(before);
    await expect(
      env.DB.prepare(
        "SELECT state, version FROM access_invite_codes WHERE id = ?",
      )
        .bind(revocable.id)
        .first(),
    ).resolves.toEqual({ state: "pending", version: revocable.version });
  });

  it("rejects a revoked replacement issuer without mutating the invite or audit", async () => {
    await seedGithubUser({
      id: "admin-b",
      accountId: "8200",
      username: "platform-admin-b",
      role: "admin",
    });
    await bootstrapAdmin("admin-b", 55_000);
    const original = await standardInvite(56_000, "guarded-wave");
    await seedGithubUser({
      id: "target-user",
      accountId: "8300",
      username: "target-user",
    });
    const targetInvite = await standardInvite(56_100, "target-access");
    const targetLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: targetInvite.id,
      now: 56_200,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: targetInvite.id,
      leaseId: targetLease.leaseId,
      userId: "target-user",
      githubAccountId: "8300",
      githubUsername: "target-user",
      now: 56_300,
    });
    await revokeBetaUser({
      d1: env.DB,
      userId: "admin-a",
      actorUserId: "admin-b",
      reason: "issuer_revoked",
      now: 57_000,
    });
    const before = await inviteAndEventCounts();

    await expect(
      replaceAccessInvite({
        d1: env.DB,
        inviteId: original.id,
        expectedVersion: original.version,
        actorUserId: "admin-a",
        now: 58_000,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "access_invite_issuer_forbidden",
    });
    expect(await inviteAndEventCounts()).toEqual(before);
    await expect(
      env.DB.prepare(
        `SELECT state, version, replaced_by_invite_id
         FROM access_invite_codes WHERE id = ?`,
      )
        .bind(original.id)
        .first(),
    ).resolves.toEqual({
      state: "pending",
      version: original.version,
      replaced_by_invite_id: null,
    });

    await expect(
      revokeBetaUser({
        d1: env.DB,
        userId: "target-user",
        actorUserId: "admin-a",
        reason: "stale_actor",
        now: 58_100,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "beta_admin_authority_required",
    });
    await expect(
      env.DB.prepare(
        "SELECT state FROM access_allowlist WHERE user_id = 'target-user'",
      ).first(),
    ).resolves.toEqual({ state: "active" });

    const targetRevocation = await revokeBetaUser({
      d1: env.DB,
      userId: "target-user",
      actorUserId: "admin-b",
      reason: "authorized_block",
      now: 58_200,
    });
    const targetCleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "target-user",
      revocationId: targetRevocation.revocationId,
      now: 58_250,
    });
    expect(targetCleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "target-user",
      revocationId: targetRevocation.revocationId,
      cleanupAttemptId: targetCleanup.cleanupAttemptId,
      now: 58_300,
    });
    const beforeClear = await inviteAndEventCounts();
    await expect(
      allowBetaReinvite({
        d1: env.DB,
        userId: "target-user",
        actorUserId: "admin-a",
        revocationId: targetRevocation.revocationId,
        now: 58_400,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "beta_admin_authority_required",
    });
    expect(await inviteAndEventCounts()).toEqual(beforeClear);
    await expect(
      env.DB.prepare(
        `SELECT state, revocation_id FROM access_allowlist
         WHERE user_id = 'target-user'`,
      ).first(),
    ).resolves.toEqual({
      state: "blocked",
      revocation_id: targetRevocation.revocationId,
    });
  });

  it("requires fenced cleanup before an administrator clears a block", async () => {
    await seedGithubUser({
      id: "revoked-user",
      accountId: "5000",
      username: "revoked-user",
    });
    const invite = await standardInvite(60_000);
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 61_000,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      leaseId: lease.leaseId,
      userId: "revoked-user",
      githubAccountId: "5000",
      githubUsername: "revoked-user",
      now: 62_000,
    });
    const revoked = await revokeBetaUser({
      d1: env.DB,
      userId: "revoked-user",
      actorUserId: "admin-a",
      reason: "admin_revoked",
      now: 63_000,
    });

    const failedCleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "revoked-user",
      revocationId: revoked.revocationId,
      now: 63_250,
    });
    expect(failedCleanup.status).toBe("acquired");
    await recordBetaRevocationCleanupStall({
      d1: env.DB,
      userId: "revoked-user",
      revocationId: revoked.revocationId,
      cleanupAttemptId: failedCleanup.cleanupAttemptId,
      actorUserId: "admin-a",
      reason: "stargate_timeout",
      now: 63_500,
    });
    await expect(
      acquireBetaRevocationCleanup({
        d1: env.DB,
        userId: "revoked-user",
        revocationId: revoked.revocationId,
        now: 63_600,
      }),
    ).rejects.toMatchObject({ code: "beta_revocation_cleanup_in_progress" });
    await recordBetaRevocationCleanupFailure({
      d1: env.DB,
      userId: "revoked-user",
      revocationId: revoked.revocationId,
      cleanupAttemptId: failedCleanup.cleanupAttemptId,
      actorUserId: "admin-a",
      reason: "operator_abandoned_cleanup",
      now: 63_700,
    });

    await expect(
      allowBetaReinvite({
        d1: env.DB,
        userId: "revoked-user",
        actorUserId: "admin-a",
        revocationId: revoked.revocationId,
        now: 64_000,
      }),
    ).rejects.toMatchObject({ code: "beta_revocation_cleanup_incomplete" });
    const successfulCleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "revoked-user",
      revocationId: revoked.revocationId,
      now: 64_500,
    });
    expect(successfulCleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "revoked-user",
      revocationId: revoked.revocationId,
      cleanupAttemptId: successfulCleanup.cleanupAttemptId,
      now: 65_000,
    });
    const retainedInvite = await standardInvite(65_100, "retained-code");
    const retainedLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: retainedInvite.id,
      now: 65_200,
    });
    await expect(
      recordBetaRevocationCleanupFailure({
        d1: env.DB,
        userId: "revoked-user",
        revocationId: revoked.revocationId,
        cleanupAttemptId: failedCleanup.cleanupAttemptId,
        reason: "stale_retry",
        now: 65_500,
      }),
    ).rejects.toMatchObject({ code: "stale_beta_revocation" });
    await allowBetaReinvite({
      d1: env.DB,
      userId: "revoked-user",
      actorUserId: "admin-a",
      revocationId: revoked.revocationId,
      now: 66_000,
    });

    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: retainedInvite.id,
        leaseId: retainedLease.leaseId,
        userId: "revoked-user",
        githubAccountId: "5000",
        githubUsername: "revoked-user",
        now: 66_100,
      }),
    ).rejects.toMatchObject({ code: "fresh_beta_invite_required" });
    const retainedState = await env.DB.prepare(
      "SELECT state FROM access_invite_codes WHERE id = ?",
    )
      .bind(retainedInvite.id)
      .first<{ state: string }>();
    expect(retainedState?.state).toBe("leased");

    const freshInvite = await standardInvite(67_000, "fresh-code");
    const freshLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: freshInvite.id,
      now: 67_100,
    });
    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: freshInvite.id,
        leaseId: freshLease.leaseId,
        userId: "revoked-user",
        githubAccountId: "5000",
        githubUsername: "revoked-user",
        now: 67_200,
      }),
    ).resolves.toMatchObject({ state: "active" });

    const access = await env.DB.prepare(
      "SELECT state FROM access_allowlist WHERE user_id = 'revoked-user'",
    ).first();
    const events = await env.DB.prepare(
      `SELECT id, event_type, reason FROM access_events
       WHERE subject_user_id = 'revoked-user' ORDER BY created_at`,
    ).all<{ id: string; event_type: string; reason: string | null }>();
    expect(access).toEqual({ state: "active" });
    expect(events.results.map(({ event_type }) => event_type)).toEqual(
      expect.arrayContaining([
        "access.blocked",
        "access.revocation_cleanup_failed",
        "access.revocation_cleanup_stalled",
        "access.revocation_cleanup_completed",
        "access.reinvite_allowed",
      ]),
    );
    const failedCleanupEvent = events.results.find(
      ({ event_type }) => event_type === "access.revocation_cleanup_failed",
    );
    expect(failedCleanupEvent).toMatchObject({
      event_type: "access.revocation_cleanup_failed",
      reason: "operator_abandoned_cleanup",
    });
  });

  it("serializes cleanup attempts without an expiring takeover", async () => {
    await seedGithubUser({
      id: "cleanup-race-user",
      accountId: "5050",
      username: "cleanup-race-user",
    });
    const invite = await standardInvite(68_000, "cleanup-race");
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 68_100,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      leaseId: lease.leaseId,
      userId: "cleanup-race-user",
      githubAccountId: "5050",
      githubUsername: "cleanup-race-user",
      now: 68_200,
    });
    const revoked = await revokeBetaUser({
      d1: env.DB,
      userId: "cleanup-race-user",
      actorUserId: "admin-a",
      reason: "cleanup_race",
      now: 68_300,
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        acquireBetaRevocationCleanup({
          d1: env.DB,
          userId: "cleanup-race-user",
          revocationId: revoked.revocationId,
          now: 68_400,
        }),
      ),
    );
    const winners = attempts.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireBetaRevocationCleanup>>
      > => result.status === "fulfilled",
    );
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]?.value.status).toBe("acquired");
    expect(losers).toHaveLength(49);
    expect(
      losers.every(
        ({ reason }) =>
          reason instanceof Error &&
          "code" in reason &&
          reason.code === "beta_revocation_cleanup_in_progress",
      ),
    ).toBe(true);

    await expect(
      acquireBetaRevocationCleanup({
        d1: env.DB,
        userId: "cleanup-race-user",
        revocationId: revoked.revocationId,
        now: 68_400 + 365 * 24 * 60 * 60 * 1_000,
      }),
    ).rejects.toMatchObject({ code: "beta_revocation_cleanup_in_progress" });
    await expect(
      allowBetaReinvite({
        d1: env.DB,
        userId: "cleanup-race-user",
        actorUserId: "admin-a",
        revocationId: revoked.revocationId,
        now: 69_000,
      }),
    ).rejects.toMatchObject({ code: "beta_revocation_cleanup_incomplete" });
    await expect(
      env.DB.prepare(
        `SELECT state, revocation_cleanup_completed_at AS completed_at
         FROM access_allowlist WHERE user_id = 'cleanup-race-user'`,
      ).first(),
    ).resolves.toEqual({ state: "blocked", completed_at: null });

    const winner = winners[0]!.value;
    if (winner.status !== "acquired") throw new Error("cleanup race lost");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "cleanup-race-user",
      revocationId: revoked.revocationId,
      cleanupAttemptId: winner.cleanupAttemptId,
      now: 69_100,
    });
    await expect(
      acquireBetaRevocationCleanup({
        d1: env.DB,
        userId: "cleanup-race-user",
        revocationId: revoked.revocationId,
        now: 69_200,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      cleanupAttemptId: winner.cleanupAttemptId,
      completedAt: 69_100,
    });
    await expect(
      env.DB.prepare(
        `SELECT state, revocation_cleanup_completed_at AS completed_at
         FROM access_allowlist WHERE user_id = 'cleanup-race-user'`,
      ).first(),
    ).resolves.toEqual({ state: "blocked", completed_at: 69_100 });
  });

  it("rejects cross-provider lease state and a GitHub account owned by another user", async () => {
    const invite = await standardInvite(70_000);
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 71_000,
    });
    await expect(
      validateGithubInviteLease({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        providerId: "oidc-corporate",
        now: 72_000,
      }),
    ).rejects.toMatchObject({ code: "access_invite_lease_invalid" });

    await seedGithubUser({
      id: "identity-owner",
      accountId: "6000",
      username: "identity-owner",
    });
    await seedUserOnly({ id: "wrong-user", username: "wrong-user" });
    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        userId: "wrong-user",
        githubAccountId: "6000",
        githubUsername: "identity-owner",
        now: 73_000,
      }),
    ).rejects.toMatchObject({ code: "access_invite_claim_conflict" });
    const state = await env.DB.prepare(
      "SELECT state FROM access_invite_codes WHERE id = ?",
    )
      .bind(invite.id)
      .first<{ state: string }>();
    expect(state?.state).toBe("leased");
  });

  it("requires an existing Better Auth admin for bootstrap and protects the last one", async () => {
    await seedGithubUser({
      id: "bootstrap-user",
      accountId: "7000",
      username: "bootstrap-user",
    });
    const invite = await createAccessInvite({
      d1: env.DB,
      kind: "bootstrap_admin",
      label: "initial-admin",
      now: 80_000,
    });
    const lease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: invite.id,
      now: 81_000,
    });
    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: invite.id,
        leaseId: lease.leaseId,
        userId: "bootstrap-user",
        githubAccountId: "7000",
        githubUsername: "bootstrap-user",
        now: 82_000,
      }),
    ).rejects.toMatchObject({ code: "access_invite_claim_conflict" });

    await env.DB.prepare(
      "UPDATE user SET role = 'admin' WHERE id = 'bootstrap-user'",
    ).run();
    const promotedInvite = await createAccessInvite({
      d1: env.DB,
      kind: "bootstrap_admin",
      label: "promoted-admin",
      now: 82_500,
    });
    const promotedLease = await leaseAccessInvite({
      d1: env.DB,
      inviteId: promotedInvite.id,
      now: 82_600,
    });

    await expect(
      confirmAccessInvite({
        d1: env.DB,
        inviteId: promotedInvite.id,
        leaseId: promotedLease.leaseId,
        userId: "bootstrap-user",
        githubAccountId: "7000",
        githubUsername: "bootstrap-user",
        now: 83_000,
      }),
    ).resolves.toMatchObject({ state: "active" });
    await expect(
      revokeBetaUser({
        d1: env.DB,
        userId: "admin-a",
        actorUserId: "bootstrap-user",
        reason: "handoff_admin",
        now: 83_500,
      }),
    ).resolves.toMatchObject({ user: { state: "blocked" } });
    await expect(
      revokeBetaUser({
        d1: env.DB,
        userId: "bootstrap-user",
        actorUserId: "bootstrap-user",
        reason: "self_revoke",
        now: 84_000,
      }),
    ).rejects.toMatchObject({ code: "last_beta_admin" });
  });

  it("atomically prevents concurrent command revocations of every administrator", async () => {
    await seedGithubUser({
      id: "admin-b",
      accountId: "8000",
      username: "platform-admin-b",
      role: "admin",
    });
    await bootstrapAdmin("admin-b", 90_000);

    const revocations = await Promise.allSettled([
      revokeBetaUser({
        d1: env.DB,
        userId: "admin-a",
        actorUserId: "admin-a",
        reason: "concurrent_admin_revoke",
        now: 91_000,
      }),
      revokeBetaUser({
        d1: env.DB,
        userId: "admin-b",
        actorUserId: "admin-a",
        reason: "concurrent_admin_revoke",
        now: 91_000,
      }),
    ]);
    expect(
      revocations.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const remaining = await env.DB.prepare(
      `SELECT identity.id
       FROM user AS identity
       INNER JOIN access_allowlist AS access ON access.user_id = identity.id
       WHERE access.state = 'active'
         AND identity.role = 'admin'
         AND coalesce(identity.banned, 0) = 0`,
    ).first<{ id: string }>();
    expect(remaining?.id).toMatch(/^admin-[ab]$/u);

    await expect(
      revokeBetaUser({
        d1: env.DB,
        userId: remaining!.id,
        actorUserId: remaining!.id,
        reason: "last_admin_revoke",
        now: 92_000,
      }),
    ).rejects.toMatchObject({ code: "last_beta_admin" });
  });
});

async function standardInvite(now: number, label?: string) {
  return createAccessInvite({
    d1: env.DB,
    kind: "standard",
    actorUserId: "admin-a",
    ...(label === undefined ? {} : { label }),
    now,
  });
}

async function bootstrapAdmin(userId: string, now: number): Promise<void> {
  const invite = await createAccessInvite({
    d1: env.DB,
    kind: "bootstrap_admin",
    label: `bootstrap-${userId}`,
    now,
  });
  const lease = await leaseAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    now: now + 1,
  });
  const account = await env.DB.prepare(
    `SELECT account_id FROM account
     WHERE user_id = ? AND provider_id = 'github' LIMIT 1`,
  )
    .bind(userId)
    .first<{ account_id: string }>();
  const identity = await env.DB.prepare(
    "SELECT username FROM user WHERE id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ username: string }>();
  await confirmAccessInvite({
    d1: env.DB,
    inviteId: invite.id,
    leaseId: lease.leaseId,
    userId,
    githubAccountId: account!.account_id,
    githubUsername: identity!.username,
    now: now + 2,
  });
}

async function inviteAndEventCounts(): Promise<{
  invites: number;
  events: number;
}> {
  const [invites, events] = await Promise.all([
    env.DB.prepare("SELECT count(*) AS count FROM access_invite_codes").first<{
      count: number;
    }>(),
    env.DB.prepare("SELECT count(*) AS count FROM access_events").first<{
      count: number;
    }>(),
  ]);
  return { invites: invites?.count ?? -1, events: events?.count ?? -1 };
}

async function inviteVersion(inviteId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT version FROM access_invite_codes WHERE id = ?",
  )
    .bind(inviteId)
    .first<{ version: number }>();
  return row!.version;
}

async function seedGithubUser(params: {
  id: string;
  accountId: string;
  username: string;
  role?: string;
}) {
  await seedUserOnly(params);
  await env.DB.prepare(
    `INSERT INTO account (
       id, account_id, provider_id, user_id, created_at, updated_at
     ) VALUES (?, ?, 'github', ?, 1, 1)`,
  )
    .bind(`account-${params.id}`, params.accountId, params.id)
    .run();
}

async function seedUserOnly(params: {
  id: string;
  username: string;
  role?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO user (
       id, name, email, email_verified, created_at, updated_at, username, role
     ) VALUES (?, ?, ?, 1, 1, 1, ?, ?)`,
  )
    .bind(
      params.id,
      params.username,
      `${params.id}@test.invalid`,
      params.username,
      params.role ?? "user",
    )
    .run();
}
