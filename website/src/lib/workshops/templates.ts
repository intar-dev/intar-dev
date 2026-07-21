import { and, desc, eq, max } from "drizzle-orm";
import {
  workshopTemplateRevisions,
  workshopTemplates,
  type WorkshopManifestV1,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import { workshopDb } from "./shared";
import type {
  WorkshopTemplateRecord,
  WorkshopTemplateRevisionRecord,
} from "./types";
import {
  validateContentHash,
  validateSourceRevision,
  validateWorkshopManifest,
  validateWorkshopSlug,
  validateWorkshopSummary,
  validateWorkshopTitle,
} from "./validation";

export async function listWorkshopTemplates(params: {
  organizationId: string;
  userId: string;
}): Promise<WorkshopTemplateRecord[]> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.userId,
    admin: true,
  });
  const rows = await workshopDb()
    .select({
      id: workshopTemplates.id,
      organizationId: workshopTemplates.organizationId,
      slug: workshopTemplates.slug,
      title: workshopTemplates.title,
      summary: workshopTemplates.summary,
      currentRevisionId: workshopTemplates.currentRevisionId,
      currentRevision: workshopTemplateRevisions.revision,
      createdAt: workshopTemplates.createdAt,
      updatedAt: workshopTemplates.updatedAt,
    })
    .from(workshopTemplates)
    .leftJoin(
      workshopTemplateRevisions,
      eq(workshopTemplates.currentRevisionId, workshopTemplateRevisions.id),
    )
    .where(eq(workshopTemplates.organizationId, params.organizationId))
    .orderBy(desc(workshopTemplates.updatedAt));
  return rows;
}

export async function createWorkshopTemplate(params: {
  organizationId: string;
  actorUserId: string;
  slug?: string;
  title?: string;
  summary?: string;
  sourceRevision: string;
  contentHash: string;
  manifest: unknown;
}): Promise<{
  template: WorkshopTemplateRecord;
  revision: WorkshopTemplateRevisionRecord;
}> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const manifest = validateWorkshopManifest(params.manifest);
  const slug = validateWorkshopSlug(params.slug ?? manifest.workshop.slug);
  if (slug !== manifest.workshop.slug) {
    throw appError(
      400,
      "workshop_slug_mismatch",
      "template slug must match the workshop manifest slug",
    );
  }
  const title = validateWorkshopTitle(params.title ?? manifest.workshop.title);
  const summary = validateWorkshopSummary(
    params.summary ?? manifest.workshop.summary,
  );
  const sourceRevision = validateSourceRevision(params.sourceRevision);
  const contentHash = validateContentHash(params.contentHash);
  const templateId = createAppId();
  const revisionId = createAppId();
  const now = Date.now();
  const db = workshopDb();
  try {
    await db.batch([
      db.insert(workshopTemplates).values({
        id: templateId,
        organizationId: params.organizationId,
        slug,
        title,
        summary,
        currentRevisionId: revisionId,
        createdBy: params.actorUserId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(workshopTemplateRevisions).values({
        id: revisionId,
        templateId,
        revision: 1,
        sourceRevision,
        contentHash,
        manifestJson: manifest,
        publishedBy: params.actorUserId,
        publishedAt: now,
      }),
    ]);
  } catch (error) {
    if (
      errorChainMatches(
        error,
        /workshop_templates_org_slug_uidx|UNIQUE constraint failed: workshop_templates\.organization_id, workshop_templates\.slug/i,
      )
    ) {
      throw appError(
        409,
        "workshop_template_exists",
        "a workshop template with this slug already exists",
      );
    }
    throw error;
  }
  return {
    template: {
      id: templateId,
      organizationId: params.organizationId,
      slug,
      title,
      summary,
      currentRevisionId: revisionId,
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    },
    revision: revisionRecord({
      id: revisionId,
      templateId,
      revision: 1,
      sourceRevision,
      contentHash,
      manifestJson: manifest,
      publishedAt: now,
    }),
  };
}

export async function listWorkshopTemplateRevisions(params: {
  organizationId: string;
  templateId: string;
  userId: string;
}): Promise<WorkshopTemplateRevisionRecord[]> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.userId,
    admin: true,
  });
  await requireTemplateInOrganization(params.templateId, params.organizationId);
  const rows = await workshopDb()
    .select({
      id: workshopTemplateRevisions.id,
      templateId: workshopTemplateRevisions.templateId,
      revision: workshopTemplateRevisions.revision,
      sourceRevision: workshopTemplateRevisions.sourceRevision,
      contentHash: workshopTemplateRevisions.contentHash,
      manifestJson: workshopTemplateRevisions.manifestJson,
      publishedAt: workshopTemplateRevisions.publishedAt,
    })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.templateId, params.templateId))
    .orderBy(desc(workshopTemplateRevisions.revision));
  return rows.map(revisionRecord);
}

