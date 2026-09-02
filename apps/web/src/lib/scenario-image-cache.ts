import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  courseCatalogs,
  hostActualState,
  hostDesiredState,
  vmScenarios,
  vmScenarioVms,
  type CourseCatalogSnapshotV2,
  type AgentHostRole,
} from "@/db/schema";
import type {
  DesiredCachedImageV1,
  HostDesiredStateV2,
} from "@/generated/bridge";
import type { ImageArchitecture, ImageKey } from "@/generated/catalog";
import {
  IMAGE_KEY_RE,
  isImageArchitecture,
  isImageKey,
  normalizeSha256,
} from "@/control-plane/image-registry/shared";
import {
  mutateDesiredState,
  upsertDesiredCachedImage,
} from "@/lib/desired-state";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";

const RECONCILE_MAX_ATTEMPTS = 8;

type CacheHost = Pick<
  typeof agentHosts.$inferSelect,
  | "id"
  | "organizationId"
  | "role"
  | "disabled"
  | "scenarioEnabled"
  | "activeSessionId"
>;

export interface ReconcileHostScenarioImagesInput {
  hostId: string;
  architecture: ImageArchitecture;
  nowUnixMs: number;
  /**
   * When present, fence the write to the bridge session that supplied the
   * architecture. `null` deliberately fences a disconnected host snapshot.
   */
  expectedActiveSessionId?: string | null;
}

export interface ReconcileHostScenarioImagesResult {
  outcome: "changed" | "unchanged" | "ineligible" | "stale_host_snapshot";
  desiredState: HostDesiredStateV2 | null;
}

export interface ReconcileScenarioImagesForScopeResult {
  changedHostIds: string[];
  skippedUnknownArchitectureHostIds: string[];
  failedHostIds: string[];
}

const PUBLICATION_RECONCILIATION_CONCURRENCY = 4;

interface ScenarioCacheIntent {
  images: DesiredCachedImageV1[];
  scenarioIds: Set<string>;
  linkedImageKeys: Set<string>;
}

/**
 * Reconciles the scenario-image portion of one host's desired cache.
 *
 * This owns its CAS loop instead of passing a captured catalog snapshot into
 * mutateStoredHostDesiredState. On a version race, both desired state and the
 * current catalog must be reloaded so an older publication cannot overwrite a
 * newer image pointer.
 */
export async function reconcileHostScenarioImages(
  db: DrizzleD1Database,
  input: ReconcileHostScenarioImagesInput,
): Promise<ReconcileHostScenarioImagesResult> {
  let changed = false;

  for (let attempt = 0; attempt < RECONCILE_MAX_ATTEMPTS; attempt += 1) {
    const host = await loadCacheHost(db, input.hostId);
    if (!host) {
      return {
        outcome: "stale_host_snapshot",
        desiredState: null,
      };
    }

    const current = await loadOrCreateHostDesiredState(
      db,
      host.id,
      input.nowUnixMs,
    );
    if (!isRuntimeImageCacheHost(host)) {
      return { outcome: "ineligible", desiredState: current };
    }
    if (!sessionMatches(host, input)) {
      return { outcome: "stale_host_snapshot", desiredState: current };
    }

    const intent = await loadScenarioCacheIntent(
      db,
      host.organizationId,
      input.architecture,
    );
    const next = mutateDesiredState(
      current,
      (draft) => {
        // cached_images carries no provenance marker. Scoped scenario IDs
        // remove stale VM keys, while a current V2 course catalog preserves
        // rollback SHAs for still-linked exact keys. Preserve other same-
        // architecture entries.
        // Without a V2 catalog, no scenario key is linked and cache intent
        // fails closed. Running VM SHAs remain independently protected by
        // desired.vms.
        draft.cached_images = draft.cached_images.filter(
          (image) => {
            const identity = imageKeyIdentity(image.image_key);
            return (
              image.image_key.arch === input.architecture &&
              (!intent.scenarioIds.has(image.image_key.scenario) ||
                intent.linkedImageKeys.has(identity))
            );
          },
        );
        for (const image of intent.images) {
          upsertDesiredCachedImage(draft, image);
        }
      },
      { nowUnixMs: input.nowUnixMs },
    );

    if (next !== current) {
      const updated = await db
        .update(hostDesiredState)
        .set({
          version: next.version,
          docJson: next,
          updatedAt: input.nowUnixMs,
        })
        .where(
          and(
            eq(hostDesiredState.hostId, host.id),
            eq(hostDesiredState.version, current.version),
            cacheHostWriteFence(db, host, input),
          ),
        )
        .returning({ version: hostDesiredState.version });
      if (updated.length === 0) {
        const latestHost = await loadCacheHost(db, input.hostId);
        if (!latestHost) {
          return {
            outcome: "stale_host_snapshot",
            desiredState: null,
          };
        }
        if (!isRuntimeImageCacheHost(latestHost)) {
          return {
            outcome: "ineligible",
            desiredState: await loadOrCreateHostDesiredState(
              db,
              latestHost.id,
              input.nowUnixMs,
            ),
          };
        }
        if (
          !sameCacheHostScope(host, latestHost) ||
          !sessionMatches(latestHost, input)
        ) {
          return {
            outcome: "stale_host_snapshot",
            desiredState: await loadOrCreateHostDesiredState(
              db,
              latestHost.id,
              input.nowUnixMs,
            ),
          };
        }
        // A concurrent desired-state writer won the CAS. Reload the desired
        // document and the catalog on the next attempt.
        continue;
      }
      changed = true;
    }

    // A catalog publication can commit between the target read and our CAS.
    // Verify the snapshot after the write/no-op; if it moved, loop and apply
    // the new generation before returning.
    const latestIntent = await loadScenarioCacheIntent(
      db,
      host.organizationId,
      input.architecture,
    );
    if (
      scenarioCacheIntentFingerprint(latestIntent) !==
      scenarioCacheIntentFingerprint(intent)
    ) {
      continue;
    }

    return {
      outcome: changed ? "changed" : "unchanged",
      desiredState: next,
    };
  }

  throw new Error(
    `scenario image cache reconciliation for host ${input.hostId} did not converge after ${RECONCILE_MAX_ATTEMPTS} attempts`,
  );
}

