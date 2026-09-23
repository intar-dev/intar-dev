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
  agentBootstrapTokens,
  agentHosts,
  user,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureMember,
  revokeFixtureAccount,
} from "@/test/account-fixtures";

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
      },
    });
  });

  it("authenticates organization credentials independently of the creator", async () => {
    const hostId = "organization-host";
    await seedBootstrapToken(hostId, "organization-secret");
    await env.DB.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org-1','Org','org-1',1)").run();
    await env.DB.prepare("UPDATE agent_hosts SET scope='organization', organization_id='org-1' WHERE id=?").bind(hostId).run();
    await env.DB.prepare("UPDATE user SET banned=1, deleted_at=1 WHERE id='user-valid-secret'").run();
    const runtimeEnv = agentEnv(STRONG_SECRET);
    const response = await handleAgentBootstrap(bootstrapRequest(hostId, "organization-secret"), runtimeEnv);
    expect(response.status).toBe(200);
    const body = await response.json() as { accessToken: string; organizationId: string };
    expect(body.organizationId).toBe("org-1");
    const verify = () => requireVerifiedAgentRequest(new Request("http://localhost/agent/connect", {
      headers: { authorization: `Bearer ${body.accessToken}` },
    }), runtimeEnv, hostId);
    expect(await verify()).toMatchObject({ ok: true, agent: { scope: "organization", organizationId: "org-1",
      userId: "user-valid-secret" } });
    await env.DB.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org-2','Other','org-2',1)").run();
    await env.DB.prepare("UPDATE agent_hosts SET organization_id='org-2' WHERE id=?").bind(hostId).run();
    expect((await verify()).ok).toBe(false);
    await env.DB.prepare("UPDATE agent_hosts SET organization_id='org-1', disabled=1 WHERE id=?").bind(hostId).run();
    expect((await verify()).ok).toBe(false);
    expect((await handleAgentBootstrap(bootstrapRequest(hostId, "organization-secret"), runtimeEnv)).status).toBe(403);
    await env.DB.prepare("UPDATE agent_hosts SET disabled=0 WHERE id=?").bind(hostId).run();
    expect((await verify()).ok).toBe(true);
    await env.DB.prepare("UPDATE agent_hosts SET scope='platform', organization_id=NULL WHERE id=?").bind(hostId).run();
    expect((await verify()).ok).toBe(false);
  });

  it("rejects both an issued JWT and the old durable secret after generation changes", async () => {
    const hostId = "host-credential-generation";
    await seedBootstrapToken(hostId, "old-secret");
    const runtimeEnv = agentEnv(STRONG_SECRET);
    const bootstrap = await handleAgentBootstrap(bootstrapRequest(hostId, "old-secret"), runtimeEnv);
    expect(bootstrap.status).toBe(200);
    const { accessToken } = await bootstrap.json() as { accessToken: string };
    await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = ?").bind(hostId).run();
    const replay = await handleAgentBootstrap(bootstrapRequest(hostId, "old-secret"), runtimeEnv);
    expect(replay.status).toBe(401);
    const verified = await requireVerifiedAgentRequest(new Request("http://localhost/agent/connect", {
      headers: { authorization: `Bearer ${accessToken}` },
    }), runtimeEnv, hostId);
    expect(verified.ok).toBe(false);
  });

  it("refuses a personal host once its owner's account is revoked", async () => {
    const hostId = "host-revoked-owner";
    const bootstrapToken = "revoked-owner-bootstrap-token";
    await seedBootstrapToken(hostId, bootstrapToken);
    const runtimeEnv = agentEnv(STRONG_SECRET);
    const bootstrap = await handleAgentBootstrap(
      bootstrapRequest(hostId, bootstrapToken),
      runtimeEnv,
    );
    expect(bootstrap.status).toBe(200);
    const { accessToken } = (await bootstrap.json()) as { accessToken: string };

    await revokeFixtureAccount({ d1: env.DB, userId: "user-valid-secret" });

    const refused = await handleAgentBootstrap(
      bootstrapRequest(hostId, bootstrapToken),
      runtimeEnv,
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      error: "account access is revoked",
    });
    const verified = await requireVerifiedAgentRequest(
      new Request("http://localhost/agent/connect", {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
      runtimeEnv,
      hostId,
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.response.status).toBe(403);
    await expect(verified.response.json()).resolves.toEqual({
      error: "account access is revoked",
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
  await ensureFixtureMember({
    d1: env.DB,
    userId: "user-valid-secret",
    githubAccountId: "test-github-account-user-valid-secret",
  });
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-valid-secret",
    name: "Valid Secret Host",
    scope: "personal",
    credentialGeneration: 1,
  });
  await db.insert(agentBootstrapTokens).values({
    id: "bootstrap-valid-secret",
    credentialGeneration: 1,
    hostId,
    tokenHash: await sha256Hex(bootstrapToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
}
