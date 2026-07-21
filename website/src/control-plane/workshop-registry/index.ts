import { and, asc, eq, isNull, lte, max, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  artifactObjectKey,
  imageObjectKey,
  isImageKey,
  isRecord,
  jsonResponse,
  normalizeSha256,
  registryImageKey,
} from "@/control-plane/image-registry/shared";
import { bumpCachedImages } from "@/control-plane/image-registry/publish";
import {
  workshopPublicationCheckpoints,
  workshopPublications,
  workshopRegistryTokens,
  workshopTemplateRevisions,
  workshopTemplates,
  type WorkshopManifestV1,
} from "@/db/schema";
import { createAppId } from "@/lib/id";
import {
  FlagshipFeatureToggleService,
  flagshipBindingFromEnvironment,
} from "@/lib/feature-toggles";
import { isWorkshopsEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { hashWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";
import { validateWorkshopManifest } from "@/lib/workshops/validation";
import {
  hydrateWorkshopManifest,
  validateWorkshopSourceBundle,
  WorkshopBundleValidationError,
  type ValidatedWorkshopSourceBundle,
  type WorkshopCheckpointBuildReport,
} from "./archive";
import {
  workshopAssetContentType,
  workshopAssetObjectKey,
  workshopPresentationAssetPaths,
} from "./assets";

const WORKSHOP_PUBLICATION_PATH = "/registry/v1/workshop-bundles";
const BUILDER_PATH = "/agent/registry/workshop-publications";
const MAX_ERROR_LENGTH = 4_000;
// A canonical multi-checkpoint build can take hours. Resume and bundle reads
// renew this lease; builder_host_id remains the completion fencing token.
const WORKSHOP_PUBLICATION_CLAIM_LEASE_MS = 12 * 60 * 60 * 1_000;
const MAX_CLAIM_ATTEMPTS = 5;

type PublisherAuthorization = {
  tokenId: string;
  organizationId: string;
  userId: string;
};

type VerifiedCheckpointReport = WorkshopCheckpointBuildReport & {
  rawVmImages: Array<Record<string, unknown>>;
};

type WorkshopPublicationRow = typeof workshopPublications.$inferSelect;
type BuilderResultStatus = "succeeded" | "failed";

export async function handleWorkshopRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === WORKSHOP_PUBLICATION_PATH) {
    return handleWorkshopBundleUpload(request, env);
  }
  const statusMatch = url.pathname.match(
    /^\/registry\/v1\/workshop-bundles\/([A-Za-z0-9_-]{1,128})$/,
  );
  if (statusMatch) {
    return handleWorkshopPublicationStatus(request, env, statusMatch[1] ?? "");
  }
  if (url.pathname === `${BUILDER_PATH}/next`) {
    return handleWorkshopPublicationClaim(request, env);
  }
  const bundleMatch = url.pathname.match(
    /^\/agent\/registry\/workshop-publications\/([A-Za-z0-9_-]{1,128})\/bundle$/,
  );
  if (bundleMatch) {
    return handleWorkshopBuilderBundle(request, env, bundleMatch[1] ?? "");
  }
  const resultMatch = url.pathname.match(
    /^\/agent\/registry\/workshop-publications\/([A-Za-z0-9_-]{1,128})\/result$/,
  );
  if (resultMatch) {
    return handleWorkshopBuilderResult(request, env, resultMatch[1] ?? "");
  }
  return null;
}

