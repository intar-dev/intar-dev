import { and, eq, isNull, lte, or } from "drizzle-orm";
import { workshopSessionMembers } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { requireWorkshopSessionMember, workshopDb } from "./shared";

export type WorkshopPresenceState = "present" | "stale" | "absent";

export const WORKSHOP_PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKSHOP_PRESENCE_FRESH_MS = 30_000;
export const WORKSHOP_PRESENCE_ABSENT_MS = 2 * 60_000;
const WORKSHOP_PRESENCE_WRITE_MIN_INTERVAL_MS = 10_000;

export async function recordWorkshopPresence(params: {
  sessionId: string;
  userId: string;
}): Promise<{
  observedAt: number;
  lastSeenAt: number;
  state: WorkshopPresenceState;
}> {
  const access = await requireWorkshopSessionMember(params);
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_presence_closed",
      "workshop presence is only recorded while the room is open",
    );
  }

  const observedAt = Date.now();
  const db = workshopDb();
  const updated = await db
    .update(workshopSessionMembers)
    .set({ lastSeenAt: observedAt })
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, params.userId),
        or(
          isNull(workshopSessionMembers.lastSeenAt),
          lte(
            workshopSessionMembers.lastSeenAt,
            observedAt - WORKSHOP_PRESENCE_WRITE_MIN_INTERVAL_MS,
          ),
        ),
      ),
    )
    .returning({ lastSeenAt: workshopSessionMembers.lastSeenAt });
  const lastSeenAt =
    updated[0]?.lastSeenAt ??
    (
      await db
        .select({ lastSeenAt: workshopSessionMembers.lastSeenAt })
        .from(workshopSessionMembers)
        .where(
          and(
            eq(workshopSessionMembers.sessionId, params.sessionId),
            eq(workshopSessionMembers.userId, params.userId),
          ),
        )
        .limit(1)
    )[0]?.lastSeenAt;
  if (lastSeenAt === null || lastSeenAt === undefined) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  return {
    observedAt,
    lastSeenAt,
    state: workshopPresenceState(lastSeenAt, observedAt),
  };
}

export function workshopPresenceState(
  lastSeenAt: number | null,
  observedAt: number,
): WorkshopPresenceState {
  if (lastSeenAt === null || observedAt - lastSeenAt > WORKSHOP_PRESENCE_ABSENT_MS) {
    return "absent";
  }
  return observedAt - lastSeenAt <= WORKSHOP_PRESENCE_FRESH_MS
    ? "present"
    : "stale";
}
