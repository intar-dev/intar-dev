/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countLiveHetznerAllocations } from "@/lib/workshops/provider-connections";
import { resetD1Database } from "@/test/d1-migrations";
import { handleWorkshopPublicationVerifierRequest } from "./workshop-publication-verifier";

const NOW = 1_800_000_000_000;
const BOOTSTRAP = "iwpv_bootstrap_test_capability";
const BUNDLE = new TextEncoder().encode("signed workshop checkpoint");
const SHA256 =
  "3df34b031378f19bb1e8d5d663086bf82f178eedc36ee82b73802bbab3f552d1";
const SIGNATURE = btoa(String.fromCharCode(...new Uint8Array(64)));
const PRICE = JSON.stringify({
  currency: "EUR",
  observedAt: NOW,
  expiresAt: NOW + 86_400_000,
  serverType: "cx43",
  locations: [
    {
      location: "nbg1",
      available: true,
      serverHourlyNet: "0.01",
      serverHourlyGross: "0.0119",
      ipv4HourlyNet: "0.0005",
      ipv4HourlyGross: "0.000595",
    },
  ],
});

describe("workshop publication verifier guest boundary", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedAttempt();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exchanges a one-use bootstrap capability for scoped credentials", async () => {
    await expect(countLiveHetznerAllocations("connection-0001")).resolves.toBe(
      1,
    );
    const first = await bootstrapRequest();
    expect(first.status).toBe(200);
    const payload = await first.json<{
      report_credential: string;
      checkpoint: { signed_url: string; sha256: string };
    }>();
    expect(payload.checkpoint.sha256).toBe(SHA256);
    expect(payload.checkpoint.signed_url).toMatch(
      /^https:\/\/intar\.test\/api\/runtime\/workshop-publication-verifier\/checkpoints\//,
    );
    expect(await bootstrapRequest()).toHaveProperty("status", 401);

    const stored = await env.DB.prepare(
      `SELECT bootstrap_token_hash, report_credential_hash,
              checkpoint_download_token_hash
       FROM workshop_publication_provider_attempts WHERE id = ?`,
    )
      .bind("attempt-0001")
      .first<Record<string, string>>();
    expect(stored).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(BOOTSTRAP);
    expect(JSON.stringify(stored)).not.toContain(payload.report_credential);

    const checkpoint = await handle(new Request(payload.checkpoint.signed_url));
    expect(checkpoint.status).toBe(200);
    expect(new Uint8Array(await checkpoint.arrayBuffer())).toEqual(BUNDLE);
    expect(checkpoint.headers.get("cache-control")).toBe("private, no-store");
  });

  it("holds provider capacity until verifier deletion is confirmed", async () => {
    await expect(countLiveHetznerAllocations("connection-0001")).resolves.toBe(
      1,
    );
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleted', deletion_requested_at = ?,
           deletion_confirmed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(NOW + 1, NOW + 2, NOW + 2, "attempt-0001")
      .run();
    await expect(countLiveHetznerAllocations("connection-0001")).resolves.toBe(
      0,
    );
  });

  it("requires the complete healthy proof and latches it for cleanup", async () => {
    const bootstrap = await bootstrapRequest();
    const {
      report_credential: credential,
      checkpoint: { signed_url: checkpointUrl },
    } = await bootstrap.json<{
      report_credential: string;
      checkpoint: { signed_url: string };
    }>();

    const incomplete = await reportRequest(credential, {
      ...proofReport(1),
      probes: [{ id: "setup-ready", status: "pass", observed_at_unix_ms: NOW }],
    });
    expect(incomplete.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
    });

    const beforeDownload = await reportRequest(credential, proofReport(2));
    expect(beforeDownload.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
    });

    expect((await handle(new Request(checkpointUrl))).status).toBe(200);
    const complete = await reportRequest(credential, proofReport(3));
    expect(complete.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "proof_succeeded",
      proof_report_sequence: 3,
      proof_verified_at: expect.any(Number),
    });
    const checkpoint = await env.DB.prepare(
      `SELECT verification_status, proof_verified_at
       FROM workshop_publication_provider_checkpoints WHERE id = ?`,
    )
      .bind("provider-checkpoint-0001")
      .first<Record<string, unknown>>();
    expect(checkpoint).toMatchObject({
      verification_status: "bootstrapping",
      proof_verified_at: null,
    });

    expect((await reportRequest(credential, proofReport(4))).status).toBe(401);
  });

  it("allows one ready probe miss to recover on the next report", async () => {
    const bootstrap = await bootstrapRequest();
    const {
      report_credential: credential,
      checkpoint: { signed_url: checkpointUrl },
    } = await bootstrap.json<{
      report_credential: string;
      checkpoint: { signed_url: string };
    }>();
    expect((await handle(new Request(checkpointUrl))).status).toBe(200);

    const first = await reportRequest(credential, {
      ...proofReport(1),
      probes: [
        { id: "setup-ready", status: "pass", observed_at_unix_ms: NOW },
        { id: "docker-ready", status: "fail", observed_at_unix_ms: NOW },
      ],
    });
    expect(first.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
      last_error_code: null,
    });

    const recovered = await reportRequest(credential, proofReport(2));
    expect(recovered.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "proof_succeeded",
      proof_report_sequence: 2,
      proof_verified_at: expect.any(Number),
      last_error_code: null,
    });
  });

  it("fails a verifier attempt only after a ready probe remains failed beyond one full run", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const bootstrap = await bootstrapRequest();
    const {
      report_credential: credential,
      checkpoint: { signed_url: checkpointUrl },
    } = await bootstrap.json<{
      report_credential: string;
      checkpoint: { signed_url: string };
    }>();
    expect((await handle(new Request(checkpointUrl))).status).toBe(200);
    expect(
      (await reportRequest(credential, failingProofReport(1))).status,
    ).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      last_error_code: null,
    });
    clock.mockReturnValue(NOW + 10_000);
    expect(
      (await reportRequest(credential, failingProofReport(2))).status,
    ).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
      last_error_code: null,
    });

    clock.mockReturnValue(NOW + 5 * 60_000);
    expect(
      (await reportRequest(credential, failingProofReport(3))).status,
    ).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "failed",
      proof_verified_at: null,
      last_error_code: "publication_verifier_probe_persisted",
      error:
        "required workshop probes remained failed after readiness: docker-ready",
    });
    expect(
      (await reportRequest(credential, failingProofReport(4))).status,
    ).toBe(401);
  });

  it("starts failure persistence only after checkpoint download", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const bootstrap = await bootstrapRequest();
    const {
      report_credential: credential,
      checkpoint: { signed_url: checkpointUrl },
    } = await bootstrap.json<{
      report_credential: string;
      checkpoint: { signed_url: string };
    }>();

    expect(
      (await reportRequest(credential, failingProofReport(1))).status,
    ).toBe(200);
    clock.mockReturnValue(NOW + 5 * 60_000);
    expect((await handle(new Request(checkpointUrl))).status).toBe(200);
    expect(
      (await reportRequest(credential, failingProofReport(2))).status,
    ).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
      last_error_code: null,
    });
  });

  it("resets failure persistence across a report sequence gap", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const bootstrap = await bootstrapRequest();
    const {
      report_credential: credential,
      checkpoint: { signed_url: checkpointUrl },
    } = await bootstrap.json<{
      report_credential: string;
      checkpoint: { signed_url: string };
    }>();
    expect((await handle(new Request(checkpointUrl))).status).toBe(200);
    expect(
      (await reportRequest(credential, failingProofReport(1))).status,
    ).toBe(200);

    clock.mockReturnValue(NOW + 5 * 60_000);
    expect(
      (await reportRequest(credential, failingProofReport(3))).status,
    ).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "applying",
      proof_verified_at: null,
      last_error_code: null,
    });
  });

  it("rejects stale verifier identities and moves guest failures to deletion", async () => {
    const bootstrap = await bootstrapRequest();
    const { report_credential: credential } = await bootstrap.json<{
      report_credential: string;
    }>();
    const stale = proofReport(1);
    stale.identity.generation = 2;
    expect((await reportRequest(credential, stale)).status).toBe(409);

    const failed = await reportRequest(credential, {
      ...proofReport(1),
      phase: "failed",
      health: "failed",
      terminal_ready: false,
      ssh_host_keys_openssh: [],
      probes: [],
      error: "checkpoint application failed",
    });
    expect(failed.status).toBe(200);
    expect(await attemptState()).toMatchObject({
      state: "failed",
      last_error_code: "guest_reported_failure",
    });
    const checkpoint = await env.DB.prepare(
      `SELECT verification_status
       FROM workshop_publication_provider_checkpoints WHERE id = ?`,
    )
      .bind("provider-checkpoint-0001")
      .first<{ verification_status: string }>();
    expect(checkpoint?.verification_status).toBe("bootstrapping");
  });
});

