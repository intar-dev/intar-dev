import type { WorkshopSessionRole } from "@/db/schema";

/**
 * Keep an explicitly selected role for the manager. Session creation still
 * defaults the manager to facilitator when the roster omits them entirely.
 */
export function withWorkshopManagerRosterDefault(
  members: Array<{ userId: string; role: WorkshopSessionRole }>,
  managerUserId: string,
): Array<{ userId: string; role: WorkshopSessionRole }> {
  const rosterByUser = new Map(
    members.map((entry) => [entry.userId, entry.role] as const),
  );
  if (!rosterByUser.has(managerUserId)) {
    rosterByUser.set(managerUserId, "facilitator");
  }
  return [...rosterByUser].map(([userId, role]) => ({ userId, role }));
}
