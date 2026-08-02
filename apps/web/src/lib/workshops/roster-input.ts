import type { WorkshopSessionRole } from "@/db/schema";

export interface WorkshopRosterInput {
  userId: string;
  role: WorkshopSessionRole;
  workspaceEnabled?: boolean;
}

/**
 * Keep an explicitly selected role for the manager. Session creation still
 * defaults the manager to facilitator when the roster omits them entirely.
 * Participant remains the backwards-compatible learner role; staff only gain
 * a learner workspace when it is explicitly requested.
 */
export function withWorkshopManagerRosterDefault(
  members: WorkshopRosterInput[],
  managerUserId: string,
): WorkshopRosterInput[] {
  const rosterByUser = new Map(
    members.map((entry) => [
      entry.userId,
      {
        ...entry,
        workspaceEnabled:
          entry.role === "participant" || entry.workspaceEnabled === true,
      },
    ] as const),
  );
  if (!rosterByUser.has(managerUserId)) {
    rosterByUser.set(managerUserId, {
      userId: managerUserId,
      role: "facilitator",
      workspaceEnabled: false,
    });
  }
  return [...rosterByUser.values()];
}
