import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  isRecord,
  jsonResponse,
} from "@/control-plane/image-registry/shared";
import {
  workshopPublicationCheckpoints,
  workshopPublications,
  workshopRegistryTokens,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopTemplateRevisions,
} from "@/db/schema";
import { toErrorResponse } from "@/lib/app-error";
import {
  FlagshipFeatureToggleService,
  flagshipBindingFromEnvironment,
} from "@/lib/feature-toggles";
import { createAppId } from "@/lib/id";
import { isWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { hashWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";
import { cancelWorkshopPublicationVerifierRuntimes } from "@/lib/workshops/provider-runtime";
import {
  validateWorkshopSourceBundle,
  WorkshopBundleValidationError,
  type ValidatedWorkshopSourceBundle,
} from "./archive";
import {
  workshopAssetContentType,
  workshopAssetObjectKey,
  workshopPresentationAssetPaths,
} from "./assets";
import { validateWorkshopBuilderResult } from "./build-result";
import {
  finalizeCertifiedWorkshopRevision,
  stageWorkshopRevision,
} from "./publication-state";
import {
  resolveWorkshopPublicationProfiles,
  type PublicationProfileResolution,
} from "./provider";

const PUBLICATION_PATH = "/registry/v1/workshop-bundles";
const BUILDER_PATH = "/agent/registry/workshop-publications";
const CLAIM_LEASE_MS = 12 * 60 * 60 * 1_000;
const MAX_ERROR_LENGTH = 4_000;

type PublisherAuthorization = {
  tokenId: string;
  organizationId: string;
  userId: string;
};

type BuilderAuthorization = {
  hostId: string;
  organizationId: string | null;
};

export async function handleWorkshopRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === PUBLICATION_PATH) {
    return handleUpload(request, env);
  }
  const publisherMatch = url.pathname.match(
    /^\/registry\/v1\/workshop-bundles\/([A-Za-z0-9_-]{1,128})$/,
  );
  if (publisherMatch) {
    return request.method === "DELETE"
      ? handleCancellation(request, env, publisherMatch[1]!)
      : handleStatus(request, env, publisherMatch[1]!);
  }
  if (url.pathname === `${BUILDER_PATH}/next`) {
    return handleClaim(request, env);
  }
  const bundleMatch = url.pathname.match(
    /^\/agent\/registry\/workshop-publications\/([A-Za-z0-9_-]{1,128})\/bundle$/,
  );
  if (bundleMatch) {
    return handleBuilderBundle(request, env, bundleMatch[1]!);
  }
  const resultMatch = url.pathname.match(
    /^\/agent\/registry\/workshop-publications\/([A-Za-z0-9_-]{1,128})\/result$/,
  );
  if (resultMatch) {
    return handleBuilderResult(request, env, resultMatch[1]!);
  }
  return null;
}