async function handleWorkshopBundleUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authorized = await authorizePublisher(request, env);
  if (!authorized) return jsonResponse({ error: "unauthorized" }, 401);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }
  const workshopId = readFormString(form.get("workshop_id"));
  const claimedSha256 = readFormString(form.get("sha256"));
  const file = form.get("bundle");
  if (!workshopId || !claimedSha256 || !(file instanceof File)) {
    return jsonResponse(
      { error: "workshop_id, sha256, and bundle are required" },
      400,
    );
  }
  const payload = await file.arrayBuffer();
  let source: ValidatedWorkshopSourceBundle;
  try {
    source = await validateWorkshopSourceBundle({
      payload,
      claimedWorkshopId: workshopId,
      claimedSha256,
    });
  } catch (error) {
    if (error instanceof WorkshopBundleValidationError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    throw error;
  }

  const db = drizzle(env.DB);
  const existing = await db
    .select({
      id: workshopPublications.id,
      status: workshopPublications.status,
    })
    .from(workshopPublications)
    .where(
      and(
        eq(workshopPublications.organizationId, authorized.organizationId),
        eq(workshopPublications.contentHash, source.contentHash),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return publicationReceipt(request, existing[0].id, existing[0].status);
  }

  const publicationId = createAppId();
  const objectKey = `workshops/source/${authorized.organizationId}/${source.workshopSlug}/${source.contentHash}.tar.gz`;
  const storedObjectKeys = [objectKey];
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
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
      if (!bytes) {
        throw new Error(`validated workshop asset ${assetPath} is missing`);
      }
      const assetKey = workshopAssetObjectKey({
        organizationId: authorized.organizationId,
        contentHash: source.contentHash,
        assetPath,
      });
      await env.VM_IMAGE_REGISTRY_BUCKET.put(assetKey, bytes, {
        httpMetadata: { contentType: workshopAssetContentType(assetPath) },
        customMetadata: {
          organization_id: authorized.organizationId,
          workshop_content_sha256: source.contentHash,
          asset_path: assetPath,
        },
      });
      storedObjectKeys.push(assetKey);
    }
  } catch (error) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(storedObjectKeys);
    throw error;
  }

  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO workshop_publications (
        id, organization_id, workshop_slug, content_hash, source_r2_key,
        compiled_manifest_json, required_checkpoint_ids_json, status,
        submitted_by, registry_token_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).bind(
      publicationId,
      authorized.organizationId,
      source.workshopSlug,
      source.contentHash,
      objectKey,
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
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await db
      .select({
        id: workshopPublications.id,
        status: workshopPublications.status,
      })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.organizationId, authorized.organizationId),
          eq(workshopPublications.contentHash, source.contentHash),
        ),
      )
      .limit(1);
    if (!raced[0]) {
      await env.VM_IMAGE_REGISTRY_BUCKET.delete(storedObjectKeys);
      throw error;
    }
    return publicationReceipt(request, raced[0].id, raced[0].status);
  }
  return publicationReceipt(request, publicationId, "queued");
}

async function handleWorkshopPublicationStatus(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authorized = await authorizePublisher(request, env);
  if (!authorized) return jsonResponse({ error: "unauthorized" }, 401);
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
  if (!publication) return jsonResponse({ error: "not found" }, 404);
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
  return jsonResponse({
    publication_id: publication.id,
    workshop_id: publication.workshopSlug,
    sha256: publication.contentHash,
    status: publication.status,
    error: publication.error,
    revision_id: publication.publishedRevisionId,
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
  });
}

