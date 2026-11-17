import { env } from "cloudflare:workers";
import { activeAdminSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";

/**
 * Grants or revokes an organization's `public_play` entitlement, which lets
 * its play scenarios open to everyone signed in. Only an active platform
 * admin may change it; the check runs inside the write.
 */
export async function setPublicPlay(params: {
  organizationId: string;
  actorUserId: string;
  granted: boolean;
}): Promise<{ organizationId: string; publicPlayGrantedAt: number | null }> {
  const grantedAt = params.granted ? Date.now() : null;
  const written = await env.DB.prepare(
    `INSERT INTO organization_entitlements (organization_id, public_play_granted_at, granted_by)
     SELECT org.id, ?3, ?2 FROM organization org
      WHERE org.id = ?1
        AND EXISTS (SELECT 1 FROM user actor WHERE actor.id = ?2 AND ${activeAdminSql("actor")})
     ON CONFLICT (organization_id) DO UPDATE SET
       public_play_granted_at = CASE WHEN excluded.public_play_granted_at IS NULL THEN NULL
         ELSE coalesce(organization_entitlements.public_play_granted_at, excluded.public_play_granted_at) END,
       granted_by = excluded.granted_by
     RETURNING public_play_granted_at`,
  ).bind(params.organizationId, params.actorUserId, grantedAt)
    .first<{ public_play_granted_at: number | null }>();
  if (written) {
    return { organizationId: params.organizationId, publicPlayGrantedAt: written.public_play_granted_at };
  }
  const exists = await env.DB.prepare("SELECT 1 FROM organization WHERE id = ?1")
    .bind(params.organizationId).first();
  if (!exists) throw appError(404, "organization_not_found", "organization not found");
  throw appError(403, "admin_required", "Active administrator access is required");
}
