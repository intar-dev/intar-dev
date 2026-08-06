/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "@/test/database-migrations";

const featureFlagMocks = vi.hoisted(() => ({
  isWorkshopsEnabledForOrganization: vi.fn(),
}));

vi.mock("@/lib/workshops/feature-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workshops/feature-flag")>()),
  isWorkshopsEnabledForOrganization:
    featureFlagMocks.isWorkshopsEnabledForOrganization,
}));

import { hashWorkshopRegistryToken } from "@/lib/workshops/registry-tokens";
import { handleWorkshopRegistryRequest } from "./v2";

const REGISTRY_TOKEN = `intar_ws_${"a".repeat(64)}`;

beforeEach(async () => {
  await resetDatabase();
  vi.clearAllMocks();
  featureFlagMocks.isWorkshopsEnabledForOrganization.mockResolvedValue(true);
  await seedPublication();
});

describe("workshop registry certification status", () => {
  it("returns cumulative direct-cloud progress without exposing raw evidence", async () => {
    await setCertificationEvidence({
      proofKind: "direct_cloud_profile_certification_v1",
      phase: "awaiting_checkpoint_proof",
      cumulativeCheckpointIds: checkpointIds(5),
      checkpointProofs: checkpointIds(5).map((checkpointId) => ({
        checkpointId,
        expectedModuleIds: [`module-${checkpointId}`],
        expectedProbeIds: [`probe-${checkpointId}`],
        privateProviderOperationId: "private-provider-operation",
      })),
      checkpointProofsCompleted: checkpointIds(4).map(
        (checkpointId, ordinal) => ({
          checkpointId,
          ordinal,
          rebootProofBootId: "private-boot-id",
        }),
      ),
      currentCheckpointOrdinal: 4,
      bootstrapCapability: "private-bootstrap-capability",
    });

    const body = await statusBody();

    expect(body).toMatchObject({
      publication_id: "publication-a",
      certifications: [
        {
          profile_id: "hetzner-cpx42",
          provider_kind: "hetzner_cloud",
          state: "verifying",
          phase: "awaiting_checkpoint_proof",
          current_checkpoint_id: "checkpoint-04",
          completed_checkpoint_ids: checkpointIds(4),
          completed_checkpoint_count: 4,
          total_checkpoint_count: 5,
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("private-provider-operation");
    expect(serialized).not.toContain("private-boot-id");
    expect(serialized).not.toContain("private-bootstrap-capability");
    expect(serialized).not.toContain("checkpointProofs");
  });

  it("sanitizes malformed phases, ordinals, and completed proof entries", async () => {
    const ids = checkpointIds(2);
    await setCertificationEvidence({
      proofKind: "direct_cloud_profile_certification_v1",
      phase: "secret-phase-value",
      cumulativeCheckpointIds: ids,
      checkpointProofs: ids.map((checkpointId) => ({ checkpointId })),
      checkpointProofsCompleted: [
        { checkpointId: "checkpoint-00", secret: "do-not-return-me" },
        { checkpointId: "secret-checkpoint-id" },
      ],
      currentCheckpointOrdinal: "1",
      providerCredential: "do-not-return-me",
    });

    const body = await statusBody();

    expect(body).toMatchObject({
      certifications: [
        {
          phase: null,
          current_checkpoint_id: null,
          completed_checkpoint_ids: [],
          completed_checkpoint_count: 0,
          total_checkpoint_count: 2,
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-phase-value");
    expect(serialized).not.toContain("secret-checkpoint-id");
    expect(serialized).not.toContain("do-not-return-me");
  });

  it("keeps accepted checkpoint counts beyond the former projection cutoff observable", async () => {
    const ids = checkpointIds(129);
    await setCertificationEvidence({
      proofKind: "direct_cloud_profile_certification_v1",
      phase: "awaiting_reboot_proof",
      cumulativeCheckpointIds: ids,
      checkpointProofs: ids.map((checkpointId) => ({ checkpointId })),
      checkpointProofsCompleted: ids
        .slice(0, 128)
        .map((checkpointId) => ({ checkpointId })),
      currentCheckpointOrdinal: 128,
    });

    await expect(statusBody()).resolves.toMatchObject({
      certifications: [
        {
          phase: "awaiting_reboot_proof",
          current_checkpoint_id: "checkpoint-128",
          completed_checkpoint_ids: ids.slice(0, 128),
          completed_checkpoint_count: 128,
          total_checkpoint_count: 129,
        },
      ],
    });
  });
});

async function statusBody(): Promise<unknown> {
  const response = await handleWorkshopRegistryRequest(
    new Request(
      "https://intar.test/registry/v1/workshop-bundles/publication-a",
      { headers: { authorization: `Bearer ${REGISTRY_TOKEN}` } },
    ),
    env,
  );
  if (!response) throw new Error("workshop registry route was not handled");
  expect(response.status).toBe(200);
  return response.json();
}

async function setCertificationEvidence(
  evidence: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_runtime_profile_certifications
     SET evidence_json = ? WHERE id = 'certification-a'`,
  )
    .bind(JSON.stringify(evidence))
    .run();
}

function checkpointIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, ordinal) => `checkpoint-${String(ordinal).padStart(2, "0")}`,
  );
}

async function seedPublication(): Promise<void> {
  const now = 1_800_000_000_000;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES ('owner-a', 'Owner', 'owner@example.test', 1, ?, ?)`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Organization A', 'organization-a', ?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO provider_connections (
         id, organization_id, provider_kind, display_name, state,
         external_project_id, project_fingerprint, created_by, created_at, updated_at
       ) VALUES (
         'connection-a', 'org-a', 'hetzner_cloud', 'Hetzner', 'active',
         'project-a', 'fingerprint-a', 'owner-a', ?, ?
       )`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by, created_at
       ) VALUES ('token-a', 'org-a', 'Publisher', 'intar_ws_aaaaaaaaaa', ?, 'owner-a', ?)`,
    ).bind(await hashWorkshopRegistryToken(REGISTRY_TOKEN), now),
    env.DB.prepare(
      `INSERT INTO workshop_templates (
         id, organization_id, slug, title, summary, created_by, created_at, updated_at
       ) VALUES (
         'template-a', 'org-a', 'workshop-a', 'Workshop A', 'Summary',
         'owner-a', ?, ?
       )`,
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions (
         id, template_id, revision, source_revision, content_hash,
         manifest_json, published_by, published_at
       ) VALUES (
         'revision-a', 'template-a', 1, 'source-a', ?, '{}', 'owner-a', ?
       )`,
    ).bind("f".repeat(64), now),
    env.DB.prepare(
      `INSERT INTO workshop_publications (
         id, organization_id, workshop_slug, content_hash, source_r2_key,
         compiled_manifest_json, required_checkpoint_ids_json, status,
         submitted_by, registry_token_id, published_revision_id,
         runtime_profile_resolutions_json, certification_state, created_at, updated_at
       ) VALUES (
         'publication-a', 'org-a', 'workshop-a', ?, 'source.tar.gz',
         '{}', '[]', 'building', 'owner-a', 'token-a', 'revision-a',
         '[]', 'verifying', ?, ?
       )`,
    ).bind("f".repeat(64), now, now),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles (
         id, template_revision_id, profile_id, provider_kind, vm_id,
         machine_type, system_image, resolved_image_id, architecture,
         cpu_millis, memory_mib, disk_mib, locations_json, configuration_json,
         created_at
       ) VALUES (
         'profile-a', 'revision-a', 'hetzner-cpx42', 'hetzner_cloud', 'learner',
         'cpx42', 'debian-13', 'debian-13-exact', 'x86_64',
         4000, 16384, 32768, '["nbg1"]', '{}', ?
       )`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profile_certifications (
         id, runtime_profile_id, connection_id, state, evidence_json,
         started_at, created_at, updated_at
       ) VALUES (
         'certification-a', 'profile-a', 'connection-a', 'verifying', '{}',
         ?, ?, ?
       )`,
    ).bind(now, now, now),
  ]);
}
