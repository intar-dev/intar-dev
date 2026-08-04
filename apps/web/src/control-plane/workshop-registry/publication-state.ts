import { and, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { WorkshopManifestV2 } from "@intar/workshop-contracts";
import {
  workshopPublications,
  workshopTemplateRevisions,
  workshopTemplates,
} from "@/db/schema";
import type { ValidatedBuilderCheckpoint } from "./build-result";
import type { PublicationProfileResolution } from "./provider";

const STAGING_ATTEMPTS = 3;

export const WORKSHOP_PUBLICATION_CANCELLED_ERROR =
  "publication cancelled by publisher";
export const WORKSHOP_PUBLICATION_CANCELLED_CODE = "publication_cancelled";

export interface StagedWorkshopRevision {
  templateId: string;
  revisionId: string;
  revision: number;
  directCertificationIds: string[];
}

/**
 * Stage one immutable revision and one certification row per declared profile.
 * The template pointer remains unchanged until every direct-cloud verifier has
 * proved readiness after reboot and confirmed complete resource deletion.
 */
export async function stageWorkshopRevision(input: {
  env: Cloudflare.Env;
  publication: typeof workshopPublications.$inferSelect;
  builderHostId: string;
  manifest: WorkshopManifestV2;
  checkpoints: ValidatedBuilderCheckpoint[];
  resolutions: PublicationProfileResolution[];
}): Promise<StagedWorkshopRevision> {
  for (let attempt = 0; attempt < STAGING_ATTEMPTS; attempt += 1) {
    try {
      return await stageOnce(input);
    } catch (error) {
      if (attempt + 1 === STAGING_ATTEMPTS || !isRetryableStagingRace(error)) {
        throw error;
      }
    }
  }
  throw new Error("workshop publication staging exhausted retries");
}

async function stageOnce(input: {
  env: Cloudflare.Env;
  publication: typeof workshopPublications.$inferSelect;
  builderHostId: string;
  manifest: WorkshopManifestV2;
  checkpoints: ValidatedBuilderCheckpoint[];
  resolutions: PublicationProfileResolution[];
}): Promise<StagedWorkshopRevision> {
  const db = drizzle(input.env.DB);
  const existing = await db
    .select({ id: workshopTemplates.id })
    .from(workshopTemplates)
    .where(
      and(
        eq(workshopTemplates.organizationId, input.publication.organizationId),
        eq(workshopTemplates.slug, input.publication.workshopSlug),
      ),
    )
    .limit(1);
  const templateId = existing[0]?.id ?? `wkt_${input.publication.id}`;
  const maxima = await db
    .select({ value: max(workshopTemplateRevisions.revision) })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.templateId, templateId));
  const revision = (maxima[0]?.value ?? 0) + 1;
  const revisionId = `wkr_${input.publication.id}`;
  const now = Date.now();
  const hasDirect = input.resolutions.some(
    (resolution) => resolution.declaration.provider !== "agent_kvm",
  );
  const profileRows = input.manifest.workspace.runtimeProfiles.map(
    (profile, index) => ({
      id: `wrp_${input.publication.id}_${index}`,
      profile,
      resolution: input.resolutions[index]!,
    }),
  );
  const directCertificationIds: string[] = [];
  const statements: D1PreparedStatement[] = [
    input.env.DB.prepare(
      `INSERT INTO workshop_templates (
         id, organization_id, slug, title, summary, current_revision_id,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT (organization_id, slug) DO NOTHING`,
    ).bind(
      templateId,
      input.publication.organizationId,
      input.manifest.workshop.slug,
      input.manifest.workshop.title,
      input.manifest.workshop.summary,
      input.publication.submittedBy,
      now,
      now,
    ),
    input.env.DB.prepare(
      `INSERT INTO workshop_template_revisions (
         id, template_id, revision, source_revision, content_hash,
         manifest_json, published_by, published_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM workshop_publications publication
       WHERE publication.id = ?
         AND publication.status = 'building'
         AND publication.builder_host_id = ?
         AND publication.certification_state IS NULL`,
    ).bind(
      revisionId,
      templateId,
      revision,
      input.publication.contentHash,
      input.publication.contentHash,
      JSON.stringify(input.manifest),
      input.publication.submittedBy,
      now,
      input.publication.id,
      input.builderHostId,
    ),
  ];

  for (const [index, row] of profileRows.entries()) {
    const { profile, resolution } = row;
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO workshop_runtime_profiles (
           id, template_revision_id, profile_id, provider_kind, vm_id,
           machine_type, system_image, resolved_image_id, root_disk_type,
           architecture, cpu_millis, memory_mib, disk_mib, locations_json,
           configuration_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x86_64', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        revisionId,
        profile.id,
        profile.provider,
        profile.vmId,
        profile.provider === "agent_kvm" ? null : profile.machineType,
        profile.requestedSystemImage,
        profile.provider === "agent_kvm" ? null : profile.immutableSystemImage,
        profile.provider === "gcp_compute" ? profile.rootDiskType : null,
        profile.hardware.cpuMillis,
        profile.hardware.memoryMib,
        profile.hardware.diskMib,
        JSON.stringify(profile.locations),
        JSON.stringify({
          immutableSystemImage: profile.immutableSystemImage,
          providerCpuCount: profile.hardware.providerCpuCount,
          claimResolutionOrdinal: index,
        }),
        now,
      ),
    );
    const certificationId = `wpc_${input.publication.id}_${index}`;
    if (profile.provider !== "agent_kvm") {
      directCertificationIds.push(certificationId);
    }
    statements.push(
      input.env.DB.prepare(
        `INSERT INTO workshop_runtime_profile_certifications (
           id, runtime_profile_id, connection_id, state,
           evidence_json, started_at, verified_at, deletion_confirmed_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        certificationId,
        row.id,
        resolution.connectionId,
        profile.provider === "agent_kvm" ? "verified" : "pending",
        JSON.stringify(
          profile.provider === "agent_kvm"
            ? {
                proofKind: "trusted_builder_agent_kvm_v1",
                builderHostId: input.builderHostId,
                cumulativeCheckpointIds: input.checkpoints.map(
                  (checkpoint) => checkpoint.checkpointId,
                ),
                sanitized: true,
                everyCheckpointColdBootVerified: true,
                verifierResourcesDeleted: true,
              }
            : {
                proofKind: "direct_cloud_profile_certification_v1",
                publicationId: input.publication.id,
                cumulativeCheckpointIds: input.checkpoints.map(
                  (checkpoint) => checkpoint.checkpointId,
                ),
                checkpointProofs: input.checkpoints.map((checkpoint) => {
                  const coveredModuleIds = checkpoint.coveredModuleIds;
                  const coveredModules = new Set(coveredModuleIds);
                  return {
                    checkpointId: checkpoint.checkpointId,
                    expectedModuleIds: coveredModuleIds,
                    expectedProbeIds: input.manifest.modules.flatMap((module) =>
                      coveredModules.has(module.id) ? module.probeIds : [],
                    ),
                  };
                }),
                currentCheckpointOrdinal: 0,
                phase: "pending",
              },
        ),
        now,
        profile.provider === "agent_kvm" ? now : null,
        profile.provider === "agent_kvm" ? now : null,
        now,
        now,
      ),
    );
  }

  for (const checkpoint of input.checkpoints) {
    statements.push(
      input.env.DB.prepare(
        `UPDATE workshop_publication_checkpoints
         SET status = 'verified', vm_images_json = ?, sanitized = ?,
             cold_boot_verified = ?, error = NULL, verified_at = ?, updated_at = ?
         WHERE publication_id = ? AND checkpoint_id = ?
           AND EXISTS (
             SELECT 1 FROM workshop_publications publication
             WHERE publication.id = ? AND publication.status = 'building'
               AND publication.builder_host_id = ?
               AND publication.certification_state IS NULL
           )`,
      ).bind(
        JSON.stringify(checkpoint.rawVmImages),
        checkpoint.sanitized ? 1 : 0,
        checkpoint.coldBootVerified ? 1 : 0,
        now,
        now,
        input.publication.id,
        checkpoint.checkpointId,
        input.publication.id,
        input.builderHostId,
      ),
    );
    if (checkpoint.providerArtifact) {
      const artifact = checkpoint.providerArtifact;
      statements.push(
        input.env.DB.prepare(
          `INSERT INTO runtime_checkpoint_bundles (
             id, template_revision_id, checkpoint_id, format, r2_key,
             sha256, size_bytes, compression, signature_b64, signing_key_id,
             workspace_agent_sha256, kino_sha256, created_at
           ) VALUES (?, ?, ?, 'direct_cloud_linux_x86_64_v1', ?, ?, ?, 'zstd', ?, ?, ?, ?, ?)`,
        ).bind(
          `wcb_${input.publication.id}_${checkpoint.checkpointId}`,
          revisionId,
          checkpoint.checkpointId,
          artifact.r2Key,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.signatureB64,
          artifact.signingKeyId,
          artifact.workspaceAgentSha256,
          artifact.kinoSha256,
          now,
        ),
      );
    }
  }

  statements.push(
    input.env.DB.prepare(
      `UPDATE workshop_publications
       SET published_revision_id = ?, certification_state = ?,
           claim_expires_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'building' AND builder_host_id = ?
         AND certification_state IS NULL
         AND (SELECT count(*) FROM workshop_publication_checkpoints checkpoint
              WHERE checkpoint.publication_id = workshop_publications.id
                AND checkpoint.status = 'verified') = ?`,
    ).bind(
      revisionId,
      hasDirect ? "verifying" : "verified",
      now,
      input.publication.id,
      input.builderHostId,
      input.checkpoints.length,
    ),
  );

  await input.env.DB.batch(statements);
  const publication = await db
    .select({
      revisionId: workshopPublications.publishedRevisionId,
      certificationState: workshopPublications.certificationState,
    })
    .from(workshopPublications)
    .where(eq(workshopPublications.id, input.publication.id))
    .limit(1);
  if (
    publication[0]?.revisionId !== revisionId ||
    publication[0]?.certificationState !== (hasDirect ? "verifying" : "verified")
  ) {
    throw new Error("workshop publication lost its staging fence");
  }

  if (!hasDirect) {
    const finalized = await finalizeCertifiedWorkshopRevision({
      env: input.env,
      publicationId: input.publication.id,
      now,
    });
    if (!finalized) throw new Error("agent_kvm publication did not finalize");
  }
  return { templateId, revisionId, revision, directCertificationIds };
}

/** Publish only at the all-profiles-certified and all-resources-deleted fence. */
export async function finalizeCertifiedWorkshopRevision(input: {
  env: Cloudflare.Env;
  publicationId: string;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const target = await input.env.DB.prepare(
    `SELECT revision.template_id, revision.id AS revision_id,
            json_extract(revision.manifest_json, '$.workshop.title') AS title,
            json_extract(revision.manifest_json, '$.workshop.summary') AS summary,
            publication.status
     FROM workshop_publications publication
     JOIN workshop_template_revisions revision
       ON revision.id = publication.published_revision_id
     WHERE publication.id = ?
     LIMIT 1`,
  )
    .bind(input.publicationId)
    .first<{
      template_id: string;
      revision_id: string;
      title: string;
      summary: string;
      status: string;
    }>();
  if (!target) return false;
  const results = await input.env.DB.batch([
    input.env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'published', certification_state = 'verified',
           finished_at = ?, claim_expires_at = NULL, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'building' AND published_revision_id = ?
         AND certification_state IN ('verifying', 'verified')
         AND EXISTS (
           SELECT 1 FROM workshop_runtime_profiles profile
           WHERE profile.template_revision_id = workshop_publications.published_revision_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workshop_runtime_profiles profile
           LEFT JOIN workshop_runtime_profile_certifications certification
             ON certification.runtime_profile_id = profile.id
           WHERE profile.template_revision_id = workshop_publications.published_revision_id
             AND (
               certification.id IS NULL OR certification.state != 'verified'
               OR certification.verified_at IS NULL
               OR certification.deletion_confirmed_at IS NULL
             )
         )`,
    ).bind(now, now, input.publicationId, target.revision_id),
    input.env.DB.prepare(
      `UPDATE workshop_templates
       SET title = ?, summary = ?, current_revision_id = ?, updated_at = ?
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM workshop_publications publication
         WHERE publication.id = ? AND publication.status = 'published'
           AND publication.published_revision_id = ?
       )`,
    ).bind(
      target.title,
      target.summary,
      target.revision_id,
      now,
      target.template_id,
      input.publicationId,
      target.revision_id,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 && target.status !== "published") {
    return false;
  }
  if (results[1]?.meta.changes !== 1) {
    throw new Error("published workshop revision failed to advance its template pointer");
  }
  return true;
}

