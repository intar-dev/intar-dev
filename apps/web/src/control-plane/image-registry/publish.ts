import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  imageBuilds,
  type ImageBuildStatus,
} from "@/db/schema";
import type {
  ImageArchitecture,
  ScenarioManifestV5,
} from "@/generated/catalog";
import {
  isCandidateSourceLocked,
  stageCandidateScenarioManifest,
  warmCandidateScenarioManifest,
} from "@/lib/scenario-catalog-candidates";
import { toErrorResponse } from "@/lib/app-error";
import {
  withImageBuildCoordinationLock,
  withImageBuildCoordinationLocks,
  type ImageBuildCoordinationLease,
} from "@/lib/image-build-lock";
import type { CachedImageRetentionScope } from "@/lib/image-artifact-retention";
import { pruneSupersededHostCachedImages } from "@/lib/registry-host-cache-eviction";
import {
  replaceScenarioCatalogWithRollback,
  type LiveCatalogReplacement,
} from "@/lib/scenario-catalog-rollback";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { tryReconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import {
  readManifest,
  validateManifest,
  normalizePublishManifest,
  type PublishedVmImage,
  type PublishedBootArtifact,
  prepareBootArtifacts,
  prepareVmImages,
  storePreparedBootArtifacts,
  storePreparedVmImages,
} from "./publish-payload";
import { requireBuilderAgentRequest } from "./agent";
import {
  admitRegistryOperation,
  createRegistryWriterGuard,
  type RegistryWriterGuard,
} from "@/lib/image-registry-admission";
import {
  jsonResponse,
  normalizeSha256,
  hasRegistryPublishToken,
  readString,
  isSafeBuildId,
  isSafeBundleRev,
  isImageArchitecture,
} from "./shared";

export async function handlePublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authorization = await authorizeManifestPublish(request, env);
  if (!authorization.ok) return authorization.response;

  // A publish is a registry write: it stores images and boot artifacts, then
  // commits live catalog pointers. It holds a shared writer guard for every one
  // of those writes, and releases it before the cleanup request below, so the
  // collector can still take its exclusive sweep while this request finishes.
  const admitted = await admitRegistryOperation(request, env, {
    operation: "publish",
  });
  if (!admitted.ok) return admitted.response;
  const writer = createRegistryWriterGuard(admitted.lease);
  try {
    const response = await publishManifest(request, env, authorization, writer);
    // A publish that ends in a known refusal is settled, exactly like the
    // thrown candidate refusal below. Every store it started was awaited, and
    // the statement that refused it decided from the same committed state: an
    // inactive build assignment, or a live catalog whose images an active run
    // or host transfer still reads. Left unresolved, the row would block every
    // destructive sweep until an operator reap. A 5xx keeps its hold, because
    // part of the write may have landed.
    if (response.status >= 400 && response.status < 500) {
      await writer.release("ok");
    }
    return response;
  } catch (error) {
    // A refused candidate source is a settled write, not an unknown one: the
    // conditional stage proved that no catalog row changed, and every write of
    // this publish was awaited before it. Settling the guard here is what keeps
    // the collector reachable; an unresolved row would instead block every
    // destructive sweep until an operator reap, for a refusal that no retry can
    // pass while the run that reads the candidate is still active.
    if (!isCandidateSourceLocked(error)) throw error;
    await writer.release("ok");
    const refusal = toErrorResponse(error, "candidate publish refused", 409);
    return jsonResponse(refusal.body, refusal.status);
  } finally {
    await writer.finish();
  }
}

