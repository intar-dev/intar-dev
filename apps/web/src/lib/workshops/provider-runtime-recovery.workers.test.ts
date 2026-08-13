import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetDatabase } from "@/test/database-migrations";
import { handleWorkspaceAgentControlPlaneRequest } from "@/control-plane/workspace-agent";

const mocks = vi.hoisted(() => ({ invokeProviderOperation: vi.fn() }));
const REPORT_CREDENTIAL = "certification-report-credential-0001";
const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";
const BOOT_C = "33333333-3333-4333-8333-333333333333";

vi.mock("./provider-service", () => ({
  invokeProviderOperation: mocks.invokeProviderOperation,
}));
import {
  classifyProviderAllocationFailure,
  classifyProviderOperationFailure,
  certificationRuntimeDurationMs,
  confirmProviderResourceDisappearance,
  hetznerResourceKindForReconcile,
  initialProviderReadinessTimedOut,
  nextProviderOperationLogicalOrdinal,
  providerLocationFallbackBootstrapEligible,
  recordProviderOperationObservation,
  shouldDiscoverHetznerCreateBeforeRetry,
  sweepWorkshopProviderRuntimes,
} from "./provider-runtime";
import { reconcileProviderCostLedger } from "./provider-cost-ledger";
import { loadDeferredWorkshopRuntimeReplacementCandidates } from "./runtime-orchestrator";

beforeEach(async () => {
  await resetDatabase();
  vi.clearAllMocks();
  mocks.invokeProviderOperation.mockResolvedValue({
    canonicalWrites: [],
    data: {},
  });
});

