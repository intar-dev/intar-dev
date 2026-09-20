import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { appError } from "@/lib/app-error";

// All management writes recheck the admission observed by the request.
export const currentPersonalOwnerSql = `EXISTS (SELECT 1 FROM access_allowlist access
  JOIN user owner ON owner.id = access.user_id
  WHERE access.user_id = ?1 AND access.state = 'active'
    AND access.source_invite_id = ?2 AND access.source_lease_id = ?3 AND access.granted_at = ?4
    AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0)`;

/** Revoke access and change placement in one transaction; network cleanup can be retried. */
export async function retirePersonalHost(input: {
  d1: D1Database; hostId: string; userId: string; betaAdmission: BetaAdmissionEpoch;
  confirmReturnToCloud?: boolean; now?: number;
}): Promise<{ placement: "platform" | "personal" }> {
  const { d1, hostId, userId, betaAdmission } = input;
  const now = input.now ?? Date.now();
  const removalId = crypto.randomUUID();
  const args = [userId, betaAdmission.sourceInviteId, betaAdmission.sourceLeaseId, betaAdmission.grantedAt, hostId] as const;
  const owned = `id = ?5 AND user_id = ?1 AND scope = 'personal' AND ${currentPersonalOwnerSql}`;
  const retired = `EXISTS (SELECT 1 FROM agent_hosts WHERE ${owned} AND disabled = 1 AND owner_removal_id IS NOT NULL)`;
  const [removed] = await d1.batch([
    d1.prepare(`UPDATE agent_hosts SET disabled = 1, scenario_enabled = 0, connected = 0,
      active_session_id = NULL, disconnected_at = ?6, updated_at = ?6,
      credential_generation = credential_generation + CASE WHEN disabled = 0 THEN 1 ELSE 0 END, owner_removal_id = ?7
      WHERE ${owned} AND (disabled = 0 OR owner_removal_id IS NULL) AND (?8 = 1
        OR NOT EXISTS (SELECT 1 FROM user WHERE id = ?1 AND metal_placement = 'personal')
        OR EXISTS (SELECT 1 FROM agent_hosts other WHERE other.user_id = ?1 AND other.scope = 'personal' AND other.disabled = 0 AND other.id <> ?5))
      RETURNING id`).bind(...args, now, removalId, input.confirmReturnToCloud === true ? 1 : 0),
    d1.prepare(`UPDATE user SET metal_placement = 'platform' WHERE id = ?1
      AND EXISTS (SELECT 1 FROM agent_hosts WHERE ${owned} AND owner_removal_id = ?6)
      AND NOT EXISTS (SELECT 1 FROM agent_hosts WHERE user_id = ?1 AND scope = 'personal' AND disabled = 0)`)
      .bind(...args, removalId),
    d1.prepare(`UPDATE agent_bootstrap_tokens SET revoked_at = ?6 WHERE host_id = ?5 AND revoked_at IS NULL AND ${retired}`).bind(...args, now),
    d1.prepare(`UPDATE host_enrollments SET revoked_at = ?6 WHERE host_id = ?5 AND revoked_at IS NULL AND ${retired}`).bind(...args, now),
    // Preserve issued leases for offline hardware. Unissued work can expire now.
    d1.prepare(`UPDATE runtime_executions SET lease_expires_at = ?6, updated_at = ?6
      WHERE host_id = ?5 AND state <> 'archived' AND lease_expires_at IS NULL AND ${retired}`).bind(...args, now),
  ]);
  const result = await d1.prepare(`SELECT host.disabled, host.owner_removal_id, user.metal_placement AS placement
    FROM agent_hosts host JOIN user ON user.id = host.user_id
    WHERE host.id = ?5 AND host.user_id = ?1 AND host.scope = 'personal' AND ${currentPersonalOwnerSql}`)
    .bind(...args).first<{ disabled: number; owner_removal_id: string | null; placement: "platform" | "personal" }>();
  if (!result) throw appError(404, "server_not_found", "Server not found. Refresh My servers.");
  if (!removed?.results.length && (!result.disabled || !result.owner_removal_id)) {
    throw appError(409, "last_server_confirmation_required", "This is your last server. Confirm removal to use cloud for new runs.");
  }
  return { placement: result.placement };
}