/**
 * Fail a staged publication only after every direct-cloud verifier has either
 * never allocated or has durable provider deletion confirmation. This keeps a
 * cancellation/failure from presenting as finished while a paid resource is
 * still alive, including publications with more than one direct profile.
 */
export async function finalizeFailedWorkshopPublicationAfterCleanup(input: {
  env: Cloudflare.Env;
  publicationId: string;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await input.env.DB.prepare(
    `UPDATE workshop_publications
     SET status = 'failed', certification_state = 'failed',
         error = COALESCE(error, 'workshop runtime profile certification failed'),
         claim_expires_at = NULL, finished_at = COALESCE(finished_at, ?),
         updated_at = ?
     WHERE id = ? AND status IN ('building', 'failed')
       AND certification_state IN ('verifying', 'cleanup_pending')
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_runtime_profiles profile
         LEFT JOIN workshop_runtime_profile_certifications certification
           ON certification.runtime_profile_id = profile.id
         LEFT JOIN runtime_provider_allocations allocation
           ON allocation.id = certification.verifier_allocation_id
         WHERE profile.template_revision_id = workshop_publications.published_revision_id
           AND (
             certification.id IS NULL
             OR certification.state IN ('pending', 'verifying', 'cleanup_pending')
             OR (
               certification.verifier_allocation_id IS NOT NULL
               AND (
                 allocation.id IS NULL
                 OR allocation.state != 'deleted'
                 OR allocation.deletion_confirmed_at IS NULL
               )
             )
           )
       )`,
  )
    .bind(now, now, input.publicationId)
    .run();
  if (result.meta.changes === 1) {
    await input.env.DB.prepare(
      `UPDATE workshop_publication_checkpoints
       SET status = CASE WHEN status = 'verified' THEN status ELSE 'failed' END,
           error = CASE
             WHEN status = 'verified' THEN error
             ELSE COALESCE(error, 'workshop runtime profile certification failed')
           END,
           updated_at = ?
       WHERE publication_id = ?`,
    )
      .bind(now, input.publicationId)
      .run();
  }
  return result.meta.changes === 1;
}

export async function failWorkshopCertification(input: {
  env: Cloudflare.Env;
  publicationId: string;
  error: string;
  cleanupPending: boolean;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  await input.env.DB.prepare(
    `UPDATE workshop_publications
     SET status = CASE WHEN ? THEN status ELSE 'failed' END,
         certification_state = CASE WHEN ? THEN 'cleanup_pending' ELSE 'failed' END,
         error = ?, finished_at = CASE WHEN ? THEN finished_at ELSE ? END,
         updated_at = ?
     WHERE id = ? AND status = 'building'`,
  )
    .bind(
      input.cleanupPending ? 1 : 0,
      input.cleanupPending ? 1 : 0,
      input.error.slice(0, 4_000),
      input.cleanupPending ? 1 : 0,
      now,
      now,
      input.publicationId,
    )
    .run();
}

function isRetryableStagingRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: workshop_(?:templates|template_revisions)/i.test(
    message,
  );
}
