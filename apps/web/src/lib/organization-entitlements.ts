import { env } from "cloudflare:workers";
import { activeAdminSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";

/**
 * Grants or revokes an organization's `public_play` entitlement, which lets
 * its play scenarios open to everyone signed in. Only an active platform
 * admin may change it; the check runs inside the write.
 *
 * It is not granted while the organization's scenario source promotes by
 * itself (#472): whoever can push to its default branch would publish to
 * everyone, with images nobody reviewed. A source is not set to automatic
 * while the grant holds either (`changeScenarioSource`).
 */
/** Holds while the organization `org` has a connected scenario source that promotes by itself. */
const AUTOMATIC_SOURCE = `EXISTS (SELECT 1 FROM scenario_sources source
  WHERE source.organization_id = org.id AND source.promotion = 'automatic' AND source.disconnected_at IS NULL)`;

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
        AND (?3 IS NULL OR NOT ${AUTOMATIC_SOURCE})
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
  const admin = await env.DB.prepare(`SELECT 1 FROM user actor WHERE actor.id = ?1 AND ${activeAdminSql("actor")}`)
    .bind(params.actorUserId).first();
  if (!admin) throw appError(403, "admin_required", "Active administrator access is required");
  throw appError(409, "public_play_automatic_promotion",
    "This organization's scenario source puts its labs live by itself. Set it to manual promotion before opening its play labs to everyone.");
}
