import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { WorkshopManifestV2 } from "@intar/workshop-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { workshopPublications } from "@/db/schema";
import { cancelWorkshopPublicationVerifierRuntimes } from "@/lib/workshops/provider-runtime";
import { resetDatabase } from "@/test/database-migrations";
import { stageWorkshopRevision } from "./publication-state";

beforeEach(resetDatabase);

describe("clean workshop publication state", () => {
  it("publishes an agent_kvm revision only after recording its profile certification", async () => {
    await seedPublication();
    const staged = await stageWorkshopRevision({
      env,
      publication: (
        await drizzle(env.DB).select().from(workshopPublications).limit(1)
      )[0]!,
      builderHostId: "builder-a",
      manifest,
      checkpoints: [
        {
          checkpointId: "checkpoint-00",
          coveredModuleIds: ["00-setup"],
          vmImages: manifest.workspace.checkpoints[0]!.vmImages,
          rawVmImages: [
            {
              vm_id: "learner",
              image_key: manifest.workspace.checkpoints[0]!.vmImages[0]!.imageKey,
              image_sha256: "a".repeat(64),
            },
          ],
          sanitized: true,
          coldBootVerified: true,
        },
      ],
      resolutions: [
        {
          declaration: {
            id: "agent-x86",
            provider: "agent_kvm",
            vmId: "learner",
            machineType: null,
            systemImage: "intar/debian-13-workshop@sha256:source",
            rootDiskType: null,
            locations: [],
            requirements: {
              cpuMillis: 4_000,
              memoryMib: 16_384,
              diskMib: 32_768,
            },
          },
          connectionId: null,
          claimedObservation: null,
        },
      ],
    });

    expect(staged.directCertificationIds).toEqual([]);
    const publication = await env.DB.prepare(
      `SELECT status, certification_state, published_revision_id
       FROM workshop_publications WHERE id = 'publication-a'`,
    ).first<{
      status: string;
      certification_state: string;
      published_revision_id: string;
    }>();
    expect(publication).toMatchObject({
      status: "published",
      certification_state: "verified",
      published_revision_id: staged.revisionId,
    });
    const certification = await env.DB.prepare(
      `SELECT certification.state, certification.verified_at,
              certification.deletion_confirmed_at, profile.provider_kind
       FROM workshop_runtime_profile_certifications certification
       JOIN workshop_runtime_profiles profile
         ON profile.id = certification.runtime_profile_id`,
    ).first<{
      state: string;
      verified_at: number;
      deletion_confirmed_at: number;
      provider_kind: string;
    }>();
    expect(certification).toMatchObject({
      state: "verified",
      provider_kind: "agent_kvm",
    });
    expect(certification?.verified_at).toBeGreaterThan(0);
    expect(certification?.deletion_confirmed_at).toBeGreaterThan(0);
    const template = await env.DB.prepare(
      "SELECT current_revision_id FROM workshop_templates WHERE id = ?",
    )
      .bind(staged.templateId)
      .first<{ current_revision_id: string }>();
    expect(template?.current_revision_id).toBe(staged.revisionId);
  });

  it("stages a direct-cloud revision without advancing the template pointer", async () => {
    await seedPublication();
    await seedHetznerConnection();
    const staged = await stageDirectPublication("publication-a");

    expect(staged.directCertificationIds).toHaveLength(1);
    const state = await env.DB.prepare(
      `SELECT publication.status, publication.certification_state,
              template.current_revision_id, certification.state AS cert_state,
              certification.connection_id
       FROM workshop_publications publication
       JOIN workshop_template_revisions revision
         ON revision.id = publication.published_revision_id
       JOIN workshop_templates template ON template.id = revision.template_id
       JOIN workshop_runtime_profiles profile
         ON profile.template_revision_id = revision.id
       JOIN workshop_runtime_profile_certifications certification
         ON certification.runtime_profile_id = profile.id
       WHERE publication.id = 'publication-a'`,
    ).first<{
      status: string;
      certification_state: string;
      current_revision_id: string | null;
      cert_state: string;
      connection_id: string;
    }>();
    expect(state).toEqual({
      status: "building",
      certification_state: "verifying",
      current_revision_id: null,
      cert_state: "pending",
      connection_id: "connection-h",
    });
  });

  it("stages identical content as a new revision after failed certification", async () => {
    await seedPublication();
    await seedHetznerConnection();
    await env.DB.batch([
      env.DB.prepare(
        "DROP INDEX workshop_template_revisions_content_idx",
      ),
      env.DB.prepare(
        `CREATE UNIQUE INDEX workshop_template_revisions_content_uidx
         ON workshop_template_revisions (template_id, content_hash)`,
      ),
    ]);
    const first = await stageDirectPublication("publication-a");
    const failedAt = Date.now();
    expect(
      await cancelWorkshopPublicationVerifierRuntimes({
        publicationId: "publication-a",
        organizationId: "org-a",
        now: failedAt,
      }),
    ).toBe("failed");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workshop_publications (
           id, organization_id, workshop_slug, content_hash, source_r2_key,
           compiled_manifest_json, required_checkpoint_ids_json, status,
           submitted_by, registry_token_id, builder_host_id,
           runtime_profile_resolutions_json
         ) VALUES ('publication-b', 'org-a', 'workshop-a', ?, 'source.tar.gz',
                   '{}', '["checkpoint-00"]', 'building', 'owner-a', 'token-a',
                   'builder-a', '[]')`,
      ).bind("f".repeat(64)),
      env.DB.prepare(
        `INSERT INTO workshop_publication_checkpoints (
           id, publication_id, checkpoint_id, status, sanitized,
           cold_boot_verified
         ) VALUES ('build-checkpoint-b', 'publication-b', 'checkpoint-00',
                   'building', 0, 0)`,
      ),
    ]);

    await expect(stageDirectPublication("publication-b")).rejects.toThrow(
      "UNIQUE constraint failed: workshop_template_revisions.template_id, workshop_template_revisions.content_hash",
    );
    await applyRepublishIndexPatch();
    await applyRepublishIndexPatch();
    const contentIndexes = await env.DB.prepare(
      `SELECT name, "unique" AS is_unique, partial
       FROM pragma_index_list('workshop_template_revisions')
       WHERE name IN (
         'workshop_template_revisions_content_uidx',
         'workshop_template_revisions_content_idx'
       ) ORDER BY name`,
    ).all<{ name: string; is_unique: number; partial: number }>();
    expect(contentIndexes.results).toEqual([
      {
        name: "workshop_template_revisions_content_idx",
        is_unique: 0,
        partial: 0,
      },
    ]);

    const second = await stageDirectPublication("publication-b");
    expect(second).toMatchObject({
      templateId: first.templateId,
      revision: 2,
    });
    expect(second.revisionId).not.toBe(first.revisionId);

    const revisions = await env.DB.prepare(
      `SELECT id, revision, content_hash
       FROM workshop_template_revisions
       WHERE template_id = ? ORDER BY revision`,
    )
      .bind(first.templateId)
      .all<{ id: string; revision: number; content_hash: string }>();
    expect(revisions.results).toEqual([
      { id: first.revisionId, revision: 1, content_hash: "f".repeat(64) },
      { id: second.revisionId, revision: 2, content_hash: "f".repeat(64) },
    ]);
  });
});

async function seedPublication() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email)
       VALUES ('owner-a', 'Owner', 'owner@example.test'),
              ('builder-user', 'Builder', 'builder@example.test')`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Organization A', 'organization-a', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO agent_hosts (
         id, user_id, organization_id, name, role, scenario_enabled,
         disabled, connected
       ) VALUES ('builder-a', 'builder-user', 'org-a', 'Builder', 'builder', 0, 0, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by
       ) VALUES ('token-a', 'org-a', 'Publisher', 'prefix', 'hash', 'owner-a')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publications (
         id, organization_id, workshop_slug, content_hash, source_r2_key,
         compiled_manifest_json, required_checkpoint_ids_json, status,
         submitted_by, registry_token_id, builder_host_id,
         runtime_profile_resolutions_json
       ) VALUES ('publication-a', 'org-a', 'workshop-a', ?, 'source.tar.gz',
                 '{}', '["checkpoint-00"]', 'building', 'owner-a', 'token-a',
                 'builder-a', '[]')`,
    ).bind("f".repeat(64)),
    env.DB.prepare(
      `INSERT INTO workshop_publication_checkpoints (
         id, publication_id, checkpoint_id, status, sanitized,
         cold_boot_verified
       ) VALUES ('build-checkpoint-a', 'publication-a', 'checkpoint-00',
                 'building', 0, 0)`,
    ),
  ]);
}

async function applyRepublishIndexPatch() {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS workshop_template_revisions_content_idx
       ON workshop_template_revisions (template_id, content_hash)`,
    ),
    env.DB.prepare(
      "DROP INDEX IF EXISTS workshop_template_revisions_content_uidx",
    ),
  ]);
}