async function handleWorkshopPublicationClaim(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const builder = await requireBuilder(request, env);
  if (!builder.ok) return builder.response;
  const db = drizzle(env.DB);

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const resumed = await db
      .select({ id: workshopPublications.id })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.status, "building"),
          eq(workshopPublications.builderHostId, builder.hostId),
          builder.organizationId
            ? eq(workshopPublications.organizationId, builder.organizationId)
            : undefined,
        ),
      )
      .orderBy(
        asc(workshopPublications.claimedAt),
        asc(workshopPublications.createdAt),
      )
      .limit(1);
    if (resumed[0]) {
      const now = Date.now();
      const claimExpiresAt = now + WORKSHOP_PUBLICATION_CLAIM_LEASE_MS;
      const claimed = await db
        .update(workshopPublications)
        .set({ claimExpiresAt, error: null, updatedAt: now })
        .where(
          and(
            eq(workshopPublications.id, resumed[0].id),
            eq(workshopPublications.status, "building"),
            eq(workshopPublications.builderHostId, builder.hostId),
            builder.organizationId
              ? eq(workshopPublications.organizationId, builder.organizationId)
              : undefined,
          ),
        )
        .returning(workshopPublicationClaimSelection());
      if (!claimed[0]) continue;
      return finishWorkshopPublicationClaim({
        env,
        publication: claimed[0],
        builderHostId: builder.hostId,
        claimExpiresAt,
        now,
      });
    }

    const expired = await db
      .select({ id: workshopPublications.id })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.status, "building"),
          or(
            isNull(workshopPublications.claimExpiresAt),
            lte(workshopPublications.claimExpiresAt, Date.now()),
          ),
          builder.organizationId
            ? eq(workshopPublications.organizationId, builder.organizationId)
            : undefined,
        ),
      )
      .orderBy(
        asc(workshopPublications.claimExpiresAt),
        asc(workshopPublications.createdAt),
      )
      .limit(1);
    if (expired[0]) {
      const now = Date.now();
      const claimExpiresAt = now + WORKSHOP_PUBLICATION_CLAIM_LEASE_MS;
      const claimed = await db
        .update(workshopPublications)
        .set({
          builderHostId: builder.hostId,
          claimedAt: now,
          claimExpiresAt,
          error: null,
          finishedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopPublications.id, expired[0].id),
            eq(workshopPublications.status, "building"),
            or(
              isNull(workshopPublications.claimExpiresAt),
              lte(workshopPublications.claimExpiresAt, now),
            ),
            builder.organizationId
              ? eq(workshopPublications.organizationId, builder.organizationId)
              : undefined,
          ),
        )
        .returning(workshopPublicationClaimSelection());
      if (!claimed[0]) continue;
      return finishWorkshopPublicationClaim({
        env,
        publication: claimed[0],
        builderHostId: builder.hostId,
        claimExpiresAt,
        now,
      });
    }

    const queued = await db
      .select({ id: workshopPublications.id })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.status, "queued"),
          isNull(workshopPublications.builderHostId),
          builder.organizationId
            ? eq(workshopPublications.organizationId, builder.organizationId)
            : undefined,
        ),
      )
      .orderBy(asc(workshopPublications.createdAt))
      .limit(1);
    const candidate = queued[0];
    if (!candidate) return new Response(null, { status: 204 });
    const now = Date.now();
    const claimExpiresAt = now + WORKSHOP_PUBLICATION_CLAIM_LEASE_MS;
    const claimed = await db
      .update(workshopPublications)
      .set({
        status: "building",
        builderHostId: builder.hostId,
        claimedAt: now,
        claimExpiresAt,
        error: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopPublications.id, candidate.id),
          eq(workshopPublications.status, "queued"),
          isNull(workshopPublications.builderHostId),
          builder.organizationId
            ? eq(workshopPublications.organizationId, builder.organizationId)
            : undefined,
        ),
      )
      .returning(workshopPublicationClaimSelection());
    if (!claimed[0]) continue;
    return finishWorkshopPublicationClaim({
      env,
      publication: claimed[0],
      builderHostId: builder.hostId,
      claimExpiresAt,
      now,
    });
  }
  return jsonResponse({ error: "claim conflict; retry" }, 409);
}

function workshopPublicationClaimSelection() {
  return {
    id: workshopPublications.id,
    workshopSlug: workshopPublications.workshopSlug,
    contentHash: workshopPublications.contentHash,
    requiredCheckpointIds: workshopPublications.requiredCheckpointIdsJson,
  };
}

async function finishWorkshopPublicationClaim(params: {
  env: Cloudflare.Env;
  publication: {
    id: string;
    workshopSlug: string;
    contentHash: string;
    requiredCheckpointIds: string[];
  };
  builderHostId: string;
  claimExpiresAt: number;
  now: number;
}): Promise<Response> {
  await params.env.DB.prepare(
    `UPDATE workshop_publication_checkpoints
     SET status = 'building', vm_images_json = NULL, sanitized = 0,
         cold_boot_verified = 0, error = NULL, verified_at = NULL, updated_at = ?
     WHERE publication_id = ? AND EXISTS (
       SELECT 1 FROM workshop_publications
       WHERE id = ? AND status = 'building' AND builder_host_id = ?
         AND claim_expires_at = ?
     )`,
  )
    .bind(
      params.now,
      params.publication.id,
      params.publication.id,
      params.builderHostId,
      params.claimExpiresAt,
    )
    .run();
  return jsonResponse({
    publication_id: params.publication.id,
    workshop_slug: params.publication.workshopSlug,
    content_hash: params.publication.contentHash,
    required_checkpoint_ids: params.publication.requiredCheckpointIds,
    bundle_url: `${BUILDER_PATH}/${params.publication.id}/bundle`,
  });
}

