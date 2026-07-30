/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({
  run: vi.fn(),
  finalize: vi.fn(),
  operations: [] as Array<Record<string, unknown>>,
  dependencySnapshots: [] as Array<Record<string, unknown>>,
  resources: new Map<string, number>(),
}));
const featureFlags = vi.hoisted(() => ({
  hcloudRuntimeEnabled: vi.fn(),
}));

vi.mock("@/lib/hcloud-provider-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hcloud-provider-service")>()),
  hcloudRunOperation: provider.run,
}));

vi.mock("@/control-plane/workshop-registry", () => ({
  finalizeVerifiedWorkshopProviderPublication: provider.finalize,
}));

vi.mock("@/lib/workshops/feature-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workshops/feature-flag")>()),
  isWorkshopHcloudRuntimeEnabledForOrganization:
    featureFlags.hcloudRuntimeEnabled,
}));

import type {
  CanonicalProviderWrite,
  HcloudOperationResult,
  RunOperationRequest,
} from "../../../../hcloud-provider-worker/src/contracts";
import { assertDeterministicName } from "../../../../hcloud-provider-worker/src/hcloud-client";
import { appError } from "@/lib/app-error";
import { d1Migrations, resetD1Database } from "@/test/d1-migrations";
import { sweepHetznerWorkshopPublicationVerifiers } from "./hcloud-publication-verifier";

const NOW = 1_800_000_000_000;
const CONNECTION_ID = "connection-verifier";
const CREDENTIAL_ID = "credential-verifier";
const PUBLICATION_ID = "publication-verifier";
const CHECKPOINT_ID = "provider-checkpoint-00";
const AGENT_SHA = "a".repeat(64);
const KINO_SHA = "b".repeat(64);
const ARTIFACT_SHA = "c".repeat(64);
const SIGNATURE = btoa(String.fromCharCode(...new Uint8Array(64)));

