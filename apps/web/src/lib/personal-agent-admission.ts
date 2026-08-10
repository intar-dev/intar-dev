import type { AgentHostRole } from "@/db/schema";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";

interface PersonalHostInsert {
  hostId: string;
  userId: string;
  name: string;
  role: AgentHostRole;
  betaAdmission: BetaAdmissionEpoch;
  now: number;
}

/**
 * Creates a personal host only in the same D1 statement that observes the
 * owner's exact active beta admission. A paused HTTP request therefore cannot
 * create a host after revocation, including after the user is re-admitted.
 */
export async function insertPersonalHostForActiveBetaAdmission(
  database: D1Database,
  input: PersonalHostInsert,
): Promise<boolean> {
  const inserted = await database
    .prepare(
      `INSERT INTO agent_hosts (
         id, user_id, organization_id, name, role, scenario_enabled,
         disabled, connected, created_at, updated_at
       )
       SELECT ?1, access.user_id, NULL, ?2, ?3, ?4, 0, 0, ?5, ?5
       FROM access_allowlist access
       WHERE access.user_id = ?6
         AND access.state = 'active'
         AND access.source_invite_id = ?7
         AND access.source_lease_id = ?8
         AND access.granted_at = ?9
       RETURNING id`,
    )
    .bind(
      input.hostId,
      input.name,
      input.role,
      input.role === "agent" ? 1 : 0,
      input.now,
      input.userId,
      input.betaAdmission.sourceInviteId,
      input.betaAdmission.sourceLeaseId,
      input.betaAdmission.grantedAt,
    )
    .first<{ id: string }>();
  return inserted?.id === input.hostId;
}

interface PersonalBootstrapRotation {
  tokenId: string;
  hostId: string;
  userId: string;
  tokenHash: string;
  betaAdmission: BetaAdmissionEpoch;
  now: number;
}

/**
 * Rotates a personal bootstrap capability in one D1 transaction. Both the
 * revocation and insertion are conditioned on the same exact beta admission
 * and enabled personal host, so revocation/readmission cannot split or revive
 * a paused rotation.
 */
export async function rotatePersonalBootstrapForActiveBetaAdmission(
  database: D1Database,
  input: PersonalBootstrapRotation,
): Promise<boolean> {
  const admission = `EXISTS (
    SELECT 1
    FROM agent_hosts host
    JOIN access_allowlist access ON access.user_id = host.user_id
    WHERE host.id = ?1
      AND host.user_id = ?2
      AND host.organization_id IS NULL
      AND host.disabled = 0
      AND access.state = 'active'
      AND access.source_invite_id = ?3
      AND access.source_lease_id = ?4
      AND access.granted_at = ?5
  )`;
  const [, issued] = await database.batch([
    database
      .prepare(
        `UPDATE agent_bootstrap_tokens
         SET revoked_at = ?6
         WHERE host_id = ?1
           AND revoked_at IS NULL
           AND ${admission}`,
      )
      .bind(
        input.hostId,
        input.userId,
        input.betaAdmission.sourceInviteId,
        input.betaAdmission.sourceLeaseId,
        input.betaAdmission.grantedAt,
        input.now,
      ),
    database
      .prepare(
        `INSERT INTO agent_bootstrap_tokens (
           id, host_id, token_hash, expires_at, revoked_at, created_at
         )
         SELECT ?6, host.id, ?7, NULL, NULL, ?8
         FROM agent_hosts host
         JOIN access_allowlist access ON access.user_id = host.user_id
         WHERE host.id = ?1
           AND host.user_id = ?2
           AND host.organization_id IS NULL
           AND host.disabled = 0
           AND access.state = 'active'
           AND access.source_invite_id = ?3
           AND access.source_lease_id = ?4
           AND access.granted_at = ?5
         RETURNING id`,
      )
      .bind(
        input.hostId,
        input.userId,
        input.betaAdmission.sourceInviteId,
        input.betaAdmission.sourceLeaseId,
        input.betaAdmission.grantedAt,
        input.tokenId,
        input.tokenHash,
        input.now,
      ),
  ]);
  return (issued?.results ?? []).some(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      "id" in row &&
      row.id === input.tokenId,
  );
}