async function handleWorkshopBuilderBundle(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const builder = await requireBuilder(request, env);
  if (!builder.ok) return builder.response;
  const now = Date.now();
  const rows = await drizzle(env.DB)
    .update(workshopPublications)
    .set({
      claimExpiresAt: now + WORKSHOP_PUBLICATION_CLAIM_LEASE_MS,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopPublications.id, publicationId),
        eq(workshopPublications.status, "building"),
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
  const publication = rows[0];
  if (!publication) return jsonResponse({ error: "not found" }, 404);
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    publication.sourceR2Key,
  );
  if (!object) return jsonResponse({ error: "bundle object not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
      etag: object.httpEtag,
      "x-workshop-content-sha256": publication.contentHash,
    },
  });
}

async function handleWorkshopBuilderResult(
  request: Request,
  env: Cloudflare.Env,
  publicationId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const builder = await requireBuilder(request, env);
  if (!builder.ok) return builder.response;
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isRecord(body))
    return jsonResponse({ error: "JSON body required" }, 400);
  if (body.status !== "succeeded" && body.status !== "failed") {
    return jsonResponse({ error: "status must be succeeded or failed" }, 400);
  }
  const requestedStatus = body.status;
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
    return jsonResponse(
      { error: "publication is not assigned to this builder" },
      409,
    );
  }
  const terminalResponse = await workshopPublicationTerminalResponse({
    env,
    publication,
    requestedStatus,
  });
  if (terminalResponse) return terminalResponse;

  if (requestedStatus === "failed") {
    const error =
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim().slice(0, MAX_ERROR_LENGTH)
        : "workshop checkpoint build failed";
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_publication_checkpoints
         SET status = 'failed', error = ?, updated_at = ?
         WHERE publication_id = ? AND status <> 'verified' AND EXISTS (
           SELECT 1 FROM workshop_publications
           WHERE id = ? AND status = 'building' AND builder_host_id = ?
         )`,
      ).bind(error, now, publicationId, publicationId, builder.hostId),
      env.DB.prepare(
        `UPDATE workshop_publications
         SET status = 'failed', error = ?, claim_expires_at = NULL,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'building' AND builder_host_id = ?`,
      ).bind(error, now, now, publicationId, builder.hostId),
    ]);
    const completed = await loadWorkshopPublication(env, publicationId);
    if (completed?.builderHostId === builder.hostId) {
      const response = await workshopPublicationTerminalResponse({
        env,
        publication: completed,
        requestedStatus,
      });
      if (response) return response;
    }
    return jsonResponse(
      { error: "workshop publication lost its completion fence; retry" },
      409,
    );
  }

  const sourceObject = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    publication.sourceR2Key,
  );
  if (!sourceObject) {
    return jsonResponse({ error: "bundle object not found" }, 409);
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
        error:
          error instanceof Error
            ? `stored source bundle failed validation: ${error.message}`
            : "stored source bundle failed validation",
      },
      409,
    );
  }

  let checkpointReports: VerifiedCheckpointReport[];
  try {
    checkpointReports = await verifyCheckpointReports({
      env,
      publicationId,
      source,
      raw: body.checkpoints,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
  let manifest: WorkshopManifestV1;
  try {
    manifest = validateWorkshopManifest(
      hydrateWorkshopManifest({
        source,
        checkpoints: checkpointReports,
      }),
    );
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }

  const existingTemplate = await db
    .select({ id: workshopTemplates.id })
    .from(workshopTemplates)
    .where(
      and(
        eq(workshopTemplates.organizationId, publication.organizationId),
        eq(workshopTemplates.slug, publication.workshopSlug),
      ),
    )
    .limit(1);
  const templateId = existingTemplate[0]?.id ?? createAppId();
  const revisionId = createAppId();
  const revisionRows = await db
    .select({ revision: max(workshopTemplateRevisions.revision) })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.templateId, templateId));
  const revision = (revisionRows[0]?.revision ?? 0) + 1;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO workshop_templates (
        id, organization_id, slug, title, summary, current_revision_id,
        created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?
      FROM workshop_publications
      WHERE id = ? AND status = 'building' AND builder_host_id = ?
      ON CONFLICT (organization_id, slug) DO NOTHING`,
    ).bind(
      templateId,
      publication.organizationId,
      manifest.workshop.slug,
      manifest.workshop.title,
      manifest.workshop.summary,
      publication.submittedBy,
      now,
      now,
      publicationId,
      builder.hostId,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions (
        id, template_id, revision, source_revision, content_hash,
        manifest_json, published_by, published_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      FROM workshop_publications
      WHERE id = ? AND status = 'building' AND builder_host_id = ?`,
    ).bind(
      revisionId,
      templateId,
      revision,
      publication.contentHash,
      publication.contentHash,
      JSON.stringify(manifest),
      publication.submittedBy,
      now,
      publicationId,
      builder.hostId,
    ),
    env.DB.prepare(
      `UPDATE workshop_templates
       SET title = ?, summary = ?, current_revision_id = ?, updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM workshop_template_revisions WHERE id = ?
       )`,
    ).bind(
      manifest.workshop.title,
      manifest.workshop.summary,
      revisionId,
      now,
      templateId,
      revisionId,
    ),
    ...checkpointReports.map((checkpoint) =>
      env.DB.prepare(
        `UPDATE workshop_publication_checkpoints
         SET status = 'verified', vm_images_json = ?, sanitized = 1,
             cold_boot_verified = 1, error = NULL, verified_at = ?, updated_at = ?
         WHERE publication_id = ? AND checkpoint_id = ? AND EXISTS (
           SELECT 1 FROM workshop_publications
           WHERE id = ? AND status = 'building' AND builder_host_id = ?
         )`,
      ).bind(
        JSON.stringify(checkpoint.rawVmImages),
        now,
        now,
        publicationId,
        checkpoint.checkpointId,
        publicationId,
        builder.hostId,
      ),
    ),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'published', published_revision_id = ?, error = NULL,
           claim_expires_at = NULL, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'building' AND builder_host_id = ?
         AND (SELECT count(*) FROM workshop_publication_checkpoints
              WHERE publication_id = ? AND status IN ('building', 'verified')) = ?`,
    ).bind(
      revisionId,
      now,
      now,
      publicationId,
      builder.hostId,
      publicationId,
      checkpointReports.length,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const completed = await loadWorkshopPublication(env, publicationId);
    if (completed?.builderHostId === builder.hostId) {
      const response = await workshopPublicationTerminalResponse({
        env,
        publication: completed,
        requestedStatus,
      });
      if (response) return response;
    }
    return jsonResponse(
      {
        error: "workshop revision publication conflicted; retry result report",
        detail: error instanceof Error ? error.message : String(error),
      },
      409,
    );
  }
  const published = await loadWorkshopPublication(env, publicationId);
  if (
    published?.status !== "published" ||
    published.publishedRevisionId !== revisionId ||
    published.builderHostId !== builder.hostId
  ) {
    if (published?.builderHostId === builder.hostId) {
      const response = await workshopPublicationTerminalResponse({
        env,
        publication: published,
        requestedStatus,
      });
      if (response) return response;
    }
    return jsonResponse(
      { error: "workshop publication lost its completion fence; retry" },
      409,
    );
  }

  const cacheImages = manifest.workspace.checkpoints.flatMap((checkpoint) =>
    checkpoint.vmImages.flatMap((image) =>
      isImageKey(image.imageKey)
        ? [{ image_key: image.imageKey, image_sha256: image.imageSha256 }]
        : [],
    ),
  );
  try {
    await bumpCachedImages(db, cacheImages, publication.organizationId);
  } catch (error) {
    // Publication is already durable and immutable. Cache convergence is
    // best-effort here and lobby preflight will continue to report readiness.
    console.error("workshop checkpoint cache prewarm failed", error);
  }
  return jsonResponse(
    {
      publication_id: publicationId,
      status: "published",
      template_id: templateId,
      revision_id: revisionId,
      revision,
    },
    201,
  );
}