describe("provider runtime recovery", () => {
  it("translates provider-neutral resource kinds before Hetzner reconciliation", () => {
    expect(hetznerResourceKindForReconcile("instance")).toBe("server");
    expect(hetznerResourceKindForReconcile("ipv4")).toBe("primary_ip");
    expect(hetznerResourceKindForReconcile("ssh_key")).toBe("ssh_key");
    expect(() => hetznerResourceKindForReconcile("boot_disk")).toThrow(
      /unsupported resource kind/u,
    );
  });

  it("repairs false Hetzner disappearance before cumulative verifier reboot and deletion", async () => {
    await seedFalseDisappearedHetznerCertification();
    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-01",
      bootId: BOOT_B,
      completedModuleIds: ["00", "01"],
      probeIds: ["probe-00", "probe-01"],
      receivedAt: 100,
      providerKind: "hetzner_cloud",
    });
    const firstProvider = installPresentHetznerProviderMock();
    await makeCertificationDue(200);

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });

    expect(firstProvider).toHaveBeenCalledTimes(2);
    const firstReconcile = firstProvider.mock.calls[0]?.[0];
    expect(firstReconcile?.operation).toMatchObject({ kind: "reconcile" });
    expect(
      firstReconcile?.operation.resources
        ?.map((resource) => resource.resourceKind)
        .sort(),
    ).toEqual(["primary_ip", "server", "ssh_key"]);
    expect(
      firstReconcile?.operation.resources?.every(
        (resource) =>
          resource.ownership.workshopPublicationRef === "publication" &&
          resource.ownership.checkpointRef === "checkpoint-00",
      ),
    ).toBe(true);
    expect(firstProvider.mock.calls[1]?.[0]?.operation).toMatchObject({
      kind: "reboot_server",
      serverId: 158742066,
      deterministicName: "intar-certification",
      ownership: {
        workshopPublicationRef: "publication",
        checkpointRef: "checkpoint-00",
      },
    });
    await expectHetznerResourcesPresent();
    await expectCertificationEvidence({
      phase: "awaiting_reboot_completion",
      currentCheckpointOrdinal: 1,
    });

    // Reproduce the stale local disappearance once more at teardown. The
    // adapter must observe and restore all identities before choosing which
    // provider resources to delete.
    await markHetznerResourcesFalselyDisappeared(300);
    await setCertificationPhase("deleting", 300);
    vi.clearAllMocks();
    const deleteProvider = installPresentHetznerProviderMock();
    await makeCertificationDue(300);
    await expect(
      sweepWorkshopProviderRuntimes({ now: 300, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });

    const operations = deleteProvider.mock.calls.map(
      ([request]) => request.operation,
    );
    expect(operations[0]).toMatchObject({ kind: "reconcile" });
    expect(
      operations.filter((operation) => operation.kind === "delete_resource"),
    ).toEqual([
      expect.objectContaining({
        resourceKind: "server",
        externalId: 158742066,
        deterministicName: "intar-certification",
        ownership: expect.objectContaining({
          workshopPublicationRef: "publication",
          checkpointRef: "checkpoint-00",
        }),
      }),
      expect.objectContaining({
        resourceKind: "ssh_key",
        externalId: 116370220,
        deterministicName: "intar-certification-ssh",
        ownership: expect.objectContaining({
          workshopPublicationRef: "publication",
          checkpointRef: "checkpoint-00",
        }),
      }),
    ]);
    expect(operations.at(-1)).toMatchObject({ kind: "reconcile" });
    for (const operation of [operations[0], operations.at(-1)]) {
      expect(
        operation?.resources?.every(
          (resource) => resource.ownership.checkpointRef === "checkpoint-00",
        ),
      ).toBe(true);
    }
  });

  it("uses attempt order while waiting to delete a Hetzner Primary IP", async () => {
    await seedFalseDisappearedHetznerCertification();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_runtime_profile_certifications
         SET state = 'cleanup_pending', error_code = 'test_cleanup', updated_at = 200
         WHERE id = 'certification'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'cleanup_pending', last_error_code = 'test_cleanup',
             deletion_requested_at = 200, updated_at = 200
         WHERE id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_reconciliation
         SET desired_state = 'deleted', observed_state = 'cleanup_pending',
             sweep_after = 0, claim_id = NULL, claim_expires_at = NULL,
             updated_at = 200
         WHERE allocation_id = 'cert-allocation'`,
      ),
    ]);
    const provider = installStatefulHetznerCleanupMock();

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1, deleted: 0 });

    expect(
      provider.deleteOperations().map((operation) => operation.resourceKind),
    ).toEqual(["server", "ssh_key"]);
    const invertedReconcileOrder = await env.DB.prepare(
      `UPDATE runtime_provider_operations
       SET created_at = CASE attempt WHEN 1 THEN 250 ELSE 200 END
       WHERE allocation_id = 'cert-allocation'
         AND operation_kind = 'reconcile' AND attempt IN (1, 2)`,
    ).run();
    expect(invertedReconcileOrder.meta.changes).toBe(2);
    provider.completeServerDeletion();
    await env.DB.prepare(
      `UPDATE runtime_provider_reconciliation
       SET sweep_after = 0, claim_id = NULL, claim_expires_at = NULL,
           updated_at = 300
       WHERE allocation_id = 'cert-allocation'`,
    ).run();

    await expect(
      sweepWorkshopProviderRuntimes({ now: 300, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 0, deleted: 1 });
    expect(
      provider.deleteOperations().map((operation) => operation.resourceKind),
    ).toEqual(["server", "ssh_key", "primary_ip"]);

    const cleanup = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.deletion_confirmed_at,
              certification.state AS certification_state,
              certification.deletion_confirmed_at AS certification_deleted_at,
              execution.state AS execution_state,
              (SELECT count(*) FROM runtime_provider_resources resource
               WHERE resource.allocation_id = allocation.id
                 AND resource.disappearance_confirmed_at IS NULL) AS present_resources
       FROM runtime_provider_allocations allocation
       JOIN workshop_runtime_profile_certifications certification
         ON certification.verifier_allocation_id = allocation.id
       JOIN runtime_executions execution ON execution.id = allocation.execution_id
       WHERE allocation.id = 'cert-allocation'`,
    ).first<Record<string, string | number | null>>();
    expect(cleanup).toMatchObject({
      allocation_state: "deleted",
      deletion_confirmed_at: 300,
      certification_state: "failed",
      certification_deleted_at: 300,
      execution_state: "archived",
      present_resources: 0,
    });
  });

  it("does not let an expired delete action block resources already proven absent", async () => {
    await seedFalseDisappearedHetznerCertification();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_runtime_profile_certifications
         SET state = 'cleanup_pending', error_code = 'test_cleanup', updated_at = 200
         WHERE id = 'certification'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'cleanup_pending', last_error_code = 'test_cleanup',
             deletion_requested_at = 200, updated_at = 200
         WHERE id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_reconciliation
         SET desired_state = 'deleted', observed_state = 'cleanup_pending',
             sweep_after = 0, updated_at = 200
         WHERE allocation_id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_operations
           (id, allocation_id, provider_kind, operation_kind, location_attempt,
            provider_operation_id, request_id, state, attempt, created_at, updated_at)
         VALUES ('stale-delete', 'cert-allocation', 'hetzner_cloud',
                 'delete_server', 1, '987654', 'stale-delete-request',
                 'running', 1, 100, 100)`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_operations
           (id, allocation_id, provider_kind, operation_kind, location_attempt,
            provider_operation_id, request_id, state, attempt, created_at, updated_at)
         VALUES ('stale-delete-action', 'cert-allocation', 'hetzner_cloud',
                 'delete_server:provider-operation', 1, '987655',
                 'stale-delete-action-request', 'retryable', 1, 100, 100)`,
      ),
    ]);
    const runOperation = vi.fn(async (request: TestHetznerRequest) => {
      expect(request.operation).toMatchObject({ kind: "reconcile", actionIds: [] });
      const resources = request.operation.resources ?? [];
      return {
        canonicalWrites: resources.map((resource) => ({
          requestId: request.requestId,
          connectionId: request.connectionId,
          operation: "resource_deleted",
          resourceKind: resource.resourceKind,
          externalId: resource.externalId,
          name: resource.deterministicName,
          state: "deleted",
        })),
        data: { resources: resources.map(() => ({ status: "missing" })) },
      };
    });
    mocks.invokeProviderOperation.mockImplementation(
      async (
        providerKind: string,
        invoke: (binding: { runOperation: typeof runOperation }) => Promise<unknown>,
      ) => {
        expect(providerKind).toBe("hetzner_cloud");
        return invoke({ runOperation });
      },
    );

    await expect(
      sweepWorkshopProviderRuntimes({ now: 300, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 0, deleted: 1 });
    expect(runOperation).toHaveBeenCalledTimes(2);
    expect(
      runOperation.mock.calls.every(
        ([request]) => request.operation.kind === "reconcile",
      ),
    ).toBe(true);
    const operations = await env.DB.prepare(
      `SELECT id, state, retry_at, completed_at, error_class, error_code,
              json_extract(sanitized_result_json, '$.confirmedAbsent') AS confirmed_absent
       FROM runtime_provider_operations
       WHERE id IN ('stale-delete', 'stale-delete-action')
       ORDER BY id`,
    ).all<{
      id: string;
      state: string;
      retry_at: number | null;
      completed_at: number | null;
      error_class: string | null;
      error_code: string | null;
      confirmed_absent: number | null;
    }>();
    expect(operations.results).toEqual([
      {
        id: "stale-delete",
        state: "succeeded",
        retry_at: null,
        completed_at: 300,
        error_class: null,
        error_code: null,
        confirmed_absent: 1,
      },
      {
        id: "stale-delete-action",
        state: "succeeded",
        retry_at: null,
        completed_at: 300,
        error_class: null,
        error_code: null,
        confirmed_absent: 1,
      },
    ]);
  });

  it("keeps delete operations open while their exact provider resource remains present", async () => {
    await seedFalseDisappearedHetznerCertification();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_runtime_profile_certifications
         SET state = 'cleanup_pending', error_code = 'test_cleanup', updated_at = 200
         WHERE id = 'certification'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'cleanup_pending', last_error_code = 'test_cleanup',
             deletion_requested_at = 200, updated_at = 200
         WHERE id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_reconciliation
         SET desired_state = 'deleted', observed_state = 'cleanup_pending',
             sweep_after = 0, updated_at = 200
         WHERE allocation_id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_operations
           (id, allocation_id, provider_kind, operation_kind, location_attempt,
            provider_operation_id, request_id, state, attempt, retry_at,
            error_class, error_code, created_at, updated_at)
         VALUES ('live-target-delete', 'cert-allocation', 'hetzner_cloud',
                 'delete_server', 1, '987654', 'live-target-delete-request',
                 'running', 1, 0, 'provider', 'action_pending', 100, 100)`,
      ),
    ]);
    installPresentHetznerProviderMock();

    await expect(
      sweepWorkshopProviderRuntimes({ now: 300, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1, deleted: 0 });

    const operation = await env.DB.prepare(
      `SELECT operation.state, operation.completed_at,
              json_extract(operation.sanitized_result_json, '$.confirmedAbsent') AS confirmed_absent,
              resource.disappearance_confirmed_at
       FROM runtime_provider_operations operation
       JOIN runtime_provider_resources resource
         ON resource.allocation_id = operation.allocation_id
        AND resource.location_attempt = operation.location_attempt
        AND resource.resource_kind = 'instance'
       WHERE operation.id = 'live-target-delete'`,
    ).first<{
      state: string;
      completed_at: number | null;
      confirmed_absent: number | null;
      disappearance_confirmed_at: number | null;
    }>();
    expect(operation).toEqual({
      state: "running",
      completed_at: null,
      confirmed_absent: null,
      disappearance_confirmed_at: null,
    });
  });

  it("trusts confirmed resource absence over a conflicting failed delete action", async () => {
    await seedFalseDisappearedHetznerCertification();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_runtime_profile_certifications
         SET state = 'cleanup_pending', error_code = 'test_cleanup', updated_at = 200
         WHERE id = 'certification'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET state = 'cleanup_pending', last_error_code = 'test_cleanup',
             deletion_requested_at = 200, updated_at = 200
         WHERE id = 'cert-allocation'`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_reconciliation
         SET desired_state = 'deleted', observed_state = 'cleanup_pending',
             sweep_after = 0, updated_at = 200
         WHERE allocation_id = 'cert-allocation'`,
      ),
    ]);
    let reconcileCount = 0;
    const ids = {
      server: 158742066,
      primary_ip: 143328111,
      ssh_key: 116370220,
    } as const;
    const runOperation = vi.fn(async (request: TestHetznerRequest) => {
      if (request.operation.kind === "reconcile") {
        const resources = request.operation.resources ?? [];
        const present = reconcileCount++ === 0;
        return {
          canonicalWrites: resources.map((resource) => ({
            requestId: request.requestId,
            connectionId: request.connectionId,
            observedAt: new Date(300).toISOString(),
            operation: present ? "resource_observed" : "resource_deleted",
            resourceKind: resource.resourceKind,
            externalId: ids[resource.resourceKind],
            name: resource.deterministicName,
            actionIds: [],
            state: present ? "running" : "deleted",
            ...(present && resource.resourceKind === "primary_ip"
              ? { publicIpv4: "192.0.2.42" }
              : {}),
          })),
          data: {
            resources: resources.map(() => ({
              status: present ? "present" : "missing",
            })),
          },
        };
      }
      if (request.operation.kind !== "delete_resource") {
        return { canonicalWrites: [], data: {} };
      }
      const resourceKind = request.operation.resourceKind as
        | "server"
        | "primary_ip"
        | "ssh_key";
      return {
        canonicalWrites: [
          {
            requestId: request.requestId,
            connectionId: request.connectionId,
            observedAt: new Date(300).toISOString(),
            operation: "resource_deleted",
            resourceKind,
            externalId: ids[resourceKind],
            name: request.operation.deterministicName,
            actionIds: [],
            state: "deleted",
          },
          ...(resourceKind === "server"
            ? [
                {
                  requestId: request.requestId,
                  connectionId: request.connectionId,
                  observedAt: new Date(300).toISOString(),
                  operation: "action_observed",
                  resourceKind: "action",
                  externalId: 987654,
                  actionIds: [987654],
                  state: "error",
                  errorCode: "action_not_found",
                },
              ]
            : []),
        ],
        data: {},
      };
    });
    mocks.invokeProviderOperation.mockImplementation(
      async (
        providerKind: string,
        invoke: (binding: { runOperation: typeof runOperation }) => Promise<unknown>,
      ) => {
        expect(providerKind).toBe("hetzner_cloud");
        return invoke({ runOperation });
      },
    );

    await expect(
      sweepWorkshopProviderRuntimes({ now: 300, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 0, deleted: 1 });

    const state = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              operation.state AS operation_state,
              operation.error_code,
              json_extract(operation.sanitized_result_json, '$.confirmedAbsent') AS confirmed_absent
       FROM runtime_provider_allocations allocation
       JOIN runtime_provider_operations operation
         ON operation.allocation_id = allocation.id
        AND operation.operation_kind = 'delete_server'
       WHERE allocation.id = 'cert-allocation'`,
    ).first<{
      allocation_state: string;
      operation_state: string;
      error_code: string | null;
      confirmed_absent: number | null;
    }>();
    expect(state).toEqual({
      allocation_state: "deleted",
      operation_state: "succeeded",
      error_code: null,
      confirmed_absent: 1,
    });
  });

  it("fails closed when Hetzner reconciliation omits a requested verifier resource", async () => {
    await seedFalseDisappearedHetznerCertification();
    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-01",
      bootId: BOOT_B,
      completedModuleIds: ["00", "01"],
      probeIds: ["probe-00", "probe-01"],
      receivedAt: 100,
      providerKind: "hetzner_cloud",
    });
    await setCertificationPhase("deleting", 200);
    const provider = installUncoveredHetznerProviderMock();
    await makeCertificationDue(200);

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 1, pending: 0 });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[0]?.operation).toMatchObject({
      kind: "reconcile",
    });
    const lifecycle = await env.DB.prepare(
      `SELECT allocation.state, allocation.deletion_requested_at,
              allocation.deletion_confirmed_at, certification.state AS certification_state,
              json_extract(certification.evidence_json, '$.phase') AS certification_phase
       FROM runtime_provider_allocations allocation
       JOIN workshop_runtime_profile_certifications certification
         ON certification.verifier_allocation_id = allocation.id
       WHERE allocation.id = 'cert-allocation'`,
    ).first<{
      state: string;
      deletion_requested_at: number | null;
      deletion_confirmed_at: number | null;
      certification_state: string;
      certification_phase: string;
    }>();
    expect(lifecycle).toEqual({
      state: "ready",
      deletion_requested_at: null,
      deletion_confirmed_at: null,
      certification_state: "verifying",
      certification_phase: "deleting",
    });
    const mutations = await env.DB.prepare(
      `SELECT operation_kind FROM runtime_provider_operations
       WHERE allocation_id = 'cert-allocation'
         AND (operation_kind LIKE 'delete_%'
           OR operation_kind LIKE 'certification_reboot_%')`,
    ).all<{ operation_kind: string }>();
    expect(mutations.results).toEqual([]);
  });

  it("keeps a missing GCP ephemeral IPv4 and its ledger closed after a present instance observation", async () => {
    await seedCumulativeCertification();
    await env.DB.batch([
      ...[
        ["gcp-core", "compute_core", 4_000_000_000],
        ["gcp-ram", "compute_ram", 16_000_000_000],
        ["gcp-ip", "external_ipv4", 1_000_000_000],
      ].map(([sku, resourceKind, quantityNanos]) =>
        env.DB.prepare(
          `INSERT INTO provider_price_line_items
             (id, observation_id, sku, resource_kind, location, raw_price,
              price_nanos, unit, quantity_nanos, billing_increment_seconds,
              minimum_duration_seconds, tax_treatment, metadata_json)
           VALUES (?, 'cert-price', ?, ?, 'europe-west3-a', '0.01',
                   10000000, 'hour', ?, 1, 60,
                   'tax_excluded_public_list', '{}')`,
        ).bind(`cert-price-${sku}`, sku, resourceKind, quantityNanos),
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources
           (id, allocation_id, provider_kind, resource_kind,
            provider_resource_id, location_attempt, location, provider_state,
            configuration_json, provider_created_at, created_at, updated_at)
         VALUES ('resource-instance', 'cert-allocation', 'gcp_compute',
                 'instance', 'instance-9001', 1, 'europe-west3-a',
                 'RUNNING', '{"deterministicName":"intar-certification"}',
                 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources
           (id, allocation_id, provider_kind, resource_kind,
            provider_resource_id, location_attempt, location, provider_state,
            configuration_json, provider_created_at, created_at, updated_at)
         VALUES ('resource-ipv4', 'cert-allocation', 'gcp_compute',
                 'ipv4', 'instance-9001:ephemeral-ipv4', 1,
                 'europe-west3-a', 'present',
                 '{"deterministicName":"intar-certification-ipv4","address":"192.0.2.42","lifecycle":"ephemeral_with_instance"}',
                 1, 1, 1)`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET external_ipv4 = '192.0.2.42', updated_at = 1
         WHERE id = 'cert-allocation'`,
      ),
    ]);
    await expect(
      reconcileProviderCostLedger({ allocationId: "cert-allocation", now: 2 }),
    ).resolves.toMatchObject({ inserted: 3, reopened: 0, closed: 0 });
    await confirmProviderResourceDisappearance({
      allocationId: "cert-allocation",
      locationAttempt: 1,
      resourceKind: "ipv4",
      now: 50,
    });
    await expect(
      reconcileProviderCostLedger({ allocationId: "cert-allocation", now: 50 }),
    ).resolves.toMatchObject({ inserted: 0, reopened: 0, closed: 1 });
    await env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET state = 'creating', external_ipv4 = '192.0.2.42', updated_at = 60
       WHERE id = 'cert-allocation'`,
    ).run();
    mocks.invokeProviderOperation.mockResolvedValue({
      canonicalWrites: [
        {
          requestId: "observe-without-ipv4",
          connectionId: "connection",
          observedAt: new Date(100).toISOString(),
          operation: "resource_observed",
          resourceKind: "instance",
          externalId: "instance-9001",
          name: "intar-certification",
          operationIds: [],
          state: "RUNNING",
          location: "europe-west3-a",
        },
      ],
      data: { status: "present" },
    });
    await env.DB.prepare(
      `UPDATE runtime_provider_reconciliation
       SET sweep_after = 0, claim_id = NULL, claim_expires_at = NULL,
           updated_at = 100
       WHERE allocation_id = 'cert-allocation'`,
    ).run();

    await expect(
      sweepWorkshopProviderRuntimes({ now: 100, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });
    expect(mocks.invokeProviderOperation).toHaveBeenCalledTimes(1);
    expect(mocks.invokeProviderOperation.mock.calls[0]?.[1]).toBeTypeOf(
      "function",
    );
    const state = await env.DB.prepare(
      `SELECT allocation.external_ipv4, allocation.state AS allocation_state,
              instance.provider_state AS instance_state,
              instance.disappearance_confirmed_at AS instance_disappeared_at,
              ipv4.provider_state AS ipv4_state,
              ipv4.disappearance_confirmed_at AS ipv4_disappeared_at,
              ipv4_ledger.deletion_confirmed_at AS ipv4_ledger_deleted_at,
              ipv4_ledger.final_cost_nanos AS ipv4_final_cost_nanos,
              (SELECT count(*) FROM runtime_provider_cost_ledger ledger
               WHERE ledger.allocation_id = allocation.id
                 AND ledger.resource_kind = 'instance'
                 AND ledger.deletion_confirmed_at IS NULL) AS open_instance_lines
       FROM runtime_provider_allocations allocation
       JOIN runtime_provider_resources instance
         ON instance.allocation_id = allocation.id
        AND instance.resource_kind = 'instance'
       JOIN runtime_provider_resources ipv4
         ON ipv4.allocation_id = allocation.id
        AND ipv4.resource_kind = 'ipv4'
       JOIN runtime_provider_cost_ledger ipv4_ledger
         ON ipv4_ledger.provider_resource_id = ipv4.id
       WHERE allocation.id = 'cert-allocation'`,
    ).first<Record<string, string | number | null>>();
    expect(state).toMatchObject({
      external_ipv4: null,
      allocation_state: "bootstrapping",
      instance_state: "RUNNING",
      instance_disappeared_at: null,
      ipv4_state: "deleted",
      ipv4_disappeared_at: 50,
      ipv4_ledger_deleted_at: 50,
      ipv4_final_cost_nanos: expect.any(Number),
      open_instance_lines: 2,
    });
  });

  it("derives a finite certification window from the checkpoint count", () => {
    expect(certificationRuntimeDurationMs(1)).toBe(4.5 * 60 * 60_000);
    expect(certificationRuntimeDurationMs(11)).toBe(44.5 * 60 * 60_000);
    expect(() => certificationRuntimeDurationMs(0)).toThrow();
    expect(() => certificationRuntimeDurationMs(12)).toThrow();
  });

  it("keeps a cumulative verifier alive beyond the former ninety-minute limit", async () => {
    await seedCumulativeCertification();
    const afterNinetyMinutes = 91 * 60_000;
    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: afterNinetyMinutes,
    });
    await makeCertificationDue(afterNinetyMinutes + 1_000);
    await sweepWorkshopProviderRuntimes({
      now: afterNinetyMinutes + 1_000,
      limit: 10,
    });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_completion",
      currentCheckpointOrdinal: 0,
    });
  });

  it("persists definitive provider errors without retrying them", () => {
    const now = 1_000;
    expect(
      classifyProviderOperationFailure(
        new AppError({
          status: 409,
          code: "provider_quota_invalid",
          message: "quota request is invalid",
        }),
        now,
      ),
    ).toEqual({ state: "failed", retryAt: null, errorClass: "definitive" });
    expect(
      classifyProviderOperationFailure(
        new AppError({
          status: 503,
          code: "runtime_provider_service_unavailable",
          message: "transport response was ambiguous",
        }),
        now,
      ),
    ).toEqual({
      state: "retryable",
      retryAt: 11_000,
      errorClass: "ambiguous_rpc",
    });
  });

  it("reconciles transport ambiguity on the same allocation but never auto-recovers definitive quota or permission failures", () => {
    const now = 50_000;
    expect(
      classifyProviderAllocationFailure(
        new AppError({
          status: 503,
          code: "hcloud_transport_error",
          message: "provider response was ambiguous",
        }),
        now,
      ),
    ).toEqual({
      disposition: "reconcile_same_allocation",
      retryAt: 60_000,
    });
    for (const [status, code] of [
      [403, "provider_permission_denied"],
      [409, "provider_quota_insufficient"],
    ] as const) {
      expect(
        classifyProviderAllocationFailure(
          new AppError({ status, code, message: "definitive provider failure" }),
          now,
        ),
      ).toEqual({
        disposition: "cleanup_manual_retry",
        retryAt: null,
      });
    }
    for (const code of [
      "resource_unavailable",
      "gcp_resource_unavailable",
    ]) {
      expect(
        classifyProviderAllocationFailure(
          new AppError({
            status: 503,
            code,
            message: "the selected location has no capacity",
          }),
          now,
        ),
      ).toEqual({ disposition: "fallback_location", retryAt: null });
    }
  });

  it("bounds initial readiness at fifteen minutes without applying the steady-state heartbeat rule early", () => {
    const createdAt = 1_000;
    expect(
      initialProviderReadinessTimedOut({
        createdAt,
        lastReportAt: null,
        now: createdAt + 15 * 60_000 - 1,
      }),
    ).toBe(false);
    expect(
      initialProviderReadinessTimedOut({
        createdAt,
        lastReportAt: null,
        now: createdAt + 15 * 60_000,
      }),
    ).toBe(true);
    expect(
      initialProviderReadinessTimedOut({
        createdAt,
        lastReportAt: createdAt + 10_000,
        now: createdAt + 30 * 60_000,
      }),
    ).toBe(false);
  });

  it("permits in-generation location fallback only before guest bootstrap consumption", () => {
    expect(
      providerLocationFallbackBootstrapEligible({
        bootstrapConsumedAt: null,
        reportCredentialRevokedAt: null,
      }),
    ).toBe(true);
    expect(
      providerLocationFallbackBootstrapEligible({
        bootstrapConsumedAt: undefined,
        reportCredentialRevokedAt: undefined,
      }),
    ).toBe(false);
    expect(
      providerLocationFallbackBootstrapEligible({
        bootstrapConsumedAt: 1,
        reportCredentialRevokedAt: null,
      }),
    ).toBe(false);
    expect(
      providerLocationFallbackBootstrapEligible({
        bootstrapConsumedAt: null,
        reportCredentialRevokedAt: 1,
      }),
    ).toBe(false);
  });

  it("uses a new logical request identity after a failed asynchronous delete instead of colliding with attempt one", () => {
    expect(
      nextProviderOperationLogicalOrdinal({ state: "failed", attempt: 1 }),
    ).toBe(2);
    expect(
      nextProviderOperationLogicalOrdinal({ state: "failed", attempt: 4 }),
    ).toBe(5);
    expect(
      nextProviderOperationLogicalOrdinal({ state: "retryable", attempt: 4 }),
    ).toBe(1);
  });

  it("rejects a late provider operation observation after location fallback advanced", async () => {
    await seedCumulativeCertification();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runtime_provider_operations
           (id, allocation_id, provider_kind, operation_kind, location_attempt,
            provider_operation_id, request_id, state, attempt, created_at, updated_at)
         VALUES ('attempt-1-operation', 'cert-allocation', 'gcp_compute',
                 'create_instance', 1, 'operation-self-link',
                 'attempt-1-request', 'running', 1, 1, 1)`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_allocations
         SET location = 'europe-west3-b', location_attempt = 2,
             location_attempt_started_at = 2, updated_at = 2
         WHERE id = 'cert-allocation' AND location_attempt = 1`,
      ),
    ]);

    await expect(
      recordProviderOperationObservation({
        allocationId: "cert-allocation",
        locationAttempt: 1,
        providerOperationId: "operation-self-link",
        providerState: "DONE",
        state: "succeeded",
        now: 3,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "provider_location_attempt_stale",
    });
    const operation = await env.DB.prepare(
      `SELECT state, last_polled_at, completed_at
       FROM runtime_provider_operations
       WHERE id = 'attempt-1-operation'`,
    ).first<{
      state: string;
      last_polled_at: number | null;
      completed_at: number | null;
    }>();
    expect(operation).toEqual({
      state: "running",
      last_polled_at: null,
      completed_at: null,
    });
  });

  it("discovers a Hetzner create left running without an action identity before any POST retry", () => {
    for (const state of ["pending", "running", "retryable"] as const) {
      expect(
        shouldDiscoverHetznerCreateBeforeRetry({
          providerKind: "hetzner_cloud",
          operationKind: "create_server",
          previous: { state, provider_operation_id: null },
        }),
      ).toBe(true);
    }
    expect(
      shouldDiscoverHetznerCreateBeforeRetry({
        providerKind: "hetzner_cloud",
        operationKind: "create_server",
        previous: { state: "running", provider_operation_id: "1234" },
      }),
    ).toBe(false);
    expect(
      shouldDiscoverHetznerCreateBeforeRetry({
        providerKind: "gcp_compute",
        operationKind: "create_instance",
        previous: { state: "running", provider_operation_id: null },
      }),
    ).toBe(false);
  });

  it("durably claims a due certification so a concurrent sweeper cannot advance it twice", async () => {
    await seedCumulativeCertification();
    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 100,
    });
    await makeCertificationDue(200);

    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.invokeProviderOperation.mockImplementationOnce(async () => {
      await providerBlocked;
      return { canonicalWrites: [], data: {} };
    });

    const firstSweep = sweepWorkshopProviderRuntimes({ now: 200, limit: 10 });
    await vi.waitFor(() => {
      expect(mocks.invokeProviderOperation).toHaveBeenCalledTimes(1);
    });
    const second = await sweepWorkshopProviderRuntimes({ now: 200, limit: 10 });
    expect(second.failed).toBe(0);
    expect(second.pending).toBe(0);

    releaseProvider();
    const first = await firstSweep;
    expect(first.failed).toBe(0);
    expect(first.pending).toBe(1);
    await expectCertificationReboots(1);
    expect(mocks.invokeProviderOperation).toHaveBeenCalledTimes(1);
    const reconciliation = await env.DB.prepare(
      `SELECT claim_id, claim_expires_at, sweep_after, consecutive_failures
       FROM runtime_provider_reconciliation
       WHERE allocation_id = 'cert-allocation'`,
    ).first<{
      claim_id: string | null;
      claim_expires_at: number | null;
      sweep_after: number;
      consecutive_failures: number;
    }>();
    expect(reconciliation).toEqual({
      claim_id: null,
      claim_expires_at: null,
      sweep_after: 10_200,
      consecutive_failures: 0,
    });
  });

  it("routes a cleanup-only GCP certification directly into deletion without a reboot loop", async () => {
    await seedCumulativeCertification();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provider_connections
         SET state = 'rotation_required', updated_at = 100
         WHERE id = 'connection'`,
      ),
      env.DB.prepare(
        `UPDATE provider_credential_versions
         SET authority = 'cleanup_only'
         WHERE id = 'credential'`,
      ),
    ]);
    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 100,
    });
    await makeCertificationDue(200);

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });
    expect(mocks.invokeProviderOperation).toHaveBeenCalledTimes(1);
    await expectCertificationReboots(0);
    const lifecycle = await env.DB.prepare(
      `SELECT certification.state AS certification_state,
              certification.error_code,
              allocation.state AS allocation_state,
              allocation.last_error_code,
              allocation.deletion_requested_at,
              execution.state AS execution_state,
              execution.ended_at,
              reconciliation.desired_state,
              reconciliation.observed_state,
              reconciliation.consecutive_failures,
              credential.report_credential_revoked_at
       FROM workshop_runtime_profile_certifications certification
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
        AND credential.generation = execution.generation
       WHERE certification.id = 'certification'`,
    ).first<Record<string, string | number | null>>();
    expect(lifecycle).toMatchObject({
      certification_state: "cleanup_pending",
      error_code: "provider_credential_cleanup_only",
      allocation_state: "cleanup_pending",
      last_error_code: "provider_credential_cleanup_only",
      deletion_requested_at: 200,
      execution_state: "failed",
      ended_at: 200,
      desired_state: "deleted",
      observed_state: "certification_failed",
      consecutive_failures: 0,
      report_credential_revoked_at: 200,
    });
    const operations = await env.DB.prepare(
      `SELECT operation_kind FROM runtime_provider_operations
       WHERE allocation_id = 'cert-allocation' ORDER BY created_at`,
    ).all<{ operation_kind: string }>();
    expect(operations.results).toEqual([{ operation_kind: "delete_instance" }]);
  });

  it("recovers a publisher cancellation fence by deleting the verifier without another reboot", async () => {
    await seedCumulativeCertification();
    await seedCertificationPublication();
    await env.DB.prepare(
      `UPDATE workshop_publications
       SET certification_state = 'cleanup_pending',
           error = 'publication cancelled by publisher', updated_at = 100
       WHERE id = 'publication'`,
    ).run();

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0 });

    const lifecycle = await env.DB.prepare(
      `SELECT publication.status AS publication_status,
              publication.certification_state AS publication_certification_state,
              certification.state AS certification_state,
              certification.error_code,
              allocation.state AS allocation_state,
              allocation.deletion_requested_at,
              execution.state AS execution_state,
              reconciliation.desired_state,
              credential.report_credential_revoked_at
       FROM workshop_publications publication
       JOIN workshop_runtime_profiles profile
         ON profile.template_revision_id = publication.published_revision_id
       JOIN workshop_runtime_profile_certifications certification
         ON certification.runtime_profile_id = profile.id
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution ON execution.id = allocation.execution_id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
        AND credential.generation = execution.generation
       WHERE publication.id = 'publication'`,
    ).first<Record<string, string | number | null>>();
    expect(lifecycle).toMatchObject({
      publication_status: "failed",
      publication_certification_state: "failed",
      certification_state: "failed",
      error_code: "publication_cancelled",
      allocation_state: "deleted",
      deletion_requested_at: 200,
      execution_state: "archived",
      desired_state: "deleted",
      report_credential_revoked_at: 200,
    });
    await expectCertificationReboots(0);
    const operations = await env.DB.prepare(
      `SELECT operation_kind FROM runtime_provider_operations
       WHERE allocation_id = 'cert-allocation' ORDER BY created_at`,
    ).all<{ operation_kind: string }>();
    expect(operations.results.map((row) => row.operation_kind)).toContain(
      "delete_instance",
    );
    expect(
      operations.results.some((row) =>
        row.operation_kind.startsWith("certification_reboot_"),
      ),
    ).toBe(false);
  });

  it("proves every cumulative checkpoint and its reboot on one verifier allocation", async () => {
    await seedCumulativeCertification();
    mocks.invokeProviderOperation.mockResolvedValueOnce({
      canonicalWrites: [
        {
          operation: "operation_observed",
          externalId: "reboot-operation-00",
          state: "RUNNING",
        },
      ],
      data: {},
    });

    await insertCertificationProof({
      sequence: 1,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 100,
    });
    await makeCertificationDue(200);
    await sweepWorkshopProviderRuntimes({ now: 200, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_completion",
      currentCheckpointOrdinal: 0,
      preRebootBootId: BOOT_A,
    });
    await expectCertificationReboots(1);

    // A newer ready heartbeat cannot prove the reboot while the provider's
    // asynchronous reboot operation remains unconfirmed.
    await insertCertificationProof({
      sequence: 2,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 300,
    });
    await makeCertificationDue(400);
    await sweepWorkshopProviderRuntimes({ now: 400, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_completion",
      currentCheckpointOrdinal: 0,
    });
    await env.DB.prepare(
      `UPDATE runtime_provider_operations
       SET state = 'succeeded', completed_at = 450, retry_at = NULL,
           updated_at = 450
       WHERE allocation_id = 'cert-allocation'
         AND operation_kind = 'certification_reboot_0'`,
    ).run();
    await makeCertificationDue(500);
    await sweepWorkshopProviderRuntimes({ now: 500, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_proof",
      currentCheckpointOrdinal: 0,
      rebootConfirmedAt: 500,
    });

    // Even after provider confirmation, a post-confirmation report from the
    // original Linux boot is stale proof and cannot advance the checkpoint.
    await insertCertificationProof({
      sequence: 3,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 600,
    });
    await makeCertificationDue(700);
    await sweepWorkshopProviderRuntimes({ now: 700, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_proof",
      currentCheckpointOrdinal: 0,
    });

    await insertCertificationProof({
      sequence: 4,
      checkpointId: "checkpoint-00",
      bootId: BOOT_B,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
      receivedAt: 800,
    });
    await makeCertificationDue(900);
    await sweepWorkshopProviderRuntimes({ now: 900, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_checkpoint_proof",
      currentCheckpointOrdinal: 1,
    });
    const advanced = await env.DB.prepare(
      `SELECT execution.checkpoint_id, credential.checkpoint_bundle_id,
              allocation.state
       FROM runtime_executions execution
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
       JOIN runtime_provider_allocations allocation
         ON allocation.execution_id = execution.id
       WHERE execution.id = 'cert-execution'`,
    ).first<{
      checkpoint_id: string;
      checkpoint_bundle_id: string;
      state: string;
    }>();
    expect(advanced).toEqual({
      checkpoint_id: "checkpoint-01",
      checkpoint_bundle_id: "bundle-01",
      state: "bootstrapping",
    });
    await expectCertificationReboots(1);

    // A late report for checkpoint 00 cannot prove checkpoint 01 or trigger
    // its reboot, even though its sequence is globally newer.
    const commandResponse = await certificationReportRequest({
      sequence: 5,
      checkpointId: "checkpoint-00",
      bootId: BOOT_B,
      completedModuleIds: ["00"],
      probeIds: ["probe-00"],
    });
    expect(commandResponse.status).toBe(200);
    const command = await commandResponse.json<{
      next_checkpoint?: { checkpoint_id: string; signed_url: string };
    }>();
    expect(command.next_checkpoint).toMatchObject({
      checkpoint_id: "checkpoint-01",
    });
    expect(command.next_checkpoint?.signed_url).toMatch(
      /^https:\/\/intar\.test\/api\/runtime\/workspace-agent\/checkpoints\//,
    );
    await makeCertificationDue(1_000);
    await sweepWorkshopProviderRuntimes({ now: 1_000, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_checkpoint_proof",
      currentCheckpointOrdinal: 1,
    });
    await expectCertificationReboots(1);

    await insertCertificationProof({
      sequence: 6,
      checkpointId: "checkpoint-01",
      bootId: BOOT_B,
      completedModuleIds: ["00", "01"],
      probeIds: ["probe-00", "probe-01"],
      receivedAt: 1_100,
    });
    await makeCertificationDue(1_200);
    await sweepWorkshopProviderRuntimes({ now: 1_200, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_completion",
      currentCheckpointOrdinal: 1,
    });
    await expectCertificationReboots(2);

    await makeCertificationDue(1_300);
    await sweepWorkshopProviderRuntimes({ now: 1_300, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_proof",
      currentCheckpointOrdinal: 1,
      rebootConfirmedAt: 1_300,
    });

    await insertCertificationProof({
      sequence: 7,
      checkpointId: "checkpoint-01",
      bootId: BOOT_B,
      completedModuleIds: ["00", "01"],
      probeIds: ["probe-00", "probe-01"],
      receivedAt: 1_400,
    });
    await makeCertificationDue(1_500);
    await sweepWorkshopProviderRuntimes({ now: 1_500, limit: 10 });
    await expectCertificationEvidence({
      phase: "awaiting_reboot_proof",
      currentCheckpointOrdinal: 1,
    });

    await insertCertificationProof({
      sequence: 8,
      checkpointId: "checkpoint-01",
      bootId: BOOT_C,
      completedModuleIds: ["00", "01"],
      probeIds: ["probe-00", "probe-01"],
      receivedAt: 1_600,
    });
    await makeCertificationDue(1_700);
    await sweepWorkshopProviderRuntimes({ now: 1_700, limit: 10 });
    const final = await env.DB.prepare(
      `SELECT certification.state, certification.evidence_json,
              certification.verifier_allocation_id,
              allocation.id AS allocation_id, allocation.state AS allocation_state,
              execution.id AS execution_id
       FROM workshop_runtime_profile_certifications certification
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       WHERE certification.id = 'certification'`,
    ).first<{
      state: string;
      evidence_json: string;
      verifier_allocation_id: string;
      allocation_id: string;
      allocation_state: string;
      execution_id: string;
    }>();
    expect(final).toMatchObject({
      state: "verifying",
      verifier_allocation_id: "cert-allocation",
      allocation_id: "cert-allocation",
      allocation_state: "deleting",
      execution_id: "cert-execution",
    });
    const evidence = JSON.parse(final?.evidence_json ?? "{}") as {
      phase?: string;
      checkpointProofsCompleted?: Array<{
        checkpointId: string;
        preRebootBootId: string;
        rebootProofBootId: string;
      }>;
    };
    expect(evidence.phase).toBe("deleting");
    expect(evidence.checkpointProofsCompleted?.map((proof) => proof.checkpointId))
      .toEqual(["checkpoint-00", "checkpoint-01"]);
    expect(
      evidence.checkpointProofsCompleted?.map((proof) => [
        proof.preRebootBootId,
        proof.rebootProofBootId,
      ]),
    ).toEqual([
      [BOOT_A, BOOT_B],
      [BOOT_B, BOOT_C],
    ]);
  });

  it("fails closed and starts cleanup when the current checkpoint reports failure", async () => {
    await seedCumulativeCertification();
    await env.DB.prepare(
      `INSERT INTO runtime_guest_reports
         (id, execution_id, provider_kind, generation, sequence, checkpoint_id,
          boot_id, phase, health, terminal_ready, probes_json,
          completed_module_ids_json, report_json, reported_at, received_at)
       VALUES ('failed-report', 'cert-execution', 'gcp_compute', 1, 1,
               'checkpoint-00', ?, 'failed', 'failed', 0, '[]', '[]', '{}', 100, 100)`,
    ).bind(BOOT_A).run();
    await makeCertificationDue(200);
    await sweepWorkshopProviderRuntimes({ now: 200, limit: 10 });
    const row = await env.DB.prepare(
      `SELECT certification.state, certification.error_code,
              allocation.state AS allocation_state,
              execution.state AS execution_state,
              credential.report_credential_revoked_at,
              credential.bootstrap_expires_at
       FROM workshop_runtime_profile_certifications certification
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
        AND credential.generation = execution.generation
       WHERE certification.id = 'certification'`,
    ).first<{
      state: string;
      error_code: string;
      allocation_state: string;
      execution_state: string;
      report_credential_revoked_at: number | null;
      bootstrap_expires_at: number;
    }>();
    expect(row).toEqual({
      state: "cleanup_pending",
      error_code: "workshop_certification_guest_failed",
      allocation_state: "cleanup_pending",
      execution_state: "failed",
      report_credential_revoked_at: 200,
      bootstrap_expires_at: 200,
    });
    await expectCertificationReboots(0);
  });

  it("latches a failed checkpoint report across a later applying report", async () => {
    await seedCumulativeCertification();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runtime_guest_reports
           (id, execution_id, provider_kind, generation, sequence, checkpoint_id,
            boot_id, phase, health, terminal_ready, probes_json,
            completed_module_ids_json, report_json, reported_at, received_at)
         VALUES ('failed-report', 'cert-execution', 'gcp_compute', 1, 1,
                 'checkpoint-00', ?, 'failed', 'failed', 0, '[]', '[]', '{}', 100, 100)`,
      ).bind(BOOT_A),
      env.DB.prepare(
        `INSERT INTO runtime_guest_reports
           (id, execution_id, provider_kind, generation, sequence, checkpoint_id,
            boot_id, phase, health, terminal_ready, probes_json,
            completed_module_ids_json, report_json, reported_at, received_at)
         VALUES ('restarted-applying-report', 'cert-execution', 'gcp_compute', 1, 2,
                 'checkpoint-00', ?, 'applying_checkpoint', 'unknown', 0,
                 '[]', '[]', '{}', 150, 150)`,
      ).bind(BOOT_A),
    ]);
    await makeCertificationDue(200);

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ failed: 0, pending: 1 });

    const lifecycle = await env.DB.prepare(
      `SELECT certification.state, certification.error_code,
              certification.evidence_json,
              allocation.state AS allocation_state,
              execution.state AS execution_state,
              credential.report_credential_revoked_at
       FROM workshop_runtime_profile_certifications certification
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
        AND credential.generation = execution.generation
       WHERE certification.id = 'certification'`,
    ).first<{
      state: string;
      error_code: string;
      evidence_json: string;
      allocation_state: string;
      execution_state: string;
      report_credential_revoked_at: number | null;
    }>();
    expect(lifecycle).toMatchObject({
      state: "cleanup_pending",
      error_code: "workshop_certification_guest_failed",
      allocation_state: "cleanup_pending",
      execution_state: "failed",
      report_credential_revoked_at: 200,
    });
    expect(JSON.parse(lifecycle?.evidence_json ?? "{}")).toMatchObject({
      failedReportSequence: 1,
      cleanupRequestedAt: 200,
    });
    await expectCertificationReboots(0);
  });

  it("sweeps a certification allocation left failed by the workspace-agent handler", async () => {
    await seedCumulativeCertification();

    const reportResponse = await certificationReportRequest({
      sequence: 1,
      checkpointId: "checkpoint-00",
      bootId: BOOT_A,
      completedModuleIds: [],
      probeIds: [],
      phase: "failed",
      health: "failed",
      terminalReady: false,
    });
    expect(reportResponse.status).toBe(200);
    await expect(reportResponse.json()).resolves.toMatchObject({
      accepted_sequence: 1,
    });

    const reported = await env.DB.prepare(
      `SELECT allocation.state AS allocation_state,
              allocation.last_report_sequence,
              execution.state AS execution_state,
              reconciliation.sweep_after,
              reconciliation.claim_id
       FROM runtime_provider_allocations allocation
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       WHERE allocation.id = 'cert-allocation'`,
    ).first<Record<string, string | number | null>>();
    expect(reported).toMatchObject({
      allocation_state: "failed",
      last_report_sequence: 1,
      execution_state: "failed",
      sweep_after: 0,
      claim_id: null,
    });

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toMatchObject({ inspected: 1, failed: 0, pending: 1 });

    const cleaned = await env.DB.prepare(
      `SELECT certification.state, certification.error_code,
              certification.evidence_json,
              allocation.state AS allocation_state,
              execution.state AS execution_state,
              reconciliation.desired_state,
              credential.report_credential_revoked_at
       FROM workshop_runtime_profile_certifications certification
       JOIN runtime_provider_allocations allocation
         ON allocation.id = certification.verifier_allocation_id
       JOIN runtime_executions execution
         ON execution.id = allocation.execution_id
       JOIN runtime_provider_reconciliation reconciliation
         ON reconciliation.allocation_id = allocation.id
       JOIN runtime_guest_credentials credential
         ON credential.execution_id = execution.id
        AND credential.generation = execution.generation
       WHERE certification.id = 'certification'`,
    ).first<{
      state: string;
      error_code: string;
      evidence_json: string;
      allocation_state: string;
      execution_state: string;
      desired_state: string;
      report_credential_revoked_at: number | null;
    }>();
    expect(cleaned).toMatchObject({
      state: "cleanup_pending",
      error_code: "workshop_certification_guest_failed",
      allocation_state: "cleanup_pending",
      execution_state: "failed",
      desired_state: "deleted",
      report_credential_revoked_at: 200,
    });
    expect(JSON.parse(cleaned?.evidence_json ?? "{}")).toMatchObject({
      failedReportSequence: 1,
      cleanupRequestedAt: 200,
    });
    await expectCertificationReboots(0);
  });

  it("does not sweep a failed learner allocation as certification work", async () => {
    await seedCumulativeCertification();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workshop_sessions
           (id, organization_id, template_revision_id, title, state,
            scheduled_start_at, lobby_opens_at, created_by)
         VALUES ('session', 'org', 'revision', 'Session', 'live', 1000, 500,
                 'owner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_session_runtime_selections
           (session_id, runtime_profile_id, profile_id, provider_kind,
            connection_id, resolved_profile_json)
         VALUES ('session', 'profile', 'gcp-e2', 'gcp_compute', 'connection', '{}')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_session_cost_forecasts
           (id, session_id, version, price_observation_id, provider_kind,
            currency, participant_count, trigger, expected_cost_nanos,
            lease_ceiling_cost_nanos, one_restore_cost_nanos,
            assumptions_json, exclusions_json, expires_at, created_by)
         VALUES ('learner-forecast', 'session', 1, 'cert-price', 'gcp_compute',
                 'USD', 1, 'session_created', 1, 1, 1, '[]', '[]', 1000,
                 'owner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_session_members
           (id, session_id, user_id, role, workspace_enabled, provision_state,
            assigned_by)
         VALUES ('roster', 'session', 'owner', 'participant', 1, 'failed',
                 'owner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_workspaces
           (id, session_id, user_id, state)
         VALUES ('workspace', 'session', 'owner', 'failed')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_workspace_generations
           (id, workspace_id, ordinal, checkpoint_id, state)
         VALUES ('learner-generation', 'workspace', 1, 'checkpoint-00', 'failed')`,
      ),
      env.DB.prepare(
        `UPDATE workshop_workspaces
         SET current_generation_id = 'learner-generation'
         WHERE id = 'workspace'`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_executions
           (id, user_id, organization_id, provider_kind,
            provider_connection_id, domain_kind, domain_id, generation,
            checkpoint_id, state, lease_expires_at, created_at, updated_at)
         VALUES ('learner-execution', 'owner', 'org', 'gcp_compute',
                 'connection', 'workshop', 'workspace', 1, 'checkpoint-00',
                 'failed', 1000, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_allocations
           (id, execution_id, connection_id, runtime_profile_id,
            price_observation_id, cost_forecast_id, provider_kind,
            deterministic_name, machine_type, resolved_image_id,
            location_attempts_json, location, location_attempt,
            location_attempt_started_at, state, created_at, updated_at)
         VALUES ('learner-allocation', 'learner-execution', 'connection',
                 'profile', 'cert-price', 'learner-forecast', 'gcp_compute',
                 'intar-learner', 'e2-standard-4', 'debian-image-1',
                 '["europe-west3-a","europe-west3-b"]', 'europe-west3-a',
                 1, 1, 'failed', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO runtime_provider_reconciliation
           (allocation_id, desired_state, observed_state, sweep_after, updated_at)
         VALUES ('learner-allocation', 'ready', 'failed', 0, 1)`,
      ),
      env.DB.prepare(
        `UPDATE runtime_provider_reconciliation
         SET sweep_after = 1000 WHERE allocation_id = 'cert-allocation'`,
      ),
    ]);

    await expect(
      sweepWorkshopProviderRuntimes({ now: 200, limit: 10 }),
    ).resolves.toEqual({ inspected: 0, deleted: 0, pending: 0, failed: 0 });
    expect(mocks.invokeProviderOperation).not.toHaveBeenCalled();
    const allocation = await env.DB.prepare(
      `SELECT state FROM runtime_provider_allocations
       WHERE id = 'learner-allocation'`,
    ).first<{ state: string }>();
    expect(allocation?.state).toBe("failed");
  });

  it("selects a durable checkpoint restore exactly until a runtime is linked", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email) VALUES ('learner', 'Learner', 'learner@example.test')`,
      ),
      env.DB.prepare(
        `INSERT INTO organization (id, name, slug, created_at)
         VALUES ('org', 'Org', 'org', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
         VALUES ('membership', 'org', 'learner', 'owner', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_templates
           (id, organization_id, slug, title, summary, created_by)
         VALUES ('template', 'org', 'workshop', 'Workshop', 'Summary', 'learner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_template_revisions
           (id, template_id, revision, source_revision, content_hash,
            manifest_json, published_by)
         VALUES ('revision', 'template', 1, 'source', 'hash',
                 '{"schemaVersion":2}', 'learner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_sessions
           (id, organization_id, template_revision_id, title, state,
            scheduled_start_at, lobby_opens_at, created_by)
         VALUES ('session', 'org', 'revision', 'Session', 'live', 1000, 500,
                 'learner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_session_members
           (id, session_id, user_id, role, workspace_enabled, provision_state,
            assigned_by)
         VALUES ('roster', 'session', 'learner', 'participant', 1, 'queued',
                 'learner')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_workspaces
           (id, session_id, user_id, state, current_generation_id,
            last_checkpoint_id)
         VALUES ('workspace', 'session', 'learner', 'recovering',
                 'generation-2', 'checkpoint-01')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_workspace_generations
           (id, workspace_id, ordinal, checkpoint_id, state)
         VALUES ('generation-2', 'workspace', 2, 'checkpoint-01', 'queued')`,
      ),
      env.DB.prepare(
        `INSERT INTO workshop_events
           (id, organization_id, session_id, actor_user_id, type,
            payload_json, created_at)
         VALUES ('restore-event', 'org', 'session', 'learner',
                 'workspace.checkpoint_restore_requested',
                 '{"generationId":"generation-2","workspaceId":"workspace","checkpointId":"checkpoint-01"}',
                 10)`,
      ),
    ]);

    const pending = await loadDeferredWorkshopRuntimeReplacementCandidates();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      generation_id: "generation-2",
      runtime_execution_id: null,
      request_event_type: "workspace.checkpoint_restore_requested",
    });

    await env.DB.prepare(
      `UPDATE workshop_workspace_generations
       SET runtime_execution_id = 'execution-already-linked'
       WHERE id = 'generation-2'`,
    ).run();
    await expect(
      loadDeferredWorkshopRuntimeReplacementCandidates(),
    ).resolves.toEqual([]);
  });
});