describe("direct Hetzner workshop publication verifier lifecycle", () => {
  beforeEach(async () => {
    await resetD1Database();
    provider.run.mockReset();
    provider.run.mockImplementation(providerOperation);
    provider.finalize.mockReset();
    provider.finalize.mockResolvedValue(true);
    provider.operations.length = 0;
    provider.dependencySnapshots.length = 0;
    provider.resources.clear();
    featureFlags.hcloudRuntimeEnabled.mockReset();
    featureFlags.hcloudRuntimeEnabled.mockResolvedValue(true);
    await seedFixture();
  });

  it("waits without provider mutation until the organization runtime flag is enabled", async () => {
    featureFlags.hcloudRuntimeEnabled.mockResolvedValue(false);

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW }),
    ).resolves.toMatchObject({
      checkpointId: "00",
      state: "waiting",
    });
    expect(featureFlags.hcloudRuntimeEnabled).toHaveBeenCalledWith(
      "org-verifier",
    );
    expect(provider.run).not.toHaveBeenCalled();
    await expect(
      count("workshop_publication_provider_cost_ledger"),
    ).resolves.toBe(0);
    expect(provider.operations).toEqual([]);
    expect(await currentAttempt()).toBeNull();
    await expect(checkpointStatus()).resolves.toBe("pending");

    featureFlags.hcloudRuntimeEnabled.mockResolvedValue(true);
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 }),
    ).resolves.toMatchObject({ state: "allocating" });
    expect(await currentAttempt()).toMatchObject({ state: "allocating" });
    expect(provider.operations.length).toBeGreaterThan(0);

    // Once an attempt exists, disabling new allocations cannot strand its
    // reconcile or cleanup lifecycle.
    featureFlags.hcloudRuntimeEnabled.mockResolvedValue(false);
    featureFlags.hcloudRuntimeEnabled.mockClear();
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 2 }),
    ).resolves.toMatchObject({ state: "bootstrapping" });
    expect(featureFlags.hcloudRuntimeEnabled).not.toHaveBeenCalled();
    expect(
      provider.operations.some((operation) => operation.kind === "reconcile"),
    ).toBe(true);
  });

  it("uses provider-canonical Intar names for every verifier resource", async () => {
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW }),
    ).resolves.toMatchObject({ state: "allocating" });

    const creates = provider.operations.filter((operation) =>
      ["create_ssh_key", "create_primary_ip", "create_server"].includes(
        String(operation.kind),
      ),
    );
    expect(creates).toHaveLength(3);
    expect(creates.map((operation) => String(operation.name))).toEqual([
      expect.stringMatching(/^intar-wpv-[a-z0-9]+-key$/),
      expect.stringMatching(/^intar-wpv-[a-z0-9]+-ip-nbg1$/),
      expect.stringMatching(/^intar-wpv-[a-z0-9]+$/),
    ]);
    for (const operation of creates) {
      expect(() =>
        assertDeterministicName(String(operation.name)),
      ).not.toThrow();
    }
    await expect(currentAttempt()).resolves.toMatchObject({
      deterministic_name: creates.at(-1)?.name,
    });
  });

  it("recovers the legacy no-resource name failure without a provider call", async () => {
    await seedLegacyNameFailure();
    provider.operations.length = 0;
    provider.run.mockClear();

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 }),
    ).resolves.toMatchObject({ state: "deleting" });
    expect(provider.run).not.toHaveBeenCalled();
    await expect(currentAttempt()).resolves.toMatchObject({
      ordinal: 1,
      state: "deleted",
      deterministic_name: "iwpv-legacyattempt",
      server_id: null,
      primary_ip_id: null,
      ssh_key_id: null,
      create_action_id: null,
      delete_action_id: null,
      deletion_confirmed_at: NOW + 1,
    });
    await expect(checkpointStatus()).resolves.toBe("pending");
    await expect(publicationAndConnectionState()).resolves.toEqual({
      publication: "verifying",
      connection: "active",
    });

    provider.run.mockImplementation(async (request: RunOperationRequest) => {
      if (request.operation.kind === "catalog") {
        const serverType = request.operation.requiredServerTypes[0] ?? "cpx42";
        return {
          data: catalog({ serverType }),
          canonicalWrites: [],
          mustPersistBeforeNextOperation: false,
        };
      }
      return providerOperation(request);
    });
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 2 }),
    ).resolves.toMatchObject({ state: "allocating" });
    const replacement = await currentAttempt();
    expect(replacement).toMatchObject({
      ordinal: 2,
      state: "allocating",
      server_type: "cpx42",
      deterministic_name: expect.stringMatching(/^intar-wpv-[a-z0-9]+$/),
    });
    expect(
      provider.operations.find(
        (operation) => operation.kind === "create_server",
      ),
    ).toMatchObject({
      name: replacement?.deterministic_name,
      serverType: "cpx42",
    });
  });

  it("resumes a partially persisted legacy recovery without provider access", async () => {
    await seedLegacyNameFailure();
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleted', deletion_confirmed_at = ?, updated_at = ?
       WHERE id = 'legacyattempt'`,
    )
      .bind(NOW, NOW)
      .run();
    provider.run.mockClear();

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 }),
    ).resolves.toMatchObject({ state: "deleting" });
    expect(provider.run).not.toHaveBeenCalled();
    await expect(checkpointStatus()).resolves.toBe("pending");
    await expect(publicationAndConnectionState()).resolves.toEqual({
      publication: "verifying",
      connection: "active",
    });
  });

  it("does not bypass provider reconciliation for an unsafe legacy attempt", async () => {
    await seedLegacyNameFailure({ sshKeyId: "201" });
    provider.run.mockRejectedValue(
      appError(
        400,
        "invalid_provider_request",
        "Provider resource name must be a canonical Intar DNS label",
      ),
    );

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 }),
    ).resolves.toMatchObject({ state: "cleanup_pending" });
    expect(provider.run).toHaveBeenCalledTimes(1);
    await expect(currentAttempt()).resolves.toMatchObject({
      state: "cleanup_pending",
      ssh_key_id: "201",
      deletion_confirmed_at: null,
    });
    await expect(checkpointStatus()).resolves.toBe("cleanup_pending");
    await expect(publicationAndConnectionState()).resolves.toEqual({
      publication: "cleanup_pending",
      connection: "cleanup_pending",
    });
  });

  it("does not let an older flag-off organization block a later enabled publication", async () => {
    await insertAdditionalPublicationFixture("later", NOW + 1);
    featureFlags.hcloudRuntimeEnabled.mockImplementation(
      async (organizationId: string) => organizationId !== "org-verifier",
    );

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 2 }),
    ).resolves.toMatchObject({
      publicationId: "publication-later",
      checkpointId: "00-later",
      state: "allocating",
    });
    expect(await attemptCount(CHECKPOINT_ID)).toBe(0);
    expect(await attemptCount("provider-checkpoint-later")).toBe(1);
    expect(provider.operations.length).toBeGreaterThan(0);
  });

  it("does not let an older capacity-waiting type block a later type on the same connection", async () => {
    await insertSameConnectionPublicationFixture("cpx42", NOW + 1, "cpx42");
    provider.run.mockImplementation(async (request: RunOperationRequest) => {
      if (request.operation.kind === "catalog") {
        const serverType = request.operation.requiredServerTypes[0] ?? "cx43";
        return {
          data: catalog({
            serverType,
            available: serverType !== "cx43",
          }),
          canonicalWrites: [],
          mustPersistBeforeNextOperation: false,
        };
      }
      return providerOperation(request);
    });

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 2 }),
    ).resolves.toMatchObject({
      publicationId: PUBLICATION_ID,
      checkpointId: "00",
      state: "waiting",
    });
    expect(await attemptCount(CHECKPOINT_ID)).toBe(0);
    expect(await attemptCount("provider-checkpoint-cpx42")).toBe(0);

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 3 }),
    ).resolves.toMatchObject({
      publicationId: "publication-cpx42",
      checkpointId: "00-cpx42",
      state: "allocating",
    });
    expect(await attemptCount(CHECKPOINT_ID)).toBe(0);
    expect(await attemptCount("provider-checkpoint-cpx42")).toBe(1);
    expect(
      provider.operations.find(
        (operation) => operation.kind === "create_server",
      ),
    ).toMatchObject({ serverType: "cpx42" });
  });

  it("does not let stuck cleanup block a later publication", async () => {
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW });
    const attempt = await currentAttempt();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_publication_provider_attempts
         SET state = 'cleanup_pending', updated_at = ? WHERE id = ?`,
      ).bind(NOW + 1, attempt?.id),
      env.DB.prepare(
        `UPDATE workshop_publication_provider_checkpoints
         SET verification_status = 'cleanup_pending', updated_at = ?
         WHERE id = ?`,
      ).bind(NOW + 1, CHECKPOINT_ID),
      env.DB.prepare(
        `UPDATE workshop_publications
         SET provider_verification_state = 'cleanup_pending', updated_at = ?
         WHERE id = ?`,
      ).bind(NOW + 1, PUBLICATION_ID),
      env.DB.prepare(
        `UPDATE organization_provider_connections
         SET state = 'cleanup_pending', active_credential_version_id = NULL,
             updated_at = ? WHERE id = ?`,
      ).bind(NOW + 1, CONNECTION_ID),
    ]);
    await insertAdditionalPublicationFixture("later", NOW + 2);
    provider.operations.length = 0;

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 3 }),
    ).resolves.toMatchObject({
      publicationId: "publication-later",
      checkpointId: "00-later",
      state: "allocating",
    });
    expect(await checkpointStatus()).toBe("cleanup_pending");
    expect(await attemptCount("provider-checkpoint-later")).toBe(1);
  });

  it("finalizes a ready publication before scanning other candidates", async () => {
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'verified', proof_verified_at = ?,
           deletion_confirmed_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(NOW + 1, NOW + 2, NOW + 2, CHECKPOINT_ID)
      .run();
    await insertAdditionalPublicationFixture("later", NOW + 3);

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 4 }),
    ).resolves.toEqual({
      processed: true,
      publicationId: PUBLICATION_ID,
      state: "verified",
    });
    expect(provider.finalize).toHaveBeenCalledWith({
      publicationId: PUBLICATION_ID,
      now: NOW + 4,
    });
    expect(provider.run).not.toHaveBeenCalled();
    expect(await attemptCount("provider-checkpoint-later")).toBe(0);
  });

  it("allocates through the provider harness, proves one checkpoint, and confirms ordered cleanup", async () => {
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW }),
    ).resolves.toMatchObject({
      checkpointId: "00",
      state: "allocating",
    });

    const attempt = await currentAttempt();
    expect(attempt).toMatchObject({
      state: "allocating",
      server_id: "401",
      primary_ip_id: "301",
      primary_ipv4: "192.0.2.31",
      ssh_key_id: "201",
      location: "nbg1",
    });
    expect(provider.dependencySnapshots).toEqual([
      { operation: "create_primary_ip", sshKeyId: "201" },
      {
        operation: "create_server",
        sshKeyId: "201",
        primaryIpId: "301",
        primaryIpv4: "192.0.2.31",
      },
    ]);
    const serverCreate = provider.operations.find(
      (operation) => operation.kind === "create_server",
    );
    expect(serverCreate).toMatchObject({
      serverType: "cx43",
      systemImage: "debian-13",
      location: "nbg1",
      firewallId: 42,
    });
    expect(String(serverCreate?.cloudInit)).toContain(
      "/api/runtime/workshop-publication-verifier/",
    );
    expect(String(serverCreate?.cloudInit)).toContain(
      'probe "workspace-ready"',
    );

    // Creation success is not guest readiness: the sweep must reconcile a
    // running server before exposing the verifier bootstrap state.
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 }),
    ).resolves.toMatchObject({ state: "bootstrapping" });

    const proofAt = NOW + 2;
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'proof_succeeded', proof_report_sequence = 7,
           proof_verified_at = ?, last_report_sequence = 7,
           last_report_phase = 'ready', last_report_health = 'healthy',
           last_report_at = ?, checkpoint_first_downloaded_at = ?,
           report_json = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        proofAt,
        proofAt,
        NOW + 1,
        JSON.stringify({
          phase: "ready",
          health: "healthy",
          terminal_ready: true,
          ssh_host_keys_openssh: ["ssh-ed25519 AAAATEST verifier"],
          probes: [{ id: "workspace-ready", status: "pass" }],
        }),
        proofAt,
        attempt?.id,
      )
      .run();

    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 3 }),
    ).resolves.toMatchObject({ state: "deleting" });
    for (let offset = 4; offset <= 7; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    expect(
      provider.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
    const finished = await currentAttempt();
    expect(finished).toMatchObject({
      state: "deleted",
      server_id: "401",
      primary_ip_id: "301",
      ssh_key_id: "201",
      proof_verified_at: proofAt,
      deletion_confirmed_at: expect.any(Number),
    });
    const checkpoint = await env.DB.prepare(
      `SELECT verification_status, proof_verified_at, deletion_confirmed_at,
              price_observation_json
       FROM workshop_publication_provider_checkpoints WHERE id = ?`,
    )
      .bind(CHECKPOINT_ID)
      .first<Record<string, unknown>>();
    expect(checkpoint).toMatchObject({
      verification_status: "verified",
      proof_verified_at: proofAt,
      deletion_confirmed_at: expect.any(Number),
    });
    const allocationPrice = JSON.parse(
      String(checkpoint?.price_observation_json),
    ) as {
      observedAt: number;
      locations: Array<{ serverHourlyGross: string }>;
    };
    expect(allocationPrice.observedAt).toBe(NOW);
    expect(allocationPrice.locations[0]?.serverHourlyGross).toBe("0.6250");
    const ledgers = await env.DB.prepare(
      `SELECT resource_kind, provider_resource_id, hourly_gross_raw,
              deletion_confirmed_at
       FROM workshop_publication_provider_cost_ledger ORDER BY resource_kind`,
    ).all<Record<string, unknown>>();
    expect(ledgers.results).toEqual([
      expect.objectContaining({
        resource_kind: "primary_ipv4",
        provider_resource_id: "301",
        hourly_gross_raw: "0.0125",
        deletion_confirmed_at: expect.any(Number),
      }),
      expect.objectContaining({
        resource_kind: "server",
        provider_resource_id: "401",
        hourly_gross_raw: "0.6250",
        deletion_confirmed_at: expect.any(Number),
      }),
    ]);
    expect(provider.finalize).toHaveBeenCalledWith({
      publicationId: PUBLICATION_ID,
      now: NOW + 7,
    });
    await expect(nonPublicationRuntimeCounts()).resolves.toEqual({
      executions: 0,
      workspaces: 0,
      generations: 0,
      slots: 0,
      routes: 0,
    });
  });

  it("does not retry a deterministic guest proof failure", async () => {
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW });
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 });
    const attempt = await currentAttempt();
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'failed', last_error_code = 'guest_reported_failure',
           error = 'deterministic probe failed', updated_at = ?
       WHERE id = ?`,
    )
      .bind(NOW + 2, attempt?.id)
      .run();

    for (let offset = 2; offset <= 6; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    const publication = await env.DB.prepare(
      `SELECT status, provider_verification_state
       FROM workshop_publications WHERE id = ?`,
    )
      .bind(PUBLICATION_ID)
      .first<Record<string, unknown>>();
    expect(publication).toEqual({
      status: "failed",
      provider_verification_state: "failed",
    });
    const attempts = await env.DB.prepare(
      `SELECT ordinal, state FROM workshop_publication_provider_attempts
       WHERE provider_checkpoint_id = ?`,
    )
      .bind(CHECKPOINT_ID)
      .all<Record<string, unknown>>();
    expect(attempts.results).toEqual([{ ordinal: 1, state: "deleted" }]);
    const checkpoint = await providerCheckpointCleanupSummary();
    expect(checkpoint).toEqual({
      verification_status: "failed",
      deletion_confirmed_at: expect.any(Number),
    });
    expect(checkpoint?.deletion_confirmed_at).toBe(
      (
        await env.DB.prepare(
          `SELECT deletion_confirmed_at
           FROM workshop_publication_provider_attempts
           WHERE provider_checkpoint_id = ?`,
        )
          .bind(CHECKPOINT_ID)
          .first<{ deletion_confirmed_at: number }>()
      )?.deletion_confirmed_at,
    );
    expect(provider.finalize).not.toHaveBeenCalled();
  });

  it("retries a persistent ready-state probe failure after confirmed cleanup", async () => {
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW });
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 });
    const attempt = await currentAttempt();
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'failed',
           last_error_code = 'publication_verifier_probe_persisted',
           error = 'required workshop probe remained failed after readiness',
           updated_at = ?
       WHERE id = ?`,
    )
      .bind(NOW + 2, attempt?.id)
      .run();

    for (let offset = 2; offset <= 6; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    await expect(providerCheckpointCleanupSummary()).resolves.toEqual({
      verification_status: "pending",
      deletion_confirmed_at: null,
    });

    for (let offset = 7; offset <= 8; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    const publication = await env.DB.prepare(
      `SELECT status, provider_verification_state
       FROM workshop_publications WHERE id = ?`,
    )
      .bind(PUBLICATION_ID)
      .first<Record<string, unknown>>();
    expect(publication).toEqual({
      status: "building",
      provider_verification_state: "verifying",
    });
    const attempts = await env.DB.prepare(
      `SELECT ordinal, state, deletion_confirmed_at
       FROM workshop_publication_provider_attempts
       WHERE provider_checkpoint_id = ?
       ORDER BY ordinal`,
    )
      .bind(CHECKPOINT_ID)
      .all<Record<string, unknown>>();
    expect(attempts.results).toEqual([
      {
        ordinal: 1,
        state: "deleted",
        deletion_confirmed_at: expect.any(Number),
      },
      expect.objectContaining({ ordinal: 2 }),
    ]);
    expect(provider.finalize).not.toHaveBeenCalled();
  });

  it("resumes cleanup after provider access returns and restores publication state", async () => {
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW });
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 });
    const attempt = await currentAttempt();
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'proof_succeeded', proof_report_sequence = 4,
           proof_verified_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(NOW + 2, NOW + 2, attempt?.id)
      .run();
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 2 });

    await env.DB.prepare(
      `UPDATE organization_provider_connections
       SET active_credential_version_id = NULL, updated_at = ? WHERE id = ?`,
    )
      .bind(NOW + 3, CONNECTION_ID)
      .run();
    await expect(
      sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 3 }),
    ).resolves.toMatchObject({ state: "cleanup_pending" });
    await expect(publicationAndConnectionState()).resolves.toEqual({
      publication: "cleanup_pending",
      connection: "cleanup_pending",
    });

    await env.DB.prepare(
      `UPDATE organization_provider_connections
       SET active_credential_version_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(CREDENTIAL_ID, NOW + 4, CONNECTION_ID)
      .run();
    for (let offset = 4; offset <= 7; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    await expect(publicationAndConnectionState()).resolves.toEqual({
      publication: "verifying",
      connection: "active",
    });
    expect(provider.finalize).toHaveBeenCalledWith({
      publicationId: PUBLICATION_ID,
      now: NOW + 7,
    });
  });

  it("keeps later checkpoints pending until the predecessor is verified", async () => {
    await insertSecondCheckpoint();
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW });
    await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + 1 });

    const rows = await env.DB.prepare(
      `SELECT checkpoint.checkpoint_id, checkpoint.verification_status,
              count(attempt.id) AS attempts
       FROM workshop_publication_provider_checkpoints checkpoint
       LEFT JOIN workshop_publication_provider_attempts attempt
         ON attempt.provider_checkpoint_id = checkpoint.id
       GROUP BY checkpoint.id ORDER BY checkpoint.ordinal`,
    ).all<Record<string, unknown>>();
    expect(rows.results).toEqual([
      {
        checkpoint_id: "00",
        verification_status: "bootstrapping",
        attempts: 1,
      },
      {
        checkpoint_id: "01",
        verification_status: "pending",
        attempts: 0,
      },
    ]);
  });

  it("uses at most two replacement attempts across the pinned location order", async () => {
    let failedCreates = 0;
    provider.run.mockImplementation(async (request: RunOperationRequest) => {
      if (request.operation.kind === "create_server" && failedCreates < 2) {
        provider.operations.push(
          request.operation as unknown as Record<string, unknown>,
        );
        failedCreates += 1;
        throw appError(
          503,
          "hcloud_resource_unavailable",
          "location temporarily unavailable",
        );
      }
      return providerOperation(request);
    });

    for (let offset = 0; offset <= 8; offset += 1) {
      await sweepHetznerWorkshopPublicationVerifiers({ now: NOW + offset });
    }

    expect(
      provider.operations
        .filter((operation) => operation.kind === "create_server")
        .map((operation) => operation.location),
    ).toEqual(["nbg1", "fsn1", "hel1"]);
    const attempts = await env.DB.prepare(
      `SELECT ordinal, location, state
       FROM workshop_publication_provider_attempts
       ORDER BY ordinal`,
    ).all<Record<string, unknown>>();
    expect(attempts.results).toEqual([
      { ordinal: 1, location: "nbg1", state: "deleted" },
      { ordinal: 2, location: "fsn1", state: "deleted" },
      { ordinal: 3, location: "hel1", state: "allocating" },
    ]);
  });
});

describe("failed provider checkpoint cleanup backfill", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(
      env.DB,
      d1Migrations.filter((migration) => migration.name < "0019"),
    );
    await seedFixture();
  });

  it("backfills only failed checkpoints whose every attempt is deletion-confirmed", async () => {
    await insertProviderCheckpoint({
      id: "provider-checkpoint-retry",
      checkpointId: "retry",
      ordinal: 1,
    });
    await insertProviderCheckpoint({
      id: "provider-checkpoint-unconfirmed",
      checkpointId: "unconfirmed",
      ordinal: 2,
    });
    await insertProviderCheckpoint({
      id: "provider-checkpoint-empty",
      checkpointId: "empty",
      ordinal: 3,
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workshop_publication_provider_checkpoints
         SET verification_status = 'failed' WHERE id = ?`,
      ).bind(CHECKPOINT_ID),
      env.DB.prepare(
        `UPDATE workshop_publication_provider_checkpoints
         SET verification_status = 'failed' WHERE id = ?`,
      ).bind("provider-checkpoint-unconfirmed"),
      env.DB.prepare(
        `UPDATE workshop_publication_provider_checkpoints
         SET verification_status = 'failed' WHERE id = ?`,
      ).bind("provider-checkpoint-empty"),
    ]);
    await insertCleanupAttempt({
      id: "failed-attempt-1",
      checkpointId: CHECKPOINT_ID,
      ordinal: 1,
      deletionConfirmedAt: NOW + 10,
    });
    await insertCleanupAttempt({
      id: "failed-attempt-2",
      checkpointId: CHECKPOINT_ID,
      ordinal: 2,
      deletionConfirmedAt: NOW + 20,
    });
    await insertCleanupAttempt({
      id: "retry-attempt-1",
      checkpointId: "provider-checkpoint-retry",
      ordinal: 1,
      deletionConfirmedAt: NOW + 30,
    });
    await insertCleanupAttempt({
      id: "unconfirmed-attempt-1",
      checkpointId: "provider-checkpoint-unconfirmed",
      ordinal: 1,
      deletionConfirmedAt: NOW + 40,
    });
    await insertCleanupAttempt({
      id: "unconfirmed-attempt-2",
      checkpointId: "provider-checkpoint-unconfirmed",
      ordinal: 2,
      deletionConfirmedAt: null,
    });

    const repair = d1Migrations.filter(
      (migration) =>
        migration.name ===
        "0019_failed_workshop_checkpoint_cleanup_backfill.sql",
    );
    expect(repair).toHaveLength(1);
    await applyD1Migrations(env.DB, repair);

    const summaries = await providerCheckpointCleanupSummaries();
    expect(summaries).toEqual([
      {
        id: CHECKPOINT_ID,
        verification_status: "failed",
        deletion_confirmed_at: NOW + 20,
      },
      {
        id: "provider-checkpoint-retry",
        verification_status: "pending",
        deletion_confirmed_at: null,
      },
      {
        id: "provider-checkpoint-unconfirmed",
        verification_status: "failed",
        deletion_confirmed_at: null,
      },
      {
        id: "provider-checkpoint-empty",
        verification_status: "failed",
        deletion_confirmed_at: null,
      },
    ]);

    for (const migration of repair) {
      for (const query of migration.queries) {
        await env.DB.prepare(query).run();
      }
    }
    await expect(providerCheckpointCleanupSummaries()).resolves.toEqual(
      summaries,
    );
  });
});

