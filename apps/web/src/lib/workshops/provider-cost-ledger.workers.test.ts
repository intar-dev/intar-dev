import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCleanD1Database } from "@/test/clean-d1-migrations";
import {
  finalizeWorkshopCostAfterAllocationDeletion,
  reconcileProviderCostLedger,
} from "./provider-cost-ledger";
import {
  ensureDirectCloudPriceObservation,
  rootDiskGibForPriceQuote,
} from "./cost-storage";
import {
  confirmProviderResourceDisappearance,
  sweepWorkshopProviderRuntimes,
} from "./provider-runtime";

const providerMocks = vi.hoisted(() => ({ runOperation: vi.fn() }));
vi.mock("./provider-service", () => ({
  invokeProviderOperation: async (
    _kind: string,
    work: (binding: { runOperation: typeof providerMocks.runOperation }) =>
      Promise<unknown>,
  ) => work({ runOperation: providerMocks.runOperation }),
}));

const HOUR_MS = 60 * 60 * 1_000;
const START = Date.UTC(2026, 6, 30, 10, 0, 0);

beforeEach(async () => {
  await resetCleanD1Database();
  providerMocks.runOperation.mockReset();
});

describe("provider-neutral runtime cost ledger", () => {
  it("rounds non-whole-GiB disk requirements up for GCP quote inputs", () => {
    expect(rootDiskGibForPriceQuote(32 * 1024)).toBe(32);
    expect(rootDiskGibForPriceQuote(32 * 1024 + 1)).toBe(33);
    expect(() => rootDiskGibForPriceQuote(0)).toThrow(
      /invalid disk requirement/u,
    );
    expect(() => rootDiskGibForPriceQuote(1.5)).toThrow(
      /invalid disk requirement/u,
    );
  });

  it("loads the immutable profile shape before issuing a provider quote", async () => {
    await seedLearnerRuntime(
      "gcp_compute",
      32 * 1024 + 1,
      ["europe-west3-a", "europe-west3-b"],
      ["europe-west3-a"],
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO provider_credential_versions
           (id, connection_id, version, algorithm, kek_version, aad_sha256,
            encrypted_payload_b64, payload_iv_b64, wrapped_dek_b64, dek_iv_b64,
            credential_fingerprint, created_by, activated_at, created_at)
         VALUES ('credential-g', 'connection-g', 1, 'AES-256-GCM', 'v1', ?,
                 'payload', 'payload-iv', 'dek', 'dek-iv', 'fingerprint',
                 'user-g', ?, ?)`,
      ).bind("a".repeat(64), START, START),
      env.DB.prepare(
        `UPDATE provider_connections
         SET active_credential_version_id = 'credential-g'
         WHERE id = 'connection-g'`,
      ),
    ]);
    providerMocks.runOperation.mockResolvedValue({
      canonicalWrites: [],
      data: [
        {
          sku: "gcp-core",
          resourceKind: "compute_core",
          rawUnitPrice: "0.001",
          unitPriceNanos: 1_000_000,
          unit: "hour",
          quantity: 4,
          billingGranularitySeconds: 1,
          minimumDurationSeconds: 60,
          capNanos: null,
          taxTreatment: "tax_excluded_public_list",
          observedAt: new Date(START).toISOString(),
        },
      ],
    });

    const observation = await ensureDirectCloudPriceObservation({
      organizationId: "org-g",
      providerKind: "gcp_compute",
      connectionId: "connection-g",
      runtimeProfileId: "profile-g",
      now: START,
    });

    expect(observation).toMatchObject({
      currency: "USD",
      availableLocations: ["europe-west3-a"],
    });
    expect(providerMocks.runOperation).toHaveBeenCalledTimes(1);
    expect(providerMocks.runOperation.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "connection-g",
      projectId: "project-g",
      operation: {
        kind: "quote",
        machineType: "e2-standard-4",
        zones: ["europe-west3-a"],
        rootDiskType: "pd-balanced",
        rootDiskGib: 33,
      },
    });
    await env.DB.prepare(
      `UPDATE gcp_connection_details
       SET approved_zones_json = '["europe-west3-a","europe-west3-b"]'
       WHERE connection_id = 'connection-g'`,
    ).run();
    const refreshed = await ensureDirectCloudPriceObservation({
      organizationId: "org-g",
      providerKind: "gcp_compute",
      connectionId: "connection-g",
      runtimeProfileId: "profile-g",
      now: START + 1,
    });
    expect(refreshed.id).not.toBe(observation.id);
    expect(providerMocks.runOperation).toHaveBeenCalledTimes(2);
    expect(providerMocks.runOperation.mock.calls[1]?.[0]).toMatchObject({
      operation: {
        kind: "quote",
        zones: ["europe-west3-a", "europe-west3-b"],
        rootDiskGib: 33,
      },
    });
    const forecasts = await env.DB.prepare(
      "SELECT count(*) AS value FROM workshop_session_cost_forecasts",
    ).first<{ value: number }>();
    expect(forecasts?.value).toBe(0);
  });

  it("pins Hetzner net/gross resource prices and closes independently rounded rows", async () => {
    await seedLearnerRuntime("hetzner_cloud");
    await insertPriceObservation({
      providerKind: "hetzner_cloud",
      observationId: "price-h-1",
      forecastId: "forecast-h-1",
      version: 1,
      lines: [
        line("server:cpx42", "instance", "provider_net", 100_000_000),
        line("server:cpx42", "instance", "provider_gross", 120_000_000),
        line("primary-ipv4", "ipv4", "provider_net", 10_000_000),
        line("primary-ipv4", "ipv4", "provider_gross", 12_000_000),
      ],
    });
    await insertLearnerAllocation(
      "hetzner_cloud",
      "price-h-1",
      "forecast-h-1",
    );
    await insertResources("hetzner_cloud", [
      ["resource-instance-h", "instance", "9001", START + 1_000],
      ["resource-ip-h", "ipv4", "9002", START + 2_000],
      ["resource-key-h", "ssh_key", "9003", START + 3_000],
    ]);

    await insertPriceObservation({
      providerKind: "hetzner_cloud",
      observationId: "price-h-2",
      forecastId: "forecast-h-2",
      version: 2,
      lines: [
        line("server:cpx42", "instance", "provider_net", 900_000_000),
        line("server:cpx42", "instance", "provider_gross", 920_000_000),
        line("primary-ipv4", "ipv4", "provider_net", 90_000_000),
        line("primary-ipv4", "ipv4", "provider_gross", 92_000_000),
      ],
    });
    await expect(
      reconcileProviderCostLedger({ allocationId: "allocation-h", now: START + 10_000 }),
    ).resolves.toMatchObject({ inserted: 4, closed: 0 });

    const pinned = await env.DB.prepare(
      `SELECT forecast_id, price_nanos, tax_treatment
       FROM runtime_provider_cost_ledger
       ORDER BY price_nanos`,
    ).all<{
      forecast_id: string;
      price_nanos: number;
      tax_treatment: string;
    }>();
    expect(pinned.results).toHaveLength(4);
    expect(new Set(pinned.results.map((row) => row.forecast_id))).toEqual(
      new Set(["forecast-h-1"]),
    );
    expect(pinned.results.map((row) => row.price_nanos)).toEqual([
      10_000_000,
      12_000_000,
      100_000_000,
      120_000_000,
    ]);
    await expect(
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET price_observation_id = 'price-h-2' WHERE id = 'allocation-h'`,
      ).run(),
    ).rejects.toThrow(/provider allocation identity is immutable/u);
    await expect(
      env.DB.prepare(
        `UPDATE provider_price_line_items SET price_nanos = 1
         WHERE id = 'price-h-1-line-0'`,
      ).run(),
    ).rejects.toThrow(/provider price line items are immutable/u);
    await expect(
      env.DB.prepare(
        "UPDATE runtime_provider_cost_ledger SET price_nanos = 1 WHERE id = ?",
      )
        .bind((await ledgerIds())[0])
        .run(),
    ).rejects.toThrow(/price snapshots are immutable/u);
    await expect(
      env.DB.prepare(
        "UPDATE runtime_provider_cost_ledger SET final_cost_nanos = 1 WHERE id = ?",
      )
        .bind((await ledgerIds())[0])
        .run(),
    ).rejects.toThrow(/runtime_provider_cost_ledger_lifecycle_valid/u);

    const deletedAt = START + HOUR_MS + 10_000;
    await env.DB.prepare(
      `UPDATE runtime_provider_resources
       SET provider_state = 'deleted', disappearance_confirmed_at = ?
       WHERE allocation_id = ? AND resource_kind != 'ssh_key'`,
    )
      .bind(deletedAt, "allocation-h")
      .run();
    const closed = await reconcileProviderCostLedger({
      allocationId: "allocation-h",
      now: deletedAt,
    });
    expect(closed).toMatchObject({ inserted: 0, closed: 4 });
    const finalRows = await env.DB.prepare(
      `SELECT deletion_confirmed_at, final_cost_nanos
       FROM runtime_provider_cost_ledger`,
    ).all<{ deletion_confirmed_at: number; final_cost_nanos: number }>();
    expect(finalRows.results.every((row) => row.deletion_confirmed_at === deletedAt)).toBe(true);
    // Hetzner rounds each independently billed resource lifetime to two hours.
    expect(finalRows.results.map((row) => row.final_cost_nanos).sort((a, b) => a - b)).toEqual([
      20_000_000,
      24_000_000,
      200_000_000,
      240_000_000,
    ]);
  });

  it("attributes certification resources to an observation without a session forecast", async () => {
    await seedLearnerRuntime("hetzner_cloud");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workshop_runtime_profile_certifications
           (id, runtime_profile_id, connection_id, state, created_at, updated_at)
         VALUES ('certification-h', 'profile-h', 'connection-h', 'pending', ?, ?)`,
      ).bind(START, START),
      env.DB.prepare(
        `INSERT INTO runtime_executions
           (id, user_id, organization_id, domain_kind, domain_id, generation,
            state, created_at, updated_at, provider_kind, provider_connection_id)
         VALUES ('cert-execution-h', 'user-h', 'org-h',
                 'workshop_certification', 'certification-h', 1, 'ready',
                 ?, ?, 'hetzner_cloud', 'connection-h')`,
      ).bind(START, START),
    ]);
    await insertStandalonePriceObservation({
      providerKind: "hetzner_cloud",
      observationId: "cert-price-h",
      lines: [
        line("server:cpx42", "instance", "provider_net", 100_000_000),
        line("server:cpx42", "instance", "provider_gross", 120_000_000),
        line("primary-ipv4", "ipv4", "provider_net", 10_000_000),
        line("primary-ipv4", "ipv4", "provider_gross", 12_000_000),
      ],
    });
    await env.DB.prepare(
      `INSERT INTO runtime_provider_allocations
         (id, execution_id, connection_id, runtime_profile_id,
          price_observation_id, cost_forecast_id, provider_kind,
          deterministic_name, machine_type, resolved_image_id,
          location_attempts_json, location, state, created_at, updated_at)
       VALUES ('cert-allocation-h', 'cert-execution-h', 'connection-h',
               'profile-h', 'cert-price-h', NULL, 'hetzner_cloud',
               'intar-cert-h', 'cpx42', 'image-h', json_array('nbg1'),
               'nbg1', 'ready', ?, ?)`,
    )
      .bind(START, START)
      .run();
    await insertResources(
      "hetzner_cloud",
      [
        ["cert-resource-instance-h", "instance", "9101", START + 1_000],
        ["cert-resource-ip-h", "ipv4", "9102", START + 2_000],
      ],
      "cert-allocation-h",
    );
    await expect(
      env.DB.prepare(
        `INSERT INTO runtime_provider_cost_ledger
           (id, execution_id, allocation_id, provider_resource_id,
            forecast_id, price_line_item_id, provider_kind, resource_kind,
            sku, location, currency, raw_price, price_nanos, unit,
            quantity_nanos, billing_increment_seconds,
            minimum_duration_seconds, cap_price_nanos, tax_treatment,
            provider_created_at, created_at, updated_at)
         VALUES ('tampered-ledger', 'cert-execution-h', 'cert-allocation-h',
                 'cert-resource-instance-h', NULL, 'cert-price-h-line-0',
                 'hetzner_cloud', 'instance', 'server:cpx42', 'nbg1', 'EUR',
                 '0.1', 100000000, 'hour', 1000000000, 3600, 3600, NULL,
                 'provider_net', ?, ?, ?)`,
      )
        .bind(START, START, START)
        .run(),
    ).rejects.toThrow(/cost ledger line does not match/u);

    await expect(
      reconcileProviderCostLedger({
        allocationId: "cert-allocation-h",
        now: START + 5_000,
      }),
    ).resolves.toMatchObject({ inserted: 4, closed: 0, skipped: null });
    const ledger = await env.DB.prepare(
      `SELECT forecast_id, currency, tax_treatment
       FROM runtime_provider_cost_ledger
       WHERE allocation_id = 'cert-allocation-h'
       ORDER BY tax_treatment`,
    ).all<{
      forecast_id: string | null;
      currency: string;
      tax_treatment: string;
    }>();
    expect(ledger.results).toHaveLength(4);
    expect(ledger.results.every((row) => row.forecast_id === null)).toBe(true);
    expect(new Set(ledger.results.map((row) => row.currency))).toEqual(
      new Set(["EUR"]),
    );
    expect(new Set(ledger.results.map((row) => row.tax_treatment))).toEqual(
      new Set(["provider_net", "provider_gross"]),
    );
    const forecasts = await env.DB.prepare(
      "SELECT count(*) AS value FROM workshop_session_cost_forecasts",
    ).first<{ value: number }>();
    expect(forecasts?.value).toBe(0);
  });

  it("accounts for GCP compute, boot disk, and ephemeral IPv4 then finalizes only after teardown", async () => {
    await seedLearnerRuntime("gcp_compute");
    await insertPriceObservation({
      providerKind: "gcp_compute",
      observationId: "price-g-1",
      forecastId: "forecast-g-1",
      version: 1,
      lines: [
        line("gcp-core", "compute_core", "tax_excluded_public_list", 36_000_000, 4),
        line("gcp-ram", "compute_ram", "tax_excluded_public_list", 4_000_000, 16),
        line("gcp-disk", "pd_balanced", "tax_excluded_public_list", 100_000_000, 32, "gib_month"),
        line("gcp-ip", "external_ipv4", "tax_excluded_public_list", 5_000_000),
      ],
      includeScenarioRows: true,
    });
    await insertLearnerAllocation(
      "gcp_compute",
      "price-g-1",
      "forecast-g-1",
    );
    await insertResources("gcp_compute", [
      ["resource-instance-g", "instance", "instance-9001", START + 5_000],
      ["resource-disk-g", "boot_disk", "disk-9001", START + 20_000],
    ]);
    await env.DB.prepare(
      "UPDATE runtime_provider_allocations SET external_ipv4 = ? WHERE id = ?",
    )
      .bind("203.0.113.42", "allocation-g")
      .run();

    const reconciled = await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: START + 30_000,
    });
    expect(reconciled).toMatchObject({ inserted: 4, closed: 0 });
    const resources = await env.DB.prepare(
      `SELECT resource_kind, provider_resource_id, provider_created_at,
              configuration_json
       FROM runtime_provider_resources
       WHERE allocation_id = ? ORDER BY resource_kind`,
    )
      .bind("allocation-g")
      .all<{
        resource_kind: string;
        provider_resource_id: string;
        provider_created_at: number;
        configuration_json: string;
      }>();
    expect(resources.results.map((row) => row.resource_kind)).toEqual([
      "boot_disk",
      "instance",
      "ipv4",
    ]);
    expect(resources.results.find((row) => row.resource_kind === "ipv4")).toMatchObject({
      provider_resource_id: "instance-9001:ephemeral-ipv4",
    });
    const ledger = await env.DB.prepare(
      `SELECT resource_kind, sku, provider_created_at
       FROM runtime_provider_cost_ledger ORDER BY sku`,
    ).all<{
      resource_kind: string;
      sku: string;
      provider_created_at: number;
    }>();
    expect(ledger.results.map((row) => [row.resource_kind, row.sku])).toEqual([
      ["instance", "gcp-core"],
      ["boot_disk", "gcp-disk"],
      ["ipv4", "gcp-ip"],
      ["instance", "gcp-ram"],
    ]);
    expect(ledger.results.map((row) => row.provider_created_at)).toEqual([
      START + 5_000,
      START + 20_000,
      START + 5_000,
      START + 5_000,
    ]);

    await expect(
      finalizeWorkshopCostAfterAllocationDeletion({
        allocationId: "allocation-g",
        now: START + HOUR_MS,
      }),
    ).resolves.toEqual({ finalized: false });

    const deletedAt = START + HOUR_MS;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE runtime_provider_resources
         SET provider_state = 'deleted', disappearance_confirmed_at = ?
         WHERE allocation_id = ?`,
      ).bind(deletedAt, "allocation-g"),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'deleted', deletion_confirmed_at = ? WHERE id = ?`,
      ).bind(deletedAt, "allocation-g"),
      env.DB.prepare(
        `UPDATE workshop_sessions
         SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(deletedAt, deletedAt, "session-g"),
    ]);
    await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: deletedAt,
    });
    await expect(
      finalizeWorkshopCostAfterAllocationDeletion({
        allocationId: "allocation-g",
        now: deletedAt,
      }),
    ).resolves.toEqual({ finalized: true });

    const open = await env.DB.prepare(
      "SELECT count(*) AS value FROM runtime_provider_cost_ledger WHERE deletion_confirmed_at IS NULL",
    ).first<{ value: number }>();
    expect(open?.value).toBe(0);
    const ledgerTotal = await env.DB.prepare(
      "SELECT sum(final_cost_nanos) AS value FROM runtime_provider_cost_ledger",
    ).first<{ value: number }>();
    const summary = await env.DB.prepare(
      `SELECT currency, final_cost_nanos, generation_count, restore_count,
              cleanup_pending_count, finalized_at
       FROM workshop_session_cost_summaries WHERE session_id = ?`,
    )
      .bind("session-g")
      .first<{
        currency: string;
        final_cost_nanos: number;
        generation_count: number;
        restore_count: number;
        cleanup_pending_count: number;
        finalized_at: number;
      }>();
    expect(summary).toMatchObject({
      currency: "USD",
      final_cost_nanos: ledgerTotal?.value,
      generation_count: 1,
      restore_count: 0,
      cleanup_pending_count: 0,
      finalized_at: deletedAt,
    });
  });

  it("keeps an orphaned GCP boot disk and its cost ledger open after the instance disappears", async () => {
    await seedLearnerRuntime("gcp_compute");
    await insertPriceObservation({
      providerKind: "gcp_compute",
      observationId: "price-g-orphan",
      forecastId: "forecast-g-orphan",
      version: 1,
      lines: [
        line("gcp-core", "compute_core", "tax_excluded_public_list", 36_000_000, 4),
        line("gcp-ram", "compute_ram", "tax_excluded_public_list", 4_000_000, 16),
        line("gcp-disk", "pd_balanced", "tax_excluded_public_list", 100_000_000, 32, "gib_month"),
        line("gcp-ip", "external_ipv4", "tax_excluded_public_list", 5_000_000),
      ],
      includeScenarioRows: true,
    });
    await insertLearnerAllocation(
      "gcp_compute",
      "price-g-orphan",
      "forecast-g-orphan",
    );
    await insertResources("gcp_compute", [
      ["resource-instance-g-orphan", "instance", "instance-orphan", START + 1_000],
      ["resource-disk-g-orphan", "boot_disk", "disk-orphan", START + 1_000],
    ]);
    await env.DB.prepare(
      "UPDATE runtime_provider_allocations SET external_ipv4 = ? WHERE id = ?",
    )
      .bind("203.0.113.88", "allocation-g")
      .run();
    await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: START + 2_000,
    });

    await env.DB.prepare(
      `INSERT INTO runtime_provider_operations
         (id, allocation_id, provider_kind, operation_kind,
          location_attempt, provider_operation_id, request_id, state, attempt, created_at,
          updated_at)
       VALUES ('operation-g-create', 'allocation-g', 'gcp_compute',
               'create_instance', 1,
               'https://compute.googleapis.com/compute/v1/projects/project-g/zones/europe-west3-a/operations/create-1',
               'request-g-create', 'running', 1, ?, ?)`,
    )
      .bind(START, START)
      .run();
    await confirmProviderResourceDisappearance({
      allocationId: "allocation-g",
      locationAttempt: 1,
      resourceKind: "instance",
      now: START + 30_000,
    });
    const transientAbsence = await env.DB.prepare(
      `SELECT disappearance_confirmed_at FROM runtime_provider_resources
       WHERE allocation_id = ? AND resource_kind = 'instance'`,
    )
      .bind("allocation-g")
      .first<{ disappearance_confirmed_at: number | null }>();
    expect(transientAbsence?.disappearance_confirmed_at).toBeNull();
    await env.DB.prepare(
      `UPDATE runtime_provider_operations
       SET state = 'succeeded', completed_at = ?, updated_at = ?
       WHERE id = 'operation-g-create'`,
    )
      .bind(START + 45_000, START + 45_000)
      .run();

    const instanceGoneAt = START + 60_000;
    await confirmProviderResourceDisappearance({
      allocationId: "allocation-g",
      locationAttempt: 1,
      resourceKind: "instance",
      now: instanceGoneAt,
    });
    await confirmProviderResourceDisappearance({
      allocationId: "allocation-g",
      locationAttempt: 1,
      resourceKind: "ipv4",
      now: instanceGoneAt,
    });
    await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: instanceGoneAt,
    });

    const active = await env.DB.prepare(
      `SELECT resource_kind FROM runtime_provider_resources
       WHERE allocation_id = ? AND disappearance_confirmed_at IS NULL
       ORDER BY resource_kind`,
    )
      .bind("allocation-g")
      .all<{ resource_kind: string }>();
    expect(active.results.map((row) => row.resource_kind)).toEqual(["boot_disk"]);
    const openLedger = await env.DB.prepare(
      `SELECT resource_kind FROM runtime_provider_cost_ledger
       WHERE allocation_id = ? AND deletion_confirmed_at IS NULL
       ORDER BY resource_kind`,
    )
      .bind("allocation-g")
      .all<{ resource_kind: string }>();
    expect(openLedger.results.map((row) => row.resource_kind)).toEqual(["boot_disk"]);
    const allocation = await env.DB.prepare(
      "SELECT external_ipv4 FROM runtime_provider_allocations WHERE id = ?",
    )
      .bind("allocation-g")
      .first<{ external_ipv4: string | null }>();
    expect(allocation?.external_ipv4).toBeNull();

    await confirmProviderResourceDisappearance({
      allocationId: "allocation-g",
      locationAttempt: 1,
      resourceKind: "boot_disk",
      now: START + 120_000,
    });
    await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: START + 120_000,
    });
    const stillOpen = await env.DB.prepare(
      `SELECT count(*) AS count FROM runtime_provider_cost_ledger
       WHERE allocation_id = ? AND deletion_confirmed_at IS NULL`,
    )
      .bind("allocation-g")
      .first<{ count: number }>();
    expect(stillOpen?.count).toBe(0);
  });

  it("deletes a degraded learner with cleanup-only authority while retaining slot and cost until confirmation", async () => {
    await seedLearnerRuntime("gcp_compute");
    await insertPriceObservation({
      providerKind: "gcp_compute",
      observationId: "price-g-cleanup",
      forecastId: "forecast-g-cleanup",
      version: 1,
      lines: [
        line(
          "gcp-core",
          "compute_core",
          "tax_excluded_public_list",
          36_000_000,
          4,
        ),
      ],
    });
    await insertLearnerAllocation(
      "gcp_compute",
      "price-g-cleanup",
      "forecast-g-cleanup",
    );
    await insertResources("gcp_compute", [
      ["resource-instance-g-cleanup", "instance", "instance-cleanup", START + 1_000],
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provider_connections
         SET state = 'rotation_required', updated_at = ?
         WHERE id = 'connection-g'`,
      ).bind(START),
      env.DB.prepare(
        `INSERT INTO provider_credential_versions
           (id, connection_id, version, authority, algorithm, kek_version,
            aad_sha256, encrypted_payload_b64, payload_iv_b64,
            wrapped_dek_b64, dek_iv_b64, credential_fingerprint, created_by,
            activated_at, created_at)
         VALUES ('credential-g-cleanup', 'connection-g', 1, 'cleanup_only',
                 'AES-256-GCM', 'v1', ?, 'payload', 'payload-iv', 'dek',
                 'dek-iv', 'fingerprint-cleanup', 'user-g', ?, ?)`,
      ).bind("a".repeat(64), START, START),
      env.DB.prepare(
        `UPDATE provider_connections
         SET active_credential_version_id = 'credential-g-cleanup'
         WHERE id = 'connection-g'`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_checkpoint_bundles
           (id, template_revision_id, checkpoint_id, format, r2_key, sha256,
            size_bytes, compression, signature_b64, signing_key_id,
            workspace_agent_sha256, kino_sha256, created_at)
         VALUES ('bundle-g-cleanup', 'revision-g', 'checkpoint-00',
                 'direct_cloud_linux_x86_64_v1', 'checkpoint-00.tar.zst', ?,
                 1, 'zstd', ?, 'test-key', ?, ?, ?)`,
      ).bind(
        "b".repeat(64),
        "A".repeat(88),
        "c".repeat(64),
        "d".repeat(64),
        START,
      ),
      env.DB.prepare(
        `UPDATE runtime_executions
         SET checkpoint_id = 'checkpoint-00', updated_at = ?
         WHERE id = 'execution-g'`,
      ).bind(START),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'degraded', last_report_at = ?, updated_at = ?
         WHERE id = 'allocation-g'`,
      ).bind(START, START),
      env.DB.prepare(
        `INSERT INTO runtime_provider_reconciliation
           (allocation_id, desired_state, observed_state, sweep_after, updated_at)
         VALUES ('allocation-g', 'ready', 'degraded', 0, ?)`,
      ).bind(START),
      env.DB.prepare(
        `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
         VALUES ('user-g', 'execution-g', ?)`,
      ).bind(START),
    ]);
    await reconcileProviderCostLedger({
      allocationId: "allocation-g",
      now: START + 2_000,
    });
    providerMocks.runOperation.mockResolvedValue({
      canonicalWrites: [],
      data: {},
    });
    const cleanupRequestedAt = START + 100_000;

    await expect(
      sweepWorkshopProviderRuntimes({ now: cleanupRequestedAt, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });
    expect(providerMocks.runOperation).toHaveBeenCalledTimes(1);
    expect(providerMocks.runOperation.mock.calls[0]?.[0]).toMatchObject({
      operation: {
        kind: "delete_instance",
        instanceName: "intar-g",
        ownership: {
          purpose: "learner_workspace",
          workspaceRef: "workspace-g",
        },
      },
    });
    const pending = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.deletion_requested_at,
              allocation.deletion_confirmed_at,
              execution.state AS execution_state,
              reconciliation.desired_state,
              reconciliation.observed_state,
              reconciliation.consecutive_failures,
              slot.execution_id AS slot_execution_id,
              ledger.deletion_confirmed_at AS ledger_deleted_at,
              ledger.final_cost_nanos
       FROM runtime_provider_allocations allocation
       JOIN runtime_executions execution ON execution.id = allocation.execution_id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       LEFT JOIN active_runtime_slots slot ON slot.execution_id = execution.id
       JOIN runtime_provider_cost_ledger ledger
         ON ledger.allocation_id = allocation.id
       WHERE allocation.id = 'allocation-g'`,
    ).first<Record<string, string | number | null>>();
    expect(pending).toMatchObject({
      allocation_state: "cleanup_pending",
      deletion_requested_at: cleanupRequestedAt,
      deletion_confirmed_at: null,
      execution_state: "failed",
      desired_state: "deleted",
      observed_state: "cleanup_only_credential",
      consecutive_failures: 0,
      slot_execution_id: "execution-g",
      ledger_deleted_at: null,
      final_cost_nanos: null,
    });

    const deletionConfirmedAt = cleanupRequestedAt + 10_000;
    await env.DB.prepare(
      `UPDATE runtime_provider_resources
       SET provider_state = 'deleted', disappearance_confirmed_at = ?,
           updated_at = ?
       WHERE allocation_id = 'allocation-g'`,
    ).bind(deletionConfirmedAt, deletionConfirmedAt).run();
    await expect(
      sweepWorkshopProviderRuntimes({ now: deletionConfirmedAt, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, deleted: 1 });
    const completed = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.deletion_confirmed_at,
              execution.state AS execution_state,
              (SELECT count(*) FROM active_runtime_slots
               WHERE execution_id = execution.id) AS active_slots,
              ledger.deletion_confirmed_at AS ledger_deleted_at,
              ledger.final_cost_nanos
       FROM runtime_provider_allocations allocation
       JOIN runtime_executions execution ON execution.id = allocation.execution_id
       JOIN runtime_provider_cost_ledger ledger
         ON ledger.allocation_id = allocation.id
       WHERE allocation.id = 'allocation-g'`,
    ).first<Record<string, string | number | null>>();
    expect(completed).toMatchObject({
      allocation_state: "deleted",
      deletion_confirmed_at: deletionConfirmedAt,
      execution_state: "archived",
      active_slots: 0,
      ledger_deleted_at: deletionConfirmedAt,
      final_cost_nanos: expect.any(Number),
    });
  });
});

type ProviderKind = "hetzner_cloud" | "gcp_compute";

async function seedLearnerRuntime(
  providerKind: ProviderKind,
  diskMib = 32_768,
  profileLocations?: string[],
  approvedLocations?: string[],
): Promise<void> {
  const suffix = providerKind === "hetzner_cloud" ? "h" : "g";
  const location =
    providerKind === "hetzner_cloud" ? "nbg1" : "europe-west3-a";
  const machineType = providerKind === "hetzner_cloud" ? "cpx42" : "e2-standard-4";
  const declaredLocations = profileLocations ?? [location];
  const connectionLocations = approvedLocations ?? declaredLocations;
  const manifest = JSON.stringify({
    formatVersion: 2,
    durationMinutes: 240,
    workspace: { leaseGraceMinutes: 60 },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, 'Learner', ?, 1, ?, ?)`,
    ).bind(`user-${suffix}`, `learner-${suffix}@example.test`, START, START),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES (?, 'Workshop Org', ?, ?)`,
    ).bind(`org-${suffix}`, `org-${suffix}`, START),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(`member-${suffix}`, `org-${suffix}`, `user-${suffix}`, START),
    env.DB.prepare(
      `INSERT INTO workshop_templates
         (id, organization_id, slug, title, summary, created_by, created_at, updated_at)
       VALUES (?, ?, 'cost-workshop', 'Cost Workshop', 'Cost test', ?, ?, ?)`,
    ).bind(`template-${suffix}`, `org-${suffix}`, `user-${suffix}`, START, START),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions
         (id, template_id, revision, source_revision, content_hash,
          manifest_json, published_by, published_at)
       VALUES (?, ?, 1, 'source', ?, ?, ?, ?)`,
    ).bind(
      `revision-${suffix}`,
      `template-${suffix}`,
      suffix.repeat(64),
      manifest,
      `user-${suffix}`,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO provider_connections
         (id, organization_id, provider_kind, display_name, state,
          external_project_id, project_fingerprint, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Test provider', 'active', ?, ?, ?, ?, ?)`,
    ).bind(
      `connection-${suffix}`,
      `org-${suffix}`,
      providerKind,
      `project-${suffix}`,
      `fingerprint-${suffix}`,
      `user-${suffix}`,
      START,
      START,
    ),
    providerKind === "hetzner_cloud"
      ? env.DB.prepare(
          `INSERT INTO hetzner_connection_details
             (connection_id, sentinel_firewall_id, approved_locations_json,
              max_concurrent_allocations, native_currency, ipv4_enabled,
              updated_at)
           VALUES (?, 'firewall-test', ?, 5, 'EUR', 1, ?)`,
        ).bind(
          `connection-${suffix}`,
          JSON.stringify(connectionLocations),
          START,
        )
      : env.DB.prepare(
          `INSERT INTO gcp_connection_details
             (connection_id, project_number, network_name, network_self_link,
              subnet_name, subnet_self_link, subnet_cidr, firewall_name,
              firewall_self_link, approved_zones_json,
              max_concurrent_allocations, updated_at)
           VALUES (?, '123456789', 'intar', 'networks/intar',
                   'intar-europe-west3', 'subnetworks/intar-europe-west3',
                   '10.64.0.0/20', 'intar-ssh', 'firewalls/intar-ssh', ?, 5, ?)`,
        ).bind(
          `connection-${suffix}`,
          JSON.stringify(connectionLocations),
          START,
        ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          machine_type, system_image, resolved_image_id, root_disk_type,
          architecture, cpu_millis, memory_mib, disk_mib, locations_json,
          configuration_json, created_at)
       VALUES (?, ?, ?, ?, 'learner', ?, 'debian-13', ?, ?, 'x86_64',
               4000, 16384, ?, ?, '{}', ?)`,
    ).bind(
      `profile-${suffix}`,
      `revision-${suffix}`,
      `profile-${suffix}`,
      providerKind,
      machineType,
      `image-${suffix}`,
      providerKind === "gcp_compute" ? "pd-balanced" : null,
      diskMib,
      JSON.stringify(declaredLocations),
      START,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_sessions
         (id, organization_id, template_revision_id, title, state, version,
          scheduled_start_at, lobby_opens_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Cost Session', 'live', 1, ?, ?, ?, ?, ?)`,
    ).bind(
      `session-${suffix}`,
      `org-${suffix}`,
      `revision-${suffix}`,
      START + HOUR_MS,
      START,
      `user-${suffix}`,
      START,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_session_runtime_selections
         (session_id, runtime_profile_id, profile_id, provider_kind,
          connection_id, resolved_profile_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
    ).bind(
      `session-${suffix}`,
      `profile-${suffix}`,
      `profile-${suffix}`,
      providerKind,
      `connection-${suffix}`,
      START,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_session_members
         (id, session_id, user_id, role, provision_state, assigned_by,
          workspace_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'participant', 'ready', ?, 1, ?, ?)`,
    ).bind(
      `session-member-${suffix}`,
      `session-${suffix}`,
      `user-${suffix}`,
      `user-${suffix}`,
      START,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_workspaces
         (id, session_id, user_id, state, current_generation_id,
          created_at, updated_at)
       VALUES (?, ?, ?, 'ready', ?, ?, ?)`,
    ).bind(
      `workspace-${suffix}`,
      `session-${suffix}`,
      `user-${suffix}`,
      `generation-${suffix}`,
      START,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_workspace_generations
         (id, workspace_id, ordinal, state, requested_at, ready_at,
          created_at, updated_at)
       VALUES (?, ?, 1, 'ready', ?, ?, ?, ?)`,
    ).bind(
      `generation-${suffix}`,
      `workspace-${suffix}`,
      START,
      START,
      START,
      START,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_executions
         (id, user_id, organization_id, domain_kind, domain_id, generation,
          state, created_at, updated_at, provider_kind, provider_connection_id)
       VALUES (?, ?, ?, 'workshop', ?, 1, 'ready', ?, ?, ?, ?)`,
    ).bind(
      `execution-${suffix}`,
      `user-${suffix}`,
      `org-${suffix}`,
      `workspace-${suffix}`,
      START,
      START,
      providerKind,
      `connection-${suffix}`,
    ),
    env.DB.prepare(
      `UPDATE workshop_workspace_generations
       SET runtime_execution_id = ? WHERE id = ?`,
    ).bind(`execution-${suffix}`, `generation-${suffix}`),
  ]);
}