async function seedCumulativeCertification(input?: {
  providerKind?: "gcp_compute" | "hetzner_cloud";
}): Promise<void> {
  const providerKind = input?.providerKind ?? "gcp_compute";
  const isHetzner = providerKind === "hetzner_cloud";
  const locations = isHetzner
    ? ["nbg1", "fsn1", "hel1"]
    : ["europe-west3-a", "europe-west3-b"];
  const reportCredentialHash = await digestHex(REPORT_CREDENTIAL);
  const certificationDurationMs = certificationRuntimeDurationMs(2);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    workspace: {
      vms: [
        {
          id: "learner",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 32_768,
        },
      ],
    },
    modules: [
      { id: "00", probeIds: ["probe-00"] },
      { id: "01", probeIds: ["probe-01"] },
    ],
  });
  const evidence = JSON.stringify({
    proofKind: "direct_cloud_profile_certification_v1",
    publicationId: "publication",
    cumulativeCheckpointIds: ["checkpoint-00", "checkpoint-01"],
    checkpointProofs: [
      {
        checkpointId: "checkpoint-00",
        expectedModuleIds: ["00"],
        expectedProbeIds: ["probe-00"],
      },
      {
        checkpointId: "checkpoint-01",
        expectedModuleIds: ["00", "01"],
        expectedProbeIds: ["probe-00", "probe-01"],
      },
    ],
    checkpointProofsCompleted: [],
    currentCheckpointOrdinal: 0,
    phase: "awaiting_checkpoint_proof",
    certificationDurationMs,
    certificationDeadlineAt: 1 + certificationDurationMs,
  });
  const connectionDetails = isHetzner
    ? env.DB.prepare(
        `INSERT INTO hetzner_connection_details
           (connection_id, sentinel_firewall_id, approved_locations_json,
            max_concurrent_allocations, native_currency, updated_at)
         VALUES ('connection', 'firewall-1', ?, 5, 'EUR', 1)`,
      ).bind(JSON.stringify(locations))
    : env.DB.prepare(
        `INSERT INTO gcp_connection_details
           (connection_id, project_number, network_name, network_self_link,
            subnet_name, subnet_self_link, subnet_cidr, firewall_name,
            firewall_self_link, approved_zones_json, max_concurrent_allocations,
            updated_at)
         VALUES ('connection', '123', 'network', 'network-link', 'subnet',
                 'subnet-link', '10.0.0.0/24', 'firewall', 'firewall-link',
                 ?, 5, 1)`,
      ).bind(JSON.stringify(locations));
  const profileId = isHetzner ? "hetzner-cpx42" : "gcp-e2";
  const machineType = isHetzner ? "cpx42" : "e2-standard-4";
  const resolvedImageId = isHetzner ? "debian-13" : "debian-image-1";
  const rootDiskType = isHetzner ? null : "pd-balanced";
  const currency = isHetzner ? "EUR" : "USD";
  const location = locations[0]!;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, created_at, updated_at)
       VALUES ('owner', 'Owner', 'owner@example.test', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org', 'Org', 'org', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('member', 'org', 'owner', 'owner', 1)`,
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
    ).bind("a".repeat(64), manifest),
    env.DB.prepare(
      `INSERT INTO provider_connections
         (id, organization_id, provider_kind, display_name, state,
          external_project_id, project_fingerprint, created_by,
          last_validated_at, created_at, updated_at)
       VALUES ('connection', 'org', ?, ?, 'active',
               'project', 'fingerprint', 'owner', 1, 1, 1)`,
    ).bind(providerKind, isHetzner ? "Hetzner" : "GCP"),
    env.DB.prepare(
      `INSERT INTO provider_credential_versions
         (id, connection_id, version, algorithm, kek_version, aad_sha256,
          encrypted_payload_b64, payload_iv_b64, wrapped_dek_b64, dek_iv_b64,
          credential_fingerprint, created_by, activated_at, created_at)
       VALUES ('credential', 'connection', 1, 'AES-256-GCM', 'v1', ?,
               'payload', 'payload-iv', 'dek', 'dek-iv', 'fingerprint',
               'owner', 1, 1)`,
    ).bind("b".repeat(64)),
    env.DB.prepare(
      `UPDATE provider_connections
       SET active_credential_version_id = 'credential'
       WHERE id = 'connection'`,
    ),
    connectionDetails,
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          machine_type, system_image, resolved_image_id, root_disk_type,
          architecture, cpu_millis, memory_mib, disk_mib, locations_json,
          configuration_json, created_at)
       VALUES ('profile', 'revision', ?, ?, 'learner',
               ?, 'debian-13', ?, ?, 'x86_64', 4000, 16384, 32768,
               ?, '{}', 1)`,
    ).bind(
      profileId,
      providerKind,
      machineType,
      resolvedImageId,
      rootDiskType,
      JSON.stringify(locations),
    ),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profile_certifications
         (id, runtime_profile_id, connection_id, state, verifier_allocation_id,
          evidence_json, started_at, created_at, updated_at)
       VALUES ('certification', 'profile', 'connection', 'verifying', NULL,
               ?, 1, 1, 1)`,
    ).bind(evidence),
    env.DB.prepare(
      `INSERT INTO provider_price_observations
         (id, provider_kind, connection_id, runtime_profile_id, currency,
          source, raw_observation_json, observed_at, expires_at, created_at)
       VALUES ('cert-price', ?, 'connection', 'profile', ?, 'test-catalog',
               ?, 1, 86400001, 1)`,
    ).bind(
      providerKind,
      currency,
      JSON.stringify({ availableLocations: locations }),
    ),
    ...(isHetzner
      ? (["instance", "ipv4"] as const).map((resourceKind) =>
          env.DB.prepare(
            `INSERT INTO provider_price_line_items
               (id, observation_id, sku, resource_kind, location, raw_price,
                price_nanos, unit, quantity_nanos, billing_increment_seconds,
                minimum_duration_seconds, tax_treatment, metadata_json)
             VALUES (?, 'cert-price', ?, ?, ?, '0.01', 10000000,
                     'hour', 1000000000, 3600, 3600, 'provider_gross', '{}')`,
          ).bind(
            `cert-price-${resourceKind}`,
            `test-${resourceKind}`,
            resourceKind,
            location,
          ),
        )
      : []),
    env.DB.prepare(
      `INSERT INTO runtime_executions
         (id, user_id, organization_id, host_id, provider_kind,
          provider_connection_id, domain_kind, domain_id, generation,
          checkpoint_id, state, lease_expires_at, created_at, updated_at)
       VALUES ('cert-execution', 'owner', 'org', NULL, ?,
               'connection', 'workshop_certification', 'certification', 1,
               'checkpoint-00', 'provisioning', 30600001, 1, 1)`,
    ).bind(providerKind),
    ...["00", "01"].map((suffix) =>
      env.DB.prepare(
        `INSERT INTO runtime_checkpoint_bundles
           (id, template_revision_id, checkpoint_id, format, r2_key, sha256,
            size_bytes, compression, signature_b64, signing_key_id,
            workspace_agent_sha256, kino_sha256, created_at)
         VALUES (?, 'revision', ?, 'direct_cloud_linux_x86_64_v1', ?, ?,
                 1, 'zstd', ?, 'test-key', ?, ?, 1)`,
      ).bind(
        `bundle-${suffix}`,
        `checkpoint-${suffix}`,
        `checkpoint-${suffix}.tar.zst`,
        suffix.repeat(32),
        "A".repeat(88),
        "c".repeat(64),
        "d".repeat(64),
      ),
    ),
    env.DB.prepare(
      `INSERT INTO runtime_vms
         (id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json,
          image_sha256, cpu_millis, memory_mib, disk_mib, created_at, updated_at)
       VALUES ('cert-vm', 'cert-execution', 'learner', 0, 'cert-vm',
               '{"kind":"direct_cloud_checkpoint","checkpointId":"checkpoint-00","bundleId":"bundle-00"}',
               ?, 4000, 16384, 32768, 1, 1)`,
    ).bind("00".repeat(32)),
    env.DB.prepare(
      `INSERT INTO runtime_provider_allocations
         (id, execution_id, connection_id, runtime_profile_id,
          price_observation_id, cost_forecast_id, provider_kind,
          deterministic_name, machine_type, resolved_image_id,
          location_attempts_json, location, location_attempt,
          location_attempt_started_at, state, created_at, updated_at)
       VALUES ('cert-allocation', 'cert-execution', 'connection', 'profile',
               'cert-price', NULL, ?, 'intar-certification', ?,
               ?, ?, ?, 1,
               1, 'ready', 1, 1)`,
    ).bind(
      providerKind,
      machineType,
      resolvedImageId,
      JSON.stringify(locations),
      location,
    ),
    env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET verifier_allocation_id = 'cert-allocation'
       WHERE id = 'certification'`,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_provider_reconciliation
         (allocation_id, desired_state, observed_state, sweep_after, updated_at)
       VALUES ('cert-allocation', 'ready', 'ready', 0, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_guest_credentials
         (id, execution_id, workspace_id, generation, control_plane_base_url,
          bootstrap_token_hash, bootstrap_expires_at, bootstrap_consumed_at,
          report_credential_hash, report_credential_issued_at,
          report_credential_expires_at, checkpoint_bundle_id,
          checkpoint_download_token_hash, checkpoint_download_expires_at,
          created_at, updated_at)
       VALUES ('guest', 'cert-execution', 'certification', 1,
               'https://intar.test', ?, 4102444800000, 1, ?, 1, 4102444800000,
               'bundle-00', ?, 4102444800000, 1, 1)`,
    ).bind("e".repeat(64), reportCredentialHash, "1".repeat(64)),
  ]);
}