async function providerOperation(
  request: RunOperationRequest,
): Promise<HcloudOperationResult> {
  const operation = request.operation;
  provider.operations.push(operation as unknown as Record<string, unknown>);
  if (operation.kind === "catalog") {
    return {
      data: catalog(),
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    };
  }
  if (operation.kind === "create_ssh_key") {
    provider.resources.set("ssh_key", 201);
    return operationResult(
      canonicalWrite(request, "ssh_key", 201, "resource_created"),
    );
  }
  if (operation.kind === "create_primary_ip") {
    const row = await currentAttempt();
    provider.dependencySnapshots.push({
      operation: operation.kind,
      sshKeyId: row?.ssh_key_id,
    });
    provider.resources.set("primary_ip", 301);
    return operationResult(
      canonicalWrite(
        request,
        "primary_ip",
        301,
        "resource_created",
        "192.0.2.31",
      ),
    );
  }
  if (operation.kind === "create_server") {
    const row = await currentAttempt();
    provider.dependencySnapshots.push({
      operation: operation.kind,
      sshKeyId: row?.ssh_key_id,
      primaryIpId: row?.primary_ip_id,
      primaryIpv4: row?.primary_ipv4,
    });
    provider.resources.set("server", 401);
    return operationResult({
      ...canonicalWrite(request, "server", 401, "resource_created"),
      actionIds: [901],
    });
  }
  if (operation.kind === "get_action") {
    return {
      data: {
        id: operation.actionId,
        status: "success",
        command: "provider_action",
        progress: 100,
        started: providerTime(),
        finished: providerTime(),
        error: null,
        resources: [],
      },
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    };
  }
  if (operation.kind === "reconcile") {
    const resources = operation.resources.map((ref) => {
      const externalId = provider.resources.get(ref.resourceKind);
      return externalId === undefined
        ? { ref, status: "missing" as const }
        : {
            ref,
            status: "present" as const,
            externalId,
            state: ref.resourceKind === "server" ? "running" : "ready",
            ...(ref.resourceKind === "primary_ip"
              ? { publicIpv4: "192.0.2.31" }
              : {}),
            resourceCreatedAt: providerTime(),
          };
    });
    const data = {
      observedAt: providerTime(),
      resources,
      actions: operation.actionIds.map((id) => ({
        id,
        status: "success" as const,
        command: "provider_action",
        progress: 100,
        started: providerTime(),
        finished: providerTime(),
        error: null,
        resources: [],
      })),
      canonicalWrites: [],
    };
    return {
      data,
      canonicalWrites: resources.flatMap((resource) =>
        resource.status === "present" && resource.externalId !== undefined
          ? [
              {
                ...canonicalWrite(
                  request,
                  resource.ref.resourceKind,
                  resource.externalId,
                  "resource_observed",
                  "publicIpv4" in resource ? resource.publicIpv4 : undefined,
                ),
                resourceCreatedAt: resource.resourceCreatedAt,
              },
            ]
          : [],
      ),
      mustPersistBeforeNextOperation: true,
    };
  }
  if (operation.kind === "delete_resource") {
    provider.resources.delete(operation.resourceKind);
    return operationResult({
      ...canonicalWrite(
        request,
        operation.resourceKind,
        operation.externalId,
        "resource_deletion_requested",
      ),
      actionIds: [1_000 + operation.externalId],
    });
  }
  throw new Error(`unexpected provider operation ${operation.kind}`);
}

