import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "@/test/database-migrations";
import { recordProviderOperationObservation } from "@/lib/workshops/provider-runtime";

beforeEach(resetDatabase);

describe("production D1 schema", () => {
  it("initializes the complete schema without legacy provider tables", async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all<{ name: string }>();
    const names = tables.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "user",
        "organization",
        "access_invite_codes",
        "access_allowlist",
        "access_events",
        "scenario_course_catalogs",
        "scenario_runs",
        "workshop_templates",
        "workshop_runtime_profiles",
        "workshop_runtime_profile_certifications",
        "workshop_session_runtime_selections",
        "provider_connections",
        "hetzner_connection_details",
        "gcp_connection_details",
        "runtime_executions",
        "runtime_provider_allocations",
        "runtime_provider_resources",
        "runtime_provider_operations",
        "runtime_provider_reconciliation",
        "runtime_guest_credentials",
        "runtime_guest_reports",
        "runtime_actual_state",
        "active_runtime_slots",
        "provider_price_observations",
        "provider_price_line_items",
        "workshop_session_cost_forecasts",
        "workshop_session_cost_forecast_line_items",
        "runtime_provider_cost_ledger",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "clean_d1_commissioning",
        "access_requests",
        "hetzner_allocations",
        "organization_provider_connections",
        "runtime_provider_checkpoint_artifacts",
        "runtime_provider_guest_credentials",
        "workshop_session_runtime_providers",
      ]),
    );

    const contentIndexes = await env.DB.prepare(
      `SELECT name, "unique" AS is_unique
       FROM pragma_index_list('workshop_template_revisions')
       WHERE name IN (
         'workshop_template_revisions_content_idx',
         'workshop_template_revisions_content_uidx'
       )
       ORDER BY name`,
    ).all<{ name: string; is_unique: number }>();
    expect(contentIndexes.results).toEqual([
      {
        name: "workshop_template_revisions_content_idx",
        is_unique: 0,
      },
    ]);

    const foreignKeyViolations = await env.DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(foreignKeyViolations.results).toEqual([]);

    const inviteSchema = await env.DB.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'table' AND name = 'access_invite_codes'`,
    ).first<{ sql: string }>();
    expect(inviteSchema?.sql).toContain("172800000");
    expect(inviteSchema?.sql).toContain("1209600000");
  });

  it("installs the beta claim, append-only audit, and last-admin guards", async () => {
    const triggers = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'access_allowlist_claim_invite',
         'access_allowlist_revoker_guard',
         'access_invite_codes_issuer_guard',
         'access_invite_codes_revoker_guard',
         'access_invite_removals_insert_command',
         'access_invite_removals_append_only_update',
         'access_invite_removals_append_only_delete',
         'access_invite_removals_event',
         'access_events_append_only_update',
         'access_events_append_only_delete',
         'access_allowlist_last_admin_guard',
         'access_user_last_beta_admin_update_guard',
         'access_user_last_beta_admin_delete_guard',
         'workshop_registry_tokens_creator_beta_guard'
       ) ORDER BY name`,
    ).all<{ name: string }>();
    expect(triggers.results.map(({ name }) => name)).toEqual([
      "access_allowlist_claim_invite",
      "access_allowlist_last_admin_guard",
      "access_allowlist_revoker_guard",
      "access_events_append_only_delete",
      "access_events_append_only_update",
      "access_invite_codes_issuer_guard",
      "access_invite_codes_revoker_guard",
      "access_invite_removals_append_only_delete",
      "access_invite_removals_append_only_update",
      "access_invite_removals_event",
      "access_invite_removals_insert_command",
      "access_user_last_beta_admin_delete_guard",
      "access_user_last_beta_admin_update_guard",
      "workshop_registry_tokens_creator_beta_guard",
    ]);

    const accountIndexes = await env.DB.prepare(
      `SELECT name, "unique" AS is_unique
       FROM pragma_index_list('account')
       WHERE name IN (
         'account_provider_account_uidx',
         'account_user_github_uidx'
       ) ORDER BY name`,
    ).all<{ name: string; is_unique: number }>();
    expect(accountIndexes.results).toEqual([
      { name: "account_provider_account_uidx", is_unique: 1 },
      { name: "account_user_github_uidx", is_unique: 1 },
    ]);
  });

  it("requires immutable allocation price attribution in the clean schema", async () => {
    const columns = await env.DB.prepare(
      "PRAGMA table_info('runtime_provider_allocations')",
    ).all<{ name: string; notnull: number }>();
    expect(
      columns.results.find((column) => column.name === "price_observation_id"),
    ).toMatchObject({ notnull: 1 });
    expect(
      columns.results.find((column) => column.name === "cost_forecast_id"),
    ).toMatchObject({ notnull: 0 });

    const triggers = await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'runtime_provider_allocations_identity_immutable',
         'runtime_provider_allocations_identity_insert_guard',
         'provider_price_observations_immutable_update',
         'provider_price_line_items_immutable_update',
         'runtime_provider_cost_ledger_identity_insert_guard'
       ) ORDER BY name`,
    ).all<{ name: string }>();
    expect(triggers.results.map((trigger) => trigger.name)).toEqual([
      "provider_price_line_items_immutable_update",
      "provider_price_observations_immutable_update",
      "runtime_provider_allocations_identity_immutable",
      "runtime_provider_allocations_identity_insert_guard",
      "runtime_provider_cost_ledger_identity_insert_guard",
    ]);
  });

  it("separates provider-neutral identities from provider details", async () => {
    await seedIdentity();
    await env.DB.prepare(
      `INSERT INTO provider_connections (
         id, organization_id, provider_kind, display_name, state,
         external_project_id, project_fingerprint, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "connection-gcp",
        "org-a",
        "gcp_compute",
        "GCP",
        "active",
        "gcp-project-a",
        "fingerprint-a",
        "owner-a",
      )
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO hetzner_connection_details (
           connection_id, sentinel_firewall_id, native_currency
         ) VALUES (?, ?, ?)`,
      )
        .bind("connection-gcp", "firewall-a", "EUR")
        .run(),
    ).rejects.toThrow("Hetzner details require a Hetzner connection");

    await expect(
      env.DB.prepare(
        `INSERT INTO gcp_connection_details (
           connection_id, project_number, network_name, network_self_link,
           subnet_name, subnet_self_link, subnet_cidr, firewall_name,
           firewall_self_link, approved_zones_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "connection-gcp",
          "123456789",
          "intar",
          "networks/intar",
          "intar-europe-west3",
          "subnetworks/intar-europe-west3",
          "10.64.0.0/20",
          "intar-ssh",
          "firewalls/intar-ssh",
          '["europe-west3-a","europe-west3-b","europe-west3-c"]',
        )
        .run(),
    ).resolves.toBeDefined();
  });

  it("rejects state-only promotion of a cleanup-only provider credential", async () => {
    await seedIdentity();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO provider_connections (
           id, organization_id, provider_kind, display_name, state,
           external_project_id, project_fingerprint, created_by
         ) VALUES ('connection-cleanup', 'org-a', 'gcp_compute', 'GCP cleanup',
                   'rotation_required', 'project-cleanup', 'fingerprint-cleanup',
                   'owner-a')`,
      ),
      env.DB.prepare(
        `INSERT INTO provider_credential_versions (
           id, connection_id, version, authority, algorithm, kek_version,
           aad_sha256, encrypted_payload_b64, payload_iv_b64,
           wrapped_dek_b64, dek_iv_b64, credential_fingerprint, created_by,
           activated_at
         ) VALUES ('credential-cleanup', 'connection-cleanup', 1,
                   'cleanup_only', 'AES-256-GCM', 'v1', ?, 'payload',
                   'payload-iv', 'wrapped-dek', 'dek-iv',
                   'credential-fingerprint', 'owner-a', 1)`,
      ).bind("a".repeat(64)),
      env.DB.prepare(
        `UPDATE provider_connections
         SET active_credential_version_id = 'credential-cleanup'
         WHERE id = 'connection-cleanup'`,
      ),
    ]);

    await expect(
      env.DB.prepare(
        `UPDATE provider_connections SET state = 'active'
         WHERE id = 'connection-cleanup'`,
      ).run(),
    ).rejects.toThrow("active credential does not belong");
  });

  it("pins an exact profile and rejects a connection from another provider", async () => {
    await seedWorkshop();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO provider_connections (
           id, organization_id, provider_kind, display_name, state,
           external_project_id, project_fingerprint, created_by
         ) VALUES ('connection-h', 'org-a', 'hetzner_cloud', 'Hetzner',
                   'active', 'project-h', 'fingerprint-h', 'owner-a')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_runtime_profiles (
           id, template_revision_id, profile_id, provider_kind, vm_id,
           machine_type, system_image, resolved_image_id, root_disk_type,
           architecture, cpu_millis, memory_mib, disk_mib, locations_json
         ) VALUES ('profile-gcp', 'revision-a', 'gcp-e2-standard-4',
                   'gcp_compute', 'learner', 'e2-standard-4',
                   'projects/debian-cloud/global/images/family/debian-13',
                   'projects/debian-cloud/global/images/debian-13-20260701',
                   'pd-balanced', 'x86_64', 4000, 16384, 32768,
                   '["europe-west3-a"]')`,
      ),
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO workshop_session_runtime_selections (
           session_id, runtime_profile_id, profile_id, provider_kind,
           connection_id, resolved_profile_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          "session-a",
          "profile-gcp",
          "gcp-e2-standard-4",
          "gcp_compute",
          "connection-h",
          '{"providerKind":"gcp_compute"}',
        )
        .run(),
    ).rejects.toThrow("invalid workshop runtime selection");
  });

  it("rejects inserting a direct-cloud certification as already verified", async () => {
    await seedWorkshop();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO provider_connections (
           id, organization_id, provider_kind, display_name, state,
           external_project_id, project_fingerprint, created_by
         ) VALUES ('connection-g', 'org-a', 'gcp_compute', 'GCP',
                   'active', 'project-g', 'fingerprint-g', 'owner-a')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_runtime_profiles (
           id, template_revision_id, profile_id, provider_kind, vm_id,
           machine_type, system_image, resolved_image_id, root_disk_type,
           architecture, cpu_millis, memory_mib, disk_mib, locations_json
         ) VALUES ('profile-g', 'revision-a', 'gcp-e2-standard-4',
                   'gcp_compute', 'vm-main', 'e2-standard-4',
                   'projects/debian-cloud/global/images/family/debian-13',
                   'projects/debian-cloud/global/images/debian-13-20260701',
                   'pd-balanced', 'x86_64', 4000, 16384, 32768,
                   '["europe-west3-a"]')`,
      ),
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO workshop_runtime_profile_certifications (
           id, runtime_profile_id, connection_id, state, verified_at,
           deletion_confirmed_at
         ) VALUES ('cert-g', 'profile-g', 'connection-g', 'verified', 10, 10)`,
      ).run(),
    ).rejects.toThrow("runtime profile certifications must begin pending");
  });

  it("scopes provider resource and async-operation identities to their allocation", async () => {
    await seedWorkshop();
    await env.DB.batch([
      ...["one", "two"].flatMap((suffix) => [
        env.DB.prepare(
          `INSERT INTO provider_connections (
             id, organization_id, provider_kind, display_name, state,
             external_project_id, project_fingerprint, created_by
           ) VALUES (?, 'org-a', 'gcp_compute', ?, 'active', ?, ?, 'owner-a')`,
        ).bind(
          `connection-${suffix}`,
          `GCP ${suffix}`,
          `project-${suffix}`,
          `fingerprint-${suffix}`,
        ),
        env.DB.prepare(
          `INSERT INTO gcp_connection_details (
             connection_id, project_number, network_name, network_self_link,
             subnet_name, subnet_self_link, subnet_cidr, firewall_name,
             firewall_self_link, approved_zones_json,
             max_concurrent_allocations
           ) VALUES (?, ?, 'intar', ?, 'intar-europe-west3', ?,
                     '10.64.0.0/20', 'intar-ssh', ?,
                     '["europe-west3-a"]', 5)`,
        ).bind(
          `connection-${suffix}`,
          suffix === "one" ? "100000001" : "100000002",
          `networks/intar-${suffix}`,
          `subnetworks/intar-${suffix}`,
          `firewalls/intar-${suffix}`,
        ),
        env.DB.prepare(
          `INSERT INTO workshop_runtime_profiles (
             id, template_revision_id, profile_id, provider_kind, vm_id,
             machine_type, system_image, resolved_image_id, root_disk_type,
             architecture, cpu_millis, memory_mib, disk_mib, locations_json
           ) VALUES (?, 'revision-a', ?, 'gcp_compute', 'learner',
                     'e2-standard-4', 'debian-13', 'debian-13-pinned',
                     'pd-balanced', 'x86_64', 4000, 16384, 32768,
                     '["europe-west3-a"]')`,
        ).bind(`profile-${suffix}`, `gcp-e2-standard-4-${suffix}`),
        env.DB.prepare(
          `INSERT INTO workshop_runtime_profile_certifications (
             id, runtime_profile_id, connection_id, state
           ) VALUES (?, ?, ?, 'pending')`,
        ).bind(
          `certification-${suffix}`,
          `profile-${suffix}`,
          `connection-${suffix}`,
        ),
        env.DB.prepare(
          `INSERT INTO provider_price_observations (
             id, provider_kind, connection_id, runtime_profile_id, currency,
             source, raw_observation_json, observed_at, expires_at
           ) VALUES (?, 'gcp_compute', ?, ?, 'USD', 'test-catalog',
                     '{"availableLocations":["europe-west3-a"]}', 1, 86400001)`,
        ).bind(`price-${suffix}`, `connection-${suffix}`, `profile-${suffix}`),
        env.DB.prepare(
          `INSERT INTO runtime_executions (
             id, user_id, organization_id, provider_kind,
             provider_connection_id, domain_kind, domain_id, generation,
             state
           ) VALUES (?, 'owner-a', 'org-a', 'gcp_compute', ?,
                     'workshop_certification',
                     ?, 1, 'provisioning')`,
        ).bind(
          `execution-${suffix}`,
          `connection-${suffix}`,
          `certification-${suffix}`,
        ),
        env.DB.prepare(
          `INSERT INTO runtime_provider_allocations (
             id, execution_id, connection_id, runtime_profile_id,
             price_observation_id, cost_forecast_id, provider_kind,
             deterministic_name, machine_type,
             resolved_image_id, location_attempts_json, location, state
           ) VALUES (?, ?, ?, ?, ?, NULL, 'gcp_compute', ?,
                     'e2-standard-4', 'debian-13-pinned',
                     '["europe-west3-a","europe-west3-b"]', 'europe-west3-a',
                     'creating')`,
        ).bind(
          `allocation-${suffix}`,
          `execution-${suffix}`,
          `connection-${suffix}`,
          `profile-${suffix}`,
          `price-${suffix}`,
          `intar-${suffix}`,
        ),
        env.DB.prepare(
          `INSERT INTO runtime_provider_reconciliation (
             allocation_id, desired_state, observed_state, sweep_after
           ) VALUES (?, 'ready', 'creating', 1)`,
        ).bind(`allocation-${suffix}`),
      ]),
    ]);

    for (const suffix of ["one", "two"]) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO runtime_provider_resources (
             id, allocation_id, provider_kind, resource_kind,
             provider_resource_id, location_attempt, location, provider_state
           ) VALUES (?, ?, 'gcp_compute', 'instance', 'same-project-id',
                     1, 'europe-west3-a', 'provisioning')`,
        ).bind(`resource-${suffix}`, `allocation-${suffix}`),
        env.DB.prepare(
          `INSERT INTO runtime_provider_operations (
             id, allocation_id, provider_kind, operation_kind,
             location_attempt, provider_operation_id, request_id, state
           ) VALUES (?, ?, 'gcp_compute', 'delete_instance',
                     1, 'same-provider-operation-id', ?, 'running')`,
        ).bind(
          `operation-${suffix}`,
          `allocation-${suffix}`,
          `request-${suffix}`,
        ),
      ]);
    }

    const identities = await env.DB.prepare(
      `SELECT allocation_id, provider_resource_id
       FROM runtime_provider_resources ORDER BY allocation_id`,
    ).all<{ allocation_id: string; provider_resource_id: string }>();
    expect(identities.results).toEqual([
      {
        allocation_id: "allocation-one",
        provider_resource_id: "same-project-id",
      },
      {
        allocation_id: "allocation-two",
        provider_resource_id: "same-project-id",
      },
    ]);
    await expect(
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources (
           id, allocation_id, provider_kind, resource_kind,
           provider_resource_id, location_attempt, location, provider_state
         ) VALUES ('resource-one-conflict', 'allocation-one', 'gcp_compute',
                   'instance', 'changed-id', 1, 'europe-west3-a', 'running')`,
      ).run(),
    ).rejects.toThrow();

    await recordProviderOperationObservation({
      allocationId: "allocation-one",
      locationAttempt: 1,
      providerOperationId: "same-provider-operation-id",
      providerState: "DONE_WITH_ERROR",
      state: "failed",
      now: 50,
    });
    const failedDelete = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.last_error_code,
              operation.state AS operation_state,
              reconciliation.desired_state,
              reconciliation.observed_state
       FROM runtime_provider_allocations allocation
       JOIN runtime_provider_operations operation
         ON operation.allocation_id = allocation.id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       WHERE allocation.id = 'allocation-one'`,
    ).first<{
      allocation_state: string;
      last_error_code: string;
      operation_state: string;
      desired_state: string;
      observed_state: string;
    }>();
    expect(failedDelete).toMatchObject({
      allocation_state: "cleanup_pending",
      last_error_code: "provider_async_operation_failed",
      operation_state: "failed",
      desired_state: "deleted",
      observed_state: "provider_operation_failed",
    });

    await env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET fallback_pending = 1, state = 'cleanup_pending'
       WHERE id = 'allocation-two'`,
    ).run();
    await expect(
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET location = 'europe-west3-b', location_attempt = 2,
             fallback_pending = 0, state = 'creating'
         WHERE id = 'allocation-two'`,
      ).run(),
    ).rejects.toThrow("invalid provider location attempt advance");
    await env.DB.prepare(
      `UPDATE runtime_provider_resources
       SET provider_state = 'deleted', disappearance_confirmed_at = 60
       WHERE allocation_id = 'allocation-two' AND location_attempt = 1`,
    ).run();
    await env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET location = 'europe-west3-b', location_attempt = 2,
           location_attempt_started_at = 61, fallback_pending = 0,
           state = 'creating'
       WHERE id = 'allocation-two'`,
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources (
           id, allocation_id, provider_kind, resource_kind,
           provider_resource_id, location_attempt, location, provider_state
         ) VALUES ('late-old-attempt', 'allocation-two', 'gcp_compute',
                   'boot_disk', 'late-disk', 1, 'europe-west3-a', 'present')`,
      ).run(),
    ).rejects.toThrow("provider resource kind does not match allocation");
    const advanced = await env.DB.prepare(
      `SELECT location, location_attempt, location_attempts_json
       FROM runtime_provider_allocations WHERE id = 'allocation-two'`,
    ).first<{
      location: string;
      location_attempt: number;
      location_attempts_json: string;
    }>();
    expect(advanced).toEqual({
      location: "europe-west3-b",
      location_attempt: 2,
      location_attempts_json: '["europe-west3-a","europe-west3-b"]',
    });

    // A late terminal failure for the old asynchronous operation is retained
    // on that historical operation, but cannot poison attempt two.
    await recordProviderOperationObservation({
      allocationId: "allocation-two",
      locationAttempt: 1,
      providerOperationId: "same-provider-operation-id",
      providerState: "DONE_WITH_ERROR",
      state: "failed",
      errorCode: "gcp_resource_unavailable",
      now: 70,
    });
    const staleFailure = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.location_attempt, allocation.last_error_code,
              operation.state AS operation_state,
              reconciliation.desired_state, reconciliation.observed_state,
              execution.state AS execution_state
       FROM runtime_provider_allocations allocation
       JOIN runtime_provider_operations operation
         ON operation.allocation_id = allocation.id
        AND operation.location_attempt = 1
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       WHERE allocation.id = 'allocation-two'`,
    ).first<{
      allocation_state: string;
      location_attempt: number;
      last_error_code: string | null;
      operation_state: string;
      desired_state: string;
      observed_state: string;
      execution_state: string;
    }>();
    expect(staleFailure).toEqual({
      allocation_state: "creating",
      location_attempt: 2,
      last_error_code: null,
      operation_state: "failed",
      desired_state: "ready",
      observed_state: "creating",
      execution_state: "provisioning",
    });
  });
});

async function seedIdentity(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email) VALUES ('owner-a', 'Owner', 'owner@example.test')`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-a', 'Organization A', 'organization-a', 1)`,
    ),
  ]);
}

async function seedWorkshop(): Promise<void> {
  await seedIdentity();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workshop_templates (
         id, organization_id, slug, title, summary, created_by
       ) VALUES ('template-a', 'org-a', 'workshop-a', 'Workshop A',
                 'Summary', 'owner-a')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions (
         id, template_id, revision, source_revision, content_hash,
         manifest_json, published_by
       ) VALUES ('revision-a', 'template-a', 1, 'source-a', 'hash-a',
                 '{"schemaVersion":2}', 'owner-a')`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_sessions (
         id, organization_id, template_revision_id, title,
         scheduled_start_at, lobby_opens_at, created_by
       ) VALUES ('session-a', 'org-a', 'revision-a', 'Session A',
                 3600000, 1800000, 'owner-a')`,
    ),
  ]);
}
