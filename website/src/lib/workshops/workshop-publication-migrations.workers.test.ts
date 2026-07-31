/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { d1Migrations } from "@/test/d1-migrations";

const migration0021 = d1Migrations.filter(
  (migration) =>
    migration.name === "0021_workshop_publication_verification_basis.sql",
);
const migrationsBefore0021 = d1Migrations.filter(
  (migration) => migration.name < "0021",
);
const migration0022 = d1Migrations.filter(
  (migration) => migration.name === "0022_workshop_publication_retries.sql",
);
const migrationsBefore0022 = d1Migrations.filter(
  (migration) => migration.name < "0022",
);

describe("workshop publication verification-basis migration", () => {
  it("preserves a null basis marker for every legacy provider checkpoint", async () => {
    await reset();
    await applyD1Migrations(env.DB, migrationsBefore0021);
    await seedPublicationPrerequisites();
    await insertPublication("publication-basis", "a".repeat(64), "building");

    await insertProviderCheckpoint({
      id: "provider-verified",
      checkpointId: "checkpoint-00",
      ordinal: 0,
      status: "verified",
      proofVerifiedAt: 2_000,
      deletionConfirmedAt: 3_000,
    });
    await insertProviderCheckpoint({
      id: "provider-pending",
      checkpointId: "checkpoint-01",
      ordinal: 1,
      status: "pending",
    });
    await insertProviderCheckpoint({
      id: "provider-applying",
      checkpointId: "checkpoint-02",
      ordinal: 2,
      status: "applying",
    });
    await insertProviderCheckpoint({
      id: "provider-proof-succeeded",
      checkpointId: "checkpoint-03",
      ordinal: 3,
      status: "proof_succeeded",
      proofVerifiedAt: 4_000,
    });
    await insertProviderCheckpoint({
      id: "provider-failed",
      checkpointId: "checkpoint-04",
      ordinal: 4,
      status: "failed",
      proofVerifiedAt: 5_000,
      deletionConfirmedAt: 6_000,
    });

    expect(migration0021).toHaveLength(1);
    await applyD1Migrations(env.DB, migration0021);

    const checkpoints = await env.DB.prepare(
      `SELECT id, verification_status, verification_basis_checkpoint_id
       FROM workshop_publication_provider_checkpoints
       ORDER BY ordinal`,
    ).all<{
      id: string;
      verification_status: string;
      verification_basis_checkpoint_id: string | null;
    }>();
    expect(checkpoints.results).toEqual([
      {
        id: "provider-verified",
        verification_status: "verified",
        verification_basis_checkpoint_id: null,
      },
      {
        id: "provider-pending",
        verification_status: "pending",
        verification_basis_checkpoint_id: null,
      },
      {
        id: "provider-applying",
        verification_status: "applying",
        verification_basis_checkpoint_id: null,
      },
      {
        id: "provider-proof-succeeded",
        verification_status: "proof_succeeded",
        verification_basis_checkpoint_id: null,
      },
      {
        id: "provider-failed",
        verification_status: "failed",
        verification_basis_checkpoint_id: null,
      },
    ]);
  });
});

describe("failed workshop publication retry migration", () => {
  it("allows a retry after failure while retaining one nonfailed publication per organization and hash", async () => {
    await reset();
    await applyD1Migrations(env.DB, migrationsBefore0022);
    await seedPublicationPrerequisites();
    const contentHash = "b".repeat(64);
    await insertPublication("publication-failed", contentHash, "failed");

    expect(migration0022).toHaveLength(1);
    await applyD1Migrations(env.DB, migration0022);

    await expect(
      insertPublication("publication-retry", contentHash, "queued"),
    ).resolves.toBeUndefined();
    await expect(
      insertPublication(
        "publication-duplicate-active",
        contentHash,
        "building",
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const publications = await env.DB.prepare(
      `SELECT id, status
       FROM workshop_publications
       WHERE organization_id = 'org-a' AND content_hash = ?
       ORDER BY id`,
    )
      .bind(contentHash)
      .all<{ id: string; status: string }>();
    expect(publications.results).toEqual([
      { id: "publication-failed", status: "failed" },
      { id: "publication-retry", status: "queued" },
    ]);
  });
});

async function seedPublicationPrerequisites(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, email_verified, created_at, updated_at
       ) VALUES ('owner-a', 'Owner A', 'owner-a@example.test', 1, 1000, 1000)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Organization A', 'org-a', 1000)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by,
         created_at
       ) VALUES (
         'registry-token-a', 'org-a', 'Migration test', 'test',
         'registry-token-hash-a', 'owner-a', 1000
       )`,
    ),
    env.DB.prepare(
      `INSERT INTO organization_provider_connections (
         id, organization_id, provider_kind, display_name, state,
         project_fingerprint, sentinel_firewall_id, approved_locations_json,
         max_concurrent_servers, currency, ipv4_enabled, last_validated_at,
         created_by, created_at, updated_at
       ) VALUES (
         'connection-a', 'org-a', 'hetzner_cloud', 'Migration project',
         'active', 'project-a', 'firewall-a', '["nbg1"]', 5, 'EUR', 1,
         1000, 'owner-a', 1000, 1000
       )`,
    ),
  ]);
}

async function insertPublication(
  id: string,
  contentHash: string,
  status: "queued" | "building" | "failed",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workshop_publications (
       id, organization_id, workshop_slug, content_hash, source_r2_key,
       compiled_manifest_json, required_checkpoint_ids_json, status,
       submitted_by, registry_token_id, created_at, updated_at
     ) VALUES (?, 'org-a', 'migration-workshop', ?, ?, '{}', '["checkpoint-00"]', ?,
       'owner-a', 'registry-token-a', 1000, 1000)`,
  )
    .bind(id, contentHash, `workshop-publications/${id}.tar.gz`, status)
    .run();
}

async function insertProviderCheckpoint(input: {
  id: string;
  checkpointId: string;
  ordinal: number;
  status: "pending" | "applying" | "proof_succeeded" | "verified" | "failed";
  proofVerifiedAt?: number;
  deletionConfirmedAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workshop_publication_provider_checkpoints (
       id, publication_id, checkpoint_id, ordinal, covered_module_ids_json,
       expected_probes_json, provider_kind, connection_id,
       resolved_provider_json, permitted_locations_json,
       price_observation_json, r2_key, sha256, size_bytes, compression,
       signature_b64, signing_key_id, workspace_agent_sha256, kino_sha256,
       verification_status, proof_verified_at, deletion_confirmed_at,
       created_at, updated_at
     ) VALUES (
       ?, 'publication-basis', ?, ?, '["00"]', '["probe-00"]',
       'hetzner_cloud', 'connection-a', '{}', '["nbg1"]', '{}', ?, ?, 1,
       'zstd', 'signature', 'runtime-v1', ?, ?, ?, ?, ?, 1000, 1000
     )`,
  )
    .bind(
      input.id,
      input.checkpointId,
      input.ordinal,
      `provider-checkpoints/${input.id}.tar.zst`,
      input.id.padEnd(64, "a").slice(0, 64),
      "c".repeat(64),
      "d".repeat(64),
      input.status,
      input.proofVerifiedAt ?? null,
      input.deletionConfirmedAt ?? null,
    )
    .run();
}