function operationResult(write: CanonicalProviderWrite): HcloudOperationResult {
  return {
    data: {},
    canonicalWrites: [write],
    mustPersistBeforeNextOperation: true,
  };
}

function canonicalWrite(
  request: RunOperationRequest,
  resourceKind: CanonicalProviderWrite["resourceKind"],
  externalId: number,
  operation: CanonicalProviderWrite["operation"],
  publicIpv4?: string,
): CanonicalProviderWrite {
  return {
    requestId: request.requestId,
    connectionId: request.connectionId,
    observedAt: providerTime(),
    resourceCreatedAt: providerTime(),
    operation,
    resourceKind,
    externalId,
    actionIds: [],
    ...(publicIpv4 ? { publicIpv4 } : {}),
  };
}

function providerTime(): string {
  return new Date(NOW).toISOString();
}

function catalog(options: { serverType?: string; available?: boolean } = {}) {
  const serverType = options.serverType ?? "cx43";
  const available = options.available ?? true;
  const prices = ["nbg1", "fsn1", "hel1"].map((location, index) => ({
    location,
    price_hourly: {
      net: `0.${5000 + index * 100}`,
      gross: `0.${6250 + index * 125}`,
    },
    price_monthly: { net: "250.0000", gross: "312.5000" },
    included_traffic: 0,
    price_per_tb_traffic: { net: "0", gross: "0" },
  }));
  return {
    observedAt: providerTime(),
    serverTypes: [
      {
        id: serverType === "cx43" ? 43 : 42,
        name: serverType,
        description: serverType.toUpperCase(),
        category: "cost_optimized",
        cores: 8,
        memory: 16,
        disk: 160,
        storage_type: "local",
        cpu_type: "shared",
        architecture: "x86",
        deprecated: false,
        deprecation: null,
        locations: ["nbg1", "fsn1", "hel1"].map((name, index) => ({
          id: index + 1,
          name,
          recommended: index === 0,
          available,
        })),
      },
    ],
    locations: [],
    systemImages: [
      {
        id: 13,
        status: "available",
        type: "system",
        name: "debian-13",
        description: "Debian 13",
        architecture: "x86",
        deprecated: null,
        deleted: null,
        os_flavor: "debian",
        os_version: "13",
      },
    ],
    pricing: {
      currency: "NOK",
      vat_rate: "25.0",
      server_types: [
        {
          id: serverType === "cx43" ? 43 : 42,
          name: serverType,
          prices,
        },
      ],
      primary_ips: [
        {
          type: "ipv4",
          prices: ["nbg1", "fsn1", "hel1"].map((location) => ({
            location,
            price_hourly: { net: "0.0100", gross: "0.0125" },
            price_monthly: { net: "5.0000", gross: "6.2500" },
          })),
        },
      ],
    },
  };
}