async function handleUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const authorized = await authorizePublisher(request, env);
  if (!authorized) return unauthorized();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }
  const workshopId = formText(form.get("workshop_id"));
  const sha256 = formText(form.get("sha256"));
  const file = form.get("bundle");
  if (!workshopId || !sha256 || !(file instanceof File)) {
    return jsonResponse(
      { error: "workshop_id, sha256, and bundle are required" },
      400,
    );
  }
  let source: ValidatedWorkshopSourceBundle;
  const payload = await file.arrayBuffer();
  try {
    source = await validateWorkshopSourceBundle({
      payload,
      claimedWorkshopId: workshopId,
      claimedSha256: sha256,
    });
  } catch (error) {
    if (error instanceof WorkshopBundleValidationError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    throw error;
  }

  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: workshopPublications.id, status: workshopPublications.status })
    .from(workshopPublications)
    .where(
      and(
        eq(workshopPublications.organizationId, authorized.organizationId),
        eq(workshopPublications.contentHash, source.contentHash),
        ne(workshopPublications.status, "failed"),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return publicationReceipt(request, existing[0].id, existing[0].status);
  }

  const publicationId = createAppId();
  const sourceKey = `workshops/source/${authorized.organizationId}/${source.workshopSlug}/${source.contentHash}.tar.gz`;
  const writtenKeys = [sourceKey];
  await env.VM_IMAGE_REGISTRY_BUCKET.put(sourceKey, payload, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      organization_id: authorized.organizationId,
      workshop_slug: source.workshopSlug,
      content_sha256: source.contentHash,
      publication_id: publicationId,
    },
  });
  try {
    for (const assetPath of workshopPresentationAssetPaths(
      source.compiledManifest,
    )) {
      const bytes = source.files.get(assetPath);
      if (!bytes) throw new Error(`validated asset ${assetPath} is missing`);
      const key = workshopAssetObjectKey({
        organizationId: authorized.organizationId,
        contentHash: source.contentHash,
        assetPath,
      });
      await env.VM_IMAGE_REGISTRY_BUCKET.put(key, bytes, {
        httpMetadata: { contentType: workshopAssetContentType(assetPath) },
        customMetadata: {
          organization_id: authorized.organizationId,
          workshop_content_sha256: source.contentHash,
          asset_path: assetPath,
        },
      });
      writtenKeys.push(key);
    }
  } catch (error) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(writtenKeys);
    throw error;
  }

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workshop_publications (
           id, organization_id, workshop_slug, content_hash, source_r2_key,
           compiled_manifest_json, required_checkpoint_ids_json, status,
           submitted_by, registry_token_id, runtime_profile_resolutions_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?)`,
      ).bind(
        publicationId,
        authorized.organizationId,
        source.workshopSlug,
        source.contentHash,
        sourceKey,
        JSON.stringify(source.compiledManifest),
        JSON.stringify(source.requiredCheckpointIds),
        authorized.userId,
        authorized.tokenId,
        now,
        now,
      ),
      ...source.requiredCheckpointIds.map((checkpointId) =>
        env.DB.prepare(
          `INSERT INTO workshop_publication_checkpoints (
             id, publication_id, checkpoint_id, status, sanitized,
             cold_boot_verified, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?)`,
        ).bind(createAppId(), publicationId, checkpointId, now, now),
      ),
    ]);
  } catch (error) {
    const raced = await db
      .select({ id: workshopPublications.id, status: workshopPublications.status })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.organizationId, authorized.organizationId),
          eq(workshopPublications.contentHash, source.contentHash),
          ne(workshopPublications.status, "failed"),
        ),
      )
      .limit(1);
    if (!raced[0]) {
      await env.VM_IMAGE_REGISTRY_BUCKET.delete(writtenKeys);
      throw error;
    }
    return publicationReceipt(request, raced[0].id, raced[0].status);
  }
  return publicationReceipt(request, publicationId, "queued");
}

async function handleStatus(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const authorized = await authorizePublisher(request, env);
  if (!authorized) return unauthorized();
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(workshopPublications)
    .where(
      and(
        eq(workshopPublications.id, publicationId),
        eq(workshopPublications.organizationId, authorized.organizationId),
      ),
    )
    .limit(1);
  const publication = rows[0];
  if (!publication) return notFound();
  const checkpoints = await db
    .select({
      checkpointId: workshopPublicationCheckpoints.checkpointId,
      status: workshopPublicationCheckpoints.status,
      sanitized: workshopPublicationCheckpoints.sanitized,
      coldBootVerified: workshopPublicationCheckpoints.coldBootVerified,
      error: workshopPublicationCheckpoints.error,
      verifiedAt: workshopPublicationCheckpoints.verifiedAt,
    })
    .from(workshopPublicationCheckpoints)
    .where(eq(workshopPublicationCheckpoints.publicationId, publicationId))
    .orderBy(asc(workshopPublicationCheckpoints.checkpointId));
  const certifications = publication.publishedRevisionId
    ? await db
        .select({
          profileId: workshopRuntimeProfiles.profileId,
          providerKind: workshopRuntimeProfiles.providerKind,
          state: workshopRuntimeProfileCertifications.state,
          errorCode: workshopRuntimeProfileCertifications.errorCode,
          startedAt: workshopRuntimeProfileCertifications.startedAt,
          verifiedAt: workshopRuntimeProfileCertifications.verifiedAt,
          deletionConfirmedAt:
            workshopRuntimeProfileCertifications.deletionConfirmedAt,
        })
        .from(workshopRuntimeProfiles)
        .innerJoin(
          workshopRuntimeProfileCertifications,
          eq(
            workshopRuntimeProfileCertifications.runtimeProfileId,
            workshopRuntimeProfiles.id,
          ),
        )
        .where(
          eq(
            workshopRuntimeProfiles.templateRevisionId,
            publication.publishedRevisionId,
          ),
        )
        .orderBy(asc(workshopRuntimeProfiles.profileId))
    : [];
  return jsonResponse({
    publication_id: publication.id,
    workshop_id: publication.workshopSlug,
    content_hash: publication.contentHash,
    status: publication.status,
    certification_state: publication.certificationState,
    revision_id: publication.publishedRevisionId,
    error: publication.error,
    claimed_at: publication.claimedAt,
    finished_at: publication.finishedAt,
    created_at: publication.createdAt,
    updated_at: publication.updatedAt,
    checkpoints: checkpoints.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpointId,
      status: checkpoint.status,
      sanitized: checkpoint.sanitized,
      cold_boot_verified: checkpoint.coldBootVerified,
      error: checkpoint.error,
      verified_at: checkpoint.verifiedAt,
    })),
    certifications: certifications.map((certification) => ({
      profile_id: certification.profileId,
      provider_kind: certification.providerKind,
      state: certification.state,
      error_code: certification.errorCode,
      started_at: certification.startedAt,
      verified_at: certification.verifiedAt,
      deletion_confirmed_at: certification.deletionConfirmedAt,
    })),
  });
}

async function handleCancellation(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "DELETE") return methodNotAllowed();
  const authorized = await authorizePublisher(request, env);
  if (!authorized) return unauthorized();
  const current = await drizzle(env.DB)
    .select({ status: workshopPublications.status })
    .from(workshopPublications)
    .where(
      and(
        eq(workshopPublications.id, publicationId),
        eq(workshopPublications.organizationId, authorized.organizationId),
      ),
    )
    .limit(1);
  if (!current[0]) return notFound();
  if (current[0].status === "published") {
    return jsonResponse(
      { error: "published workshop revisions are immutable" },
      409,
    );
  }
  const now = Date.now();
  const status = await cancelWorkshopPublicationVerifierRuntimes({
    publicationId,
    organizationId: authorized.organizationId,
    now,
  });
  return jsonResponse(
    { publication_id: publicationId, status },
    status === "cleanup_pending" ? 202 : 200,
  );
}

async function handleClaim(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const builder = await requireBuilder(request, env);
  if ("response" in builder) return builder.response;
  const modes = new URL(request.url).searchParams.getAll("execution_mode");
  if (
    modes.length > 1 ||
    (modes.length === 1 && modes[0] !== "direct_provider_only")
  ) {
    return jsonResponse({ error: "invalid builder execution mode" }, 400);
  }
  const directOnly = modes[0] === "direct_provider_only";
  const candidates = await claimCandidates(env, builder, directOnly);
  for (const candidate of candidates) {
    let resolutions: PublicationProfileResolution[];
    try {
      resolutions = parsePinnedResolutions(candidate.runtimeProfileResolutionsJson);
      if (resolutions.length === 0) {
        resolutions = await resolveWorkshopPublicationProfiles({
          d1: env.DB,
          organizationId: candidate.organizationId,
          source: sourceFromPublication(candidate),
        });
      }
    } catch (error) {
      const response = toErrorResponse(
        error,
        "workshop runtime profile resolution failed",
        409,
      );
      return jsonResponse(response.body, response.status);
    }
    const now = Date.now();
    const expiresAt = now + CLAIM_LEASE_MS;
    const result = await env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'building', builder_host_id = ?, claimed_at = ?,
           claim_expires_at = ?, runtime_profile_resolutions_json = ?,
           error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND certification_state IS NULL AND (
         (status = 'queued' AND builder_host_id IS NULL)
         OR (status = 'building' AND builder_host_id = ?)
         OR (status = 'building' AND (claim_expires_at IS NULL OR claim_expires_at <= ?))
       )`,
    )
      .bind(
        builder.hostId,
        now,
        expiresAt,
        JSON.stringify(resolutions),
        now,
        candidate.id,
        builder.hostId,
        now,
      )
      .run();
    if (result.meta.changes !== 1) continue;
    await env.DB.prepare(
      `UPDATE workshop_publication_checkpoints
       SET status = 'building', vm_images_json = NULL, sanitized = 0,
           cold_boot_verified = 0, error = NULL, verified_at = NULL, updated_at = ?
       WHERE publication_id = ?`,
    )
      .bind(now, candidate.id)
      .run();
    return jsonResponse({
      publication_id: candidate.id,
      workshop_slug: candidate.workshopSlug,
      content_hash: candidate.contentHash,
      required_checkpoint_ids: candidate.requiredCheckpointIdsJson,
      bundle_url: `${BUILDER_PATH}/${candidate.id}/bundle`,
      runtime_profile_observations: resolutions.flatMap((resolution) =>
        resolution.claimedObservation ? [resolution.claimedObservation] : [],
      ),
    });
  }
  return new Response(null, { status: 204 });
}

