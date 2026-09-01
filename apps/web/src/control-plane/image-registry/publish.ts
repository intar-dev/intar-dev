import { and, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  imageBuilds,
  type ImageBuildStatus,
} from "@/db/schema";
import type { ImageArchitecture } from "@/generated/catalog";
import { seedScenarioManifest } from "@/lib/catalog-manifest";
import {
  stageCandidateScenarioManifest,
  warmCandidateScenarioManifest,
} from "@/lib/scenario-catalog-candidates";
import {
  withImageBuildCoordinationLock,
  type ImageBuildCoordinationLease,
} from "@/lib/image-build-lock";
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
      }
    | { ok: false; response: Response }
  > => {
    let organizationId: string | null = null;
    let catalogChannel: "candidate" | "live" = "live";
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
      catalogChannel = assignment?.catalogChannel ?? "live";
      await lease?.assertHeld();
    }

    const now = Date.now();
    if (buildFence && catalogChannel === "candidate") {
      await stageCandidateScenarioManifest(db, {
        revision: buildFence.rev,
        organizationId,
        buildId: buildFence.buildId,
        manifest: normalizedManifest,
        nowUnixMs: now,
      });
    } else {
      await seedScenarioManifest(db, normalizedManifest, {
        enabled: true,
        ...(organizationId ? { organizationId } : {}),
        sourceRevision: buildFence?.rev ?? null,
        nowUnixMs: now,
      });
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
    };
  };

  let published:
    | {
        ok: true;
        organizationId: string | null;
        uploaded: PublishedVmImage[];
        artifacts: PublishedBootArtifact[];
        catalogChannel: "candidate" | "live";
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
      pruned: [],
    },
    201,
  );
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