async function seedAttempt(): Promise<void> {
  const bootstrapHash = await sha256Hex(BOOTSTRAP);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    `artifacts/sha256/${SHA256.slice(0, 2)}/${SHA256}`,
    BUNDLE,
    { customMetadata: { artifact_sha256: SHA256 } },
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, email_verified, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind("user-0001", "Owner", "owner@example.test", NOW, NOW),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind("org-0001", "Test Org", "test-org", NOW),
    env.DB.prepare(
      `INSERT INTO workshop_registry_tokens (
         id, organization_id, name, token_prefix, token_hash, created_by,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "registry-token-0001",
      "org-0001",
      "test",
      "test",
      "f".repeat(64),
      "user-0001",
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO organization_provider_connections (
         id, organization_id, provider_kind, display_name, state,
         project_fingerprint, sentinel_firewall_id,
         approved_locations_json, max_concurrent_servers, currency,
         ipv4_enabled, last_validated_at, created_by, created_at, updated_at
       ) VALUES (?, ?, 'hetzner_cloud', ?, 'active', ?, ?, ?, 5, 'EUR',
                 1, ?, ?, ?, ?)`,
    ).bind(
      "connection-0001",
      "org-0001",
      "Test Hetzner",
      "project-fingerprint",
      "firewall-1",
      JSON.stringify(["nbg1"]),
      NOW,
      "user-0001",
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publications (
         id, organization_id, workshop_slug, content_hash, source_r2_key,
         compiled_manifest_json, required_checkpoint_ids_json, status,
         submitted_by, registry_token_id, provider_verification_state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, 'verifying', ?, ?)`,
    ).bind(
      "publication-0001",
      "org-0001",
      "test-workshop",
      "a".repeat(64),
      "sources/test.tar.zst",
      "{}",
      JSON.stringify(["00"]),
      "user-0001",
      "registry-token-0001",
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publication_provider_checkpoints (
         id, publication_id, checkpoint_id, ordinal,
         covered_module_ids_json, expected_probes_json,
         provider_kind, connection_id, resolved_provider_json,
         permitted_locations_json, price_observation_json,
         r2_key, sha256, size_bytes, compression, signature_b64,
         signing_key_id, workspace_agent_sha256, kino_sha256,
         verification_status, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?, 'hetzner_cloud', ?, ?, ?, ?, ?, ?, ?,
                 'zstd', ?, ?, ?, ?, 'bootstrapping', ?, ?)`,
    ).bind(
      "provider-checkpoint-0001",
      "publication-0001",
      "00",
      JSON.stringify(["00"]),
      JSON.stringify([
        { moduleId: "00", probeId: "setup-ready" },
        { moduleId: "00", probeId: "docker-ready" },
      ]),
      "connection-0001",
      JSON.stringify({
        kind: "hetzner_cloud",
        vmId: "learner",
        serverType: "cx43",
        systemImage: "debian-13",
        architecture: "x86",
        cores: 8,
        memoryMib: 16_384,
        diskMib: 160_000,
      }),
      JSON.stringify(["nbg1"]),
      PRICE,
      `artifacts/sha256/${SHA256.slice(0, 2)}/${SHA256}`,
      SHA256,
      BUNDLE.byteLength,
      SIGNATURE,
      "test-key",
      "b".repeat(64),
      "c".repeat(64),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_publication_provider_attempts (
         id, provider_checkpoint_id, connection_id, ordinal,
         deterministic_name, server_type, system_image, location, state,
         control_plane_base_url, bootstrap_token_hash, bootstrap_expires_at,
         report_credential_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, 'cx43', 'debian-13', 'nbg1',
                 'bootstrapping', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "attempt-0001",
      "provider-checkpoint-0001",
      "connection-0001",
      "intar-pub-test-00-1",
      "https://intar.test/",
      bootstrapHash,
      NOW + 30 * 60_000,
      NOW + 2 * 60 * 60_000,
      NOW,
      NOW,
    ),
  ]);
}