async function claimCandidates(
  env: Cloudflare.Env,
  builder: BuilderAuthorization,
  directOnly: boolean,
) {
  const now = Date.now();
  const candidates = await drizzle(env.DB)
    .select()
    .from(workshopPublications)
    .where(
      and(
        isNull(workshopPublications.certificationState),
        builder.organizationId
          ? eq(workshopPublications.organizationId, builder.organizationId)
          : undefined,
        or(
          and(
            eq(workshopPublications.status, "building"),
            eq(workshopPublications.builderHostId, builder.hostId),
          ),
          and(
            eq(workshopPublications.status, "building"),
            or(
              isNull(workshopPublications.claimExpiresAt),
              lte(workshopPublications.claimExpiresAt, now),
            ),
          ),
          and(
            eq(workshopPublications.status, "queued"),
            isNull(workshopPublications.builderHostId),
          ),
        ),
      ),
    )
    .orderBy(asc(workshopPublications.createdAt))
    .limit(20);
  return candidates.filter((candidate) => {
    const providers = authoredProviders(candidate.compiledManifestJson);
    return !directOnly || (providers.size > 0 && !providers.has("agent_kvm"));
  });
}

async function handleBuilderBundle(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const builder = await requireBuilder(request, env);
  if ("response" in builder) return builder.response;
  const now = Date.now();
  const claimed = await drizzle(env.DB)
    .update(workshopPublications)
    .set({ claimExpiresAt: now + CLAIM_LEASE_MS, updatedAt: now })
    .where(
      and(
        eq(workshopPublications.id, publicationId),
        eq(workshopPublications.status, "building"),
        isNull(workshopPublications.certificationState),
        eq(workshopPublications.builderHostId, builder.hostId),
        builder.organizationId
          ? eq(workshopPublications.organizationId, builder.organizationId)
          : undefined,
      ),
    )
    .returning({
      sourceR2Key: workshopPublications.sourceR2Key,
      contentHash: workshopPublications.contentHash,
    });
  if (!claimed[0]) return notFound();
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    claimed[0].sourceR2Key,
  );
  if (!object) return jsonResponse({ error: "bundle object not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      etag: object.httpEtag,
      "x-workshop-content-sha256": claimed[0].contentHash,
    },
  });
}