async function seedCertificationPublication(): Promise<void> {
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner", now: 1 });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens
         (id, organization_id, name, token_prefix, token_hash, created_by, created_at)
       VALUES ('registry-token', 'org', 'Test publisher', 'intar_test', ?, 'owner', 1)`,
    ).bind("f".repeat(64)),
    env.DB.prepare(
      `INSERT INTO workshop_publications
         (id, organization_id, workshop_slug, content_hash, source_r2_key,
          compiled_manifest_json, required_checkpoint_ids_json, status,
          submitted_by, registry_token_id, published_revision_id,
          certification_state, created_at, updated_at)
       VALUES ('publication', 'org', 'workshop', ?, 'source-bundle', '{}',
               '["checkpoint-00","checkpoint-01"]', 'building', 'owner',
               'registry-token', 'revision', 'verifying', 1, 1)`,
    ).bind("9".repeat(64)),
  ]);
}

async function insertCertificationProof(input: {
  sequence: number;
  checkpointId: string;
  bootId: string;
  completedModuleIds: string[];
  probeIds: string[];
  receivedAt: number;
  providerKind?: "gcp_compute" | "hetzner_cloud";
}): Promise<void> {
  const probes = input.probeIds.map((id) => ({ id, status: "pass" }));
  await env.DB.prepare(
    `INSERT INTO runtime_guest_reports
       (id, execution_id, provider_kind, generation, sequence, checkpoint_id,
        boot_id, phase, health, terminal_ready, probes_json, completed_module_ids_json,
        report_json, reported_at, received_at)
     VALUES (?, 'cert-execution', ?, 1, ?, ?, ?, 'ready', 'healthy',
             1, ?, ?, '{}', ?, ?)`,
  )
    .bind(
      `report-${input.sequence}`,
      input.providerKind ?? "gcp_compute",
      input.sequence,
      input.checkpointId,
      input.bootId,
      JSON.stringify(probes),
      JSON.stringify(input.completedModuleIds),
      input.receivedAt,
      input.receivedAt,
    )
    .run();
}

async function certificationReportRequest(input: {
  sequence: number;
  checkpointId: string;
  bootId: string;
  completedModuleIds: string[];
  probeIds: string[];
  phase?: "ready" | "failed";
  health?: "healthy" | "failed";
  terminalReady?: boolean;
}): Promise<Response> {
  const terminalReady = input.terminalReady ?? true;
  const response = await handleWorkspaceAgentControlPlaneRequest(
    new Request("https://intar.test/api/runtime/workspace-agent/reports", {
      method: "POST",
      headers: {
        authorization: `Bearer ${REPORT_CREDENTIAL}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract_version: 1,
        identity: {
          execution_id: "cert-execution",
          workspace_id: "certification",
          generation: 1,
        },
        sequence: input.sequence,
        checkpoint_id: input.checkpointId,
        boot_id: input.bootId,
        phase: input.phase ?? "ready",
        health: input.health ?? "healthy",
        terminal_ready: terminalReady,
        recording_drain_completed: false,
        completed_module_ids: input.completedModuleIds,
        ssh_host_keys_openssh: terminalReady
          ? ["ssh-ed25519 AAAATEST verifier"]
          : [],
        probes: input.probeIds.map((id) => ({
          id,
          status: "pass",
          observed_at_unix_ms: 500,
        })),
        reported_at_unix_ms: 500,
      }),
    }),
    env,
  );
  if (!response) throw new Error("workspace agent route was not handled");
  return response;
}

