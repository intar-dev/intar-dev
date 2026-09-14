import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { agentHosts } from "@/db/schema";
import {
  pruneSupersededCachedImages,
  type CachedImageRetentionScope,
} from "@/lib/image-artifact-retention";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";

/**
 * Evicts superseded scenario images from host desired state.
 *
 * Ready local cache entries that no desired entry requires never block a
 * promotion; this is what removes them, through the same desired-state path a
 * host already follows. The kept set is the incoming live images plus the one
 * retained rollback image of each promoted family.
 */
export async function pruneSupersededHostCachedImages(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    scenarios: readonly CachedImageRetentionScope[];
    nowUnixMs: number;
    wakeHost?: (hostId: string) => Promise<void>;
  },
): Promise<{ changedHostIds: string[] }> {
  if (!input.scenarios.length) return { changedHostIds: [] };
  const hosts = await db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        input.organizationId
          ? eq(agentHosts.organizationId, input.organizationId)
          : undefined,
      ),
    );
  const changedHostIds: string[] = [];
  for (const host of hosts) {
    let changed = false;
    await mutateStoredHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
      (draft) => {
        const next = pruneSupersededCachedImages(
          draft.cached_images,
          input.scenarios,
        );
        changed = next.length !== draft.cached_images.length;
        draft.cached_images = next;
      },
    );
    if (changed) {
      changedHostIds.push(host.id);
      await input.wakeHost?.(host.id);
    }
  }
  return { changedHostIds: changedHostIds.sort() };
}
