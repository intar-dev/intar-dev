import { env } from "cloudflare:workers";
import { and, countDistinct, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  workshopSessionMembers,
  workshopSessionRuntimeSelections,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import type { ProviderPreflightResult } from "./runtime-provider";

export const WORKSHOP_PROVIDER_PREFLIGHT_TTL_MS = 5 * 60_000;

export async function countWorkshopRequestedSeats(
  sessionId: string,
): Promise<number> {
  const rows = await drizzle(env.DB)
    .select({ value: countDistinct(workshopSessionMembers.userId) })
    .from(workshopSessionMembers)
    .where(
      and(
        eq(workshopSessionMembers.sessionId, sessionId),
        eq(workshopSessionMembers.workspaceEnabled, true),
      ),
    );
  return rows[0]?.value ?? 0;
}

export async function persistWorkshopProviderPreflight(input: {
  sessionId: string;
  requestedSeats: number;
  result: ProviderPreflightResult;
  checkedAt: number;
}): Promise<void> {
  const expiresAt = input.checkedAt + WORKSHOP_PROVIDER_PREFLIGHT_TTL_MS;
  const updated = await drizzle(env.DB)
    .update(workshopSessionRuntimeSelections)
    .set({
      preflightRequestedSeats: input.requestedSeats,
      preflightAvailableSeats: input.result.availableSeats,
      preflightOk: input.result.ok,
      preflightPreferredLocation: input.result.preferredLocation,
      preflightReasonsJson: [...input.result.reasons],
      preflightCheckedAt: input.checkedAt,
      preflightExpiresAt: expiresAt,
      updatedAt: input.checkedAt,
    })
    .where(eq(workshopSessionRuntimeSelections.sessionId, input.sessionId))
    .returning({ sessionId: workshopSessionRuntimeSelections.sessionId });
  if (!updated[0]) {
    throw appError(
      409,
      "workshop_runtime_provider_missing",
      "the workshop session has no runtime provider selection",
    );
  }
}

/** Fail closed before bulk provisioning can create any Workspace rows. */
export async function requireFreshWorkshopProviderPreflight(input: {
  sessionId: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const requestedSeats = await countWorkshopRequestedSeats(input.sessionId);
  const rows = await drizzle(env.DB)
    .select({
      providerKind: workshopSessionRuntimeSelections.providerKind,
      snapshotRequestedSeats:
        workshopSessionRuntimeSelections.preflightRequestedSeats,
      availableSeats: workshopSessionRuntimeSelections.preflightAvailableSeats,
      ok: workshopSessionRuntimeSelections.preflightOk,
      checkedAt: workshopSessionRuntimeSelections.preflightCheckedAt,
      expiresAt: workshopSessionRuntimeSelections.preflightExpiresAt,
      reasons: workshopSessionRuntimeSelections.preflightReasonsJson,
    })
    .from(workshopSessionRuntimeSelections)
    .where(eq(workshopSessionRuntimeSelections.sessionId, input.sessionId))
    .limit(1);
  const snapshot = rows[0];
  if (!snapshot) {
    throw appError(
      409,
      "workshop_runtime_provider_missing",
      "the workshop session has no runtime provider selection",
    );
  }
  // Organization runners retain their existing host-resource reservation
  // preflight. This snapshot gates only direct-cloud allocation.
  if (snapshot.providerKind === "agent_kvm") return;
  if (
    snapshot.checkedAt === null ||
    snapshot.expiresAt === null ||
    snapshot.expiresAt <= now ||
    snapshot.snapshotRequestedSeats !== requestedSeats
  ) {
    throw appError(
      409,
      "workshop_provider_preflight_stale",
      "a fresh provider capacity preflight for the current Workshop roster is required",
    );
  }
  if (
    snapshot.ok !== true ||
    snapshot.availableSeats === null ||
    snapshot.availableSeats < requestedSeats
  ) {
    const detail = snapshot.reasons[0];
    throw appError(
      409,
      "workshop_provider_capacity_insufficient",
      detail ?? "the provider cannot provision the full Workshop roster",
    );
  }
}
