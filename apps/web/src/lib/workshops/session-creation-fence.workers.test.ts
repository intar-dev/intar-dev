/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  afterProviderPreflight: vi.fn(),
  invokeProviderOperation: vi.fn(),
}));

vi.mock("./provider-service", () => ({
  invokeProviderOperation: hooks.invokeProviderOperation,
}));

vi.mock("./session-provider", async (importOriginal) => {
  const original = await importOriginal<typeof import("./session-provider")>();
  return {
    ...original,
    prepareWorkshopSessionProvider: async (
      input: Parameters<typeof original.prepareWorkshopSessionProvider>[0],
    ) => {
      const prepared = await original.prepareWorkshopSessionProvider(input);
      await hooks.afterProviderPreflight();
      return prepared;
    },
  };
});

import { resetD1Database } from "@/test/d1-migrations";
import { createWorkshopSession } from "./sessions";

describe("workshop session creation commit fence", () => {
  beforeEach(async () => {
    await resetD1Database();
    hooks.afterProviderPreflight.mockReset();
    hooks.afterProviderPreflight.mockResolvedValue(undefined);
    hooks.invokeProviderOperation.mockReset();
    hooks.invokeProviderOperation.mockResolvedValue({
      canonicalWrites: [],
      data: {
        serverTypes: [
          {
            name: "cpx42",
            architecture: "x86",
            cores: 2,
            memory: 4,
            disk: 16,
          },
        ],
        systemImages: [
          {
            id: 42,
            name: "debian-13",
            architecture: "x86",
            status: "available",
          },
        ],
      },
    });
    await seedSchedulableWorkshop();
  });

  it("rolls back the whole session command when creator authority changes after preflight", async () => {
    hooks.afterProviderPreflight.mockImplementationOnce(async () => {
      await env.DB.prepare(
        `UPDATE member SET role = 'member' WHERE id = 'owner-membership'`,
      ).run();
    });

    await expect(
      createWorkshopSession({
        organizationId: "org",
        actorUserId: "owner",
        templateRevisionId: "revision",
        runtimeProvider: { profileId: "agent-x86" },
        title: "Authority race",
        scheduledStartAt: 3_600_000,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_session_creation_changed",
    });

    const durableRows = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM workshop_sessions) AS sessions,
         (SELECT count(*) FROM workshop_session_runtime_selections) AS selections,
         (SELECT count(*) FROM workshop_session_members) AS roster,
         (SELECT count(*) FROM workshop_events) AS events`,
    ).first<{
      sessions: number;
      selections: number;
      roster: number;
      events: number;
    }>();
    expect(durableRows).toEqual({
      sessions: 0,
      selections: 0,
      roster: 0,
      events: 0,
    });
  });

  it("rolls back a direct-cloud session when its connection changes after provider preflight", async () => {
    await makeWorkshopDirectCloud();
    hooks.afterProviderPreflight.mockImplementationOnce(async () => {
      await env.DB.prepare(
        `UPDATE provider_connections
         SET state = 'disconnected', disconnected_at = 2, updated_at = 2
         WHERE id = 'connection'`,
      ).run();
    });

    await expect(
      createWorkshopSession({
        organizationId: "org",
        actorUserId: "owner",
        templateRevisionId: "revision",
        runtimeProvider: {
          profileId: "hetzner-cpx42",
          connectionId: "connection",
        },
        title: "Connection race",
        scheduledStartAt: 3_600_000,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_session_creation_changed",
    });
    expect(hooks.invokeProviderOperation).toHaveBeenCalledTimes(1);
    const sessions = await env.DB.prepare(
      `SELECT count(*) AS value FROM workshop_sessions`,
    ).first<{ value: number }>();
    expect(sessions?.value).toBe(0);
  });
});

async function seedSchedulableWorkshop(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org', 'Organization', 'organization', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('owner-membership', 'org', 'owner', 'owner', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_templates
         (id, organization_id, slug, title, summary, created_by, created_at, updated_at)
       VALUES ('template', 'org', 'workshop', 'Workshop', 'Summary', 'owner', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions
         (id, template_id, revision, source_revision, content_hash,
          manifest_json, published_by, published_at)
       VALUES ('revision', 'template', 1, 'source', ?, ?, 'owner', 1)`,
    ).bind(
      "a".repeat(64),
      JSON.stringify({
        workshop: { defaultLobbyMinutes: 15 },
        workspace: { runtimeProfiles: [{ id: "agent-x86" }] },
      }),
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          system_image, architecture, cpu_millis, memory_mib, disk_mib,
          locations_json, configuration_json, created_at)
       VALUES ('profile', 'revision', 'agent-x86', 'agent_kvm', 'learner',
               'debian-13', 'x86_64', 2000, 4096, 16384, '[]', '{}', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profile_certifications
         (id, runtime_profile_id, state, evidence_json, verified_at,
          deletion_confirmed_at, created_at, updated_at)
       VALUES ('certification', 'profile', 'verified', '{}', 1, 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens
         (id, organization_id, name, token_prefix, token_hash, created_by, created_at)
       VALUES ('registry-token', 'org', 'Publisher', 'intar_test',
               'registry-token-hash', 'owner', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publications
         (id, organization_id, workshop_slug, content_hash, source_r2_key,
          compiled_manifest_json, required_checkpoint_ids_json, status,
          submitted_by, registry_token_id, published_revision_id,
          certification_state, finished_at, created_at, updated_at)
       VALUES ('publication', 'org', 'workshop', ?, 'source.tar.zst', '{}',
               '[]', 'published', 'owner', 'registry-token', 'revision',
               'verified', 1, 1, 1)`,
    ).bind("a".repeat(64)),
  ]);
}

async function makeWorkshopDirectCloud(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM workshop_runtime_profile_certifications
       WHERE id = 'certification'`,
    ),
    env.DB.prepare(`DELETE FROM workshop_runtime_profiles WHERE id = 'profile'`),
    env.DB.prepare(
      `UPDATE workshop_template_revisions
       SET manifest_json = ?
       WHERE id = 'revision'`,
    ).bind(
      JSON.stringify({
        workshop: { defaultLobbyMinutes: 15 },
        workspace: { runtimeProfiles: [{ id: "hetzner-cpx42" }] },
      }),
    ),
    env.DB.prepare(
      `INSERT INTO provider_connections
         (id, organization_id, provider_kind, display_name, state,
          external_project_id, project_fingerprint, created_by,
          last_validated_at, created_at, updated_at)
       VALUES ('connection', 'org', 'hetzner_cloud', 'Hetzner', 'active',
               'project', 'project-fingerprint', 'owner', 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO provider_credential_versions
         (id, connection_id, version, authority, algorithm, kek_version,
          aad_sha256, encrypted_payload_b64, payload_iv_b64, wrapped_dek_b64,
          dek_iv_b64, credential_fingerprint, created_by, activated_at, created_at)
       VALUES ('credential', 'connection', 1, 'active', 'AES-256-GCM', 'v1',
               ?, 'payload', 'payload-iv', 'wrapped-dek', 'wrapped-dek-iv',
               'credential-fingerprint', 'owner', 1, 1)`,
    ).bind("b".repeat(64)),
    env.DB.prepare(
      `UPDATE provider_connections
       SET active_credential_version_id = 'credential'
       WHERE id = 'connection'`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          machine_type, system_image, resolved_image_id, architecture,
          cpu_millis, memory_mib, disk_mib, locations_json,
          configuration_json, created_at)
       VALUES ('direct-profile', 'revision', 'hetzner-cpx42',
               'hetzner_cloud', 'learner', 'cpx42', 'debian-13', '42',
               'x86_64', 2000, 4096, 16384, '["nbg1"]', '{}', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profile_certifications
         (id, runtime_profile_id, connection_id, state, evidence_json,
          verified_at, deletion_confirmed_at, created_at, updated_at)
       VALUES ('direct-certification', 'direct-profile', 'connection',
               'verified', '{}', 1, 1, 1, 1)`,
    ),
  ]);
}