async function publishManifest(
  request: Request,
  env: Cloudflare.Env,
  authorization: Extract<ManifestPublishAuthorization, { ok: true }>,
  writer: RegistryWriterGuard,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }

  const manifest = await readManifest(form.get("manifest"));
  if (!manifest.ok) return manifest.response;

  const validationError = validateManifest(manifest.value);
  if (validationError) return validationError;

  const normalizedManifest = normalizePublishManifest(manifest.value);

  let buildFence:
    (PublishBuildIdentity & { hostId: string; scenarioId: string }) | null =
    null;
  if (authorization.kind === "builder") {
    const identity = readPublishBuildIdentity(form);
    if (!identity.ok) return identity.response;
    if (
      !normalizedManifest.vms.every(
        (vm) => vm.image_key.arch === identity.value.architecture,
      )
    ) {
      return inactivePublishBuildResponse();
    }

    buildFence = {
      ...identity.value,
      hostId: authorization.hostId,
      scenarioId: normalizedManifest.scenario_id,
    };
  }

  const db = drizzle(env.DB);
  const persistPreparedPublish = async (
    lease: ImageBuildCoordinationLease | null,
  ): Promise<
    | {
        ok: true;
        organizationId: string | null;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        catalogChannel: "candidate" | "live";
        transitionId: string | null;
        evictedHostIds: string[];
      }
    | { ok: false; response: Response }
  > => {
    let organizationId: string | null = null;
    let catalogChannel: "candidate" | "live" = "live";
    let liveReplacement:
      | { ok: true; transitionId: string | null; evictedHostIds: string[] }
      | { ok: false; response: Response } = {
      ok: true,
      transitionId: null,
      evictedHostIds: [],
    };
    if (buildFence) {
      const assignment = await loadPublishBuildAssignment(
        db,
        buildFence.buildId,
      );
      if (!isActivePublishBuildAssignment(assignment, buildFence)) {
        return { ok: false, response: inactivePublishBuildResponse() };
      }
      organizationId = assignment?.organizationId ?? null;
      catalogChannel = assignment?.catalogChannel ?? "live";
    }

    const artifacts = await prepareBootArtifacts(env, form, manifest.value);
    if (!artifacts.ok) return artifacts;

    const images = await prepareVmImages(env, manifest.value);
    if (!images.ok) return images;

    // Every path that reaches this line can store an object, so a later throw
    // is a hold rather than a settled end.
    writer.markWriteStarted();
    await storePreparedBootArtifacts(env, artifacts.prepared);
    const uploaded = await storePreparedVmImages(
      env,
      images.prepared,
      normalizedManifest.scenario_id,
    );

    if (buildFence) {
      const assignment = await loadPublishBuildAssignment(
        db,
        buildFence.buildId,
      );
      if (!isActivePublishBuildAssignment(assignment, buildFence)) {
        return { ok: false, response: inactivePublishBuildResponse() };
      }
      organizationId = assignment?.organizationId ?? null;
      catalogChannel = assignment?.catalogChannel ?? "live";
      await lease?.assertHeld();
    }

    const now = Date.now();
    if (buildFence && catalogChannel === "candidate") {
      // A candidate publish replaces no live catalog, so it records no
      // rollback: the live pointers it warms are still the live ones.
      await stageCandidateScenarioManifest(db, {
        revision: buildFence.rev,
        organizationId,
        buildId: buildFence.buildId,
        manifest: normalizedManifest,
        nowUnixMs: now,
      });
    } else {
      // A live publish replaces the catalog pointers. The previous-state read,
      // the reference policy, the rollback record, the catalog rows, and the
      // host cache update all run under one per-family lock, so two concurrent
      // live replacements cannot both capture the same previous state and lose
      // the release in between.
      const families = [
        ...new Set(normalizedManifest.vms.map((vm) => vm.image_key.arch)),
      ].map((arch) => ({
        scenarioId: normalizedManifest.scenario_id,
        arch,
      }));
      const applyLiveReplacement = async () => {
        const replacement = await replaceScenarioCatalogWithRollback(
          db,
          env.DB,
          {
            manifest: normalizedManifest,
            organizationId,
            sourceRevision: buildFence?.rev ?? null,
            nowUnixMs: now,
          },
        );
        if (replacement.blocked) {
          return {
            ok: false as const,
            response: jsonResponse(
              {
                error: "image publish is blocked by active image use",
                blocking_execution_ids: replacement.blocked.executionIds,
                blocking_host_ids: replacement.blocked.hostIds,
                outgoing_image_ids: replacement.outgoingImageIds,
              },
              409,
            ),
          };
        }
        const evicted = await pruneSupersededHostCachedImages(db, {
          organizationId,
          scenarios: retentionScopesForReplacement(
            normalizedManifest,
            replacement,
          ),
          nowUnixMs: now,
          wakeHost: tryWakeHostRuntime,
        });
        return {
          ok: true as const,
          transitionId: replacement.transitionId,
          evictedHostIds: evicted.changedHostIds,
        };
      };
      // The builder path already holds the family lock for its one arch.
      liveReplacement = lease
        ? await applyLiveReplacement()
        : await withImageBuildCoordinationLocks(
            db,
            families,
            applyLiveReplacement,
          );
      if (!liveReplacement.ok) return liveReplacement;
    }
    if (buildFence) {
      await db
        .update(imageBuilds)
        .set({
          publishedManifestJson: normalizedManifest,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(imageBuilds.id, buildFence.buildId),
            eq(imageBuilds.hostId, buildFence.hostId),
          ),
        );
    }
    return {
      ok: true,
      organizationId,
      uploaded,
      artifacts: artifacts.uploaded,
      catalogChannel,
      transitionId: liveReplacement.ok ? liveReplacement.transitionId : null,
      evictedHostIds: liveReplacement.ok ? liveReplacement.evictedHostIds : [],
    };
  };

  let published:
    | {
        ok: true;
        organizationId: string | null;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        catalogChannel: "candidate" | "live";
        transitionId: string | null;
        evictedHostIds: string[];
      }
    | { ok: false; response: Response };
  if (buildFence) {
    const fenceRejected = { response: null as Response | null };
    try {
      published = await withImageBuildCoordinationLock(
        db,
        {
          scenarioId: buildFence.scenarioId,
          arch: buildFence.architecture,
        },
        async (lease) => {
          const result = await persistPreparedPublish(lease);
          if (!result.ok && result.response.status === 409) {
            fenceRejected.response = result.response;
          }
          return result;
        },
      );
    } catch (error) {
      // Once the assignment check has deliberately rejected the publish, a
      // best-effort lease release failure must not turn that 409 into a 500.
      if (fenceRejected.response) return fenceRejected.response;
      throw error;
    }
  } else {
    published = await persistPreparedPublish(null);
  }
  if (!published.ok) return published.response;

  // The pointer marker is settled outside the family lock: the batch above is
  // committed with its rollback record, so the family already has one live
  // pointer set and one recoverable previous state.
  const retention = await finishPublishCommit(db, {
    buildId: buildFence?.buildId ?? null,
    nowUnixMs: Date.now(),
    releaseWriter: () => writer.release("ok"),
  });

  if (published.catalogChannel === "candidate") {
    await warmCandidateScenarioManifest(db, {
      organizationId: published.organizationId,
      manifest: normalizedManifest,
      nowUnixMs: Date.now(),
      wakeHost: tryWakeHostRuntime,
    });
  } else {
    await tryReconcileScenarioImagesForPublicationScope(db, {
      publicationOrganizationId: published.organizationId,
      nowUnixMs: Date.now(),
      reason: "image_published",
      wakeHostRuntime: tryWakeHostRuntime,
    });
  }

  return jsonResponse(
    {
      ok: true,
      scenario_id: normalizedManifest.scenario_id,
      images: published.uploaded,
      artifacts: published.artifacts,
      catalog_channel: published.catalogChannel,
      transition_id: published.transitionId,
      evicted_host_ids: published.evictedHostIds,
      cleanup: retention.cleanup,
    },
    201,
  );
}