async function handleBuilderResult(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const builder = await requireBuilder(request, env);
  if ("response" in builder) return builder.response;
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(body) || (body.status !== "succeeded" && body.status !== "failed")) {
    return jsonResponse(
      { error: "body must be a succeeded or failed builder result" },
      400,
    );
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(workshopPublications)
    .where(
      and(
        eq(workshopPublications.id, publicationId),
        eq(workshopPublications.builderHostId, builder.hostId),
        builder.organizationId
          ? eq(workshopPublications.organizationId, builder.organizationId)
          : undefined,
      ),
    )
    .limit(1);
  const publication = rows[0];
  if (!publication) {
    return jsonResponse({ error: "publication is not assigned to this builder" }, 409);
  }
  if (publication.status === "published") {
    return body.status === "succeeded"
      ? publishedResult(env, publication)
      : jsonResponse({ error: "publication is already published" }, 409);
  }
  if (publication.status === "failed") {
    return body.status === "failed"
      ? jsonResponse({ publication_id: publicationId, status: "failed" })
      : jsonResponse({ error: "publication is already failed" }, 409);
  }
  if (publication.status !== "building" || publication.certificationState !== null) {
    return jsonResponse(
      { error: "builder completion fence is no longer active" },
      409,
    );
  }
  if (body.status === "failed") {
    const error =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim().slice(0, MAX_ERROR_LENGTH)
        : "workshop checkpoint build failed";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_publication_checkpoints
         SET status = 'failed', error = ?, updated_at = ?
         WHERE publication_id = ? AND status != 'verified'`,
      ).bind(error, now, publicationId),
      env.DB.prepare(
        `UPDATE workshop_publications
         SET status = 'failed', error = ?, claim_expires_at = NULL,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'building' AND builder_host_id = ?
           AND certification_state IS NULL`,
      ).bind(error, now, now, publicationId, builder.hostId),
    ]);
    return jsonResponse({ publication_id: publicationId, status: "failed" });
  }

  const sourceObject = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    publication.sourceR2Key,
  );
  if (!sourceObject) {
    return jsonResponse({ error: "stored source bundle is unavailable" }, 409);
  }
  let source: ValidatedWorkshopSourceBundle;
  try {
    source = await validateWorkshopSourceBundle({
      payload: await sourceObject.arrayBuffer(),
      claimedWorkshopId: publication.workshopSlug,
      claimedSha256: publication.contentHash,
    });
  } catch (error) {
    return jsonResponse(
      {
        error: `stored source bundle failed validation: ${error instanceof Error ? error.message : String(error)}`,
      },
      409,
    );
  }
  const resolutions = parsePinnedResolutions(
    publication.runtimeProfileResolutionsJson,
  );
  if (resolutions.length === 0) {
    return jsonResponse({ error: "publication has no pinned runtime profiles" }, 409);
  }
  let validated: Awaited<ReturnType<typeof validateWorkshopBuilderResult>>;
  try {
    validated = await validateWorkshopBuilderResult({
      env,
      publicationId,
      source,
      resolutions,
      rawManifest: body.manifest,
      rawCheckpoints: body.checkpoints,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
  let staged: Awaited<ReturnType<typeof stageWorkshopRevision>>;
  try {
    staged = await stageWorkshopRevision({
      env,
      publication,
      builderHostId: builder.hostId,
      manifest: validated.manifest,
      checkpoints: validated.checkpoints,
      resolutions,
    });
  } catch (error) {
    const raced = await loadPublication(env, publicationId);
    if (raced?.status === "published") return publishedResult(env, raced);
    return jsonResponse(
      {
        error: "workshop revision staging conflicted; retry the result",
        detail: error instanceof Error ? error.message : String(error),
      },
      409,
    );
  }
  if (staged.directCertificationIds.length === 0) {
    const completed = await loadPublication(env, publicationId);
    if (!completed || completed.status !== "published") {
      return jsonResponse({ error: "publication failed its finalization fence" }, 409);
    }
    return publishedResult(env, completed, 201);
  }
  return jsonResponse(
    {
      publication_id: publicationId,
      status: "building",
      certification_state: "verifying",
      template_id: staged.templateId,
      revision_id: staged.revisionId,
      revision: staged.revision,
      certifications: staged.directCertificationIds,
    },
    202,
  );
}

async function publishedResult(
  env: Cloudflare.Env,
  publication: typeof workshopPublications.$inferSelect,
  status = 200,
): Promise<Response> {
  if (!publication.publishedRevisionId) {
    return jsonResponse({ error: "published revision metadata is missing" }, 409);
  }
  const revision = await drizzle(env.DB)
    .select({
      templateId: workshopTemplateRevisions.templateId,
      revision: workshopTemplateRevisions.revision,
    })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.id, publication.publishedRevisionId))
    .limit(1);
  if (!revision[0]) {
    return jsonResponse({ error: "published revision metadata is missing" }, 409);
  }
  return jsonResponse(
    {
      publication_id: publication.id,
      status: "published",
      template_id: revision[0].templateId,
      revision_id: publication.publishedRevisionId,
      revision: revision[0].revision,
    },
    status,
  );
}

/** Called by the provider certification sweep after the final deletion proof. */
export async function finalizeWorkshopPublication(
  env: Cloudflare.Env,
  publicationId: string,
): Promise<boolean> {
  return finalizeCertifiedWorkshopRevision({ env, publicationId });
}

async function authorizePublisher(
  request: Request,
  env: Cloudflare.Env,
): Promise<PublisherAuthorization | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const tokenHash = await hashWorkshopRegistryToken(token);
  const now = Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: workshopRegistryTokens.id,
      organizationId: workshopRegistryTokens.organizationId,
      userId: workshopRegistryTokens.createdBy,
      expiresAt: workshopRegistryTokens.expiresAt,
    })
    .from(workshopRegistryTokens)
    .where(
      and(
        eq(workshopRegistryTokens.tokenHash, tokenHash),
        isNull(workshopRegistryTokens.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || (row.expiresAt !== null && row.expiresAt <= now)) return null;
  if (
    !(await isWorkshopsEnabledForOrganization(
      row.organizationId,
      new FlagshipFeatureToggleService(flagshipBindingFromEnvironment(env)),
    ))
  ) {
    return null;
  }
  await db
    .update(workshopRegistryTokens)
    .set({ lastUsedAt: now })
    .where(eq(workshopRegistryTokens.id, row.id));
  return {
    tokenId: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
  };
}

async function requireBuilder(
  request: Request,
  env: Cloudflare.Env,
): Promise<BuilderAuthorization | { response: Response }> {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return { response: verified.response };
  if (verified.agent.role !== "builder") {
    return { response: jsonResponse({ error: "builder role required" }, 403) };
  }
  return {
    hostId: verified.agent.hostId,
    organizationId: verified.agent.organizationId,
  };
}

function sourceFromPublication(
  publication: typeof workshopPublications.$inferSelect,
): ValidatedWorkshopSourceBundle {
  return {
    contentHash: publication.contentHash,
    workshopSlug: publication.workshopSlug,
    compiledManifest: publication.compiledManifestJson,
    requiredCheckpointIds: publication.requiredCheckpointIdsJson,
    files: new Map(),
  };
}

function parsePinnedResolutions(value: unknown): PublicationProfileResolution[] {
  if (!Array.isArray(value)) throw new Error("runtime profile resolutions are invalid");
  return value as PublicationProfileResolution[];
}

function authoredProviders(value: unknown): Set<string> {
  if (!isRecord(value) || !isRecord(value.manifest)) return new Set();
  const workspace = value.manifest.workspace;
  if (!isRecord(workspace) || !Array.isArray(workspace.runtime_profiles)) {
    return new Set();
  }
  return new Set(
    workspace.runtime_profiles.flatMap((profile) =>
      isRecord(profile) && typeof profile.provider === "string"
        ? [profile.provider]
        : [],
    ),
  );
}

async function loadPublication(env: Cloudflare.Env, publicationId: string) {
  return (
    await drizzle(env.DB)
      .select()
      .from(workshopPublications)
      .where(eq(workshopPublications.id, publicationId))
      .limit(1)
  )[0];
}

function publicationReceipt(
  request: Request,
  publicationId: string,
  status: string,
): Response {
  const statusUrl = new URL(`${PUBLICATION_PATH}/${publicationId}`, request.url);
  return jsonResponse(
    {
      publication_id: publicationId,
      status,
      status_url: statusUrl.toString(),
    },
    status === "queued" ? 202 : 200,
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function formText(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method not allowed" }, 405);
}

function unauthorized(): Response {
  return jsonResponse({ error: "unauthorized" }, 401);
}

function notFound(): Response {
  return jsonResponse({ error: "not found" }, 404);
}
