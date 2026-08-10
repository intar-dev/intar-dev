/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleAgentBootstrap,
  requireVerifiedAgentRequest,
  sha256Hex,
} from "./auth";
import {
  accessInviteCodes,
  agentBootstrapTokens,
  agentHosts,
  user,
} from "@/db/schema";
import {
  acquireBetaRevocationCleanup,
  allowBetaReinvite,
  completeBetaRevocationCleanup,
  confirmAccessInvite,
  revokeBetaUser,
} from "@/lib/access-invites";
import { resetD1Database } from "@/test/d1-migrations";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";

const STRONG_SECRET = "test-agent-jwt-secret-0123456789abcdef";

describe("agent JWT secret validation", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["short", "too-short"],
    ["31 bytes", "x".repeat(31)],
  ])("fails bootstrap safely when the secret is %s", async (_label, secret) => {
    const response = await handleAgentBootstrap(
      bootstrapRequest("host-secret-check", "bootstrap-token"),
      agentEnv(secret),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "agent authentication unavailable",
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["short", "too-short"],
    ["31 bytes", "x".repeat(31)],
  ])("rejects agent authentication when the secret is %s", async (_label, secret) => {
    const result = await requireVerifiedAgentRequest(
      new Request("http://localhost/agent/connect", {
        headers: { authorization: "Bearer attacker-controlled-token" },
      }),
      agentEnv(secret),
      "known-host",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(500);
    await expect(result.response.json()).resolves.toEqual({
      error: "agent authentication unavailable",
    });
  });

  it("signs and verifies agent tokens with a sufficiently strong secret", async () => {
    const hostId = "host-valid-secret";
    const bootstrapToken = "bootstrap-token";
    await seedBootstrapToken(hostId, bootstrapToken);

    const runtimeEnv = agentEnv(STRONG_SECRET);
    const response = await handleAgentBootstrap(
      bootstrapRequest(hostId, bootstrapToken),
      runtimeEnv,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string };
    expect(body.accessToken.split(".")).toHaveLength(3);

    const verified = await requireVerifiedAgentRequest(
      new Request("http://localhost/agent/connect", {
        headers: { authorization: `Bearer ${body.accessToken}` },
      }),
      runtimeEnv,
      hostId,
    );
    expect(verified).toMatchObject({
      ok: true,
      agent: {
        hostId,
        userId: "user-valid-secret",
        role: "agent",
        betaSourceInviteId: expect.any(String),
        betaSourceLeaseId: expect.any(String),
        betaAdmissionGrantedAt: expect.any(Number),
      },
    });
  });

  it("rejects an earlier personal-host JWT after equal-timestamp readmission", async () => {
    const hostId = "host-stale-beta-admission";
    const bootstrapToken = "stale-admission-bootstrap-token";
    await seedBootstrapToken(hostId, bootstrapToken);
    const runtimeEnv = agentEnv(STRONG_SECRET);
    const bootstrap = await handleAgentBootstrap(
      bootstrapRequest(hostId, bootstrapToken),
      runtimeEnv,
    );
    expect(bootstrap.status).toBe(200);
    const oldJwt = ((await bootstrap.json()) as { accessToken: string })
      .accessToken;

    const db = drizzle(env.DB);
    const oldAdmission = await env.DB.prepare(
      `SELECT source_invite_id, source_lease_id, granted_at
       FROM access_allowlist WHERE user_id = 'user-valid-secret'`,
    ).first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
    expect(oldAdmission).not.toBeNull();
    const equalGrantedAt = oldAdmission!.granted_at;
    const base = equalGrantedAt - 10;
    const revoked = await revokeBetaUser({
      d1: env.DB,
      userId: "user-valid-secret",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "stale_agent_jwt_test",
      now: base,
    });
    const cleanup = await acquireBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-valid-secret",
      revocationId: revoked.revocationId,
      now: base + 1,
    });
    expect(cleanup.status).toBe("acquired");
    await completeBetaRevocationCleanup({
      d1: env.DB,
      userId: "user-valid-secret",
      revocationId: revoked.revocationId,
      cleanupAttemptId: cleanup.cleanupAttemptId,
      now: base + 2,
    });
    await allowBetaReinvite({
      d1: env.DB,
      userId: "user-valid-secret",
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      revocationId: revoked.revocationId,
      now: base + 3,
    });

    const freshInviteId = "fresh-agent-admission-invite";
    const freshLeaseId = "fresh-agent-admission-lease";
    const freshCreatedAt = base + 4;
    await db.insert(accessInviteCodes).values({
      id: freshInviteId,
      codeHash: await sha256Hex("fresh-agent-admission-code"),
      codePrefix: "fixture",
      kind: "standard",
      state: "leased",
      createdBy: FIXTURE_BETA_ADMIN_ID,
      createdAt: freshCreatedAt,
      expiresAt: freshCreatedAt + 172_800_000,
      leaseId: freshLeaseId,
      leasedAt: freshCreatedAt,
      leaseExpiresAt: freshCreatedAt + 600_000,
      updatedAt: freshCreatedAt,
    });
    await confirmAccessInvite({
      d1: env.DB,
      inviteId: freshInviteId,
      leaseId: freshLeaseId,
      userId: "user-valid-secret",
      githubAccountId: "test-github-account-user-valid-secret",
      githubUsername: "user-valid-secret",
      now: equalGrantedAt,
    });
    const freshAdmission = await env.DB.prepare(
      `SELECT source_invite_id, source_lease_id, granted_at
       FROM access_allowlist WHERE user_id = 'user-valid-secret'`,
    ).first<{
      source_invite_id: string;
      source_lease_id: string;
      granted_at: number;
    }>();
    expect(freshAdmission).toEqual({
      source_invite_id: freshInviteId,
      source_lease_id: freshLeaseId,
      granted_at: equalGrantedAt,
    });
    expect(freshAdmission!.granted_at).toBe(oldAdmission!.granted_at);

    const verified = await requireVerifiedAgentRequest(
      new Request("http://localhost/agent/connect", {
        headers: { authorization: `Bearer ${oldJwt}` },
      }),
      runtimeEnv,
      hostId,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.response.status).toBe(401);
    await expect(verified.response.json()).resolves.toEqual({
      error: "stale beta admission",
    });
  });
});

function agentEnv(secret: string | undefined): Cloudflare.Env {
  return {
    DB: env.DB,
    AGENT_JWT_SECRET: secret,
    AGENT_JWT_ISSUER: "intar-agent-bridge",
    AGENT_JWT_AUDIENCE: "agent-connect",
  } as unknown as Cloudflare.Env;
}

function bootstrapRequest(hostId: string, bootstrapToken: string): Request {
  return new Request("http://localhost/agent/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, bootstrapToken }),
  });
}

async function seedBootstrapToken(
  hostId: string,
  bootstrapToken: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({
    id: "user-valid-secret",
    name: "Agent Owner",
    email: "agent-owner@example.com",
  });
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "user-valid-secret",
    githubAccountId: "test-github-account-user-valid-secret",
    githubUsername: "user-valid-secret",
  });
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-valid-secret",
    name: "Valid Secret Host",
  });
  await db.insert(agentBootstrapTokens).values({
    id: "bootstrap-valid-secret",
    hostId,
    tokenHash: await sha256Hex(bootstrapToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
}
