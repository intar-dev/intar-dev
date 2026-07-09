/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleAgentBootstrap,
  requireVerifiedAgentRequest,
  sha256Hex,
} from "./auth";
import { agentBootstrapTokens, agentHosts, user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";

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
      agent: { hostId, userId: "user-valid-secret", role: "agent" },
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
