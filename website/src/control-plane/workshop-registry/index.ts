import { and, asc, eq, isNull, lte, max, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env as workerEnv } from "cloudflare:workers";
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
  workshopPublicationProviderAttempts,
  workshopPublicationProviderCheckpoints,
  workshopPublicationProviderCostLedger,
  workshopPublications,
  workshopRegistryTokens,
  workshopTemplateRevisions,
  workshopTemplates,
  type ProviderPriceObservation,
  type WorkshopManifestV1,
} from "@/db/schema";
import type { WorkshopPublicationExpectedProbe } from "@/db/schema/workshop-publication-providers";
import { AppError, toErrorResponse } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  FlagshipFeatureToggleService,
  flagshipBindingFromEnvironment,
} from "@/lib/feature-toggles";
import { decimalCurrencyToMicros } from "@/lib/workshops/costs";
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
import {
  resolveWorkshopPublicationProviderContext,
  resolveWorkshopPublicationProvider,
  workshopUsesHetznerProvider,
} from "./provider";

const WORKSHOP_PUBLICATION_PATH = "/registry/v1/workshop-bundles";
const BUILDER_PATH = "/agent/registry/workshop-publications";
const MAX_ERROR_LENGTH = 4_000;
// A canonical multi-checkpoint build can take hours. Resume and bundle reads
// renew this lease; builder_host_id remains the completion fencing token.
const WORKSHOP_PUBLICATION_CLAIM_LEASE_MS = 12 * 60 * 60 * 1_000;
const MAX_CLAIM_ATTEMPTS = 5;
const TERMINAL_PROVIDER_STAGING_ERROR_CODES: ReadonlySet<string> = new Set([
  "hcloud_server_type_unavailable",
  "hcloud_server_type_incompatible",
  "hcloud_server_type_undersized",
  "hcloud_system_image_unavailable",
]);
const PROVIDER_FINALIZATION_GUARD_SQL = `
  publication.status = 'building'
  AND publication.provider_verification_state = 'verifying'
  AND (
    SELECT count(*)
    FROM workshop_publication_provider_checkpoints checkpoint
    WHERE checkpoint.publication_id = publication.id
  ) = ?
  AND NOT EXISTS (
    SELECT 1
    FROM workshop_publication_provider_checkpoints checkpoint
    WHERE checkpoint.publication_id = publication.id
      AND (
        checkpoint.provider_kind != 'hetzner_cloud'
        OR checkpoint.verification_status != 'verified'
        OR checkpoint.proof_verified_at IS NULL
        OR checkpoint.deletion_confirmed_at IS NULL
        OR checkpoint.deletion_confirmed_at < checkpoint.proof_verified_at
        OR json_array_length(checkpoint.expected_probes_json) = 0
        OR (
          SELECT count(*)
          FROM workshop_publication_provider_attempts attempt
          WHERE attempt.provider_checkpoint_id = checkpoint.id
            AND attempt.proof_verified_at IS NOT NULL
            AND attempt.proof_report_sequence IS NOT NULL
        ) != 1
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workshop_publication_provider_attempts attempt
    INNER JOIN workshop_publication_provider_checkpoints checkpoint
      ON checkpoint.id = attempt.provider_checkpoint_id
    WHERE checkpoint.publication_id = publication.id
      AND (
        attempt.state != 'deleted'
        OR attempt.deletion_confirmed_at IS NULL
        OR (
          attempt.report_credential_hash IS NOT NULL
          AND attempt.report_credential_revoked_at IS NULL
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workshop_publication_provider_attempts attempt
    INNER JOIN workshop_publication_provider_checkpoints checkpoint
      ON checkpoint.id = attempt.provider_checkpoint_id
    WHERE checkpoint.publication_id = publication.id
      AND attempt.proof_verified_at IS NOT NULL
      AND (
        attempt.proof_report_sequence IS NULL
        OR attempt.last_report_sequence != attempt.proof_report_sequence
        OR attempt.last_report_phase != 'ready'
        OR attempt.last_report_health != 'healthy'
        OR attempt.report_json IS NULL
        OR attempt.checkpoint_first_downloaded_at IS NULL
        OR attempt.proof_verified_at < attempt.checkpoint_first_downloaded_at
        OR attempt.last_report_at IS NULL
        OR attempt.last_report_at < attempt.checkpoint_first_downloaded_at
        OR attempt.server_id IS NULL
        OR attempt.primary_ip_id IS NULL
        OR attempt.ssh_key_id IS NULL
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workshop_publication_provider_cost_ledger ledger
    INNER JOIN workshop_publication_provider_attempts attempt
      ON attempt.id = ledger.attempt_id
    INNER JOIN workshop_publication_provider_checkpoints checkpoint
      ON checkpoint.id = attempt.provider_checkpoint_id
    WHERE checkpoint.publication_id = publication.id
      AND ledger.deletion_confirmed_at IS NULL
  )
`;

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
  const providerCheckpoints = await db
    .select({
      checkpointId: workshopPublicationProviderCheckpoints.checkpointId,
      status: workshopPublicationProviderCheckpoints.verificationStatus,
      error: workshopPublicationProviderCheckpoints.error,
      proofVerifiedAt: workshopPublicationProviderCheckpoints.proofVerifiedAt,
      deletionConfirmedAt:
        workshopPublicationProviderCheckpoints.deletionConfirmedAt,
    })
    .from(workshopPublicationProviderCheckpoints)
    .where(
      eq(workshopPublicationProviderCheckpoints.publicationId, publicationId),
    )
    .orderBy(asc(workshopPublicationProviderCheckpoints.ordinal));
  const providerCost = await env.DB.prepare(
    `SELECT
       checkpoint.checkpoint_id,
       ledger.currency,
       sum(
         min(
           max(1, cast((coalesce(ledger.deletion_confirmed_at, ?) - ledger.provider_created_at + 3599999) / 3600000 as integer))
             * ledger.hourly_net_micros,
           coalesce(ledger.monthly_net_micros, 9223372036854775807)
         )
       ) AS estimated_net_micros,
       sum(
         min(
           max(1, cast((coalesce(ledger.deletion_confirmed_at, ?) - ledger.provider_created_at + 3599999) / 3600000 as integer))
             * ledger.hourly_gross_micros,
           coalesce(ledger.monthly_gross_micros, 9223372036854775807)
         )
       ) AS estimated_gross_micros
     FROM workshop_publication_provider_cost_ledger ledger
     INNER JOIN workshop_publication_provider_attempts attempt
       ON attempt.id = ledger.attempt_id
     INNER JOIN workshop_publication_provider_checkpoints checkpoint
       ON checkpoint.id = attempt.provider_checkpoint_id
     WHERE checkpoint.publication_id = ?
     GROUP BY checkpoint.checkpoint_id, ledger.currency
     ORDER BY checkpoint.ordinal ASC`,
  )
    .bind(Date.now(), Date.now(), publicationId)
    .all<{
      checkpoint_id: string;
      currency: string;
      estimated_net_micros: number;
      estimated_gross_micros: number;
    }>();
  const publicStatus =
    publication.status === "building" &&
    publication.providerVerificationState !== null
      ? publication.providerVerificationState
      : publication.status;
  return jsonResponse({
    publication_id: publication.id,
    workshop_id: publication.workshopSlug,
    sha256: publication.contentHash,
    status: publicStatus,
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
    provider_verification:
      providerCheckpoints.length === 0
        ? null
        : {
            state: publication.providerVerificationState,
            checkpoints: providerCheckpoints.map((checkpoint) => ({
              checkpoint_id: checkpoint.checkpointId,
              status: checkpoint.status,
              error: checkpoint.error,
              proof_verified_at: checkpoint.proofVerifiedAt,
              deletion_confirmed_at: checkpoint.deletionConfirmedAt,
            })),
            estimated_costs: providerCost.results.map((entry) => ({
              checkpoint_id: entry.checkpoint_id,
              currency: entry.currency,
              estimated_net_micros: entry.estimated_net_micros,
              estimated_gross_micros: entry.estimated_gross_micros,
            })),
          },
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
  const executionModes = new URL(request.url).searchParams.getAll(
    "execution_mode",
  );
  if (
    executionModes.length > 1 ||
    (executionModes.length === 1 &&
      executionModes[0] !== "direct_provider_only")
  ) {
    return jsonResponse({ error: "invalid builder execution mode" }, 400);
  }
  const capabilityFilter =
    executionModes[0] === "direct_provider_only"
      ? sql<boolean>`json_extract(${workshopPublications.compiledManifestJson}, '$.manifest.workspace.provider.kind') = 'hetzner_cloud'`
      : undefined;
  const db = drizzle(env.DB);

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const resumed = await db
      .select({ id: workshopPublications.id })
      .from(workshopPublications)
      .where(
        and(
          eq(workshopPublications.status, "building"),
          isNull(workshopPublications.providerVerificationState),
          eq(workshopPublications.builderHostId, builder.hostId),
          capabilityFilter,
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
            isNull(workshopPublications.providerVerificationState),
            eq(workshopPublications.builderHostId, builder.hostId),
            capabilityFilter,
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
          isNull(workshopPublications.providerVerificationState),
          or(
            isNull(workshopPublications.claimExpiresAt),
            lte(workshopPublications.claimExpiresAt, Date.now()),
          ),
          capabilityFilter,
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
            isNull(workshopPublications.providerVerificationState),
            or(
              isNull(workshopPublications.claimExpiresAt),
              lte(workshopPublications.claimExpiresAt, now),
            ),
            capabilityFilter,
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
          isNull(workshopPublications.providerVerificationState),
          isNull(workshopPublications.builderHostId),
          capabilityFilter,
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
          isNull(workshopPublications.providerVerificationState),
          isNull(workshopPublications.builderHostId),
          capabilityFilter,
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
        isNull(workshopPublications.providerVerificationState),
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
    if (publication.providerVerificationState !== null) {
      return jsonResponse(
        {
          error:
            "direct provider verification owns this publication after staging",
        },
        409,
      );
    }
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

  if (workshopUsesHetznerProvider(source)) {
    if (!isProviderVerificationPendingResult(body.checkpoints)) {
      return jsonResponse(
        {
          error:
            "Hetzner workshop checkpoints require Intar direct provider verification",
        },
        400,
      );
    }
    return stageHetznerProviderPublication({
      env,
      publication,
      builderHostId: builder.hostId,
      source,
      raw: body.checkpoints,
    });
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
  let resolvedProvider: Awaited<
    ReturnType<typeof resolveWorkshopPublicationProvider>
  >;
  try {
    resolvedProvider = await resolveWorkshopPublicationProvider({
      d1: env.DB,
      organizationId: publication.organizationId,
      source,
    });
  } catch (error) {
    const response = toErrorResponse(
      error,
      "workshop provider resolution failed",
      400,
    );
    return jsonResponse(response.body, response.status);
  }
  let manifest: WorkshopManifestV1;
  try {
    manifest = validateWorkshopManifest(
      hydrateWorkshopManifest({
        source,
        checkpoints: checkpointReports,
        ...(resolvedProvider ? { resolvedProvider } : {}),
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
    ...checkpointReports.flatMap((checkpoint) => {
      const artifact = checkpoint.providerArtifact;
      if (!artifact) return [];
      return [
        env.DB.prepare(
          `INSERT INTO runtime_provider_checkpoint_artifacts (
            id, template_revision_id, checkpoint_id, provider_kind,
            r2_key, sha256, size_bytes, compression, signature_b64,
            signing_key_id, workspace_agent_sha256, kino_sha256, status,
            cold_boot_verified_at, created_at
          )
          SELECT ?, ?, ?, 'hetzner_cloud', ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?
          FROM workshop_template_revisions
          WHERE id = ?`,
        ).bind(
          createAppId(),
          revisionId,
          checkpoint.checkpointId,
          artifact.r2Key,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.compression,
          artifact.signatureB64,
          artifact.signingKeyId,
          artifact.workspaceAgentSha256,
          artifact.kinoSha256,
          now,
          now,
          revisionId,
        ),
      ];
    }),
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

interface StagedProviderCheckpointReport {
  checkpointId: string;
  coveredModuleIds: string[];
  expectedProbes: WorkshopPublicationExpectedProbe[];
  artifact: NonNullable<WorkshopCheckpointBuildReport["providerArtifact"]>;
}

type StagedProviderCheckpointRow =
  typeof workshopPublicationProviderCheckpoints.$inferSelect;

function expectedProviderCheckpointMetadata(
  source: ValidatedWorkshopSourceBundle,
): Map<
  string,
  {
    coveredModuleIds: string[];
    expectedProbes: WorkshopPublicationExpectedProbe[];
  }
> {
  const sourceManifest = asRecord(
    source.compiledManifest.manifest,
    "compiled manifest",
  );
  const modules = asRecordArray(sourceManifest.modules, "manifest.modules");
  const orderedModules: Record<string, unknown>[] = [];
  const completedModuleIds = new Set<string>();
  while (orderedModules.length < modules.length) {
    let progressed = false;
    for (const module of modules) {
      const moduleId = readRequiredString(module.id, "module id");
      if (completedModuleIds.has(moduleId)) continue;
      const dependencies = module.depends_on;
      if (
        !Array.isArray(dependencies) ||
        dependencies.some(
          (dependency) => typeof dependency !== "string" || !dependency.trim(),
        )
      ) {
        throw new Error(`module ${moduleId} dependencies are invalid`);
      }
      if (
        dependencies.every((dependency) =>
          completedModuleIds.has((dependency as string).trim()),
        )
      ) {
        completedModuleIds.add(moduleId);
        orderedModules.push(module);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error(
        "validated workshop modules cannot be ordered by dependencies",
      );
    }
  }
  const expected = new Map<
    string,
    {
      coveredModuleIds: string[];
      expectedProbes: WorkshopPublicationExpectedProbe[];
    }
  >();
  const coveredModuleIds: string[] = [];
  const coveredProbes: WorkshopPublicationExpectedProbe[] = [];
  for (const module of orderedModules) {
    const moduleId = readRequiredString(module.id, "module id");
    const checkpointId = readRequiredString(
      module.checkpoint,
      `module ${moduleId} checkpoint`,
    );
    const probes = module.probes;
    if (
      !Array.isArray(probes) ||
      probes.some((probe) => typeof probe !== "string" || !probe.trim())
    ) {
      throw new Error(`module ${moduleId} probes are invalid`);
    }
    coveredModuleIds.push(moduleId);
    coveredProbes.push(
      ...probes.map((probe) => ({
        moduleId,
        probeId: (probe as string).trim(),
      })),
    );
    expected.set(checkpointId, {
      coveredModuleIds: [...coveredModuleIds],
      expectedProbes: [...coveredProbes],
    });
  }
  return expected;
}

function stagedGuestTools(
  rows: StagedProviderCheckpointRow[],
): { workspaceAgentSha256: string; kinoSha256: string } | null {
  const first = rows[0];
  if (!first) return null;
  const workspaceAgentSha256 = normalizeSha256(first.workspaceAgentSha256);
  const kinoSha256 = normalizeSha256(first.kinoSha256);
  if (
    !workspaceAgentSha256 ||
    !kinoSha256 ||
    rows.some(
      (row) =>
        row.workspaceAgentSha256 !== workspaceAgentSha256 ||
        row.kinoSha256 !== kinoSha256,
    )
  ) {
    return null;
  }
  return { workspaceAgentSha256, kinoSha256 };
}

function stagedProviderRowsMatchReports(
  rows: StagedProviderCheckpointRow[],
  reports: StagedProviderCheckpointReport[],
): boolean {
  return (
    rows.length === reports.length &&
    rows.every((row, ordinal) => {
      const report = reports[ordinal];
      return (
        !!report &&
        row.ordinal === ordinal &&
        row.checkpointId === report.checkpointId &&
        jsonEqual(row.coveredModuleIdsJson, report.coveredModuleIds) &&
        jsonEqual(row.expectedProbesJson, report.expectedProbes) &&
        row.r2Key === report.artifact.r2Key &&
        row.sha256 === report.artifact.sha256 &&
        row.sizeBytes === report.artifact.sizeBytes &&
        row.compression === report.artifact.compression &&
        row.signatureB64 === report.artifact.signatureB64 &&
        row.signingKeyId === report.artifact.signingKeyId &&
        row.workspaceAgentSha256 === report.artifact.workspaceAgentSha256 &&
        row.kinoSha256 === report.artifact.kinoSha256
      );
    })
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validProviderPriceObservation(
  value: unknown,
  expectedServerType: string,
  permittedLocations: readonly string[],
): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !Number.isSafeInteger(value.observedAt) ||
    Number(value.observedAt) <= 0 ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= Number(value.observedAt) ||
    value.serverType !== expectedServerType ||
    !Array.isArray(value.locations) ||
    value.locations.length !== permittedLocations.length
  ) {
    return false;
  }
  const permitted = new Set(permittedLocations);
  const seen = new Set<string>();
  for (const raw of value.locations) {
    if (!isRecord(raw) || typeof raw.location !== "string") return false;
    const location = raw.location;
    if (
      !permitted.has(location) ||
      seen.has(location) ||
      typeof raw.available !== "boolean"
    ) {
      return false;
    }
    seen.add(location);
    const requiredPrices = [
      raw.serverHourlyNet,
      raw.serverHourlyGross,
      raw.ipv4HourlyNet,
      raw.ipv4HourlyGross,
    ];
    const optionalPrices = [
      raw.serverMonthlyNet,
      raw.serverMonthlyGross,
      raw.ipv4MonthlyNet,
      raw.ipv4MonthlyGross,
    ];
    if (
      requiredPrices.some((price) => !validProviderDecimal(price)) ||
      optionalPrices.some(
        (price) => price !== undefined && !validProviderDecimal(price),
      )
    ) {
      return false;
    }
  }
  return seen.size === permitted.size;
}

function validProviderDecimal(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    decimalCurrencyToMicros(value);
    return true;
  } catch {
    return false;
  }
}

function providerLedgerMatchesObservation(
  entry: {
    resourceKind: "server" | "primary_ipv4";
    resourceType: string;
    location: string;
    currency: string;
    hourlyNetRaw: string;
    hourlyGrossRaw: string;
    hourlyNetMicros: number;
    hourlyGrossMicros: number;
    monthlyNetRaw: string | null;
    monthlyGrossRaw: string | null;
    monthlyNetMicros: number | null;
    monthlyGrossMicros: number | null;
  },
  observation: ProviderPriceObservation,
  location: string,
): boolean {
  const prices = observation.locations.find(
    (candidate) => candidate.location === location,
  );
  if (!prices) return false;
  const server = entry.resourceKind === "server";
  const hourlyNetRaw = server ? prices.serverHourlyNet : prices.ipv4HourlyNet;
  const hourlyGrossRaw = server
    ? prices.serverHourlyGross
    : prices.ipv4HourlyGross;
  const monthlyNetRaw =
    (server ? prices.serverMonthlyNet : prices.ipv4MonthlyNet) ?? null;
  const monthlyGrossRaw =
    (server ? prices.serverMonthlyGross : prices.ipv4MonthlyGross) ?? null;
  return (
    entry.location === location &&
    entry.currency === observation.currency &&
    entry.resourceType === (server ? observation.serverType : "ipv4") &&
    entry.hourlyNetRaw === hourlyNetRaw &&
    entry.hourlyGrossRaw === hourlyGrossRaw &&
    entry.hourlyNetMicros === decimalCurrencyToMicros(hourlyNetRaw) &&
    entry.hourlyGrossMicros === decimalCurrencyToMicros(hourlyGrossRaw) &&
    entry.monthlyNetRaw === monthlyNetRaw &&
    entry.monthlyGrossRaw === monthlyGrossRaw &&
    entry.monthlyNetMicros ===
      (monthlyNetRaw === null
        ? null
        : decimalCurrencyToMicros(monthlyNetRaw)) &&
    entry.monthlyGrossMicros ===
      (monthlyGrossRaw === null
        ? null
        : decimalCurrencyToMicros(monthlyGrossRaw))
  );
}

function isProviderVerificationPendingResult(raw: unknown): boolean {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every(
      (value) =>
        isRecord(value) &&
        (value.provider_verification_pending ??
          value.providerVerificationPending) === true,
    )
  );
}

function isTerminalProviderStagingError(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    TERMINAL_PROVIDER_STAGING_ERROR_CODES.has(error.code)
  );
}

async function failTerminalProviderStaging(input: {
  env: Cloudflare.Env;
  publication: WorkshopPublicationRow;
  builderHostId: string;
  error: AppError;
}): Promise<boolean> {
  const now = Date.now();
  const reason = input.error.message.slice(0, MAX_ERROR_LENGTH);

  const results = await input.env.DB.batch([
    input.env.DB.prepare(
      `UPDATE workshop_publication_checkpoints
       SET status = 'failed', vm_images_json = NULL, sanitized = 0,
           cold_boot_verified = 0, error = ?, verified_at = NULL,
           updated_at = ?
       WHERE publication_id = ? AND status <> 'verified' AND EXISTS (
         SELECT 1 FROM workshop_publications publication
         WHERE publication.id = ? AND publication.status = 'building'
           AND publication.builder_host_id = ?
           AND publication.provider_verification_state IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM workshop_publication_provider_checkpoints checkpoint
             WHERE checkpoint.publication_id = publication.id
           )
       )`,
    ).bind(
      reason,
      now,
      input.publication.id,
      input.publication.id,
      input.builderHostId,
    ),
    input.env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'failed', error = ?, claim_expires_at = NULL,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'building' AND builder_host_id = ?
         AND provider_verification_state IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM workshop_publication_provider_checkpoints checkpoint
           WHERE checkpoint.publication_id = workshop_publications.id
         )`,
    ).bind(
      reason,
      now,
      now,
      input.publication.id,
      input.builderHostId,
    ),
  ]);

  return (
    results[0]?.meta.changes ===
      input.publication.requiredCheckpointIdsJson.length &&
    results[1]?.meta.changes === 1
  );
}

async function stageHetznerProviderPublication(input: {
  env: Cloudflare.Env;
  publication: WorkshopPublicationRow;
  builderHostId: string;
  source: ValidatedWorkshopSourceBundle;
  raw: unknown;
}): Promise<Response> {
  const db = drizzle(input.env.DB);
  const existing = await db
    .select()
    .from(workshopPublicationProviderCheckpoints)
    .where(
      eq(
        workshopPublicationProviderCheckpoints.publicationId,
        input.publication.id,
      ),
    )
    .orderBy(asc(workshopPublicationProviderCheckpoints.ordinal));
  const existingGuestTools =
    existing.length === 0 ? undefined : stagedGuestTools(existing);
  if (existing.length > 0 && !existingGuestTools) {
    return jsonResponse(
      { error: "staged provider guest-tool pins are inconsistent" },
      409,
    );
  }

  let reports: StagedProviderCheckpointReport[];
  try {
    reports = await verifyStagedProviderCheckpointReports({
      env: input.env,
      source: input.source,
      raw: input.raw,
      guestTools:
        existingGuestTools ?? (await verifyPublishedGuestToolPair(input.env)),
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }

  if (existing.length > 0) {
    if (!stagedProviderRowsMatchReports(existing, reports)) {
      return jsonResponse(
        { error: "provider verification staging replay does not match" },
        409,
      );
    }
    if (
      input.publication.providerVerificationState === "failed" ||
      input.publication.providerVerificationState === "cleanup_pending"
    ) {
      return jsonResponse(
        {
          error: `provider verification is ${input.publication.providerVerificationState}`,
        },
        409,
      );
    }
    return jsonResponse(
      {
        publication_id: input.publication.id,
        status: input.publication.providerVerificationState ?? "verifying",
      },
      202,
    );
  }

  let context: NonNullable<
    Awaited<ReturnType<typeof resolveWorkshopPublicationProviderContext>>
  >;
  try {
    const resolved = await resolveWorkshopPublicationProviderContext({
      d1: input.env.DB,
      organizationId: input.publication.organizationId,
      source: input.source,
    });
    if (!resolved) {
      throw new Error(
        "direct provider verification requires a Hetzner workshop declaration",
      );
    }
    context = resolved;
  } catch (error) {
    const response = toErrorResponse(
      error,
      "workshop provider verification staging failed",
      400,
    );
    if (isTerminalProviderStagingError(error)) {
      try {
        if (
          !(await failTerminalProviderStaging({
            env: input.env,
            publication: input.publication,
            builderHostId: input.builderHostId,
            error,
          }))
        ) {
          return jsonResponse(
            {
              error:
                "workshop provider verification staging failure lost its completion fence; retry",
            },
            409,
          );
        }
      } catch (persistenceError) {
        const persistenceResponse = toErrorResponse(
          persistenceError,
          "workshop provider verification staging failure could not be persisted",
        );
        return jsonResponse(
          persistenceResponse.body,
          persistenceResponse.status,
        );
      }
    }
    return jsonResponse(response.body, response.status);
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `UPDATE workshop_publications
       SET provider_verification_state = 'verifying',
           claim_expires_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'building' AND builder_host_id = ?
         AND provider_verification_state IS NULL`,
    ).bind(now, input.publication.id, input.builderHostId),
    ...reports.map((report, ordinal) =>
      input.env.DB.prepare(
        `INSERT INTO workshop_publication_provider_checkpoints (
           id, publication_id, checkpoint_id, ordinal,
           covered_module_ids_json, expected_probes_json,
           provider_kind, connection_id, resolved_provider_json,
           permitted_locations_json, price_observation_json,
           r2_key, sha256, size_bytes, compression, signature_b64,
           signing_key_id, workspace_agent_sha256, kino_sha256,
           verification_status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'hetzner_cloud', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, 'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM workshop_publications publication
           WHERE publication.id = ? AND publication.status = 'building'
             AND publication.builder_host_id = ?
             AND publication.provider_verification_state = 'verifying'
         )`,
      ).bind(
        createAppId(),
        input.publication.id,
        report.checkpointId,
        ordinal,
        JSON.stringify(report.coveredModuleIds),
        JSON.stringify(report.expectedProbes),
        context.connectionId,
        JSON.stringify(context.provider),
        JSON.stringify(context.permittedLocations),
        JSON.stringify(context.priceObservation),
        report.artifact.r2Key,
        report.artifact.sha256,
        report.artifact.sizeBytes,
        report.artifact.compression,
        report.artifact.signatureB64,
        report.artifact.signingKeyId,
        report.artifact.workspaceAgentSha256,
        report.artifact.kinoSha256,
        now,
        now,
        input.publication.id,
        input.builderHostId,
      ),
    ),
  ];
  try {
    const results = await input.env.DB.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new Error("provider verification staging fence was lost");
    }
  } catch {
    const replay = await db
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          input.publication.id,
        ),
      )
      .orderBy(asc(workshopPublicationProviderCheckpoints.ordinal));
    if (
      !stagedProviderRowsMatchReports(replay, reports) ||
      replay.some(
        (row) =>
          row.connectionId !== context.connectionId ||
          !jsonEqual(row.resolvedProviderJson, context.provider) ||
          !jsonEqual(row.permittedLocationsJson, context.permittedLocations),
      )
    ) {
      return jsonResponse(
        { error: "provider verification staging conflicted; retry" },
        409,
      );
    }
  }
  return jsonResponse(
    {
      publication_id: input.publication.id,
      status: "verifying",
      checkpoints: reports.map((report) => ({
        checkpoint_id: report.checkpointId,
        status: "pending",
      })),
    },
    202,
  );
}

/**
 * Finalize an immutable direct-provider workshop revision after the Intar
 * verifier has proven every signed checkpoint in a real Hetzner guest and
 * confirmed deletion of every provider resource.
 *
 * The verifier sweep calls this without passing an environment so the
 * production Worker binding is the only authority used by this boundary.
 */
export async function finalizeVerifiedWorkshopProviderPublication(input: {
  publicationId: string;
  now?: number;
}): Promise<boolean> {
  return finalizeVerifiedWorkshopProviderPublicationWithEnvironment(
    workerEnv,
    input,
  );
}

async function finalizeVerifiedWorkshopProviderPublicationWithEnvironment(
  env: Cloudflare.Env,
  input: { publicationId: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(input.publicationId) ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    return false;
  }
  const db = drizzle(env.DB);
  const publication = await loadWorkshopPublication(env, input.publicationId);
  if (
    publication?.status === "published" &&
    publication.providerVerificationState === "verified" &&
    publication.publishedRevisionId
  ) {
    return true;
  }
  if (
    !publication ||
    publication.status !== "building" ||
    publication.providerVerificationState !== "verifying"
  ) {
    return false;
  }

  const sourceObject = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    publication.sourceR2Key,
  );
  if (!sourceObject) return false;
  let source: ValidatedWorkshopSourceBundle;
  try {
    source = await validateWorkshopSourceBundle({
      payload: await sourceObject.arrayBuffer(),
      claimedWorkshopId: publication.workshopSlug,
      claimedSha256: publication.contentHash,
    });
    if (
      !workshopUsesHetznerProvider(source) ||
      !jsonEqual(source.compiledManifest, publication.compiledManifestJson) ||
      !jsonEqual(
        source.requiredCheckpointIds,
        publication.requiredCheckpointIdsJson,
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const [providerCheckpoints, publicationCheckpoints] = await Promise.all([
    db
      .select()
      .from(workshopPublicationProviderCheckpoints)
      .where(
        eq(
          workshopPublicationProviderCheckpoints.publicationId,
          publication.id,
        ),
      )
      .orderBy(asc(workshopPublicationProviderCheckpoints.ordinal)),
    db
      .select()
      .from(workshopPublicationCheckpoints)
      .where(eq(workshopPublicationCheckpoints.publicationId, publication.id)),
  ]);
  if (
    providerCheckpoints.length !== source.requiredCheckpointIds.length ||
    publicationCheckpoints.length !== source.requiredCheckpointIds.length ||
    publicationCheckpoints.some(
      (checkpoint) =>
        checkpoint.status !== "building" ||
        checkpoint.sanitized ||
        checkpoint.coldBootVerified ||
        (checkpoint.vmImagesJson !== null &&
          checkpoint.vmImagesJson.length !== 0),
    )
  ) {
    return false;
  }

  let expectedMetadata: ReturnType<typeof expectedProviderCheckpointMetadata>;
  let expectedCheckpointIds: string[];
  let sourceProvider: Record<string, unknown>;
  try {
    expectedMetadata = expectedProviderCheckpointMetadata(source);
    expectedCheckpointIds = [...expectedMetadata.keys()];
    const requiredCheckpointIds = new Set(source.requiredCheckpointIds);
    if (
      expectedCheckpointIds.length !== requiredCheckpointIds.size ||
      expectedCheckpointIds.some(
        (checkpointId) => !requiredCheckpointIds.has(checkpointId),
      )
    ) {
      return false;
    }
    const sourceManifest = asRecord(
      source.compiledManifest.manifest,
      "compiled manifest",
    );
    const sourceWorkspace = asRecord(
      sourceManifest.workspace,
      "manifest.workspace",
    );
    sourceProvider = asRecord(
      sourceWorkspace.provider,
      "manifest.workspace.provider",
    );
  } catch {
    return false;
  }

  const firstCheckpoint = providerCheckpoints[0];
  const guestTools = stagedGuestTools(providerCheckpoints);
  if (!firstCheckpoint || !guestTools) return false;
  const resolvedProvider = firstCheckpoint.resolvedProviderJson;
  const permittedLocations = firstCheckpoint.permittedLocationsJson;
  if (
    resolvedProvider.kind !== "hetzner_cloud" ||
    resolvedProvider.compatible !== true ||
    resolvedProvider.vmId !== sourceProvider.vm_id ||
    resolvedProvider.serverType !== sourceProvider.server_type ||
    resolvedProvider.systemImage !== sourceProvider.system_image ||
    !Array.isArray(permittedLocations) ||
    permittedLocations.length === 0 ||
    permittedLocations.some(
      (location) => typeof location !== "string" || !location.trim(),
    )
  ) {
    return false;
  }

  for (const [ordinal, checkpoint] of providerCheckpoints.entries()) {
    const checkpointId = expectedCheckpointIds[ordinal];
    const expected = checkpointId
      ? expectedMetadata.get(checkpointId)
      : undefined;
    if (
      !expected ||
      expected.expectedProbes.length === 0 ||
      checkpoint.ordinal !== ordinal ||
      checkpoint.checkpointId !== checkpointId ||
      checkpoint.providerKind !== "hetzner_cloud" ||
      checkpoint.connectionId !== firstCheckpoint.connectionId ||
      !jsonEqual(checkpoint.resolvedProviderJson, resolvedProvider) ||
      !jsonEqual(checkpoint.permittedLocationsJson, permittedLocations) ||
      !validProviderPriceObservation(
        checkpoint.priceObservationJson,
        resolvedProvider.serverType,
        permittedLocations,
      ) ||
      !jsonEqual(checkpoint.coveredModuleIdsJson, expected.coveredModuleIds) ||
      !jsonEqual(checkpoint.expectedProbesJson, expected.expectedProbes) ||
      checkpoint.verificationStatus !== "verified" ||
      checkpoint.proofVerifiedAt === null ||
      checkpoint.deletionConfirmedAt === null ||
      checkpoint.deletionConfirmedAt < checkpoint.proofVerifiedAt ||
      checkpoint.r2Key !== artifactObjectKey(checkpoint.sha256) ||
      !normalizeSha256(checkpoint.sha256) ||
      checkpoint.sizeBytes <= 0 ||
      !isEd25519Signature(checkpoint.signatureB64) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(checkpoint.signingKeyId)
    ) {
      return false;
    }
  }

  const artifactObjects = await Promise.all(
    providerCheckpoints.map((checkpoint) =>
      env.VM_IMAGE_REGISTRY_BUCKET.head(checkpoint.r2Key),
    ),
  );
  if (
    artifactObjects.some((object, ordinal) => {
      const checkpoint = providerCheckpoints[ordinal];
      return (
        !checkpoint ||
        !object ||
        object.size !== checkpoint.sizeBytes ||
        normalizeSha256(object.customMetadata?.artifact_sha256 ?? "") !==
          checkpoint.sha256
      );
    })
  ) {
    return false;
  }
  const [workspaceAgentObject, kinoObject] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/releases/${guestTools.workspaceAgentSha256}/intar-workspace-agent`,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/kino/releases/${guestTools.kinoSha256}/kino`,
    ),
  ]);
  if (
    !workspaceAgentObject ||
    workspaceAgentObject.size <= 0 ||
    !kinoObject ||
    kinoObject.size <= 0
  ) {
    return false;
  }

  const attempts = await db
    .select({
      checkpointDatabaseId: workshopPublicationProviderCheckpoints.id,
      checkpointId: workshopPublicationProviderCheckpoints.checkpointId,
      checkpointConnectionId:
        workshopPublicationProviderCheckpoints.connectionId,
      expectedProbes: workshopPublicationProviderCheckpoints.expectedProbesJson,
      attemptId: workshopPublicationProviderAttempts.id,
      attemptConnectionId: workshopPublicationProviderAttempts.connectionId,
      attemptOrdinal: workshopPublicationProviderAttempts.ordinal,
      serverType: workshopPublicationProviderAttempts.serverType,
      systemImage: workshopPublicationProviderAttempts.systemImage,
      location: workshopPublicationProviderAttempts.location,
      serverId: workshopPublicationProviderAttempts.serverId,
      primaryIpId: workshopPublicationProviderAttempts.primaryIpId,
      sshKeyId: workshopPublicationProviderAttempts.sshKeyId,
      state: workshopPublicationProviderAttempts.state,
      reportCredentialRevokedAt:
        workshopPublicationProviderAttempts.reportCredentialRevokedAt,
      reportCredentialHash:
        workshopPublicationProviderAttempts.reportCredentialHash,
      checkpointFirstDownloadedAt:
        workshopPublicationProviderAttempts.checkpointFirstDownloadedAt,
      lastReportSequence:
        workshopPublicationProviderAttempts.lastReportSequence,
      lastReportPhase: workshopPublicationProviderAttempts.lastReportPhase,
      lastReportHealth: workshopPublicationProviderAttempts.lastReportHealth,
      lastReportAt: workshopPublicationProviderAttempts.lastReportAt,
      reportJson: workshopPublicationProviderAttempts.reportJson,
      proofReportSequence:
        workshopPublicationProviderAttempts.proofReportSequence,
      proofVerifiedAt: workshopPublicationProviderAttempts.proofVerifiedAt,
      deletionConfirmedAt:
        workshopPublicationProviderAttempts.deletionConfirmedAt,
    })
    .from(workshopPublicationProviderAttempts)
    .innerJoin(
      workshopPublicationProviderCheckpoints,
      eq(
        workshopPublicationProviderAttempts.providerCheckpointId,
        workshopPublicationProviderCheckpoints.id,
      ),
    )
    .where(
      eq(workshopPublicationProviderCheckpoints.publicationId, publication.id),
    )
    .orderBy(
      asc(workshopPublicationProviderCheckpoints.ordinal),
      asc(workshopPublicationProviderAttempts.ordinal),
    );
  const costLedger = await db
    .select({
      attemptId: workshopPublicationProviderCostLedger.attemptId,
      providerResourceId:
        workshopPublicationProviderCostLedger.providerResourceId,
      resourceKind: workshopPublicationProviderCostLedger.resourceKind,
      resourceType: workshopPublicationProviderCostLedger.resourceType,
      location: workshopPublicationProviderCostLedger.location,
      currency: workshopPublicationProviderCostLedger.currency,
      hourlyNetRaw: workshopPublicationProviderCostLedger.hourlyNetRaw,
      hourlyGrossRaw: workshopPublicationProviderCostLedger.hourlyGrossRaw,
      hourlyNetMicros: workshopPublicationProviderCostLedger.hourlyNetMicros,
      hourlyGrossMicros:
        workshopPublicationProviderCostLedger.hourlyGrossMicros,
      monthlyNetRaw: workshopPublicationProviderCostLedger.monthlyNetRaw,
      monthlyGrossRaw: workshopPublicationProviderCostLedger.monthlyGrossRaw,
      monthlyNetMicros: workshopPublicationProviderCostLedger.monthlyNetMicros,
      monthlyGrossMicros:
        workshopPublicationProviderCostLedger.monthlyGrossMicros,
      providerCreatedAt:
        workshopPublicationProviderCostLedger.providerCreatedAt,
      deletionConfirmedAt:
        workshopPublicationProviderCostLedger.deletionConfirmedAt,
    })
    .from(workshopPublicationProviderCostLedger)
    .innerJoin(
      workshopPublicationProviderAttempts,
      eq(
        workshopPublicationProviderCostLedger.attemptId,
        workshopPublicationProviderAttempts.id,
      ),
    )
    .innerJoin(
      workshopPublicationProviderCheckpoints,
      eq(
        workshopPublicationProviderAttempts.providerCheckpointId,
        workshopPublicationProviderCheckpoints.id,
      ),
    )
    .where(
      eq(workshopPublicationProviderCheckpoints.publicationId, publication.id),
    );
  const ledgerByAttempt = new Map<string, Array<(typeof costLedger)[number]>>();
  for (const entry of costLedger) {
    const entries = ledgerByAttempt.get(entry.attemptId) ?? [];
    entries.push(entry);
    ledgerByAttempt.set(entry.attemptId, entries);
    if (
      entry.deletionConfirmedAt === null ||
      entry.deletionConfirmedAt < entry.providerCreatedAt ||
      !/^[A-Z]{3}$/.test(entry.currency) ||
      !validProviderDecimal(entry.hourlyNetRaw) ||
      !validProviderDecimal(entry.hourlyGrossRaw) ||
      decimalCurrencyToMicros(entry.hourlyNetRaw) !== entry.hourlyNetMicros ||
      decimalCurrencyToMicros(entry.hourlyGrossRaw) !==
        entry.hourlyGrossMicros ||
      (entry.monthlyNetRaw === null
        ? entry.monthlyNetMicros !== null
        : !validProviderDecimal(entry.monthlyNetRaw) ||
          decimalCurrencyToMicros(entry.monthlyNetRaw) !==
            entry.monthlyNetMicros) ||
      (entry.monthlyGrossRaw === null
        ? entry.monthlyGrossMicros !== null
        : !validProviderDecimal(entry.monthlyGrossRaw) ||
          decimalCurrencyToMicros(entry.monthlyGrossRaw) !==
            entry.monthlyGrossMicros)
    ) {
      return false;
    }
  }
  if (
    attempts.length < providerCheckpoints.length ||
    attempts.some(
      (attempt) =>
        attempt.state !== "deleted" ||
        attempt.deletionConfirmedAt === null ||
        (attempt.reportCredentialHash !== null &&
          attempt.reportCredentialRevokedAt === null),
    )
  ) {
    return false;
  }

  for (const checkpoint of providerCheckpoints) {
    const checkpointAttempts = attempts.filter(
      (attempt) => attempt.checkpointDatabaseId === checkpoint.id,
    );
    const proofAttempts = checkpointAttempts.filter(
      (attempt) =>
        attempt.proofVerifiedAt !== null &&
        attempt.proofReportSequence !== null,
    );
    const proof = proofAttempts[0];
    if (
      proofAttempts.length !== 1 ||
      !proof ||
      proof.attemptConnectionId !== proof.checkpointConnectionId ||
      proof.attemptConnectionId !== checkpoint.connectionId ||
      proof.serverType !== resolvedProvider.serverType ||
      proof.systemImage !== resolvedProvider.systemImage ||
      !permittedLocations.includes(proof.location) ||
      !proof.serverId ||
      !proof.primaryIpId ||
      !proof.sshKeyId ||
      proof.proofVerifiedAt !== checkpoint.proofVerifiedAt ||
      proof.deletionConfirmedAt === null ||
      proof.checkpointFirstDownloadedAt === null ||
      proof.proofVerifiedAt === null ||
      proof.proofVerifiedAt < proof.checkpointFirstDownloadedAt ||
      proof.lastReportAt === null ||
      proof.lastReportAt < proof.checkpointFirstDownloadedAt ||
      checkpoint.deletionConfirmedAt === null ||
      checkpoint.deletionConfirmedAt <
        Math.max(
          ...checkpointAttempts.map(
            (attempt) => attempt.deletionConfirmedAt ?? Number.MAX_SAFE_INTEGER,
          ),
        ) ||
      !providerAttemptReportProvesCheckpoint(proof)
    ) {
      return false;
    }
    const proofLedger = ledgerByAttempt.get(proof.attemptId) ?? [];
    if (
      proofLedger.length !== 2 ||
      !proofLedger.some(
        (entry) =>
          entry.resourceKind === "server" &&
          entry.providerResourceId === proof.serverId &&
          entry.location === proof.location &&
          providerLedgerMatchesObservation(
            entry,
            checkpoint.priceObservationJson,
            proof.location,
          ),
      ) ||
      !proofLedger.some(
        (entry) =>
          entry.resourceKind === "primary_ipv4" &&
          entry.providerResourceId === proof.primaryIpId &&
          entry.location === proof.location &&
          providerLedgerMatchesObservation(
            entry,
            checkpoint.priceObservationJson,
            proof.location,
          ),
      )
    ) {
      return false;
    }
    for (const attempt of checkpointAttempts) {
      const attemptLedger = ledgerByAttempt.get(attempt.attemptId) ?? [];
      if (
        (attempt.serverId &&
          !attemptLedger.some(
            (entry) =>
              entry.resourceKind === "server" &&
              entry.providerResourceId === attempt.serverId,
          )) ||
        (attempt.primaryIpId &&
          !attemptLedger.some(
            (entry) =>
              entry.resourceKind === "primary_ipv4" &&
              entry.providerResourceId === attempt.primaryIpId,
          ))
      ) {
        return false;
      }
    }
  }

  const verifiedProviderCheckpointIds = new Set(
    providerCheckpoints.map((checkpoint) => checkpoint.checkpointId),
  );
  let manifest: WorkshopManifestV1;
  try {
    manifest = validateWorkshopManifest(
      hydrateWorkshopManifest({
        source,
        checkpoints: providerCheckpoints.map((checkpoint) => ({
          checkpointId: checkpoint.checkpointId,
          coveredModuleIds: checkpoint.coveredModuleIdsJson,
          vmImages: [],
          sanitized: false,
          coldBootVerified: false,
          providerArtifact: {
            r2Key: checkpoint.r2Key,
            sha256: checkpoint.sha256,
            sizeBytes: checkpoint.sizeBytes,
            compression: checkpoint.compression,
            signatureB64: checkpoint.signatureB64,
            signingKeyId: checkpoint.signingKeyId,
            workspaceAgentSha256: checkpoint.workspaceAgentSha256,
            kinoSha256: checkpoint.kinoSha256,
          },
        })),
        resolvedProvider,
      }),
      { verifiedProviderCheckpointIds },
    );
  } catch {
    return false;
  }

  const templateCandidateId = createAppId();
  const revisionId = createAppId();
  const guardedPublication = `SELECT 1
    FROM workshop_publications publication
    WHERE publication.id = ?
      AND ${PROVIDER_FINALIZATION_GUARD_SQL}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO workshop_templates (
         id, organization_id, slug, title, summary, current_revision_id,
         created_by, created_at, updated_at
       )
       SELECT ?, publication.organization_id, publication.workshop_slug,
              ?, ?, NULL, publication.submitted_by, ?, ?
       FROM workshop_publications publication
       WHERE publication.id = ?
         AND ${PROVIDER_FINALIZATION_GUARD_SQL}
       ON CONFLICT (organization_id, slug) DO NOTHING`,
    ).bind(
      templateCandidateId,
      manifest.workshop.title,
      manifest.workshop.summary,
      now,
      now,
      publication.id,
      providerCheckpoints.length,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions (
         id, template_id, revision, source_revision, content_hash,
         manifest_json, published_by, published_at
       )
       SELECT ?,
              template.id,
              coalesce((
                SELECT max(existing.revision)
                FROM workshop_template_revisions existing
                WHERE existing.template_id = template.id
              ), 0) + 1,
              publication.content_hash,
              publication.content_hash,
              ?,
              publication.submitted_by,
              ?
       FROM workshop_publications publication
       INNER JOIN workshop_templates template
         ON template.organization_id = publication.organization_id
        AND template.slug = publication.workshop_slug
       WHERE publication.id = ?
         AND ${PROVIDER_FINALIZATION_GUARD_SQL}`,
    ).bind(
      revisionId,
      JSON.stringify(manifest),
      now,
      publication.id,
      providerCheckpoints.length,
    ),
    ...providerCheckpoints.map((checkpoint) =>
      env.DB.prepare(
        `INSERT INTO runtime_provider_checkpoint_artifacts (
           id, template_revision_id, checkpoint_id, provider_kind,
           r2_key, sha256, size_bytes, compression, signature_b64,
           signing_key_id, workspace_agent_sha256, kino_sha256, status,
           cold_boot_verified_at, created_at
         )
         SELECT ?, ?, ?, 'hetzner_cloud', ?, ?, ?, ?, ?, ?, ?, ?,
                'verified', ?, ?
         FROM workshop_template_revisions revision
         WHERE revision.id = ?
           AND EXISTS (${guardedPublication})`,
      ).bind(
        createAppId(),
        revisionId,
        checkpoint.checkpointId,
        checkpoint.r2Key,
        checkpoint.sha256,
        checkpoint.sizeBytes,
        checkpoint.compression,
        checkpoint.signatureB64,
        checkpoint.signingKeyId,
        checkpoint.workspaceAgentSha256,
        checkpoint.kinoSha256,
        checkpoint.proofVerifiedAt,
        now,
        revisionId,
        publication.id,
        providerCheckpoints.length,
      ),
    ),
    ...providerCheckpoints.map((checkpoint) =>
      env.DB.prepare(
        `UPDATE workshop_publication_checkpoints
         SET status = 'verified', vm_images_json = '[]', sanitized = 0,
             cold_boot_verified = 0, error = NULL, verified_at = ?,
             updated_at = ?
         WHERE publication_id = ? AND checkpoint_id = ?
           AND EXISTS (${guardedPublication})`,
      ).bind(
        checkpoint.proofVerifiedAt,
        now,
        publication.id,
        checkpoint.checkpointId,
        publication.id,
        providerCheckpoints.length,
      ),
    ),
    env.DB.prepare(
      `UPDATE workshop_templates
       SET title = ?, summary = ?, current_revision_id = ?, updated_at = ?
       WHERE id = (
         SELECT template_id
         FROM workshop_template_revisions
         WHERE id = ?
       )
         AND EXISTS (${guardedPublication})`,
    ).bind(
      manifest.workshop.title,
      manifest.workshop.summary,
      revisionId,
      now,
      revisionId,
      publication.id,
      providerCheckpoints.length,
    ),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'published', provider_verification_state = 'verified',
           published_revision_id = ?, error = NULL, claim_expires_at = NULL,
           finished_at = ?, updated_at = ?
       WHERE id = ?
         AND EXISTS (${guardedPublication})
         AND (
           SELECT count(*)
           FROM runtime_provider_checkpoint_artifacts artifact
           WHERE artifact.template_revision_id = ?
             AND artifact.provider_kind = 'hetzner_cloud'
             AND artifact.status = 'verified'
         ) = ?
         AND (
           SELECT count(*)
           FROM workshop_publication_checkpoints checkpoint
           WHERE checkpoint.publication_id = ?
             AND checkpoint.status = 'verified'
             AND checkpoint.vm_images_json = '[]'
             AND checkpoint.sanitized = 0
             AND checkpoint.cold_boot_verified = 0
         ) = ?`,
    ).bind(
      revisionId,
      now,
      now,
      publication.id,
      publication.id,
      providerCheckpoints.length,
      revisionId,
      providerCheckpoints.length,
      publication.id,
      providerCheckpoints.length,
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    const raced = await loadWorkshopPublication(env, publication.id);
    return (
      raced?.status === "published" &&
      raced.providerVerificationState === "verified" &&
      raced.publishedRevisionId !== null
    );
  }
  const finalized = await loadWorkshopPublication(env, publication.id);
  return (
    finalized?.status === "published" &&
    finalized.providerVerificationState === "verified" &&
    finalized.publishedRevisionId !== null
  );
}

function providerAttemptReportProvesCheckpoint(input: {
  checkpointDatabaseId: string;
  expectedProbes: WorkshopPublicationExpectedProbe[];
  attemptId: string;
  attemptOrdinal: number;
  lastReportSequence: number;
  lastReportPhase: string | null;
  lastReportHealth: string | null;
  lastReportAt: number | null;
  checkpointFirstDownloadedAt: number | null;
  reportJson: Record<string, unknown> | null;
  proofVerifiedAt: number | null;
  proofReportSequence: number | null;
}): boolean {
  const report = input.reportJson;
  if (
    !report ||
    input.proofReportSequence === null ||
    input.lastReportSequence !== input.proofReportSequence ||
    input.lastReportPhase !== "ready" ||
    input.lastReportHealth !== "healthy" ||
    input.checkpointFirstDownloadedAt === null ||
    input.proofVerifiedAt === null ||
    input.proofVerifiedAt < input.checkpointFirstDownloadedAt ||
    input.lastReportAt === null ||
    input.lastReportAt < input.checkpointFirstDownloadedAt ||
    report.contract_version !== 1 ||
    report.sequence !== input.proofReportSequence ||
    report.phase !== "ready" ||
    report.health !== "healthy" ||
    report.terminal_ready !== true ||
    !Number.isSafeInteger(report.reported_at_unix_ms) ||
    Number(report.reported_at_unix_ms) <= 0 ||
    !Array.isArray(report.ssh_host_keys_openssh) ||
    report.ssh_host_keys_openssh.length === 0
  ) {
    return false;
  }
  const identity = isRecord(report.identity) ? report.identity : null;
  if (
    !identity ||
    identity.execution_id !== input.attemptId ||
    identity.workspace_id !== input.checkpointDatabaseId ||
    identity.generation !== input.attemptOrdinal ||
    !Array.isArray(report.probes)
  ) {
    return false;
  }
  const probes = new Map<string, string>();
  for (const raw of report.probes) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      typeof raw.status !== "string" ||
      probes.has(raw.id)
    ) {
      return false;
    }
    probes.set(raw.id, raw.status);
  }
  return (
    input.expectedProbes.length > 0 &&
    input.expectedProbes.every(
      (expected) => probes.get(expected.probeId) === "pass",
    )
  );
}

async function verifyStagedProviderCheckpointReports(input: {
  env: Cloudflare.Env;
  source: ValidatedWorkshopSourceBundle;
  raw: unknown;
  guestTools: { workspaceAgentSha256: string; kinoSha256: string };
}): Promise<StagedProviderCheckpointReport[]> {
  if (!Array.isArray(input.raw)) {
    throw new Error("checkpoints must be an array");
  }
  const required = new Set(input.source.requiredCheckpointIds);
  const expected = expectedProviderCheckpointMetadata(input.source);
  const expectedCheckpointIds = [...expected.keys()];
  if (
    expectedCheckpointIds.length !== required.size ||
    expectedCheckpointIds.some((checkpointId) => !required.has(checkpointId))
  ) {
    throw new Error(
      "required checkpoint IDs do not match the topologically ordered modules",
    );
  }

  const seen = new Set<string>();
  const reports: StagedProviderCheckpointReport[] = [];
  for (const raw of input.raw) {
    const checkpoint = asRecord(raw, "provider checkpoint staging report");
    const checkpointId = readRequiredString(
      checkpoint.checkpoint_id ?? checkpoint.checkpointId,
      "checkpoint_id",
    );
    if (!required.has(checkpointId) || seen.has(checkpointId)) {
      throw new Error(`checkpoint ${checkpointId} is unexpected or duplicated`);
    }
    seen.add(checkpointId);
    if (
      (checkpoint.provider_verification_pending ??
        checkpoint.providerVerificationPending) !== true ||
      checkpoint.sanitized !== false ||
      (checkpoint.cold_boot_verified ?? checkpoint.coldBootVerified) !==
        false ||
      (checkpoint.runtime_bundle_cold_boot_verified ??
        checkpoint.runtimeBundleColdBootVerified) !== false
    ) {
      throw new Error(
        `checkpoint ${checkpointId} must explicitly request direct provider verification`,
      );
    }
    const rawImages = checkpoint.vm_images ?? checkpoint.vmImages;
    if (!Array.isArray(rawImages) || rawImages.length !== 0) {
      throw new Error(
        `checkpoint ${checkpointId} provider staging must not contain KVM images`,
      );
    }
    const coverage =
      checkpoint.covered_module_ids ?? checkpoint.coveredModuleIds;
    const expectedEntry = expected.get(checkpointId);
    if (
      !expectedEntry ||
      !Array.isArray(coverage) ||
      coverage.length !== expectedEntry.coveredModuleIds.length ||
      coverage.some(
        (moduleId, index) => moduleId !== expectedEntry.coveredModuleIds[index],
      )
    ) {
      throw new Error(
        `checkpoint ${checkpointId} covered module prefix does not match the source manifest`,
      );
    }
    if (expectedEntry.expectedProbes.length === 0) {
      throw new Error(
        `checkpoint ${checkpointId} has no deterministic verification probes`,
      );
    }
    const artifact = await verifyStagedProviderCheckpointArtifact({
      env: input.env,
      checkpointId,
      raw: checkpoint.runtime_bundle ?? checkpoint.runtimeBundle,
      guestTools: input.guestTools,
    });
    reports.push({
      checkpointId,
      coveredModuleIds: expectedEntry.coveredModuleIds,
      expectedProbes: expectedEntry.expectedProbes,
      artifact,
    });
  }
  if (seen.size !== required.size) {
    throw new Error("every required checkpoint must be staged exactly once");
  }
  return reports.sort(
    (left, right) =>
      expectedCheckpointIds.indexOf(left.checkpointId) -
      expectedCheckpointIds.indexOf(right.checkpointId),
  );
}

async function verifyStagedProviderCheckpointArtifact(input: {
  env: Cloudflare.Env;
  checkpointId: string;
  raw: unknown;
  guestTools: { workspaceAgentSha256: string; kinoSha256: string };
}): Promise<NonNullable<WorkshopCheckpointBuildReport["providerArtifact"]>> {
  const artifact = asRecord(
    input.raw,
    `checkpoint ${input.checkpointId} runtime_bundle`,
  );
  if (
    artifact.workspace_agent_sha256 !== undefined ||
    artifact.workspaceAgentSha256 !== undefined
  ) {
    throw new Error(
      `checkpoint ${input.checkpointId} must not assert its verifier binary`,
    );
  }
  const sha256 = normalizeSha256(
    readRequiredString(artifact.sha256, "runtime bundle sha256"),
  );
  const signatureB64 = readRequiredString(
    artifact.signature_b64 ?? artifact.signatureB64,
    "runtime bundle signature_b64",
  );
  const signingKeyId = readRequiredString(
    artifact.signing_key_id ?? artifact.signingKeyId,
    "runtime bundle signing_key_id",
  );
  const compression = artifact.compression;
  if (
    !sha256 ||
    !isEd25519Signature(signatureB64) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(signingKeyId) ||
    (compression !== "none" && compression !== "gzip" && compression !== "zstd")
  ) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle metadata is invalid`,
    );
  }
  const r2Key = artifactObjectKey(sha256);
  const object = await input.env.VM_IMAGE_REGISTRY_BUCKET.head(r2Key);
  if (
    !object ||
    object.size <= 0 ||
    normalizeSha256(object.customMetadata?.artifact_sha256 ?? "") !== sha256
  ) {
    throw new Error(
      `checkpoint ${input.checkpointId} references a missing runtime bundle`,
    );
  }
  return {
    r2Key,
    sha256,
    sizeBytes: object.size,
    compression,
    signatureB64,
    signingKeyId,
    workspaceAgentSha256: input.guestTools.workspaceAgentSha256,
    kinoSha256: input.guestTools.kinoSha256,
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
  const expectedMetadata = expectedProviderCheckpointMetadata(params.source);
  const requiredCheckpoints = new Set(params.source.requiredCheckpointIds);
  const requiresProviderArtifact = workshopUsesHetznerProvider(params.source);
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
    const expectedCoverage =
      expectedMetadata.get(checkpointId)?.coveredModuleIds;
    const rawCoverage =
      checkpoint.covered_module_ids ?? checkpoint.coveredModuleIds;
    if (
      !expectedCoverage ||
      !Array.isArray(rawCoverage) ||
      rawCoverage.some(
        (moduleId) => typeof moduleId !== "string" || !moduleId.trim(),
      )
    ) {
      throw new Error(
        `checkpoint ${checkpointId} covered module prefix is invalid`,
      );
    }
    const coveredModuleIds = rawCoverage.map((moduleId) =>
      (moduleId as string).trim(),
    );
    if (
      coveredModuleIds.length !== expectedCoverage.length ||
      coveredModuleIds.some(
        (moduleId, index) => moduleId !== expectedCoverage[index],
      )
    ) {
      throw new Error(
        `checkpoint ${checkpointId} covered module prefix does not match the source manifest`,
      );
    }
    if (
      checkpoint.sanitized !== true ||
      (checkpoint.cold_boot_verified ?? checkpoint.coldBootVerified) !== true
    ) {
      throw new Error(
        `checkpoint ${checkpointId} must be sanitized and cold-boot verified`,
      );
    }
    if (
      requiresProviderArtifact &&
      (checkpoint.runtime_bundle_cold_boot_verified ??
        checkpoint.runtimeBundleColdBootVerified) !== true
    ) {
      throw new Error(
        `checkpoint ${checkpointId} runtime bundle must be cold-boot verified on a clean direct-cloud base`,
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
    const providerArtifact = requiresProviderArtifact
      ? await verifyProviderCheckpointArtifact({
          env: params.env,
          checkpointId,
          raw: checkpoint.runtime_bundle ?? checkpoint.runtimeBundle,
        })
      : undefined;
    reports.push({
      checkpointId,
      coveredModuleIds,
      vmImages,
      rawVmImages: images,
      sanitized: true,
      coldBootVerified: true,
      ...(requiresProviderArtifact
        ? { runtimeBundleColdBootVerified: true as const }
        : {}),
      ...(providerArtifact ? { providerArtifact } : {}),
    });
  }
  if (seen.size !== requiredCheckpoints.size) {
    throw new Error("every required checkpoint must be reported exactly once");
  }
  return reports.sort((left, right) =>
    left.checkpointId.localeCompare(right.checkpointId),
  );
}

async function verifyProviderCheckpointArtifact(input: {
  env: Cloudflare.Env;
  checkpointId: string;
  raw: unknown;
}): Promise<NonNullable<WorkshopCheckpointBuildReport["providerArtifact"]>> {
  const artifact = asRecord(
    input.raw,
    `checkpoint ${input.checkpointId} runtime_bundle`,
  );
  const sha256 = normalizeSha256(
    readRequiredString(artifact.sha256, "runtime bundle sha256"),
  );
  if (!sha256) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle has an invalid sha256`,
    );
  }
  const signatureB64 = readRequiredString(
    artifact.signature_b64 ?? artifact.signatureB64,
    "runtime bundle signature_b64",
  );
  if (!isEd25519Signature(signatureB64)) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle has an invalid signature`,
    );
  }
  const signingKeyId = readRequiredString(
    artifact.signing_key_id ?? artifact.signingKeyId,
    "runtime bundle signing_key_id",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(signingKeyId)) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle has an invalid signing key ID`,
    );
  }
  const workspaceAgentSha256 = normalizeSha256(
    readRequiredString(
      artifact.workspace_agent_sha256 ?? artifact.workspaceAgentSha256,
      "runtime bundle workspace_agent_sha256",
    ),
  );
  if (!workspaceAgentSha256) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle has an invalid workspace-agent digest`,
    );
  }
  const compression = artifact.compression;
  if (
    compression !== "none" &&
    compression !== "gzip" &&
    compression !== "zstd"
  ) {
    throw new Error(
      `checkpoint ${input.checkpointId} runtime bundle has an invalid compression`,
    );
  }
  const r2Key = artifactObjectKey(sha256);
  const object = await input.env.VM_IMAGE_REGISTRY_BUCKET.head(r2Key);
  if (
    !object ||
    object.size <= 0 ||
    normalizeSha256(object.customMetadata?.artifact_sha256 ?? "") !== sha256
  ) {
    throw new Error(
      `checkpoint ${input.checkpointId} references a missing runtime bundle`,
    );
  }
  const guestTools = await verifyPublishedGuestToolPair(input.env, {
    expectedWorkspaceAgentSha256: workspaceAgentSha256,
  });
  return {
    r2Key,
    sha256,
    sizeBytes: object.size,
    compression,
    signatureB64,
    signingKeyId,
    workspaceAgentSha256,
    kinoSha256: guestTools.kinoSha256,
  };
}

async function verifyPublishedGuestToolPair(
  env: Cloudflare.Env,
  options: { expectedWorkspaceAgentSha256?: string } = {},
): Promise<{ workspaceAgentSha256: string; kinoSha256: string }> {
  const current = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    "workspace-agent/releases/current.json",
  );
  if (!current || current.size <= 0 || current.size > 4_096) {
    throw new Error("workspace guest-tools release manifest is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await current.text());
  } catch {
    throw new Error("workspace guest-tools release manifest is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workspace guest-tools release manifest is invalid");
  }
  const manifest = parsed as Record<string, unknown>;
  const workspaceAgentSha256 = normalizeSha256(
    typeof manifest.sha256 === "string" ? manifest.sha256 : "",
  );
  const kinoSha256 = normalizeSha256(
    typeof manifest.kino_sha256 === "string" ? manifest.kino_sha256 : "",
  );
  const workspaceAgentSize = manifest.size_bytes;
  const kinoSize = manifest.kino_size_bytes;
  if (
    manifest.schema_version !== 2 ||
    (options.expectedWorkspaceAgentSha256 !== undefined &&
      workspaceAgentSha256 !== options.expectedWorkspaceAgentSha256) ||
    !workspaceAgentSha256 ||
    !kinoSha256 ||
    typeof workspaceAgentSize !== "number" ||
    !Number.isSafeInteger(workspaceAgentSize) ||
    workspaceAgentSize <= 0 ||
    workspaceAgentSize > 128 * 1024 * 1024 ||
    typeof kinoSize !== "number" ||
    !Number.isSafeInteger(kinoSize) ||
    kinoSize <= 0 ||
    kinoSize > 128 * 1024 * 1024
  ) {
    throw new Error(
      "workspace guest-tools release does not match the direct-cloud proof",
    );
  }
  const [agent, kino] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/releases/${workspaceAgentSha256}/intar-workspace-agent`,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/kino/releases/${kinoSha256}/kino`,
    ),
  ]);
  if (
    !agent ||
    agent.size !== workspaceAgentSize ||
    !kino ||
    kino.size !== kinoSize
  ) {
    throw new Error("pinned workspace guest-tools binaries are unavailable");
  }
  return { workspaceAgentSha256, kinoSha256 };
}

function isEd25519Signature(value: string): boolean {
  if (
    value.length > 128 ||
    !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(value)
  ) {
    return false;
  }
  try {
    return atob(value).length === 64;
  } catch {
    return false;
  }
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
