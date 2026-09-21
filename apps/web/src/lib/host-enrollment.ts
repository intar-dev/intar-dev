import { sha256Hex } from "@/control-plane/auth";
import type { UserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

// Check this inside each write transaction. A route check can become stale
// while it reads the request body or hashes a credential.
function registrationOpen(scopeSql: string): string {
  return `EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = CASE WHEN ${scopeSql} = 'platform'
    THEN 'platform_metal_registration' ELSE 'personal_metal_registration' END AND state = 'open')`;
}

export function randomHostSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function createHostEnrollment(db: D1Database, context: UserContext, input: {
  name: string;
  scope: "personal" | "platform" | "organization";
  organizationId?: string;
  role: "agent" | "builder";
}) {
  if (input.scope === "platform" && !context.isAdmin) throw new Error("Platform admin required");
  if (input.scope !== "platform" && input.role !== "agent") throw new Error("User-managed servers cannot build images");
  if ((input.scope === "organization") !== Boolean(input.organizationId)) {
    throw appError(400, "invalid_server_organization", "Organization servers must belong to an organization.");
  }
  const token = randomHostSecret();
  const hostId = createAppId();
  const expiresAt = Date.now() + 15 * 60_000;
  const epoch = context.betaAdmission;
  const row = await db.prepare(
    "INSERT INTO host_enrollments (token_hash, host_id, user_id, name, scope, role, source_invite_id, source_lease_id, granted_at, expires_at, organization_id) " +
    "SELECT ?1, ?2, user_id, ?3, ?4, ?5, source_invite_id, source_lease_id, granted_at, ?6, ?11 FROM access_allowlist " +
    "WHERE user_id = ?7 AND state = 'active' AND source_invite_id = ?8 AND source_lease_id = ?9 AND granted_at = ?10 " +
    "AND EXISTS (SELECT 1 FROM user WHERE id = ?7 AND coalesce(banned, 0) = 0 AND deleted_at IS NULL) " +
    "AND (?4 <> 'organization' OR EXISTS (SELECT 1 FROM member WHERE user_id = ?7 AND organization_id = ?11 AND role IN ('owner', 'admin'))) " +
    "AND (?4 <> 'platform' OR EXISTS (SELECT 1 FROM user WHERE id = ?7 AND instr(',' || replace(lower(coalesce(role, '')), ' ', '') || ',', ',admin,') > 0 AND coalesce(banned, 0) = 0 AND deleted_at IS NULL)) AND " + registrationOpen("?4") + " RETURNING host_id",
  ).bind(await sha256Hex(token), hostId, input.name, input.scope, input.role, expiresAt,
    context.userId, epoch.sourceInviteId, epoch.sourceLeaseId, epoch.grantedAt, input.organizationId ?? null).first();
  if (!row) throw appError(409, "host_enrollment_changed", "Registration changed. Reload My servers and try again.");
  return { hostId, enrollmentToken: token, expiresAt };
}

/** All claim steps use the same secret and admission epoch within one D1 transaction. */
export async function claimHostEnrollment(db: D1Database, token: string, credential: string) {
  if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(credential)) return null;
  const tokenHash = await sha256Hex(token);
  const credentialHash = await sha256Hex(credential);
  const now = Date.now();
  const active = registrationOpen("enrollment.scope") + " AND EXISTS (SELECT 1 FROM access_allowlist access WHERE access.user_id = enrollment.user_id " +
    "AND access.state = 'active' AND access.source_invite_id = enrollment.source_invite_id " +
    "AND access.source_lease_id = enrollment.source_lease_id AND access.granted_at = enrollment.granted_at) " +
    "AND EXISTS (SELECT 1 FROM user WHERE id = enrollment.user_id AND coalesce(banned, 0) = 0 AND deleted_at IS NULL) " +
    "AND (enrollment.scope <> 'organization' OR (enrollment.role = 'agent' AND EXISTS (SELECT 1 FROM member " +
    "WHERE user_id = enrollment.user_id AND organization_id = enrollment.organization_id AND role IN ('owner', 'admin')))) " +
    "AND (enrollment.scope <> 'platform' OR EXISTS (SELECT 1 FROM user WHERE id = enrollment.user_id " +
    "AND instr(',' || replace(lower(coalesce(role, '')), ' ', '') || ',', ',admin,') > 0 AND coalesce(banned, 0) = 0 AND deleted_at IS NULL))";
  const eligible = "enrollment.token_hash = ?1 AND enrollment.credential_hash = ?2 AND enrollment.revoked_at IS NULL AND " + active;
  await db.batch([
    db.prepare("UPDATE host_enrollments AS enrollment SET credential_hash = ?2, claimed_at = ?3 " +
      "WHERE token_hash = ?1 AND claimed_at IS NULL AND expires_at > ?3 AND revoked_at IS NULL AND " + active)
      .bind(tokenHash, credentialHash, now),
    db.prepare("INSERT INTO agent_hosts (id, user_id, name, scope, role, organization_id, credential_generation, scenario_enabled, disabled, connected, created_at, updated_at) " +
      "SELECT enrollment.host_id, enrollment.user_id, enrollment.name, enrollment.scope, enrollment.role, enrollment.organization_id, 1, CASE WHEN enrollment.role = 'agent' THEN 1 ELSE 0 END, 0, 0, ?3, ?3 " +
      "FROM host_enrollments enrollment WHERE " + eligible + " AND enrollment.claimed_at = ?3 " +
      "ON CONFLICT (id) DO NOTHING").bind(tokenHash, credentialHash, now),
    db.prepare("INSERT INTO agent_bootstrap_tokens (id, host_id, token_hash, credential_generation, created_at) " +
      "SELECT enrollment.host_id, enrollment.host_id, ?2, 1, ?3 FROM host_enrollments enrollment " +
      "JOIN agent_hosts host ON host.id = enrollment.host_id WHERE " + eligible +
      " AND host.disabled = 0 AND host.credential_generation = 1 AND enrollment.claimed_at = ?3 " +
      "ON CONFLICT (id) DO NOTHING").bind(tokenHash, credentialHash, now),
  ]);
  // A lost-response retry can recover the claim, but cannot replace or revive credentials.
  return db.prepare("SELECT host.id AS hostId, host.user_id AS ownerUserId, host.scope, host.organization_id AS organizationId, host.credential_generation AS credentialGeneration " +
    "FROM host_enrollments enrollment JOIN agent_hosts host ON host.id = enrollment.host_id " +
    "JOIN agent_bootstrap_tokens credential ON credential.host_id = host.id AND credential.token_hash = ?2 " +
    "WHERE " + eligible + " AND host.disabled = 0 AND host.credential_generation = 1 " +
    "AND credential.credential_generation = host.credential_generation " +
    "AND credential.revoked_at IS NULL AND (credential.expires_at IS NULL OR credential.expires_at > ?3)")
    .bind(tokenHash, credentialHash, now).first();
}
