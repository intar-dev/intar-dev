/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it } from "vitest";
import { user } from "@/db/schema";
import type { UserContext } from "./agent-bridge";
import { createHostEnrollment, claimHostEnrollment, randomHostSecret } from "./host-enrollment";
import { handleHostEnrollment } from "@/control-plane/host-enrollment";
import { resetD1Database } from "@/test/d1-migrations";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";

let context: UserContext;
beforeEach(async () => {
  await resetD1Database();
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key, state, updated_at) VALUES ('personal_metal_registration', 'open', 1)").run();
  await drizzle(env.DB).insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner" });
  const admission = await env.DB.prepare(
    "SELECT source_invite_id AS sourceInviteId, source_lease_id AS sourceLeaseId, granted_at AS grantedAt FROM access_allowlist WHERE user_id = 'owner'",
  ).first<UserContext["betaAdmission"]>();
  context = {
    userId: "owner", sessionId: "browser", betaAdmission: admission!,
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

it("rejects a lost-response retry after the owner's admission changes", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  const credential = randomHostSecret();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).not.toBeNull();
  await env.DB.prepare("UPDATE access_allowlist SET granted_at = granted_at + 1 WHERE user_id = 'owner'").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).toBeNull();
});

it("rechecks platform administrator rights when claiming an enrollment", async () => {
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key,state,updated_at) VALUES ('platform_metal_registration','open',1)").run();
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'owner'").run();
  const enrollment = await createHostEnrollment(env.DB, { ...context, isAdmin: true }, {
    name: "Builder", scope: "platform", role: "builder",
  });
  await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = 'owner'").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, randomHostSecret())).toBeNull();
});

it("keeps the public enrollment endpoint closed until release validation opens it", async () => {
  await env.DB.prepare("DELETE FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").run();
  const response = await handleHostEnrollment(new Request("https://intar.dev/agent/enroll", {
    method: "POST", body: JSON.stringify({ enrollmentToken: randomHostSecret(), credential: randomHostSecret() }),
  }), env);
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("checks the registration gate again inside enrollment writes", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Server", scope: "personal", role: "agent" });
  const credential = randomHostSecret();
  // The route has already read an open gate. Maintenance starts before claim.
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'drained'").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).toBeNull();
  await expect(createHostEnrollment(env.DB, context, { name: "Second", scope: "personal", role: "agent" })).rejects.toThrow();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_hosts").first()).toEqual({ n: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_bootstrap_tokens").first()).toEqual({ n: 0 });
  expect(await env.DB.prepare("SELECT claimed_at FROM host_enrollments").first()).toEqual({ claimed_at: null });
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'open'").run();
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).not.toBeNull();
});

it("registers the admin platform fleet while personal registration stays closed", async () => {
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'drained' WHERE key = 'personal_metal_registration'").run();
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key,state,updated_at) VALUES ('platform_metal_registration','open',1)").run();
  await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'owner'").run();
  const admin = { ...context, isAdmin: true };
  await expect(createHostEnrollment(env.DB, admin, { name: "Personal", scope: "personal", role: "agent" })).rejects.toThrow();
  const enrollment = await createHostEnrollment(env.DB, admin, { name: "Builder", scope: "platform", role: "builder" });
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, randomHostSecret())).toMatchObject({ scope: "platform" });
});