/**
 * The last step of a publish: a rebuilt content hash becomes an active pointer
 * again, and the registry writer ends. The family lock is already released, so
 * the collector can take its exclusive sweep while this request finishes.
 */
async function finishPublishCommit(
  db: DrizzleD1Database,
  input: {
    buildId: string | null;
    nowUnixMs: number;
    releaseWriter: () => Promise<void>;
  },
): Promise<{
  cleanup: {
    state: string;
    deleted_objects: number;
    deleted_bytes: number;
    pending: boolean;
  };
}> {
  if (input.buildId) {
    // Its artifacts may have been deleted when an earlier generation retired
    // this content hash.
    await db
      .update(imageBuilds)
      .set({ artifactsRetiredAt: null, updatedAt: input.nowUnixMs })
      .where(
        and(
          inArray(imageBuilds.id, [input.buildId]),
          isNotNull(imageBuilds.artifactsRetiredAt),
        ),
      );
  }
  await input.releaseWriter();
  // No sweep is attempted here. The uploader holds its upload session until
  // this response arrives and the collector refuses its exclusive lease while
  // any session is open, so a waited sweep would deadlock. The scheduled pass
  // removes whatever this publish replaced.
  return {
    cleanup: {
      state: "deferred",
      deleted_objects: 0,
      deleted_bytes: 0,
      pending: true,
    },
  };
}