async function insertLearnerAllocation(
  providerKind: ProviderKind,
  priceObservationId: string,
  costForecastId: string,
): Promise<void> {
  const suffix = providerKind === "hetzner_cloud" ? "h" : "g";
  const location =
    providerKind === "hetzner_cloud" ? "nbg1" : "europe-west3-a";
  const machineType =
    providerKind === "hetzner_cloud" ? "cpx42" : "e2-standard-4";
  await env.DB.prepare(
    `INSERT INTO runtime_provider_allocations
       (id, execution_id, connection_id, runtime_profile_id,
        price_observation_id, cost_forecast_id, provider_kind,
        deterministic_name, machine_type, resolved_image_id,
        location_attempts_json, location, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json_array(?), ?, 'ready', ?, ?)`,
  )
    .bind(
      `allocation-${suffix}`,
      `execution-${suffix}`,
      `connection-${suffix}`,
      `profile-${suffix}`,
      priceObservationId,
      costForecastId,
      providerKind,
      `intar-${suffix}`,
      machineType,
      `image-${suffix}`,
      location,
      location,
      START,
      START,
    )
    .run();
}

function line(
  sku: string,
  resourceKind: string,
  taxTreatment: "provider_net" | "provider_gross" | "tax_excluded_public_list",
  priceNanos: number,
  quantity = 1,
  unit: "hour" | "gib_month" = "hour",
) {
  return { sku, resourceKind, taxTreatment, priceNanos, quantity, unit };
}

