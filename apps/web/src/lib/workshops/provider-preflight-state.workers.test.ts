import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/database-migrations";
import {
  WORKSHOP_PROVIDER_PREFLIGHT_TTL_MS,
  countWorkshopRequestedSeats,
  persistWorkshopProviderPreflight,
  requireFreshWorkshopProviderPreflight,
} from "./provider-preflight-state";

const NOW = Date.UTC(2026, 7, 2, 0, 0, 0);

beforeEach(async () => {
  await resetDatabase();
  await seedSession();
});

describe("persisted direct-cloud Workshop preflight", () => {
  it("counts each workspace-enabled roster member once and persists failure reasons", async () => {
    await expect(countWorkshopRequestedSeats("session")).resolves.toBe(2);
    await persistWorkshopProviderPreflight({
      sessionId: "session",
      requestedSeats: 2,
      result: {
        ok: false,
        availableSeats: 1,
        preferredLocation: "europe-west3-a",
        reasons: ["only one seat is available"],
      },
      checkedAt: NOW,
    });
    await expect(
      requireFreshWorkshopProviderPreflight({ sessionId: "session", now: NOW }),
    ).rejects.toMatchObject({
      code: "workshop_provider_capacity_insufficient",
      message: "only one seat is available",
    });
    const stored = await env.DB.prepare(
      `SELECT preflight_requested_seats, preflight_available_seats,
              preflight_ok, preflight_reasons_json
         FROM workshop_session_runtime_selections WHERE session_id = ?`,
    )
      .bind("session")
      .first<{
        preflight_requested_seats: number;
        preflight_available_seats: number;
        preflight_ok: number;
        preflight_reasons_json: string;
      }>();
    expect(stored).toMatchObject({
      preflight_requested_seats: 2,
      preflight_available_seats: 1,
      preflight_ok: 0,
      preflight_reasons_json: '["only one seat is available"]',
    });
  });

  it("accepts only a fresh successful snapshot for the unchanged roster", async () => {
    await persistWorkshopProviderPreflight({
      sessionId: "session",
      requestedSeats: 2,
      result: {
        ok: true,
        availableSeats: 2,
        preferredLocation: "europe-west3-a",
        reasons: [],
      },
      checkedAt: NOW,
    });
    await expect(
      requireFreshWorkshopProviderPreflight({
        sessionId: "session",
        now: NOW + WORKSHOP_PROVIDER_PREFLIGHT_TTL_MS - 1,
      }),
    ).resolves.toBeUndefined();
    await expect(
      requireFreshWorkshopProviderPreflight({
        sessionId: "session",
        now: NOW + WORKSHOP_PROVIDER_PREFLIGHT_TTL_MS,
      }),
    ).rejects.toMatchObject({ code: "workshop_provider_preflight_stale" });

    await env.DB.prepare(
      `INSERT INTO user (id, name, email) VALUES ('learner-3', 'Learner 3', 'learner-3@example.test')`,
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
         VALUES ('membership-3', 'org', 'learner-3', 'member', ?)`,
      ).bind(NOW),
      env.DB.prepare(
        `INSERT INTO workshop_session_members
           (id, session_id, user_id, role, workspace_enabled, assigned_by)
         VALUES ('roster-3', 'session', 'learner-3', 'participant', 1, 'owner')`,
      ),
    ]);
    await expect(
      requireFreshWorkshopProviderPreflight({ sessionId: "session", now: NOW }),
    ).rejects.toMatchObject({ code: "workshop_provider_preflight_stale" });
  });
});

async function seedSession(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email) VALUES
         ('owner', 'Owner', 'owner@example.test'),
         ('learner-1', 'Learner 1', 'learner-1@example.test'),
         ('learner-2', 'Learner 2', 'learner-2@example.test')`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org', 'Organization', 'organization', ?)`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
         ('membership-owner', 'org', 'owner', 'owner', ?),
         ('membership-1', 'org', 'learner-1', 'member', ?),
         ('membership-2', 'org', 'learner-2', 'member', ?)`,
    ).bind(NOW, NOW, NOW),
    env.DB.prepare(
      `INSERT INTO workshop_templates
         (id, organization_id, slug, title, summary, created_by)
       VALUES ('template', 'org', 'workshop', 'Workshop', 'Summary', 'owner')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions
         (id, template_id, revision, source_revision, content_hash,
          manifest_json, published_by)
       VALUES ('revision', 'template', 1, 'source', 'hash',
               '{"schemaVersion":2}', 'owner')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_sessions
         (id, organization_id, template_revision_id, title, state,
          scheduled_start_at, lobby_opens_at, created_by)
       VALUES ('session', 'org', 'revision', 'Session', 'lobby', ?, ?, 'owner')`,
    ).bind(NOW + 60_000, NOW),
    env.DB.prepare(
      `INSERT INTO provider_connections
         (id, organization_id, provider_kind, display_name, state,
          external_project_id, project_fingerprint, created_by)
       VALUES ('connection', 'org', 'gcp_compute', 'GCP', 'active',
               'intar-project', 'fingerprint', 'owner')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          machine_type, system_image, resolved_image_id, root_disk_type,
          architecture, cpu_millis, memory_mib, disk_mib, locations_json)
       VALUES ('profile', 'revision', 'gcp', 'gcp_compute', 'learner',
               'e2-standard-4', 'debian-13', 'image-1', 'pd-balanced',
               'x86_64', 4000, 16384, 32768,
               '["europe-west3-a","europe-west3-b","europe-west3-c"]')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_session_runtime_selections
         (session_id, runtime_profile_id, profile_id, provider_kind,
          connection_id, resolved_profile_json)
       VALUES ('session', 'profile', 'gcp', 'gcp_compute', 'connection',
               '{"providerKind":"gcp_compute","vmId":"learner","machineType":"e2-standard-4","systemImage":"debian-13","resolvedImageId":"image-1","rootDiskType":"pd-balanced","locations":["europe-west3-a"],"hardware":{"architecture":"x86_64","cpuMillis":4000,"memoryMib":16384,"diskMib":32768,"providerCpuCount":4,"providerMemoryMib":16384,"providerDiskMib":32768},"configuration":{}}')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_session_members
         (id, session_id, user_id, role, workspace_enabled, assigned_by) VALUES
         ('roster-1', 'session', 'learner-1', 'participant', 1, 'owner'),
         ('roster-2', 'session', 'learner-2', 'participant', 1, 'owner')`,
    ),
  ]);
}
