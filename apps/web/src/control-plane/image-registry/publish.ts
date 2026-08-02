import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuilds,
  scenarioSources,
  vmScenarioVms,
  workshopPublicationCheckpoints,
  workshopPublications,
  type AgentHostRole,
  type ImageBuildStatus,
} from "@/db/schema";
import {
  type ImageArchitecture,
  type ImageKey,
  type ScenarioManifestV3,
} from "@/generated/catalog";
import { seedScenarioManifest } from "@/lib/catalog-manifest";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { upsertDesiredCachedImage } from "@/lib/desired-state";
import {
  withImageBuildCoordinationLock,
  type ImageBuildCoordinationLease,
} from "@/lib/image-build-lock";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import {
  readManifest,
  validateManifest,
  normalizePublishManifest,
  type PublishedVmImage,
  type PublishedBootArtifact,
  type PreparedVmImage,
  prepareBootArtifacts,
  prepareVmImages,
  storePreparedBootArtifacts,
  storePreparedVmImages,
} from "./publish-payload";
import { requireBuilderAgentRequest } from "./agent";
import {
  jsonResponse,
  isImageKey,
  normalizeSha256,
  registryImageKey,
  imageObjectKey,
  hasRegistryPublishToken,
  readString,
  isSafeBuildId,
  isSafeBundleRev,
  isImageArchitecture,
} from "./shared";

export const MAX_IMAGES_PER_KEY = 2;

export const IMAGE_OBJECT_SUFFIX = ".raw.zst";

export const IMAGE_COMPANION_SUFFIX = ".raw.zst.sha256";

export async function handlePublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authorization = await authorizeManifestPublish(request, env);
  if (!authorization.ok) return authorization.response;

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
    | (PublishBuildIdentity & { hostId: string; scenarioId: string })
    | null = null;
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
        preparedImages: PreparedVmImage[];
      }
    | { ok: false; response: Response }
  > => {
    let organizationId: string | null = null;
    if (buildFence) {
      const assignment = await loadPublishBuildAssignment(
        db,
        buildFence.buildId,
      );
      if (!isActivePublishBuildAssignment(assignment, buildFence)) {
        return { ok: false, response: inactivePublishBuildResponse() };
      }
      organizationId = assignment?.organizationId ?? null;
    }

    const artifacts = await prepareBootArtifacts(env, form, manifest.value);
    if (!artifacts.ok) return artifacts;

    const images = await prepareVmImages(env, form, manifest.value);
    if (!images.ok) return images;

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
      await lease?.assertHeld();
    }

    await seedScenarioManifest(db, normalizedManifest, {
      enabled: true,
      ...(organizationId ? { organizationId } : {}),
      nowUnixMs: Date.now(),
    });
    if (organizationId) {
      await db
        .update(scenarioSources)
        .set({ status: "published", updatedAt: Date.now() })
        .where(
          and(
            eq(scenarioSources.organizationId, organizationId),
            eq(scenarioSources.scenarioId, normalizedManifest.scenario_id),
          ),
        );
    }
    return {
      ok: true,
      organizationId,
      uploaded,
      artifacts: artifacts.uploaded,
      preparedImages: images.prepared,
    };
  };

  let published:
    | {
        ok: true;
        organizationId: string | null;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        preparedImages: PreparedVmImage[];
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

  await bumpHostCachedImages(db, normalizedManifest, published.organizationId);

  let pruned: PrunedImages[] = [];
  try {
    pruned = await pruneStaleVmImages(env, db, published.preparedImages);
  } catch (error) {
    // Retention is best-effort; a prune failure must never fail the publish.
    console.error("vm image registry prune failed", error);
  }

  return jsonResponse(
    {
      ok: true,
      scenario_id: normalizedManifest.scenario_id,
      images: published.uploaded,
      artifacts: published.artifacts,
      pruned,
    },
    201,
  );
}

export type PrunedImages = {
  image_key: string;
  deleted_sha256s: string[];
};

export async function catalogReferencedImageShas(
  db: DrizzleD1Database,
): Promise<Set<string>> {
  const scenarioRows = await db
    .select({
      imageKey: vmScenarioVms.imageKeyJson,
      imageSha256: vmScenarioVms.imageSha256,
    })
    .from(vmScenarioVms)
    .where(isNotNull(vmScenarioVms.imageSha256));

  const referenced = new Set<string>();
  for (const row of scenarioRows) {
    if (!isImageKey(row.imageKey)) continue;
    const sha256 = normalizeSha256(row.imageSha256 ?? "");
    if (!sha256) continue;
    referenced.add(`${registryImageKey(row.imageKey)}:${sha256}`);
  }

  // Workshop checkpoint images are immutable revision inputs just like
  // scenario catalog images. Keep every image referenced by a published
  // checkpoint so a later scenario publication cannot prune it.
  const workshopRows = await db
    .select({ images: workshopPublicationCheckpoints.vmImagesJson })
    .from(workshopPublicationCheckpoints)
    .innerJoin(
      workshopPublications,
      eq(workshopPublicationCheckpoints.publicationId, workshopPublications.id),
    )
    .where(
      and(
        eq(workshopPublications.status, "published"),
        eq(workshopPublicationCheckpoints.status, "verified"),
        isNotNull(workshopPublicationCheckpoints.vmImagesJson),
      ),
    );
  for (const row of workshopRows) {
    for (const image of row.images ?? []) {
      const imageKey = image.image_key ?? image.imageKey;
      const sha256 = normalizeSha256(
        typeof image.image_sha256 === "string"
          ? image.image_sha256
          : typeof image.imageSha256 === "string"
            ? image.imageSha256
            : "",
      );
      if (!isImageKey(imageKey) || !sha256) continue;
      referenced.add(`${registryImageKey(imageKey)}:${sha256}`);
    }
  }
  return referenced;
}

