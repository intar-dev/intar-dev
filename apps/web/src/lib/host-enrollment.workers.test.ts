/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it } from "vitest";
import { user } from "@/db/schema";
import type { UserContext } from "./agent-bridge";
import { createHostEnrollment, claimHostEnrollment, randomHostSecret } from "./host-enrollment";
import { handleHostEnrollment } from "@/control-plane/host-enrollment";
import { resetD1Database } from "@/test/d1-migrations";
import { ensureFixtureMember, revokeFixtureAccount } from "@/test/account-fixtures";

let context: UserContext;
beforeEach(async () => {
  await resetD1Database();
  await drizzle(env.DB).insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await ensureFixtureMember({ d1: env.DB, userId: "owner" });
  context = {
    userId: "owner", sessionId: "browser",
    role: "user", isAdmin: false, organizationIds: [], activeOrganizationId: null,
  };
});

it("allows only one durable credential across concurrent claims and lost-response retries", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  const credentials = [randomHostSecret(), randomHostSecret()];
  const claims = await Promise.all(credentials.map(secret => claimHostEnrollment(env.DB, enrollment.enrollmentToken, secret)));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winner = claims.findIndex(Boolean);
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credentials[winner]!)).toEqual(claims[winner]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_hosts").first()).toEqual({ n: 1 });
  await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credentials[winner]!)).toBeNull();
});

it("rejects an expired unclaimed token and does not create a host", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  expect(enrollment.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  await env.DB.prepare("UPDATE host_enrollments SET expires_at = 0").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, randomHostSecret())).toBeNull();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_hosts").first()).toEqual({ n: 0 });
});

it("rejects a lost-response retry and new enrollments after the owner's account is revoked", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  const credential = randomHostSecret();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).not.toBeNull();
  await revokeFixtureAccount({ d1: env.DB, userId: "owner" });
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).toBeNull();
  await expect(createHostEnrollment(env.DB, context, { name: "Second", scope: "personal", role: "agent" }))
    .rejects.toMatchObject({ code: "host_enrollment_changed" });
});

it("rechecks platform administrator rights when claiming an enrollment", async () => {
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'owner'").run();
  const enrollment = await createHostEnrollment(env.DB, { ...context, isAdmin: true }, {
    name: "Builder", scope: "platform", role: "builder",
  });
  await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = 'owner'").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, randomHostSecret())).toBeNull();
});

it("claims an enrollment through the public endpoint without a registration gate", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  const enroll = (enrollmentToken: string) => handleHostEnrollment(new Request("https://intar.dev/agent/enroll", {
    method: "POST", body: JSON.stringify({ enrollmentToken, credential: randomHostSecret() }),
  }), env);
  expect((await enroll(randomHostSecret())).status).toBe(401);
  const response = await enroll(enrollment.enrollmentToken);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toMatchObject({ hostId: enrollment.hostId, ownerUserId: "owner", scope: "personal" });
});

it("ignores leftover drained registration gate rows", async () => {
  // Production D1 keeps the retired gate rows; nothing may read them any more.
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key,state,updated_at) VALUES " +
    "('personal_metal_registration','drained',1), ('platform_metal_registration','drained',1)").run();
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'owner'").run();
  const admin = { ...context, isAdmin: true };
  const personal = await createHostEnrollment(env.DB, admin, { name: "Personal", scope: "personal", role: "agent" });
  const platform = await createHostEnrollment(env.DB, admin, { name: "Builder", scope: "platform", role: "builder" });
  expect(await claimHostEnrollment(env.DB, personal.enrollmentToken, randomHostSecret())).toMatchObject({ scope: "personal" });
  expect(await claimHostEnrollment(env.DB, platform.enrollmentToken, randomHostSecret())).toMatchObject({ scope: "platform" });
});