function proofReport(sequence: number) {
  return {
    contract_version: 1,
    identity: {
      execution_id: "attempt-0001",
      workspace_id: "provider-checkpoint-0001",
      generation: 1,
    },
    sequence,
    phase: "ready",
    health: "healthy",
    terminal_ready: true,
    recording_drain_completed: false,
    ssh_host_keys_openssh: ["ssh-ed25519 AAAATEST verifier"],
    probes: [
      { id: "setup-ready", status: "pass", observed_at_unix_ms: NOW },
      { id: "docker-ready", status: "pass", observed_at_unix_ms: NOW },
    ],
    reported_at_unix_ms: NOW,
  };
}

function failingProofReport(sequence: number) {
  return {
    ...proofReport(sequence),
    error: "guest supplied diagnostic",
    probes: [
      { id: "setup-ready", status: "pass", observed_at_unix_ms: NOW },
      { id: "docker-ready", status: "fail", observed_at_unix_ms: NOW },
    ],
  };
}

async function bootstrapRequest(): Promise<Response> {
  return handle(
    new Request(
      "https://intar.test/api/runtime/workshop-publication-verifier/bootstrap",
      {
        method: "POST",
        headers: {
          authorization: `Intar-Bootstrap ${BOOTSTRAP}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contract_version: 1,
          identity: {
            execution_id: "attempt-0001",
            workspace_id: "provider-checkpoint-0001",
            generation: 1,
          },
          agent_version: "test",
        }),
      },
    ),
  );
}

async function reportRequest(
  credential: string,
  body: unknown,
): Promise<Response> {
  return handle(
    new Request(
      "https://intar.test/api/runtime/workshop-publication-verifier/reports",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

async function handle(request: Request): Promise<Response> {
  const response = await handleWorkshopPublicationVerifierRequest(request, env);
  return response ?? new Response("not handled", { status: 404 });
}

async function attemptState(): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(
    `SELECT state, proof_report_sequence, proof_verified_at, last_error_code,
            error
     FROM workshop_publication_provider_attempts WHERE id = ?`,
  )
    .bind("attempt-0001")
    .first<Record<string, unknown>>();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