async function insertPriceObservation(input: {
  providerKind: ProviderKind;
  observationId: string;
  forecastId: string;
  version: number;
  lines: ReturnType<typeof line>[];
  includeScenarioRows?: boolean;
}): Promise<void> {
  const suffix = input.providerKind === "hetzner_cloud" ? "h" : "g";
  const location = input.providerKind === "hetzner_cloud" ? "nbg1" : "europe-west3-a";
  const currency = input.providerKind === "hetzner_cloud" ? "EUR" : "USD";
  await insertStandalonePriceObservation(input);
  await env.DB.prepare(
    `INSERT INTO workshop_session_cost_forecasts
       (id, session_id, version, price_observation_id, provider_kind,
        currency, participant_count, trigger, expected_cost_nanos,
        lease_ceiling_cost_nanos, one_restore_cost_nanos,
        assumptions_json, exclusions_json, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'session_created', 100000000,
             200000000, 300000000, '[]', '[]', ?, ?, ?)`,
  )
    .bind(
      input.forecastId,
      `session-${suffix}`,
      input.version,
      input.observationId,
      input.providerKind,
      currency,
      START + 24 * HOUR_MS,
      `user-${suffix}`,
      START + input.version,
    )
    .run();
  if (!input.includeScenarioRows) return;
  const scenario = {
    location,
    participantCount: 1,
    generationLifetimeSeconds: [3600],
    perLearnerCostNanos: 100_000_000,
    totalCostNanos: 100_000_000,
    providerNetCostNanos: null,
    providerGrossCostNanos: null,
    taxExcludedListCostNanos: 100_000_000,
    lineItems: [],
  };
  await env.DB.batch(
    (["expected", "lease_ceiling", "one_restore"] as const).map((name) =>
      env.DB.prepare(
        `INSERT INTO workshop_session_cost_forecast_line_items
           (id, forecast_id, price_line_item_id, scenario, participant_count,
            generation_count, lifetime_seconds, billed_quantity_nanos,
            calculated_cost_nanos, calculation_json)
         VALUES (?, ?, ?, ?, 1, 1, 3600, 1000000000, 100000000, ?)`,
      ).bind(
        `${input.forecastId}-${name}`,
        input.forecastId,
        `${input.observationId}-line-0`,
        name,
        JSON.stringify({ scenario }),
      ),
    ),
  );
}