async function seedFixture(): Promise<void> {
  await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/releases/${AGENT_SHA}/intar-workspace-agent`,
      "agent",
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/kino/releases/${KINO_SHA}/kino`,
      "kino",
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `artifacts/sha256/${ARTIFACT_SHA.slice(0, 2)}/${ARTIFACT_SHA}`,
      new Uint8Array(128),
      { customMetadata: { artifact_sha256: ARTIFACT_SHA } },
    ),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, email_verified, created_at, updated_at
       ) VALUES ('owner-verifier', 'Owner', 'owner@example.test', 1, ?, ?)`,
    ).bind(NOW, NOW),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('org-verifier', 'Verifier Org', 'verifier-org', ?)`,
    ).bind(NOW),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by,
         created_at
       ) VALUES ('registry-token-verifier', 'org-verifier', 'test', 'test',
                 ?, 'owner-verifier', ?)`,
    ).bind("f".repeat(64), NOW),
    env.DB.prepare(
      `INSERT INTO organization_provider_connections (
         id, organization_id, provider_kind, display_name, state,
         project_fingerprint, sentinel_firewall_id,
         approved_locations_json, max_concurrent_servers, currency,
         ipv4_enabled, last_validated_at, created_by, created_at, updated_at
       ) VALUES (?, 'org-verifier', 'hetzner_cloud', 'Verifier project',
                 'active', 'project-fingerprint', '42', ?, 5, 'NOK', 1, ?,
                 'owner-verifier', ?, ?)`,
    ).bind(
      CONNECTION_ID,
      JSON.stringify(["nbg1", "fsn1", "hel1"]),
      NOW,
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publications (
         id, organization_id, workshop_slug, content_hash, source_r2_key,
         compiled_manifest_json, required_checkpoint_ids_json, status,
         submitted_by, registry_token_id, provider_verification_state,
         created_at, updated_at
       ) VALUES (?, 'org-verifier', 'test-workshop', ?, 'source/test.tar.zst',
                 '{}', '["00"]', 'building', 'owner-verifier',
                 'registry-token-verifier', 'verifying', ?, ?)`,
    ).bind(PUBLICATION_ID, "d".repeat(64), NOW, NOW),
  ]);
  await env.DB.prepare(
    `INSERT INTO provider_credential_versions (
       id, connection_id, version, algorithm, kek_version, aad_sha256,
       encrypted_token_b64, token_iv_b64, wrapped_dek_b64, dek_iv_b64,
       envelope_created_at, token_fingerprint, created_by, activated_at,
       created_at
     ) VALUES (?, ?, 1, 'AES-256-GCM', 'v1', ?, 'encrypted-token',
               'token-iv', 'wrapped-dek', 'dek-iv', ?, 'fingerprint',
               'owner-verifier', ?, ?)`,
  )
    .bind(CREDENTIAL_ID, CONNECTION_ID, "e".repeat(64), NOW, NOW, NOW)
    .run();
  await env.DB.prepare(
    `UPDATE organization_provider_connections
     SET active_credential_version_id = ? WHERE id = ?`,
  )
    .bind(CREDENTIAL_ID, CONNECTION_ID)
    .run();
  await insertProviderCheckpoint({
    id: CHECKPOINT_ID,
    checkpointId: "00",
    ordinal: 0,
  });
}

