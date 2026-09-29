import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { imageBuilds, member } from "@/db/schema";
import { serializeAdminBuildSummary } from "@/lib/admin-build-response";
import { redactHostPaths } from "@/lib/scenario-sources";

/**
 * The organizations `userId` owns or administers. Builds match it as an `IN`
 * subquery: the organization index serves the lookup, where a correlated
 * `EXISTS` scanned every tenant's builds, and no id list is bound.
 */
const administeredOrganizations = (db: DrizzleD1Database, userId: string) =>
  db
    .select({ id: member.organizationId })
    .from(member)
    .where(and(eq(member.userId, userId), inArray(member.role, ["owner", "admin"])));

/** The newest builds of the organizations `userId` owns or administers. */
export function administeredBuildsQuery(db: DrizzleD1Database, userId: string) {
  return db
    .select({
      id: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
      status: imageBuilds.status,
      phase: imageBuilds.phase,
      attempt: imageBuilds.attempt,
      error: imageBuilds.error,
      logR2Key: imageBuilds.logR2Key,
      timings: imageBuilds.timingsJson,
      createdAt: imageBuilds.createdAt,
      updatedAt: imageBuilds.updatedAt,
    })
    .from(imageBuilds)
    .where(inArray(imageBuilds.organizationId, administeredOrganizations(db, userId)))
    .orderBy(desc(imageBuilds.updatedAt))
    .limit(200);
}

/**
 * The builds of every organization `userId` owns or administers, in the
 * tenant projection of the Scenario source card: no builder host, no bundle
 * key, and host paths removed from errors. `null` when they administer none.
 */
export async function listAdministeredBuilds(userId: string) {
  const db = drizzle(env.DB);
  const [administers] = await administeredOrganizations(db, userId).limit(1);
  if (!administers) return null;
  const rows = await administeredBuildsQuery(db, userId);
  return rows.map((row) => ({
    ...serializeAdminBuildSummary({
      ...row,
      hostId: null,
      hostName: null,
      bundleR2Key: null,
    }),
    error: row.error === null ? null : redactHostPaths(row.error),
  }));
}

/**
 * The tenant's stage scripts write the log and its size is unbounded, so a
 * tenant reads at most its tail: redaction holds the text in memory.
 */
export const TENANT_BUILD_LOG_BYTES = 1024 * 1024;

/**
 * The tail of an administered build's log with host paths removed; `null`
 * when absent.
 */
export async function readAdministeredBuildLog(
  userId: string,
  buildId: string,
): Promise<string | null> {
  const db = drizzle(env.DB);
  const [build] = await db
    .select({ logR2Key: imageBuilds.logR2Key })
    .from(imageBuilds)
    .where(
      and(
        eq(imageBuilds.id, buildId),
        inArray(imageBuilds.organizationId, administeredOrganizations(db, userId)),
      ),
    )
    .limit(1);
  const object = build?.logR2Key
    ? await env.VM_IMAGE_REGISTRY_BUCKET.get(build.logR2Key, {
        range: { suffix: TENANT_BUILD_LOG_BYTES },
      })
    : null;
  if (!object) return null;
  const text = await object.text();
  if (object.size <= TENANT_BUILD_LOG_BYTES) return redactHostPaths(text);
  // The cut line may hold the rest of a host path without its leading slash.
  const cut = text.indexOf("\n");
  return `[earlier output truncated: the log is ${object.size} bytes]\n${redactHostPaths(
    cut === -1 ? "" : text.slice(cut + 1),
  )}`;
}