async function makeCertificationDue(now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET state = 'ready', updated_at = ? WHERE id = 'cert-allocation'`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE runtime_provider_reconciliation
       SET sweep_after = 0, claim_id = NULL, claim_expires_at = NULL,
           updated_at = ?
       WHERE allocation_id = 'cert-allocation'`,
    ).bind(now),
  ]);
}

async function expectCertificationEvidence(
  expected: Record<string, unknown>,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT evidence_json FROM workshop_runtime_profile_certifications
     WHERE id = 'certification'`,
  ).first<{ evidence_json: string }>();
  expect(JSON.parse(row?.evidence_json ?? "{}")).toMatchObject(expected);
}

async function expectCertificationReboots(expected: number): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS value FROM runtime_provider_operations
     WHERE allocation_id = 'cert-allocation'
       AND operation_kind LIKE 'certification_reboot_%'`,
  ).first<{ value: number }>();
  expect(row?.value).toBe(expected);
}

interface TestHetznerOwnership {
  workshopPublicationRef: string;
  checkpointRef: string;
}

interface TestHetznerResourceRequest {
  resourceKind: "server" | "primary_ip" | "ssh_key";
  externalId: number;
  deterministicName: string;
  ownership: TestHetznerOwnership;
}

interface TestHetznerOperation {
  kind: string;
  resources?: TestHetznerResourceRequest[];
  actionIds?: number[];
  serverId?: number;
  resourceKind?: string;
  externalId?: number;
  deterministicName?: string;
}