async function loadWorkshopPublication(
  env: Cloudflare.Env,
  publicationId: string,
): Promise<WorkshopPublicationRow | undefined> {
  const rows = await drizzle(env.DB)
    .select()
    .from(workshopPublications)
    .where(eq(workshopPublications.id, publicationId))
    .limit(1);
  return rows[0];
}

async function workshopPublicationTerminalResponse(params: {
  env: Cloudflare.Env;
  publication: WorkshopPublicationRow;
  requestedStatus: BuilderResultStatus;
}): Promise<Response | null> {
  if (params.publication.status === "building") return null;

  if (params.publication.status === "failed") {
    if (params.requestedStatus !== "failed") {
      return jsonResponse(
        {
          error:
            "publication is already failed and cannot accept a succeeded result",
        },
        409,
      );
    }
    return jsonResponse({
      publication_id: params.publication.id,
      status: "failed",
    });
  }

  if (params.publication.status === "published") {
    if (params.requestedStatus !== "succeeded") {
      return jsonResponse(
        {
          error:
            "publication is already published and cannot accept a failed result",
        },
        409,
      );
    }
    if (!params.publication.publishedRevisionId) {
      return jsonResponse(
        { error: "published publication is missing revision metadata" },
        409,
      );
    }
    const revisions = await drizzle(params.env.DB)
      .select({
        templateId: workshopTemplateRevisions.templateId,
        revision: workshopTemplateRevisions.revision,
      })
      .from(workshopTemplateRevisions)
      .where(
        eq(
          workshopTemplateRevisions.id,
          params.publication.publishedRevisionId,
        ),
      )
      .limit(1);
    const revision = revisions[0];
    if (!revision) {
      return jsonResponse(
        { error: "published publication is missing revision metadata" },
        409,
      );
    }
    return jsonResponse({
      publication_id: params.publication.id,
      status: "published",
      template_id: revision.templateId,
      revision_id: params.publication.publishedRevisionId,
      revision: revision.revision,
    });
  }

  return jsonResponse(
    { error: "publication is not assigned to this builder" },
    409,
  );
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
  const workshopsEnabled = await isWorkshopsEnabledForOrganization(
    row.organizationId,
    new FlagshipFeatureToggleService(flagshipBindingFromEnvironment(env)),
  );
  if (!workshopsEnabled) return null;
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
): Promise<
  | { ok: true; hostId: string; organizationId: string | null }
  | { ok: false; response: Response }