async function insertSecondCheckpoint(): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_publications
     SET required_checkpoint_ids_json = '["00","01"]' WHERE id = ?`,
  )
    .bind(PUBLICATION_ID)
    .run();
  await insertProviderCheckpoint({
    id: "provider-checkpoint-01",
    checkpointId: "01",
    ordinal: 1,
  });
}

async function seedLegacyNameFailure(
  input: { sshKeyId?: string } = {},
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET resolved_provider_json = json_set(
             resolved_provider_json, '$.serverType', 'cpx42'
           ),
           price_observation_json = json_set(
             price_observation_json, '$.serverType', 'cpx42'
           ),
           verification_status = 'cleanup_pending',
           error = 'Provider resource name must be a canonical Intar DNS label',
           updated_at = ?
       WHERE id = ?`,
    ).bind(NOW, CHECKPOINT_ID),
    env.DB.prepare(
      `INSERT INTO workshop_publication_provider_attempts (
         id, provider_checkpoint_id, connection_id, ordinal,
         deterministic_name, server_type, system_image, location, ssh_key_id,
         state, control_plane_base_url, bootstrap_token_hash,
         bootstrap_expires_at, report_credential_expires_at,
         deletion_requested_at, last_error_code, error, created_at, updated_at
       ) VALUES (
         'legacyattempt', ?, ?, 1, 'iwpv-legacyattempt', 'cpx42',
         'debian-13', 'nbg1', ?, 'cleanup_pending', 'https://intar.dev/',
         ?, ?, ?, ?, 'invalid_provider_request',
         'Provider resource name must be a canonical Intar DNS label', ?, ?
       )`,
    ).bind(
      CHECKPOINT_ID,
      CONNECTION_ID,
      input.sshKeyId ?? null,
      "9".repeat(64),
      NOW + 30 * 60_000,
      NOW + 2 * 60 * 60_000,
      NOW,
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET provider_verification_state = 'cleanup_pending',
           error = 'Provider resource name must be a canonical Intar DNS label',
           updated_at = ? WHERE id = ?`,
    ).bind(NOW, PUBLICATION_ID),
    env.DB.prepare(
      `UPDATE organization_provider_connections
       SET state = 'cleanup_pending', updated_at = ? WHERE id = ?`,
    ).bind(NOW, CONNECTION_ID),
  ]);
}

async function insertProviderCheckpoint(input: {
  id: string;
  checkpointId: string;
  ordinal: number;
  publicationId?: string;
  connectionId?: string;
  createdAt?: number;
  serverType?: string;
}): Promise<void> {
  const serverType = input.serverType ?? "cx43";
  await env.DB.prepare(
    `INSERT INTO workshop_publication_provider_checkpoints (
       id, publication_id, checkpoint_id, ordinal,
       covered_module_ids_json, expected_probes_json,
       provider_kind, connection_id, resolved_provider_json,
       permitted_locations_json, price_observation_json,
       r2_key, sha256, size_bytes, compression, signature_b64,
       signing_key_id, workspace_agent_sha256, kino_sha256,
       verification_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'hetzner_cloud', ?, ?, ?, ?, ?, ?, 128,
               'zstd', ?, 'test-key', ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      input.id,
      input.publicationId ?? PUBLICATION_ID,
      input.checkpointId,
      input.ordinal,
      JSON.stringify([input.checkpointId]),
      JSON.stringify([
        { moduleId: input.checkpointId, probeId: "workspace-ready" },
      ]),
      input.connectionId ?? CONNECTION_ID,
      JSON.stringify({
        kind: "hetzner_cloud",
        vmId: "learner",
        serverType,
        systemImage: "debian-13",
        hardware: {
          architecture: "x86",
          cores: 8,
          memoryMib: 16_384,
          diskMib: 163_840,
        },
        compatible: true,
      }),
      JSON.stringify(["nbg1", "fsn1", "hel1"]),
      JSON.stringify({
        currency: "NOK",
        observedAt: NOW - 60_000,
        expiresAt: NOW + 86_400_000,
        serverType,
        locations: [
          {
            location: "nbg1",
            available: true,
            serverHourlyNet: "0.4000",
            serverHourlyGross: "0.5000",
            ipv4HourlyNet: "0.0050",
            ipv4HourlyGross: "0.00625",
          },
        ],
      }),
      `artifacts/sha256/${ARTIFACT_SHA.slice(0, 2)}/${ARTIFACT_SHA}`,
      ARTIFACT_SHA,
      SIGNATURE,
      AGENT_SHA,
      KINO_SHA,
      input.createdAt ?? NOW,
      input.createdAt ?? NOW,
    )
    .run();
}