async function seedHetznerConnection() {
  await env.DB.prepare(
    `INSERT INTO provider_connections (
       id, organization_id, provider_kind, display_name, state,
       external_project_id, project_fingerprint, created_by
     ) VALUES ('connection-h', 'org-a', 'hetzner_cloud', 'Hetzner',
               'active', 'project-h', 'fingerprint-h', 'owner-a')`,
  ).run();
}

async function stageDirectPublication(publicationId: string) {
  const publication = (
    await drizzle(env.DB)
      .select()
      .from(workshopPublications)
      .where(eq(workshopPublications.id, publicationId))
      .limit(1)
  )[0]!;
  return stageWorkshopRevision({
    env,
    publication,
    builderHostId: "builder-a",
    manifest: directManifest,
    checkpoints: [
      {
        checkpointId: "checkpoint-00",
        coveredModuleIds: ["00-setup"],
        vmImages: [],
        rawVmImages: [],
        sanitized: false,
        coldBootVerified: false,
        providerArtifact: {
          r2Key: `artifacts/${"b".repeat(64)}`,
          sha256: "b".repeat(64),
          sizeBytes: 1024,
          compression: "zstd",
          signatureB64: "A".repeat(86) + "==",
          signingKeyId: "test-key",
          workspaceAgentSha256: "c".repeat(64),
          kinoSha256: "d".repeat(64),
        },
      },
    ],
    resolutions: [
      {
        declaration: {
          id: "hetzner-cpx42",
          provider: "hetzner_cloud",
          vmId: "learner",
          machineType: "cpx42",
          systemImage: "debian-13",
          rootDiskType: null,
          locations: ["nbg1"],
          requirements: {
            cpuMillis: 4_000,
            memoryMib: 16_384,
            diskMib: 32_768,
          },
        },
        connectionId: "connection-h",
        claimedObservation: {
          profile_id: "hetzner-cpx42",
          observation: {
            provider: "hetzner_cloud",
            machine_type: "cpx42",
            resolved_system_image: "image-13",
            system_image_is_immutable: true,
            architecture: "x86_64",
            cores: 8,
            memory_mib: 16_384,
            disk_mib: 163_840,
            deprecated: false,
            available_locations: ["nbg1"],
          },
        },
      },
    ],
  });
}