> {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified;
  if (verified.agent.role !== "builder") {
    return {
      ok: false,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  return {
    ok: true,
    hostId: verified.agent.hostId,
    organizationId: verified.agent.organizationId,
  };
}

async function verifyCheckpointReports(params: {
  env: Cloudflare.Env;
  publicationId: string;
  source: ValidatedWorkshopSourceBundle;
  raw: unknown;
}): Promise<VerifiedCheckpointReport[]> {
  if (!Array.isArray(params.raw)) {
    throw new Error("checkpoints must be an array");
  }
  const sourceManifest = asRecord(
    params.source.compiledManifest.manifest,
    "compiled manifest",
  );
  const workspace = asRecord(sourceManifest.workspace, "workspace");
  const sourceVms = asRecordArray(workspace.vms, "workspace.vms");
  const requiredVmIds = sourceVms.map((vm) =>
    readRequiredString(vm.id, "VM id"),
  );
  const requiredCheckpoints = new Set(params.source.requiredCheckpointIds);
  const seen = new Set<string>();
  const reports: VerifiedCheckpointReport[] = [];
  for (const rawCheckpoint of params.raw) {
    const checkpoint = asRecord(rawCheckpoint, "checkpoint report");
    const checkpointId = readRequiredString(
      checkpoint.checkpoint_id ?? checkpoint.checkpointId,
      "checkpoint_id",
    );
    if (!requiredCheckpoints.has(checkpointId) || seen.has(checkpointId)) {
      throw new Error(`checkpoint ${checkpointId} is unexpected or duplicated`);
    }
    seen.add(checkpointId);
    if (
      checkpoint.sanitized !== true ||
      (checkpoint.cold_boot_verified ?? checkpoint.coldBootVerified) !== true
    ) {
      throw new Error(
        `checkpoint ${checkpointId} must be sanitized and cold-boot verified`,
      );
    }
    const rawImages = checkpoint.vm_images ?? checkpoint.vmImages;
    const images = asRecordArray(
      rawImages,
      `checkpoint ${checkpointId} vm_images`,
    );
    if (images.length !== requiredVmIds.length) {
      throw new Error(
        `checkpoint ${checkpointId} must contain every workspace VM`,
      );
    }
    const vmImages: WorkshopCheckpointBuildReport["vmImages"] = [];
    const imageVmIds = new Set<string>();
    for (const image of images) {
      const vmId = readRequiredString(image.vm_id ?? image.vmId, "vm_id");
      if (!requiredVmIds.includes(vmId) || imageVmIds.has(vmId)) {
        throw new Error(
          `checkpoint ${checkpointId} has an invalid or duplicated VM ${vmId}`,
        );
      }
      imageVmIds.add(vmId);
      const imageKey = image.image_key ?? image.imageKey;
      if (!isImageKey(imageKey)) {
        throw new Error(`checkpoint ${checkpointId} has an invalid image_key`);
      }
      const expectedScenario = `workshop-${params.publicationId}-${checkpointId}`;
      if (imageKey.scenario !== expectedScenario || imageKey.vm !== vmId) {
        throw new Error(
          `checkpoint ${checkpointId} image_key is outside its publication namespace`,
        );
      }
      const imageSha256 = normalizeSha256(
        readRequiredString(
          image.image_sha256 ?? image.imageSha256,
          "image_sha256",
        ),
      );
      const kernelSha256 = normalizeSha256(
        readRequiredString(
          image.kernel_sha256 ?? image.kernelSha256,
          "kernel_sha256",
        ),
      );
      const initrdSha256 = normalizeSha256(
        readRequiredString(
          image.initrd_sha256 ?? image.initrdSha256,
          "initrd_sha256",
        ),
      );
      const imageFormat = image.image_format ?? image.imageFormat;
      const virtualSize =
        image.image_virtual_size_bytes ?? image.imageVirtualSizeBytes;
      const bootCmdline = readRequiredString(
        image.boot_cmdline ?? image.bootCmdline,
        "boot_cmdline",
      );
      if (
        !imageSha256 ||
        !kernelSha256 ||
        !initrdSha256 ||
        imageFormat !== "raw_zstd" ||
        typeof virtualSize !== "number" ||
        !Number.isSafeInteger(virtualSize) ||
        virtualSize <= 0
      ) {
        throw new Error(
          `checkpoint ${checkpointId} image metadata is incomplete`,
        );
      }
      const imageRegistryKey = registryImageKey(imageKey);
      const storedImageKey: Record<string, unknown> = { ...imageKey };
      const [imageObject, kernelObject, initrdObject] = await Promise.all([
        params.env.VM_IMAGE_REGISTRY_BUCKET.head(
          imageObjectKey(imageRegistryKey, imageSha256),
        ),
        params.env.VM_IMAGE_REGISTRY_BUCKET.head(
          artifactObjectKey(kernelSha256),
        ),
        params.env.VM_IMAGE_REGISTRY_BUCKET.head(
          artifactObjectKey(initrdSha256),
        ),
      ]);
      if (
        !imageObject ||
        normalizeSha256(imageObject.customMetadata?.image_sha256 ?? "") !==
          imageSha256 ||
        !kernelObject ||
        !initrdObject
      ) {
        throw new Error(
          `checkpoint ${checkpointId} references missing registry objects`,
        );
      }
      vmImages.push({ vmId, imageKey: storedImageKey, imageSha256 });
      Object.assign(image, {
        vm_id: vmId,
        image_key: imageKey,
        image_sha256: imageSha256,
        image_format: imageFormat,
        image_virtual_size_bytes: virtualSize,
        kernel_sha256: kernelSha256,
        initrd_sha256: initrdSha256,
        boot_cmdline: bootCmdline,
      });
    }
    reports.push({
      checkpointId,
      vmImages,
      rawVmImages: images,
      sanitized: true,
      coldBootVerified: true,
    });
  }
  if (seen.size !== requiredCheckpoints.size) {
    throw new Error("every required checkpoint must be reported exactly once");
  }
  return reports.sort((left, right) =>
    left.checkpointId.localeCompare(right.checkpointId),
  );
}

function publicationReceipt(
  request: Request,
  publicationId: string,
  status: string,
): Response {
  const statusUrl = new URL(
    `${WORKSHOP_PUBLICATION_PATH}/${publicationId}`,
    request.url,
  ).toString();
  return jsonResponse(
    { publication_id: publicationId, status, status_url: statusUrl },
    202,
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function readFormString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function asRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry) => asRecord(entry, label));
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}