/** Reconciles every eligible host affected by a public or organization catalog event. */
export async function reconcileScenarioImagesForPublicationScope(
  db: DrizzleD1Database,
  input: {
    publicationOrganizationId: string | null;
    nowUnixMs: number;
    wakeHostRuntime?: (hostId: string) => Promise<void>;
  },
): Promise<ReconcileScenarioImagesForScopeResult> {
  const hosts = await db
    .select({
      id: agentHosts.id,
      activeSessionId: agentHosts.activeSessionId,
      architecture: sql<unknown>`json_extract(${hostActualState.reportJson}, '$.capabilities.arch')`,
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        input.publicationOrganizationId
          ? eq(agentHosts.organizationId, input.publicationOrganizationId)
          : undefined,
      ),
    );

  const outcomes: Array<
    | { kind: "changed"; hostId: string }
    | { kind: "unchanged"; hostId: string }
    | { kind: "unknown_architecture"; hostId: string }
    | { kind: "failed"; hostId: string }
  > = [];
  for (
    let offset = 0;
    offset < hosts.length;
    offset += PUBLICATION_RECONCILIATION_CONCURRENCY
  ) {
    const batch = hosts.slice(
      offset,
      offset + PUBLICATION_RECONCILIATION_CONCURRENCY,
    );
    outcomes.push(
      ...(await Promise.all(
        batch.map(async (host) => {
          const architecture = host.architecture;
          if (!isImageArchitecture(architecture)) {
            return {
              kind: "unknown_architecture" as const,
              hostId: host.id,
            };
          }
          try {
            const result = await reconcileHostScenarioImages(db, {
              hostId: host.id,
              architecture,
              nowUnixMs: input.nowUnixMs,
              expectedActiveSessionId: host.activeSessionId,
            });
            if (result.outcome !== "changed") {
              return { kind: "unchanged" as const, hostId: host.id };
            }
            await input.wakeHostRuntime?.(host.id);
            return { kind: "changed" as const, hostId: host.id };
          } catch (error) {
            // A broken or racing host must not prevent later hosts from being
            // attempted. Its hello/report convergence path remains a durable
            // retry, while this event records exactly which host missed the
            // eager repair.
            console.error(
              JSON.stringify({
                message: "scenario image cache host reconciliation failed",
                hostId: host.id,
                publicationOrganizationId: input.publicationOrganizationId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return { kind: "failed" as const, hostId: host.id };
          }
        }),
      )),
    );
  }

  return {
    changedHostIds: outcomes
      .filter((outcome) => outcome.kind === "changed")
      .map((outcome) => outcome.hostId)
      .sort(),
    skippedUnknownArchitectureHostIds: outcomes
      .filter((outcome) => outcome.kind === "unknown_architecture")
      .map((outcome) => outcome.hostId)
      .sort(),
    failedHostIds: outcomes
      .filter((outcome) => outcome.kind === "failed")
      .map((outcome) => outcome.hostId)
      .sort(),
  };
}

export async function tryReconcileScenarioImagesForPublicationScope(
  db: DrizzleD1Database,
  input: {
    publicationOrganizationId: string | null;
    nowUnixMs: number;
    reason: string;
    wakeHostRuntime?: (hostId: string) => Promise<void>;
  },
): Promise<ReconcileScenarioImagesForScopeResult | null> {
  try {
    return await reconcileScenarioImagesForPublicationScope(db, input);
  } catch (error) {
    // Catalog/build state is already authoritative by the time callers use
    // this helper. Do not turn a repair failure into a partially completed
    // upload/delete operation; hello and periodic report reconciliation remain
    // durable fallbacks.
    console.error(
      JSON.stringify({
        message: "scenario image cache reconciliation failed",
        reason: input.reason,
        publicationOrganizationId: input.publicationOrganizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** Reconciles one known host using a current-session actual-state report. */
export async function reconcileHostScenarioImagesFromActualState(
  db: DrizzleD1Database,
  input: { hostId: string; nowUnixMs: number },
): Promise<ReconcileHostScenarioImagesResult | null> {
  const rows = await db
    .select({
      activeSessionId: agentHosts.activeSessionId,
      report: hostActualState.reportJson,
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(eq(agentHosts.id, input.hostId))
    .limit(1);
  const row = rows[0];
  const architecture = row?.report?.capabilities?.arch;
  if (!row || !isImageArchitecture(architecture)) return null;

  return reconcileHostScenarioImages(db, {
    hostId: input.hostId,
    architecture,
    nowUnixMs: input.nowUnixMs,
    expectedActiveSessionId: row.activeSessionId,
  });
}

export async function tryReconcileHostScenarioImagesFromActualState(
  db: DrizzleD1Database,
  input: { hostId: string; nowUnixMs: number; reason: string },
): Promise<ReconcileHostScenarioImagesResult | null> {
  try {
    return await reconcileHostScenarioImagesFromActualState(db, input);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "host scenario image cache reconciliation failed",
        reason: input.reason,
        hostId: input.hostId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

async function loadScenarioCacheIntent(
  db: DrizzleD1Database,
  organizationId: string | null,
  architecture: ImageArchitecture,
): Promise<ScenarioCacheIntent> {
  const scopeKeys = [
    "public",
    ...(organizationId ? [`organization:${organizationId}`] : []),
  ];
  const visibleScope = organizationId
    ? or(
        isNull(vmScenarios.organizationId),
        eq(vmScenarios.organizationId, organizationId),
      )
    : isNull(vmScenarios.organizationId);
  const [catalogRows, scenarioRows, rows] = await Promise.all([
    db
      .select({ catalog: courseCatalogs.catalogJson })
      .from(courseCatalogs)
      .where(inArray(courseCatalogs.scopeKey, scopeKeys)),
    db
      .select({ scenarioId: vmScenarios.scenarioId })
      .from(vmScenarios)
      .where(visibleScope),
    db
      .select({
        scenarioId: vmScenarios.scenarioId,
        imageKey: vmScenarioVms.imageKeyJson,
        imageSha256: vmScenarioVms.imageSha256,
        imageFormat: vmScenarioVms.imageFormat,
        imageVirtualSizeBytes: vmScenarioVms.imageVirtualSizeBytes,
        chunkManifestSha256: vmScenarioVms.chunkManifestSha256,
        guestBootstrapAbi: vmScenarioVms.guestBootstrapAbi,
        kernelSha256: vmScenarioVms.kernelSha256,
        initrdSha256: vmScenarioVms.initrdSha256,
        bootCmdline: vmScenarioVms.bootCmdline,
      })
      .from(vmScenarioVms)
      .innerJoin(
        vmScenarios,
        eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId),
      )
      .where(visibleScope)
      .orderBy(vmScenarios.scenarioId, vmScenarioVms.ordinal),
  ]);
  const linkedScenarioIds = linkedScenarioIdsFromCatalogs(
    catalogRows.map((row) => row.catalog),
  );
  const byKey = new Map<string, DesiredCachedImageV1>();
  const scenarioIds = new Set(scenarioRows.map((row) => row.scenarioId));
  const linkedImageKeys = new Set<string>();
  for (const row of rows) {
    if (!validScenarioImageKey(row.imageKey)) continue;
    if (row.imageKey.arch !== architecture) continue;
    const identity = imageKeyIdentity(row.imageKey);
    if (linkedScenarioIds.has(row.scenarioId)) {
      linkedImageKeys.add(identity);
    } else {
      continue;
    }
    const imageSha256 = normalizeSha256(row.imageSha256 ?? "");
    if (
      !imageSha256 ||
      row.imageFormat !== "raw_chunks_v1" ||
      row.imageVirtualSizeBytes <= 0 ||
      !normalizeSha256(row.chunkManifestSha256 ?? "") ||
      row.guestBootstrapAbi !== 1 ||
      !normalizeSha256(row.kernelSha256) ||
      !normalizeSha256(row.initrdSha256) ||
      !row.bootCmdline.trim()
    ) {
      continue;
    }

    const existing = byKey.get(identity);
    if (existing && existing.image_id !== imageSha256) {
      throw new Error(
        `scenario catalog contains conflicting image pointers for ${identity}`,
      );
    }
    byKey.set(identity, {
      image_key: { ...row.imageKey },
      image_id: imageSha256,
    });
  }
  return {
    images: [...byKey.values()].sort((left, right) =>
      imageKeyIdentity(left.image_key).localeCompare(
        imageKeyIdentity(right.image_key),
      ),
    ),
    scenarioIds,
    linkedImageKeys,
  };
}

function linkedScenarioIdsFromCatalogs(
  catalogs: CourseCatalogSnapshotV2[],
): Set<string> {
  const scenarioIds = new Set<string>();
  for (const catalog of catalogs) {
    if (catalog.version !== 2) {
      throw new Error("scenario image cache requires a V2 course catalog");
    }
    for (const course of catalog.courses) {
      for (const lecture of course.lectures) {
        if (lecture.scenarioId) scenarioIds.add(lecture.scenarioId);
      }
    }
  }
  return scenarioIds;
}

export function isRuntimeImageCacheHost(host: {
  role: AgentHostRole;
  disabled: boolean;
  scenarioEnabled: boolean;
}): boolean {
  // scenarioEnabled controls placement, not cache convergence. A drained host
  // should be able to prewarm before starts are re-enabled.
  return host.role === "agent" && !host.disabled;
}

async function loadCacheHost(
  db: DrizzleD1Database,
  hostId: string,
): Promise<CacheHost | null> {
  const rows = await db
    .select({
      id: agentHosts.id,
      organizationId: agentHosts.organizationId,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      activeSessionId: agentHosts.activeSessionId,
    })
    .from(agentHosts)
    .where(eq(agentHosts.id, hostId))
    .limit(1);
  return rows[0] ?? null;
}

function cacheHostWriteFence(
  db: DrizzleD1Database,
  host: CacheHost,
  input: ReconcileHostScenarioImagesInput,
): SQL {
  const sessionFence = expectedSessionCondition(input);
  return exists(
    db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.id, host.id),
          eq(agentHosts.role, "agent"),
          eq(agentHosts.disabled, false),
          host.organizationId
            ? eq(agentHosts.organizationId, host.organizationId)
            : isNull(agentHosts.organizationId),
          sessionFence,
        ),
      ),
  );
}

function expectedSessionCondition(
  input: ReconcileHostScenarioImagesInput,
): SQL | undefined {
  if (input.expectedActiveSessionId === undefined) return undefined;
  return input.expectedActiveSessionId === null
    ? isNull(agentHosts.activeSessionId)
    : eq(agentHosts.activeSessionId, input.expectedActiveSessionId);
}

function sessionMatches(
  host: CacheHost,
  input: ReconcileHostScenarioImagesInput,
): boolean {
  return (
    input.expectedActiveSessionId === undefined ||
    host.activeSessionId === input.expectedActiveSessionId
  );
}

function sameCacheHostScope(left: CacheHost, right: CacheHost): boolean {
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.role === right.role &&
    left.disabled === right.disabled
  );
}

function validScenarioImageKey(value: unknown): value is ImageKey {
  return (
    isImageKey(value) &&
    IMAGE_KEY_RE.test(value.scenario) &&
    IMAGE_KEY_RE.test(value.vm)
  );
}

function imageKeyIdentity(imageKey: ImageKey): string {
  return `${imageKey.scenario}:${imageKey.vm}:${imageKey.arch}`;
}

function scenarioCacheIntentFingerprint(intent: ScenarioCacheIntent): string {
  return JSON.stringify({
    images: intent.images,
    scenarioIds: [...intent.scenarioIds].sort(),
    linkedImageKeys: [...intent.linkedImageKeys].sort(),
  });
}