/**
 * Host cache scopes of one live replacement: keep the incoming live images and
 * the single rollback image the transition recorded.
 */
function retentionScopesForReplacement(
  manifest: ScenarioManifestV5,
  replacement: LiveCatalogReplacement,
): CachedImageRetentionScope[] {
  const incomingByArch = new Map<string, string[]>();
  for (const vm of manifest.vms) {
    const arch = vm.image_key.arch;
    incomingByArch.set(arch, [...(incomingByArch.get(arch) ?? []), vm.image_id]);
  }
  const previousByArch = new Map<string, string[]>();
  for (const vm of replacement.previous.vms) {
    const arch = vm.imageKeyJson?.arch;
    const imageId = vm.imageSha256;
    if (!arch || !imageId) continue;
    previousByArch.set(arch, [...(previousByArch.get(arch) ?? []), imageId]);
  }
  const scopes: CachedImageRetentionScope[] = [];
  for (const [arch, incoming] of incomingByArch) {
    if (!isImageArchitecture(arch)) continue;
    scopes.push({
      scenarioId: manifest.scenario_id,
      arch,
      keepImageIds: [
        ...new Set([...incoming, ...(previousByArch.get(arch) ?? [])]),
      ].sort(),
    });
  }
  return scopes;
}

export { isRuntimeImageCacheHost } from "@/lib/scenario-image-cache";

export type ManifestPublishAuthorization =
  | { ok: true; kind: "trusted-token" }
  | { ok: true; kind: "builder"; hostId: string }
  | { ok: false; response: Response };

export type PublishBuildIdentity = {
  buildId: string;
  rev: string;
  contentHash: string;
  architecture: ImageArchitecture;
};

export type PublishBuildAssignment = {
  id: string;
  organizationId: string | null;
  hostId: string | null;
  status: ImageBuildStatus;
  scenarioId: string;
  arch: ImageArchitecture;
  rev: string;
  contentHash: string;
  catalogChannel?: "candidate" | "live";
};

export async function authorizeManifestPublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<ManifestPublishAuthorization> {
  // The repository publication token is an administrative path used by the
  // release pipeline. Builder agents use their host identity and are fenced
  // against the exact active build assignment below.
  if (await hasRegistryPublishToken(request, env)) {
    return { ok: true, kind: "trusted-token" };
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified;
  return {
    ok: true,
    kind: "builder",
    hostId: verified.agent.hostId,
  };
}

export function readPublishBuildIdentity(
  form: FormData,
):
  | { ok: true; value: PublishBuildIdentity }
  | { ok: false; response: Response } {
  const buildId = readString(form.get("build_id"));
  const rev = readString(form.get("rev"));
  const contentHash = normalizeSha256(
    readString(form.get("content_hash")) ?? "",
  );
  const architecture = readString(form.get("architecture"));
  if (
    !buildId ||
    !isSafeBuildId(buildId) ||
    !rev ||
    !isSafeBundleRev(rev) ||
    !contentHash ||
    !isImageArchitecture(architecture)
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error:
            "builder publish requires valid build_id, rev, content_hash, and architecture",
        },
        400,
      ),
    };
  }
  return {
    ok: true,
    value: { buildId, rev, contentHash, architecture },
  };
}

export async function loadPublishBuildAssignment(
  db: DrizzleD1Database,
  buildId: string,
): Promise<PublishBuildAssignment | undefined> {
  const rows = await db
    .select({
      id: imageBuilds.id,
      organizationId: imageBuilds.organizationId,
      hostId: imageBuilds.hostId,
      status: imageBuilds.status,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
      catalogChannel: imageBuilds.catalogChannel,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  return rows[0];
}

export function isActivePublishBuildAssignment(
  assignment: PublishBuildAssignment | undefined,
  expected: PublishBuildIdentity & { hostId: string; scenarioId: string },
): boolean {
  return Boolean(
    assignment &&
    assignment.id === expected.buildId &&
    assignment.hostId === expected.hostId &&
    (assignment.status === "assigned" || assignment.status === "building") &&
    assignment.scenarioId === expected.scenarioId &&
    assignment.arch === expected.architecture &&
    assignment.rev === expected.rev &&
    assignment.contentHash === expected.contentHash,
  );
}

export function inactivePublishBuildResponse(): Response {
  return jsonResponse({ error: "build is not active for this builder" }, 409);
}