async function insertAdditionalPublicationFixture(
  suffix: string,
  createdAt: number,
): Promise<void> {
  const organizationId = `org-${suffix}`;
  const connectionId = `connection-${suffix}`;
  const credentialId = `credential-${suffix}`;
  const publicationId = `publication-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(organizationId, `Org ${suffix}`, `org-${suffix}`, createdAt),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by,
         created_at
       ) VALUES (?, ?, 'test', 'test', ?, 'owner-verifier', ?)`,
    ).bind(
      `registry-token-${suffix}`,
      organizationId,
      "1".repeat(64),
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO organization_provider_connections (
         id, organization_id, provider_kind, display_name, state,
         project_fingerprint, sentinel_firewall_id,
         approved_locations_json, max_concurrent_servers, currency,
         ipv4_enabled, last_validated_at, created_by, created_at, updated_at
       ) VALUES (?, ?, 'hetzner_cloud', 'Later project', 'active', ?, '43',
                 ?, 5, 'NOK', 1, ?, 'owner-verifier', ?, ?)`,
    ).bind(
      connectionId,
      organizationId,
      `fingerprint-${suffix}`,
      JSON.stringify(["nbg1", "fsn1", "hel1"]),
      createdAt,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO provider_credential_versions (
         id, connection_id, version, algorithm, kek_version, aad_sha256,
         encrypted_token_b64, token_iv_b64, wrapped_dek_b64, dek_iv_b64,
         envelope_created_at, token_fingerprint, created_by, activated_at,
         created_at
       ) VALUES (?, ?, 1, 'AES-256-GCM', 'v1', ?, 'encrypted-token',
                 'token-iv', 'wrapped-dek', 'dek-iv', ?, ?,
                 'owner-verifier', ?, ?)`,
    ).bind(
      credentialId,
      connectionId,
      "2".repeat(64),
      createdAt,
      `token-${suffix}`,
      createdAt,
      createdAt,
    ),
    env.DB.prepare(
      `UPDATE organization_provider_connections
       SET active_credential_version_id = ? WHERE id = ?`,
    ).bind(credentialId, connectionId),
    env.DB.prepare(
      `INSERT INTO workshop_publications (
         id, organization_id, workshop_slug, content_hash, source_r2_key,
         compiled_manifest_json, required_checkpoint_ids_json, status,
         submitted_by, registry_token_id, provider_verification_state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'building', 'owner-verifier', ?,
                 'verifying', ?, ?)`,
    ).bind(
      publicationId,
      organizationId,
      `workshop-${suffix}`,
      suffix.padEnd(64, "3"),
      `source/${suffix}.tar.zst`,
      JSON.stringify([`00-${suffix}`]),
      `registry-token-${suffix}`,
      createdAt,
      createdAt,
    ),
  ]);
  await insertProviderCheckpoint({
    id: `provider-checkpoint-${suffix}`,
    checkpointId: `00-${suffix}`,
    ordinal: 0,
    publicationId,
    connectionId,
    createdAt,
  });
}