export async function listImageKeyObjects(
  env: Cloudflare.Env,
  imageKey: string,
): Promise<Array<{ key: string; uploaded: Date }>> {
  const objects: Array<{ key: string; uploaded: Date }> = [];
  let cursor: string | undefined;
  do {
    const result = await env.VM_IMAGE_REGISTRY_BUCKET.list({
      prefix: `images/${imageKey}/`,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of result.objects) {
      objects.push({ key: object.key, uploaded: object.uploaded });
    }
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return objects;
}

export async function pruneStaleVmImages(
  env: Cloudflare.Env,
  db: DrizzleD1Database,
  published: PreparedVmImage[],
): Promise<PrunedImages[]> {
  const publishedShasByImageKey = new Map<string, Set<string>>();
  for (const image of published) {
    const shas = publishedShasByImageKey.get(image.imageKey) ?? new Set();
    shas.add(image.imageSha256);
    publishedShasByImageKey.set(image.imageKey, shas);
  }
  if (publishedShasByImageKey.size === 0) return [];

  const referenced = await catalogReferencedImageShas(db);
  const pruned: PrunedImages[] = [];

  for (const [imageKey, publishedShas] of publishedShasByImageKey) {
    const prefix = `images/${imageKey}/`;
    const entries = new Map<
      string,
      { uploaded: Date | null; companion: boolean }
    >();
    for (const object of await listImageKeyObjects(env, imageKey)) {
      const basename = object.key.slice(prefix.length);
      if (basename.endsWith(IMAGE_COMPANION_SUFFIX)) {
        const sha256 = normalizeSha256(
          basename.slice(0, -IMAGE_COMPANION_SUFFIX.length),
        );
        if (!sha256) continue;
        const entry = entries.get(sha256) ?? {
          uploaded: null,
          companion: false,
        };
        entry.companion = true;
        entries.set(sha256, entry);
      } else if (basename.endsWith(IMAGE_OBJECT_SUFFIX)) {
        const sha256 = normalizeSha256(
          basename.slice(0, -IMAGE_OBJECT_SUFFIX.length),
        );
        if (!sha256) continue;
        const entry = entries.get(sha256) ?? {
          uploaded: null,
          companion: false,
        };
        entry.uploaded = object.uploaded;
        entries.set(sha256, entry);
      }
    }

    const mostRecent = [...entries.entries()]
      .filter(([, entry]) => entry.uploaded !== null)
      .sort(
        (a, b) =>
          (b[1].uploaded?.getTime() ?? 0) - (a[1].uploaded?.getTime() ?? 0),
      )
      .slice(0, MAX_IMAGES_PER_KEY)
      .map(([sha256]) => sha256);

    // A reused image keeps its original R2 uploaded timestamp, so recency
    // alone would evict the image that was just published or is still the
    // live catalog pointer — both are always kept.
    const keep = new Set([...publishedShas, ...mostRecent]);

    const deleteKeys: string[] = [];
    const deletedShas: string[] = [];
    for (const [sha256, entry] of entries) {
      if (keep.has(sha256) || referenced.has(`${imageKey}:${sha256}`)) {
        continue;
      }
      if (entry.uploaded !== null) {
        deleteKeys.push(imageObjectKey(imageKey, sha256));
      }
      if (entry.companion) {
        deleteKeys.push(`${imageObjectKey(imageKey, sha256)}.sha256`);
      }
      deletedShas.push(sha256);
    }
    if (deleteKeys.length === 0) continue;

    await env.VM_IMAGE_REGISTRY_BUCKET.delete(deleteKeys);
    pruned.push({ image_key: imageKey, deleted_sha256s: deletedShas.sort() });
  }

  return pruned;
}

export async function bumpHostCachedImages(
  db: DrizzleD1Database,
  manifest: ScenarioManifestV3,
  organizationId: string | null = null,
): Promise<void> {
  const images = manifest.vms.map((vm) => ({
    image_key: vm.image_key,
    image_sha256: vm.image_sha256,
  }));
  await bumpCachedImages(db, images, organizationId);
}

export async function bumpCachedImages(
  db: DrizzleD1Database,
  images: Array<{ image_key: ImageKey; image_sha256: string }>,
  organizationId: string | null = null,
): Promise<void> {
  if (images.length === 0) return;
  const nowUnixMs = Date.now();
  const hosts = await db
    .select({
      id: agentHosts.id,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
    })
    .from(agentHosts)
    .where(
      organizationId
        ? and(
            eq(agentHosts.disabled, false),
            eq(agentHosts.organizationId, organizationId),
          )
        : eq(agentHosts.disabled, false),
    );

  for (const host of hosts) {
    if (!isRuntimeImageCacheHost(host)) {
      continue;
    }
    await mutateStoredHostDesiredState(db, host.id, nowUnixMs, (draft) => {
      for (const image of images) {
        upsertDesiredCachedImage(draft, image);
      }
    });
    await tryWakeHostRuntime(host.id);
  }
}

export function isRuntimeImageCacheHost(host: {
  role: AgentHostRole;
  disabled: boolean;
  scenarioEnabled: boolean;
}): boolean {
  // Maintenance disables placement, not cache convergence. Keeping this
  // independent from scenarioEnabled lets a drained host prewarm the newly
  // published generation before starts are re-enabled.
  return host.role === "agent" && !host.disabled;
}

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
