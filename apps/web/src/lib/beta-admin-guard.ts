import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

interface AdminAccessRow {
  target_is_active_admin: number;
  active_admin_count: number;
}

/**
 * Platform administration is useful only while at least one active beta user
 * can reach it. This guard is shared by beta revocation and native Better Auth
 * ban/role/removal routes.
 */
export async function assertNotLastActivePlatformAdmin(
  targetUserId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT
       EXISTS(
         SELECT 1
         FROM access_allowlist AS access
         INNER JOIN user AS identity ON identity.id = access.user_id
         WHERE access.user_id = ?1
           AND access.state = 'active'
           AND identity.role = 'admin'
           AND identity.banned = 0
       ) AS target_is_active_admin,
       (
         SELECT COUNT(*)
         FROM access_allowlist AS access
         INNER JOIN user AS identity ON identity.id = access.user_id
         WHERE access.state = 'active'
           AND identity.role = 'admin'
           AND identity.banned = 0
       ) AS active_admin_count`,
  )
    .bind(targetUserId)
    .first<AdminAccessRow>();

  if (row?.target_is_active_admin === 1 && row.active_admin_count <= 1) {
    throw appError(
      409,
      "last_active_admin",
      "the last active platform administrator cannot be removed",
    );
  }
}

export async function guardNativeAdminMutation(request: Request): Promise<void> {
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/u, "");
  if (
    path !== "/admin/ban-user" &&
    path !== "/admin/remove-user" &&
    path !== "/admin/set-role" &&
    path !== "/admin/update-user"
  ) {
    return;
  }

  const body = (await request.clone().json().catch(() => null)) as
    | {
        userId?: unknown;
        role?: unknown;
        data?: { role?: unknown; banned?: unknown };
      }
    | null;
  const targetUserId =
    typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!targetUserId) return;

  if (path === "/admin/set-role") {
    const roles = Array.isArray(body?.role) ? body.role : [body?.role];
    if (roles.some((role) => role === "admin")) return;
  }

  if (path === "/admin/update-user") {
    const data = body?.data;
    const removesAdmin =
      data?.role !== undefined && data.role !== "admin";
    const bansUser = data?.banned === true;
    if (!removesAdmin && !bansUser) return;
  }

  await assertNotLastActivePlatformAdmin(targetUserId);
}