interface TestHetznerRequest {
  requestId: string;
  connectionId: string;
  operation: TestHetznerOperation;
}

function installPresentHetznerProviderMock() {
  const ids = {
    server: 158742066,
    primary_ip: 143328111,
    ssh_key: 116370220,
  } as const;
  const runOperation = vi.fn(async (request: TestHetznerRequest) => {
    if (request.operation.kind !== "reconcile") {
      return { canonicalWrites: [], data: {} };
    }
    const resources = request.operation.resources ?? [];
    return {
      canonicalWrites: resources.map((resource) => ({
        requestId: request.requestId,
        connectionId: request.connectionId,
        observedAt: new Date(200).toISOString(),
        operation: "resource_observed",
        resourceKind: resource.resourceKind,
        externalId: ids[resource.resourceKind],
        name: resource.deterministicName,
        state: "running",
        ...(resource.resourceKind === "primary_ip"
          ? { publicIpv4: "192.0.2.42" }
          : {}),
      })),
      data: { resources: resources.map(() => ({ status: "present" })) },
    };
  });
  mocks.invokeProviderOperation.mockImplementation(
    async (
      providerKind: string,
      invoke: (binding: { runOperation: typeof runOperation }) => Promise<unknown>,
    ) => {
      expect(providerKind).toBe("hetzner_cloud");
      return invoke({ runOperation });
    },
  );
  return runOperation;
}