async function insertSameConnectionPublicationFixture(
  suffix: string,
  createdAt: number,
  serverType: string,
): Promise<void> {
  const publicationId = `publication-${suffix}`;
  await env.DB.prepare(
    `INSERT INTO workshop_publications (
       id, organization_id, workshop_slug, content_hash, source_r2_key,
       compiled_manifest_json, required_checkpoint_ids_json, status,
       submitted_by, registry_token_id, provider_verification_state,
       created_at, updated_at
     ) VALUES (?, 'org-verifier', ?, ?, ?, '{}', ?, 'building',
               'owner-verifier', 'registry-token-verifier', 'verifying', ?, ?)`,
  )
    .bind(
      publicationId,
      `workshop-${suffix}`,
      suffix.padEnd(64, "4"),
      `source/${suffix}.tar.zst`,
      JSON.stringify([`00-${suffix}`]),
      createdAt,
      createdAt,
    )
    .run();
  await insertProviderCheckpoint({
    id: `provider-checkpoint-${suffix}`,
    checkpointId: `00-${suffix}`,
    ordinal: 0,
    publicationId,
    connectionId: CONNECTION_ID,
    createdAt,
    serverType,
  });
}

async function attemptCount(checkpointId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS count FROM workshop_publication_provider_attempts
     WHERE provider_checkpoint_id = ?`,
  )
    .bind(checkpointId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function currentAttempt(): Promise<
  | (Record<string, unknown> & {
      id: string;
      ssh_key_id: string | null;
      primary_ip_id: string | null;
      primary_ipv4: string | null;
    })
  | null
> {
  return env.DB.prepare(
    `SELECT * FROM workshop_publication_provider_attempts
     ORDER BY created_at DESC LIMIT 1`,
  ).first();
}

async function checkpointStatus(): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT verification_status
     FROM workshop_publication_provider_checkpoints WHERE id = ?`,
  )
    .bind(CHECKPOINT_ID)
    .first<{ verification_status: string }>();
  return row?.verification_status ?? null;
}

async function providerCheckpointCleanupSummary(): Promise<{
  verification_status: string;
  deletion_confirmed_at: number | null;
} | null> {
  return env.DB.prepare(
    `SELECT verification_status, deletion_confirmed_at
     FROM workshop_publication_provider_checkpoints WHERE id = ?`,
  )
    .bind(CHECKPOINT_ID)
    .first();
}

async function providerCheckpointCleanupSummaries(): Promise<
  Array<{
    id: string;
    verification_status: string;
    deletion_confirmed_at: number | null;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT id, verification_status, deletion_confirmed_at
     FROM workshop_publication_provider_checkpoints
     ORDER BY ordinal`,
  ).all<{
    id: string;
    verification_status: string;
    deletion_confirmed_at: number | null;
  }>();
  return rows.results;
}

async function insertCleanupAttempt(input: {
  id: string;
  checkpointId: string;
  ordinal: number;
  deletionConfirmedAt: number | null;
}): Promise<void> {
  const deletionRequestedAt = NOW + input.ordinal;
  await env.DB.prepare(
    `INSERT INTO workshop_publication_provider_attempts (
       id, provider_checkpoint_id, connection_id, ordinal,
       deterministic_name, server_type, system_image, location, state,
       control_plane_base_url, bootstrap_token_hash, bootstrap_expires_at,
       report_credential_expires_at, deletion_requested_at,
       deletion_confirmed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'cx43', 'debian-13', 'nbg1', ?, 'https://intar.dev/',
               ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.checkpointId,
      CONNECTION_ID,
      input.ordinal,
      `intar-wpv-${input.id}`,
      input.deletionConfirmedAt === null ? "deleting" : "deleted",
      `bootstrap-${input.id}`,
      NOW + 30 * 60_000,
      NOW + 2 * 60 * 60_000,
      deletionRequestedAt,
      input.deletionConfirmedAt,
      NOW,
      input.deletionConfirmedAt ?? deletionRequestedAt,
    )
    .run();
}

async function nonPublicationRuntimeCounts() {
  const [executions, workspaces, generations, slots, terminalRoutes, intents] =
    await Promise.all([
      count("runtime_executions"),
      count("workshop_workspaces"),
      count("workshop_workspace_generations"),
      count("active_runtime_slots"),
      count("runtime_terminal_sessions"),
      count("workshop_route_issuance_intents"),
    ]);
  return {
    executions,
    workspaces,
    generations,
    slots,
    routes: terminalRoutes + intents,
  };
}

async function publicationAndConnectionState(): Promise<{
  publication: string;
  connection: string;
}> {
  const [publication, connection] = await Promise.all([
    env.DB.prepare(
      `SELECT provider_verification_state AS state
       FROM workshop_publications WHERE id = ?`,
    )
      .bind(PUBLICATION_ID)
      .first<{ state: string }>(),
    env.DB.prepare(
      `SELECT state FROM organization_provider_connections WHERE id = ?`,
    )
      .bind(CONNECTION_ID)
      .first<{ state: string }>(),
  ]);
  return {
    publication: publication?.state ?? "",
    connection: connection?.state ?? "",
  };
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return row?.count ?? 0;
}