const manifest: WorkshopManifestV2 = {
  schemaVersion: 2,
  workshop: {
    slug: "workshop-a",
    title: "Workshop A",
    summary: "Summary",
    prerequisites: [],
    attribution: { title: "Source", url: "https://example.test", license: "Apache-2.0" },
    defaultLobbyMinutes: 30,
  },
  workspace: {
    leaseGraceMinutes: 60,
    vms: [
      { id: "learner", name: "Learner", cpuMillis: 4_000, memoryMib: 16_384, diskMib: 32_768 },
    ],
    runtimeProfiles: [
      {
        id: "agent-x86",
        provider: "agent_kvm",
        vmId: "learner",
        requestedSystemImage: "intar/debian-13-workshop@sha256:source",
        immutableSystemImage: "intar/debian-13-workshop@sha256:source",
        locations: [],
        hardware: {
          architecture: "x86_64",
          cpuMillis: 4_000,
          providerCpuCount: 4,
          memoryMib: 16_384,
          diskMib: 32_768,
        },
      },
    ],
    checkpoints: [
      {
        id: "checkpoint-00",
        label: "Checkpoint 00",
        vmImages: [
          {
            vmId: "learner",
            imageKey: {
              scenario: "workshop-publication-a-checkpoint-00",
              vm: "learner",
              arch: "x86_64",
            },
            imageSha256: "a".repeat(64),
          },
        ],
      },
    ],
    initialCheckpointId: "checkpoint-00",
    applications: [],
  },
  modules: [
    {
      id: "00-setup",
      title: "Setup",
      tier: "gate",
      outcome: "Ready",
      dependsOn: [],
      participantMarkdown: "# Setup",
      facilitatorNotesMarkdown: "Notes",
      hints: [],
      solutionMarkdown: "Solution",
      probeIds: ["setup-ready"],
      catchUpCheckpointId: "checkpoint-00",
    },
  ],
  agenda: [
    {
      id: "setup",
      kind: "lab",
      title: "Setup",
      durationMinutes: 30,
      scheduled: true,
      moduleId: "00-setup",
      slideIds: [],
      release: "facilitator",
    },
  ],
  presentation: { slides: [] },
  durationMinutes: 30,
};

const directManifest: WorkshopManifestV2 = {
  ...manifest,
  workspace: {
    ...manifest.workspace,
    runtimeProfiles: [
      {
        id: "hetzner-cpx42",
        provider: "hetzner_cloud",
        vmId: "learner",
        machineType: "cpx42",
        requestedSystemImage: "debian-13",
        immutableSystemImage: "image-13",
        locations: ["nbg1"],
        hardware: {
          architecture: "x86_64",
          cpuMillis: 8_000,
          providerCpuCount: 8,
          memoryMib: 16_384,
          diskMib: 163_840,
        },
      },
    ],
    checkpoints: [
      { id: "checkpoint-00", label: "Checkpoint 00", vmImages: [] },
    ],
  },
};
