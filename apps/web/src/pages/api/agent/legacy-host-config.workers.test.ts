/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it, vi } from "vitest";
import { user } from "@/db/schema";
import { handleAgentBootstrap, requireVerifiedAgentRequest } from "@/control-plane/auth";
import type { UserContext } from "@/lib/agent-bridge";
import { claimHostEnrollment, createHostEnrollment, randomHostSecret } from "@/lib/host-enrollment";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const auth = vi.hoisted(() => ({
  requireAdminUserContext: vi.fn(),
  requireUserContext: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/agent-bridge")>(),
  ...auth,
}));

import { POST as hostConfig } from "./hosts";

let context: UserContext;
beforeEach(async () => {
  await resetD1Database();
  await env.DB.prepare(
    "INSERT INTO runtime_operation_gates (key, state) VALUES ('personal_metal_registration', 'open'), ('platform_metal_registration', 'open')",
  ).run();
  await drizzle(env.DB).insert(user).values({
    id: "owner", name: "Owner", email: "owner@example.test", role: "admin",
  });
  await ensureFixtureMember({ d1: env.DB, userId: "owner" });
  context = {
    userId: "owner", sessionId: "browser",
    role: "admin", isAdmin: true, organizationIds: [], activeOrganizationId: null,
  };
  auth.requireAdminUserContext.mockResolvedValue({ ok: true, context });
  auth.requireUserContext.mockResolvedValue({ ok: true, context });
});

it.each(["personal", "platform"] as const)("keeps a %s credential valid after legacy config requests", async scope => {
  const enrollment = await createHostEnrollment(env.DB, context, {
    name: "Enrolled server", scope, role: "agent",
  });
  const credential = randomHostSecret();
  const claim = await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential);
  expect(claim).not.toBeNull();
  const bootstrap = () => handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
    method: "POST",
    body: JSON.stringify({ hostId: enrollment.hostId, bootstrapToken: credential }),
  }), env);
  expect((await bootstrap()).status).toBe(200);
  const before = await env.DB.prepare("SELECT * FROM agent_bootstrap_tokens").all();
  const hostsBefore = await env.DB.prepare("SELECT * FROM agent_hosts").all();

  for (const [path, route] of [
    ["/api/agent/hosts", hostConfig],
  ] as const) {
    for (const body of [
      { name: "New legacy server", role: "agent" },
      { hostId: enrollment.hostId, runnerId: enrollment.hostId, role: "agent" },
    ]) {
      const request = new Request(`https://intar.test${path}`, {
        method: "POST", body: JSON.stringify(body),
      });
      const response = await route({ request, url: new URL(request.url), params: { orgId: "org-1" } } as never);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "fresh_enrollment_required" });
    }
  }

  expect((await env.DB.prepare("SELECT * FROM agent_bootstrap_tokens").all()).results).toEqual(before.results);
  expect((await env.DB.prepare("SELECT * FROM agent_hosts").all()).results).toEqual(hostsBefore.results);
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).toEqual(claim);
  const response = await bootstrap();
  expect(response.status).toBe(200);
  const { accessToken } = await response.json() as { accessToken: string };
  const verified = await requireVerifiedAgentRequest(new Request("https://intar.test/agent/connect", {
    headers: { authorization: `Bearer ${accessToken}` },
  }), env, enrollment.hostId);
  expect(verified.ok).toBe(true);
});