function installStatefulHetznerCleanupMock() {
  const present = {
    server: true,
    primary_ip: true,
    ssh_key: true,
  };
  const ids = {
    server: 158742066,
    primary_ip: 143328111,
    ssh_key: 116370220,
  } as const;
  const deletions: TestHetznerOperation[] = [];
  const runOperation = vi.fn(async (request: TestHetznerRequest) => {
    if (request.operation.kind === "reconcile") {
      const resources = request.operation.resources ?? [];
      return {
        canonicalWrites: resources.map((resource) => ({
          requestId: request.requestId,
          connectionId: request.connectionId,
          observedAt: new Date(200).toISOString(),
          operation: present[resource.resourceKind]
            ? "resource_observed"
            : "resource_deleted",
          resourceKind: resource.resourceKind,
          externalId: ids[resource.resourceKind],
          name: resource.deterministicName,
          state: present[resource.resourceKind] ? "running" : "deleted",
          ...(resource.resourceKind === "primary_ip" &&
          present.primary_ip
            ? { publicIpv4: "192.0.2.42" }
            : {}),
        })),
        data: {
          resources: resources.map((resource) => ({
            status: present[resource.resourceKind] ? "present" : "missing",
          })),
        },
      };
    }
    if (request.operation.kind !== "delete_resource") {
      return { canonicalWrites: [], data: {} };
    }
    deletions.push(request.operation);
    const resourceKind = request.operation.resourceKind as
      | "server"
      | "primary_ip"
      | "ssh_key";
    if (resourceKind === "primary_ip" && present.server) {
      throw new Error("Primary IP deletion was attempted while its server was present");
    }
    if (resourceKind !== "server") present[resourceKind] = false;
    return {
      canonicalWrites: [
        {
          requestId: request.requestId,
          connectionId: request.connectionId,
          observedAt: new Date(200).toISOString(),
          operation:
            resourceKind === "server"
              ? "resource_deletion_requested"
              : "resource_deleted",
          resourceKind,
          externalId: ids[resourceKind],
          name: request.operation.deterministicName,
          state: resourceKind === "server" ? "deleting" : "deleted",
        },
      ],
      data: {},
    };
  });
  mocks.invokeProviderOperation.mockImplementation(
    async (
      providerKind: string,
      invoke: (binding: { runOperation: typeof runOperation }) => Promise<unknown>,
    ) => {
      expect(providerKind).toBe("hetzner_cloud");
      return invoke({ runOperation });
    },
  );
  return {
    completeServerDeletion() {
      present.server = false;
    },
    deleteOperations() {
      return deletions;
    },
  };
}