async function insertStandalonePriceObservation(input: {
  providerKind: ProviderKind;
  observationId: string;
  lines: ReturnType<typeof line>[];
}): Promise<void> {
  const suffix = input.providerKind === "hetzner_cloud" ? "h" : "g";
  const location =
    input.providerKind === "hetzner_cloud" ? "nbg1" : "europe-west3-a";
  const currency = input.providerKind === "hetzner_cloud" ? "EUR" : "USD";
  const priceStatements = input.lines.map((price, index) =>
    env.DB.prepare(
      `INSERT INTO provider_price_line_items
         (id, observation_id, sku, resource_kind, location, raw_price,
          price_nanos, unit, quantity_nanos, billing_increment_seconds,
          minimum_duration_seconds, tax_treatment, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(
      `${input.observationId}-line-${index}`,
      input.observationId,
      price.sku,
      price.resourceKind,
      location,
      String(price.priceNanos / 1_000_000_000),
      price.priceNanos,
      price.unit,
      price.quantity * 1_000_000_000,
      input.providerKind === "hetzner_cloud" ? 3600 : 1,
      input.providerKind === "hetzner_cloud" ? 3600 : price.resourceKind.startsWith("compute_") ? 60 : 1,
      price.taxTreatment,
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO provider_price_observations
         (id, provider_kind, connection_id, runtime_profile_id, currency,
          source, raw_observation_json, observed_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'test-catalog', '{}', ?, ?, ?)`,
    ).bind(
      input.observationId,
      input.providerKind,
      `connection-${suffix}`,
      `profile-${suffix}`,
      currency,
      START,
      START + 24 * HOUR_MS,
      START,
    ),
    ...priceStatements,
  ]);
}

async function insertResources(
  providerKind: ProviderKind,
  resources: Array<[
    id: string,
    kind: "instance" | "boot_disk" | "ipv4" | "ssh_key",
    providerId: string,
    createdAt: number,
  ]>,
  allocationId?: string,
): Promise<void> {
  const suffix = providerKind === "hetzner_cloud" ? "h" : "g";
  const location =
    providerKind === "hetzner_cloud" ? "nbg1" : "europe-west3-a";
  await env.DB.batch(
    resources.map(([id, kind, providerId, createdAt]) =>
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources
           (id, allocation_id, provider_kind, resource_kind,
            provider_resource_id, location_attempt, location,
            provider_state, configuration_json,
            provider_created_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'present', '{}', ?, ?, ?)`,
      ).bind(
        id,
        allocationId ?? `allocation-${suffix}`,
        providerKind,
        kind,
        providerId,
        location,
        createdAt,
        createdAt,
        createdAt,
      ),
    ),
  );
}

async function ledgerIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM runtime_provider_cost_ledger ORDER BY id",
  ).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