export async function publishWorkshopTemplateRevision(params: {
  organizationId: string;
  templateId: string;
  actorUserId: string;
  sourceRevision: string;
  contentHash: string;
  manifest: unknown;
}): Promise<WorkshopTemplateRevisionRecord> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const template = await requireTemplateInOrganization(
    params.templateId,
    params.organizationId,
  );
  const manifest = validateWorkshopManifest(params.manifest);
  if (manifest.workshop.slug !== template.slug) {
    throw appError(
      400,
      "workshop_slug_mismatch",
      "published revisions cannot change the workshop slug",
    );
  }
  const sourceRevision = validateSourceRevision(params.sourceRevision);
  const contentHash = validateContentHash(params.contentHash);
  const db = workshopDb();
  const existing = await db
    .select({
      id: workshopTemplateRevisions.id,
      templateId: workshopTemplateRevisions.templateId,
      revision: workshopTemplateRevisions.revision,
      sourceRevision: workshopTemplateRevisions.sourceRevision,
      contentHash: workshopTemplateRevisions.contentHash,
      manifestJson: workshopTemplateRevisions.manifestJson,
      publishedAt: workshopTemplateRevisions.publishedAt,
    })
    .from(workshopTemplateRevisions)
    .where(
      and(
        eq(workshopTemplateRevisions.templateId, params.templateId),
        eq(workshopTemplateRevisions.contentHash, contentHash),
      ),
    )
    .limit(1);
  if (existing[0]) return revisionRecord(existing[0]);

  const maxima = await db
    .select({ value: max(workshopTemplateRevisions.revision) })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.templateId, params.templateId));
  const revision = (maxima[0]?.value ?? 0) + 1;
  const revisionId = createAppId();
  const now = Date.now();
  try {
    await db.batch([
      db.insert(workshopTemplateRevisions).values({
        id: revisionId,
        templateId: params.templateId,
        revision,
        sourceRevision,
        contentHash,
        manifestJson: manifest,
        publishedBy: params.actorUserId,
        publishedAt: now,
      }),
      db
        .update(workshopTemplates)
        .set({
          title: validateWorkshopTitle(manifest.workshop.title),
          summary: validateWorkshopSummary(manifest.workshop.summary),
          currentRevisionId: revisionId,
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopTemplates.id, params.templateId),
            eq(workshopTemplates.organizationId, params.organizationId),
          ),
        ),
    ]);
  } catch (error) {
    if (errorChainMatches(error, /UNIQUE constraint failed/i)) {
      throw appError(
        409,
        "workshop_revision_conflict",
        "another workshop revision was published concurrently",
      );
    }
    throw error;
  }
  return revisionRecord({
    id: revisionId,
    templateId: params.templateId,
    revision,
    sourceRevision,
    contentHash,
    manifestJson: manifest,
    publishedAt: now,
  });
}

async function requireTemplateInOrganization(
  templateId: string,
  organizationId: string,
) {
  const rows = await workshopDb()
    .select({
      id: workshopTemplates.id,
      slug: workshopTemplates.slug,
      title: workshopTemplates.title,
      summary: workshopTemplates.summary,
    })
    .from(workshopTemplates)
    .where(
      and(
        eq(workshopTemplates.id, templateId),
        eq(workshopTemplates.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_template_not_found",
      "workshop template not found",
    );
  }
  return row;
}

function revisionRecord(row: {
  id: string;
  templateId: string;
  revision: number;
  sourceRevision: string;
  contentHash: string;
  manifestJson: WorkshopManifestV1;
  publishedAt: number;
}): WorkshopTemplateRevisionRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    revision: row.revision,
    sourceRevision: row.sourceRevision,
    contentHash: row.contentHash,
    manifest: row.manifestJson,
    publishedAt: row.publishedAt,
  };
}