function installUncoveredHetznerProviderMock() {
  const runOperation = vi.fn(async (request: TestHetznerRequest) => ({
    canonicalWrites: [],
    data: {
      resources: (request.operation.resources ?? []).map(() => ({
        status: "ownership_mismatch",
      })),
    },
  }));
  mocks.invokeProviderOperation.mockImplementation(
    async (
      providerKind: string,
      invoke: (binding: { runOperation: typeof runOperation }) => Promise<unknown>,
    ) => {
      expect(providerKind).toBe("hetzner_cloud");
      return invoke({ runOperation });
    },
  );
  return runOperation;
}

async function seedFalseDisappearedHetznerCertification(): Promise<void> {
  await seedCumulativeCertification({ providerKind: "hetzner_cloud" });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET evidence_json = json_set(
             evidence_json,
             '$.currentCheckpointOrdinal', 1,
             '$.phase', 'awaiting_checkpoint_proof',
             '$.checkpointProofsCompleted', json(?)
           ),
           updated_at = 50
       WHERE id = 'certification'`,
    ).bind(JSON.stringify([{ checkpointId: "checkpoint-00" }])),
    env.DB.prepare(
      `UPDATE runtime_executions
       SET checkpoint_id = 'checkpoint-01', updated_at = 50
       WHERE id = 'cert-execution'`,
    ),
    env.DB.prepare(
      `UPDATE runtime_guest_credentials
       SET checkpoint_bundle_id = 'bundle-01', updated_at = 50
       WHERE execution_id = 'cert-execution'`,
    ),
    ...(
      [
        ["instance", "158742066", "intar-certification"],
        ["ipv4", "143328111", "intar-certification-ipv4"],
        ["ssh_key", "116370220", "intar-certification-ssh"],
      ] as const
    ).map(([resourceKind, providerResourceId, deterministicName]) =>
      env.DB.prepare(
        `INSERT INTO runtime_provider_resources
           (id, allocation_id, provider_kind, resource_kind,
            provider_resource_id, location_attempt, location, provider_state,
            configuration_json, provider_created_at,
            disappearance_confirmed_at, created_at, updated_at)
         VALUES (?, 'cert-allocation', 'hetzner_cloud', ?, ?, 1, 'nbg1',
                 'deleted', ?, 1, 50, 1, 50)`,
      ).bind(
        `resource-${resourceKind}`,
        resourceKind,
        providerResourceId,
        JSON.stringify({ deterministicName }),
      ),
    ),
  ]);
}

async function markHetznerResourcesFalselyDisappeared(
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE runtime_provider_resources
       SET provider_state = 'deleted', disappearance_confirmed_at = ?,
           updated_at = ?
       WHERE allocation_id = 'cert-allocation'`,
    ).bind(now, now),
    env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET external_ipv4 = NULL, updated_at = ?
       WHERE id = 'cert-allocation'`,
    ).bind(now),
  ]);
}

async function setCertificationPhase(
  phase: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_runtime_profile_certifications
     SET evidence_json = json_set(evidence_json, '$.phase', ?), updated_at = ?
     WHERE id = 'certification'`,
  )
    .bind(phase, now)
    .run();
}

async function expectHetznerResourcesPresent(): Promise<void> {
  const resources = await env.DB.prepare(
    `SELECT resource_kind, provider_state, disappearance_confirmed_at
     FROM runtime_provider_resources
     WHERE allocation_id = 'cert-allocation'
     ORDER BY resource_kind`,
  ).all<{
    resource_kind: string;
    provider_state: string;
    disappearance_confirmed_at: number | null;
  }>();
  expect(resources.results).toEqual([
    {
      resource_kind: "instance",
      provider_state: "running",
      disappearance_confirmed_at: null,
    },
    {
      resource_kind: "ipv4",
      provider_state: "running",
      disappearance_confirmed_at: null,
    },
    {
      resource_kind: "ssh_key",
      provider_state: "running",
      disappearance_confirmed_at: null,
    },
  ]);
  const allocation = await env.DB.prepare(
    `SELECT external_ipv4 FROM runtime_provider_allocations
     WHERE id = 'cert-allocation'`,
  ).first<{ external_ipv4: string | null }>();
  expect(allocation?.external_ipv4).toBe("192.0.2.42");
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
