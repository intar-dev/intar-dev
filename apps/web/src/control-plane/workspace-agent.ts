import type { WorkshopManifestV2 } from "@/db/schema";
import { createAppId } from "@/lib/id";
import {
  recordRuntimeVmTerminalTarget,
  updateRuntimeExecutionState,
} from "@/lib/runtime-executions";
import { loadRuntimeVmAccessKey } from "@/lib/runtime-vm-state";
import {
  assertWorkshopProbeBatchResults,
  prepareWorkshopProbeReport,
} from "@/lib/workshops/progress";
import { recordWorkshopGenerationState } from "@/lib/workshops/provisioning";

const CONTRACT_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const ARTIFACT_GRANT_TTL_MS = 5 * 60_000;
const CHECKPOINT_DOWNLOAD_TTL_MS = 20 * 60_000;
const TOKEN_BYTES = 32;
const PHASES = new Set([
  "bootstrapping",
  "applying_checkpoint",
  "starting_services",
  "ready",
  "degraded",
  "failed",
]);
const HEALTH = new Set(["unknown", "healthy", "degraded", "failed"]);
const PROBE_STATUS = new Set(["unknown", "pass", "fail"]);

interface CredentialRow {
  id: string;
  execution_id: string;
  workspace_id: string;
  generation: number;
  control_plane_base_url: string;
  report_credential_expires_at: number;
  checkpoint_bundle_id: string;
  checkpoint_id: string;
  checkpoint_r2_key: string;
  checkpoint_sha256: string;
  checkpoint_size_bytes: number;
  checkpoint_compression: "zstd";
  checkpoint_signature_b64: string;
  checkpoint_signing_key_id: string;
}

interface AuthenticatedGeneration extends CredentialRow {
  domain_kind: "workshop" | "workshop_certification";
  provider_kind: "hetzner_cloud" | "gcp_compute";
  allocation_id: string;
  allocation_state: string;
  recording_drain_completed_at: number | null;
  workspace_generation_id: string | null;
  organization_id: string;
  session_id: string | null;
  participant_user_id: string | null;
  manifest_json: string | WorkshopManifestV2;
}

interface RuntimeVmTerminalRow {
  runtime_vm_id: string;
  vm_id: string;
  external_ipv4: string | null;
}

interface SanitizedProbe {
  id: string;
  status: "unknown" | "pass" | "fail";
  observed_at_unix_ms: number;
  error?: string;
}

interface SanitizedReport {
  contract_version: 1;
  identity: {
    execution_id: string;
    workspace_id: string;
    generation: number;
  };
  sequence: number;
  checkpoint_id: string;
  boot_id: string;
  phase:
    | "bootstrapping"
    | "applying_checkpoint"
    | "starting_services"
    | "ready"
    | "degraded"
    | "failed";
  health: "unknown" | "healthy" | "degraded" | "failed";
  terminal_ready: boolean;
  recording_drain_completed: boolean;
  completed_module_ids: string[];
  ssh_host_keys_openssh: string[];
  probes: SanitizedProbe[];
  error?: string;
  reported_at_unix_ms: number;
}

export async function handleWorkspaceAgentControlPlaneRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/runtime/workspace-agent/bootstrap") {
    return handleBootstrap(request, env);
  }
  if (path === "/api/runtime/workspace-agent/reports") {
    return handleReport(request, env);
  }
  if (path === "/api/runtime/workspace-agent/artifacts/grants") {
    return handleArtifactGrant(request, env);
  }
  const checkpoint = path.match(
    /^\/api\/runtime\/workspace-agent\/checkpoints\/([A-Za-z0-9_-]{32,128})$/,
  );
  if (checkpoint) {
    return handleCheckpointDownload(request, env, checkpoint[1] ?? "");
  }
  const binary = path.match(
    /^\/api\/runtime\/workspace-agent\/binaries\/([a-f0-9]{64})$/,
  );
  if (binary) {
    return handleWorkspaceAgentBinary(request, env, binary[1] ?? "");
  }
  const kinoBinary = path.match(
    /^\/api\/runtime\/workspace-agent\/kino\/binaries\/([a-f0-9]{64})$/,
  );
  if (kinoBinary) {
    return handleKinoBinary(request, env, kinoBinary[1] ?? "");
  }
  const artifact = path.match(
    /^\/api\/runtime\/workspace-agent\/artifacts\/uploads\/([A-Za-z0-9_-]{32,128})$/,
  );
  if (artifact) {
    return handleArtifactUpload(request, env, artifact[1] ?? "");
  }
  if (path.startsWith("/api/runtime/workspace-agent/")) {
    return jsonResponse({ error: "not found" }, 404);
  }
  return null;
}

async function handleKinoBinary(
  request: Request,
  env: Cloudflare.Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const key = `workspace-agent/kino/releases/${sha256}/kino`;
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key);
  if (!object) return jsonResponse({ error: "Kino binary not found" }, 404);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(object.size),
    "content-disposition": 'attachment; filename="kino"',
    "x-intar-binary-sha256": sha256,
    "cache-control": "public, max-age=31536000, immutable",
    "cloudflare-cdn-cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
}

async function handleWorkspaceAgentBinary(
  request: Request,
  env: Cloudflare.Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const key = `workspace-agent/releases/${sha256}/intar-workspace-agent`;
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key);
  if (!object)
    return jsonResponse({ error: "workspace agent binary not found" }, 404);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(object.size),
    "content-disposition": 'attachment; filename="intar-workspace-agent"',
    "x-intar-binary-sha256": sha256,
    "cache-control": "public, max-age=31536000, immutable",
    "cloudflare-cdn-cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { headers });
}

async function handleBootstrap(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const capability = parseAuthorization(request, "Intar-Bootstrap");
  if (!capability) return unauthorized();
  const body = await readBoundedJson(request);
  if (!body || body.contract_version !== CONTRACT_VERSION) {
    return jsonResponse({ error: "invalid bootstrap request" }, 400);
  }
  const identity = parseIdentity(body.identity);
  if (!identity || !validVersion(body.agent_version)) {
    return jsonResponse({ error: "invalid bootstrap request" }, 400);
  }

  const now = Date.now();
  const capabilityHash = await sha256Hex(capability);
  const row = await env.DB.prepare(
    `SELECT
       credential.id,
       credential.execution_id,
       credential.workspace_id,
       credential.generation,
       credential.control_plane_base_url,
       credential.report_credential_expires_at,
       credential.checkpoint_bundle_id,
       bundle.checkpoint_id,
       bundle.r2_key AS checkpoint_r2_key,
       bundle.sha256 AS checkpoint_sha256,
       bundle.size_bytes AS checkpoint_size_bytes,
       bundle.compression AS checkpoint_compression,
       bundle.signature_b64 AS checkpoint_signature_b64,
       bundle.signing_key_id AS checkpoint_signing_key_id
     FROM runtime_guest_credentials credential
     INNER JOIN runtime_executions execution
       ON execution.id = credential.execution_id
      AND execution.domain_kind IN ('workshop', 'workshop_certification')
      AND execution.provider_kind IN ('hetzner_cloud', 'gcp_compute')
      AND execution.domain_id = credential.workspace_id
      AND execution.generation = credential.generation
     INNER JOIN runtime_checkpoint_bundles bundle
       ON bundle.id = credential.checkpoint_bundle_id
      AND bundle.checkpoint_id = execution.checkpoint_id
     WHERE credential.bootstrap_token_hash = ?
       AND credential.bootstrap_consumed_at IS NULL
       AND credential.bootstrap_expires_at > ?
       AND credential.report_credential_expires_at > ?
       AND (
         (
           execution.domain_kind = 'workshop'
           AND EXISTS (
             SELECT 1
             FROM workshop_workspaces workspace
             JOIN workshop_workspace_generations workspace_generation
               ON workspace_generation.id = workspace.current_generation_id
              AND workspace_generation.runtime_execution_id = execution.id
              AND workspace_generation.ordinal = execution.generation
             JOIN workshop_sessions session
               ON session.id = workspace.session_id
              AND session.organization_id = execution.organization_id
              AND session.template_revision_id = bundle.template_revision_id
             WHERE workspace.id = execution.domain_id
           )
         )
         OR (
           execution.domain_kind = 'workshop_certification'
           AND EXISTS (
             SELECT 1
             FROM workshop_runtime_profile_certifications certification
             JOIN workshop_runtime_profiles profile
               ON profile.id = certification.runtime_profile_id
              AND profile.template_revision_id = bundle.template_revision_id
              AND profile.provider_kind = execution.provider_kind
             WHERE certification.id = execution.domain_id
               AND certification.state IN ('pending', 'verifying')
           )
         )
       )
     LIMIT 1`,
  )
    .bind(capabilityHash, now, now)
    .first<CredentialRow>();
  if (!row || !identitiesEqual(identity, row)) return unauthorized();

  const reportCredential = randomCapability("iwa_report");
  const checkpointCapability = randomCapability("iwa_checkpoint");
  const reportHash = await sha256Hex(reportCredential);
  const checkpointHash = await sha256Hex(checkpointCapability);
  const checkpointExpiresAt = Math.min(
    now + CHECKPOINT_DOWNLOAD_TTL_MS,
    row.report_credential_expires_at,
  );
  const consumed = await env.DB.prepare(
    `UPDATE runtime_guest_credentials
     SET bootstrap_consumed_at = ?,
         report_credential_hash = ?,
         report_credential_issued_at = ?,
         checkpoint_download_token_hash = ?,
         checkpoint_download_expires_at = ?,
         updated_at = ?
     WHERE id = ?
       AND bootstrap_token_hash = ?
       AND bootstrap_consumed_at IS NULL
       AND bootstrap_expires_at > ?`,
  )
    .bind(
      now,
      reportHash,
      now,
      checkpointHash,
      checkpointExpiresAt,
      now,
      row.id,
      capabilityHash,
      now,
    )
    .run();
  if (consumed.meta.changes !== 1) return unauthorized();

  return jsonResponse({
    contract_version: CONTRACT_VERSION,
    identity,
    report_credential: reportCredential,
    checkpoint: {
      checkpoint_id: row.checkpoint_id,
      signed_url: new URL(
        `/api/runtime/workspace-agent/checkpoints/${encodeURIComponent(checkpointCapability)}`,
        row.control_plane_base_url,
      ).toString(),
      sha256: row.checkpoint_sha256,
      size_bytes: row.checkpoint_size_bytes,
      compression: row.checkpoint_compression,
      signature_b64: row.checkpoint_signature_b64,
      signing_key_id: row.checkpoint_signing_key_id,
      expires_at_unix_ms: checkpointExpiresAt,
    },
  });
}

async function handleCheckpointDownload(
  request: Request,
  env: Cloudflare.Env,
  capability: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const now = Date.now();
  const hash = await sha256Hex(capability);
  const row = await env.DB.prepare(
    `SELECT
       credential.id,
       artifact.r2_key,
       artifact.sha256,
       artifact.size_bytes,
       artifact.compression
     FROM runtime_guest_credentials credential
     INNER JOIN runtime_executions execution
       ON execution.id = credential.execution_id
      AND execution.generation = credential.generation
      AND execution.domain_kind IN ('workshop', 'workshop_certification')
      AND execution.state IN ('queued', 'provisioning', 'ready')
     INNER JOIN runtime_checkpoint_bundles artifact
       ON artifact.id = credential.checkpoint_bundle_id
      AND artifact.checkpoint_id = execution.checkpoint_id
     WHERE credential.checkpoint_download_token_hash = ?
       AND credential.checkpoint_download_expires_at > ?
       AND credential.report_credential_revoked_at IS NULL
       AND (
         (
           execution.domain_kind = 'workshop'
           AND EXISTS (
             SELECT 1
             FROM workshop_workspaces workspace
             JOIN workshop_workspace_generations workspace_generation
               ON workspace_generation.id = workspace.current_generation_id
              AND workspace_generation.runtime_execution_id = execution.id
              AND workspace_generation.ordinal = execution.generation
             JOIN workshop_sessions session
               ON session.id = workspace.session_id
              AND session.organization_id = execution.organization_id
              AND session.template_revision_id = artifact.template_revision_id
             WHERE workspace.id = execution.domain_id
           )
         )
         OR (
           execution.domain_kind = 'workshop_certification'
           AND EXISTS (
             SELECT 1
             FROM workshop_runtime_profile_certifications certification
             JOIN workshop_runtime_profiles profile
               ON profile.id = certification.runtime_profile_id
              AND profile.template_revision_id = artifact.template_revision_id
              AND profile.provider_kind = execution.provider_kind
             WHERE certification.id = execution.domain_id
               AND certification.state IN ('pending', 'verifying')
           )
         )
       )
     LIMIT 1`,
  )
    .bind(hash, now)
    .first<{
      id: string;
      r2_key: string;
      sha256: string;
      size_bytes: number;
      compression: string;
    }>();
  if (!row) return unauthorized();
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(row.r2_key);
  if (!object || object.size !== row.size_bytes) {
    return jsonResponse({ error: "checkpoint unavailable" }, 404);
  }
  await env.DB.prepare(
    `UPDATE runtime_guest_credentials
     SET checkpoint_first_downloaded_at = COALESCE(checkpoint_first_downloaded_at, ?),
         updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, row.id)
    .run();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(row.size_bytes));
  headers.set("x-intar-checkpoint-sha256", row.sha256);
  headers.set("x-intar-checkpoint-compression", row.compression);
  setPrivateNoStore(headers);
  return new Response(object.body, { headers });
}

async function handleReport(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const authenticated = await authenticateGeneration(request, env);
  if (!authenticated.ok) return authenticated.response;
  const body = await readBoundedJson(request);
  const report = parseReport(body, authenticated.credential);
  if (!report) return jsonResponse({ error: "invalid report" }, 400);
  if (!identitiesEqual(report.identity, authenticated.generation)) {
    return jsonResponse({ error: "stale runtime generation" }, 409);
  }
  const checkpointAdvance =
    report.checkpoint_id === authenticated.generation.checkpoint_id
      ? null
      : await loadCertificationCheckpointAdvance({
          env,
          generation: authenticated.generation,
          reportedCheckpointId: report.checkpoint_id,
        });
  if (
    report.checkpoint_id !== authenticated.generation.checkpoint_id &&
    !checkpointAdvance
  ) {
    return jsonResponse({ error: "stale runtime checkpoint" }, 409);
  }

  const now = Date.now();
  const sourceState = providerState(report.phase);
  const reportId = `wgr_${createAppId()}`;
  const reportJson = JSON.stringify(report);
  const guestReport = env.DB.prepare(
    `INSERT OR IGNORE INTO runtime_guest_reports (
       id, execution_id, provider_kind, generation, sequence, checkpoint_id,
       boot_id, phase, health, terminal_ready, ssh_host_key_openssh, probes_json,
       completed_module_ids_json, report_json, reported_at, received_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM runtime_provider_allocations allocation
       WHERE allocation.id = ?
         AND allocation.execution_id = ?
         AND allocation.provider_kind = ?
         AND allocation.last_report_sequence < ?
         AND allocation.state NOT IN ('deleting', 'deleted', 'cleanup_pending')
     )`,
  ).bind(
    reportId,
    report.identity.execution_id,
    authenticated.generation.provider_kind,
    report.identity.generation,
    report.sequence,
    report.checkpoint_id,
    report.boot_id,
    report.phase,
    report.health,
    report.terminal_ready ? 1 : 0,
    preferredHostKey(report.ssh_host_keys_openssh) || null,
    JSON.stringify(report.probes),
    JSON.stringify(report.completed_module_ids),
    reportJson,
    report.reported_at_unix_ms,
    now,
    authenticated.generation.allocation_id,
    report.identity.execution_id,
    authenticated.generation.provider_kind,
    report.sequence,
  );
  const actualState = env.DB.prepare(
    `INSERT INTO runtime_actual_state (
       execution_id, latest_report_id, source_kind, source_id, generation,
       sequence, phase, health, observed_at, updated_at
     )
     SELECT ?, report.id, 'guest_report', ?, ?, ?, ?, ?, ?, ?
     FROM runtime_guest_reports report
     WHERE report.id = ?
     ON CONFLICT(execution_id) DO UPDATE SET
       latest_report_id = excluded.latest_report_id,
       source_kind = excluded.source_kind,
       source_id = excluded.source_id,
       generation = excluded.generation,
       sequence = excluded.sequence,
       phase = excluded.phase,
       health = excluded.health,
       observed_at = excluded.observed_at,
       updated_at = excluded.updated_at
     WHERE runtime_actual_state.generation = excluded.generation
       AND runtime_actual_state.sequence < excluded.sequence`,
  ).bind(
    report.identity.execution_id,
    authenticated.generation.allocation_id,
    report.identity.generation,
    report.sequence,
    report.phase,
    report.health,
    now,
    now,
    reportId,
  );
  const allocationState = env.DB.prepare(
    `UPDATE runtime_provider_allocations
     SET last_report_sequence = ?, last_report_at = ?,
         state = CASE WHEN state = 'draining' THEN state ELSE ? END,
         recording_drain_completed_at = CASE
           WHEN state = 'draining' AND ? = 1
             THEN COALESCE(recording_drain_completed_at, ?)
           ELSE recording_drain_completed_at
         END,
         retry_count = 0, last_error_code = ?, updated_at = ?
     WHERE id = ?
       AND execution_id = ?
       AND provider_kind = ?
       AND last_report_sequence < ?
       AND state NOT IN ('deleting', 'deleted', 'cleanup_pending')`,
  ).bind(
    report.sequence,
    now,
    sourceState,
    report.recording_drain_completed ? 1 : 0,
    now,
    report.error ? "guest_reported_error" : null,
    now,
    authenticated.generation.allocation_id,
    report.identity.execution_id,
    authenticated.generation.provider_kind,
    report.sequence,
  );
  const progressStatements =
    authenticated.generation.domain_kind === "workshop"
      ? await prepareWorkshopProbeProgress({
          env,
          generation: authenticated.generation,
          probes: report.probes,
          observedAt: now,
          sequence: report.sequence,
        })
      : [];
  const results = await env.DB.batch([
    guestReport,
    actualState,
    allocationState,
    ...progressStatements,
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1
  ) {
    return jsonResponse({ error: "stale report sequence" }, 409);
  }
  if (authenticated.generation.domain_kind === "workshop") {
    assertWorkshopProbeBatchResults(results.slice(3));
  }
  if (
    authenticated.generation.domain_kind === "workshop" &&
    authenticated.generation.allocation_state !== "draining" &&
    report.terminal_ready &&
    report.ssh_host_keys_openssh.length > 0
  ) {
    const terminal = await loadTerminalTarget(
      env,
      report.identity.execution_id,
    );
    if (!terminal?.external_ipv4) {
      return jsonResponse({ error: "terminal target is not allocated" }, 409);
    }
    const key = await loadRuntimeVmAccessKey({
      executionId: report.identity.execution_id,
      expectedGeneration: report.identity.generation,
      vmId: terminal.vm_id,
    });
    // Terminal target keys use a different authenticated-encryption context
    // than the access-key store. Re-encrypt through the canonical runtime API;
    // copying ciphertext between the two columns would make route issuance
    // undecryptable and silently corrupt the credential boundary.
    await recordRuntimeVmTerminalTarget({
      executionId: report.identity.execution_id,
      expectedGeneration: report.identity.generation,
      vmId: terminal.vm_id,
      target: {
        host: terminal.external_ipv4,
        port: 22,
        username: "intar",
        hostKeyOpenssh: preferredHostKey(report.ssh_host_keys_openssh),
        privateKeyOpenssh: key.privateKeyOpenssh,
      },
      observedAt: now,
    });
  }
  if (
    authenticated.generation.allocation_state !== "draining" &&
    report.phase === "ready" &&
    report.health === "healthy" &&
    report.terminal_ready
  ) {
    await updateRuntimeExecutionState({
      executionId: report.identity.execution_id,
      expectedGeneration: report.identity.generation,
      state: "ready",
      observedAt: now,
    });
    if (authenticated.generation.workspace_generation_id) {
      await recordWorkshopGenerationState({
        generationId: authenticated.generation.workspace_generation_id,
        update: {
          state: "ready",
          runtimeExecutionId: report.identity.execution_id,
          observedAt: now,
        },
      });
    }
  } else if (
    authenticated.generation.allocation_state !== "draining" &&
    (report.phase === "failed" || report.health === "failed")
  ) {
    await updateRuntimeExecutionState({
      executionId: report.identity.execution_id,
      expectedGeneration: report.identity.generation,
      state: "failed",
      observedAt: now,
    });
    if (authenticated.generation.workspace_generation_id) {
      await recordWorkshopGenerationState({
        generationId: authenticated.generation.workspace_generation_id,
        update: {
          state: "failed",
          runtimeExecutionId: report.identity.execution_id,
          error: report.error ?? "learner workspace agent reported a failure",
          observedAt: now,
        },
      });
    }
  }
  const nextCheckpoint = checkpointAdvance
    ? await issueCertificationCheckpointCommand({
        env,
        generation: authenticated.generation,
        ordinal: checkpointAdvance.ordinal,
        now,
      })
    : null;
  return jsonResponse({
    accepted_sequence: report.sequence,
    drain_recordings:
      authenticated.generation.allocation_state === "draining" &&
      authenticated.generation.recording_drain_completed_at === null &&
      !report.recording_drain_completed,
    ...(nextCheckpoint ? { next_checkpoint: nextCheckpoint } : {}),
  });
}

async function loadCertificationCheckpointAdvance(input: {
  env: Cloudflare.Env;
  generation: AuthenticatedGeneration;
  reportedCheckpointId: string;
}): Promise<{ ordinal: number } | null> {
  if (input.generation.domain_kind !== "workshop_certification") return null;
  const row = await input.env.DB.prepare(
    `SELECT certification.evidence_json
     FROM workshop_runtime_profile_certifications certification
     JOIN runtime_executions execution
       ON execution.domain_kind = 'workshop_certification'
      AND execution.domain_id = certification.id
      AND execution.id = ?
      AND execution.generation = ?
      AND execution.checkpoint_id = ?
     WHERE certification.id = ?
       AND certification.state = 'verifying'
       AND certification.verifier_allocation_id = ?
     LIMIT 1`,
  )
    .bind(
      input.generation.execution_id,
      input.generation.generation,
      input.generation.checkpoint_id,
      input.generation.workspace_id,
      input.generation.allocation_id,
    )
    .first<{ evidence_json: string | Record<string, unknown> }>();
  if (!row) return null;
  const evidence =
    typeof row.evidence_json === "string"
      ? safeJsonRecord(row.evidence_json)
      : row.evidence_json;
  const ordinal = evidence?.currentCheckpointOrdinal;
  const proofs = evidence?.checkpointProofs;
  if (
    evidence?.phase !== "awaiting_checkpoint_proof" ||
    typeof ordinal !== "number" ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    !Array.isArray(proofs)
  ) {
    return null;
  }
  const current = proofs[ordinal];
  const previous = proofs[ordinal - 1];
  if (
    !isRecord(current) ||
    current.checkpointId !== input.generation.checkpoint_id ||
    !isRecord(previous) ||
    previous.checkpointId !== input.reportedCheckpointId
  ) {
    return null;
  }
  return { ordinal };
}

async function issueCertificationCheckpointCommand(input: {
  env: Cloudflare.Env;
  generation: AuthenticatedGeneration;
  ordinal: number;
  now: number;
}): Promise<Record<string, unknown> | null> {
  const capability = randomCapability("iwa_checkpoint");
  const capabilityHash = await sha256Hex(capability);
  const expiresAt = Math.min(
    input.now + CHECKPOINT_DOWNLOAD_TTL_MS,
    input.generation.report_credential_expires_at,
  );
  const rotated = await input.env.DB.prepare(
    `UPDATE runtime_guest_credentials
     SET checkpoint_download_token_hash = ?,
         checkpoint_download_expires_at = ?,
         checkpoint_first_downloaded_at = NULL,
         updated_at = ?
     WHERE id = ? AND execution_id = ? AND generation = ?
       AND checkpoint_bundle_id = ?
       AND report_credential_revoked_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM runtime_executions execution
         JOIN runtime_provider_allocations allocation
           ON allocation.execution_id = execution.id
          AND allocation.id = ?
         JOIN workshop_runtime_profile_certifications certification
           ON certification.id = execution.domain_id
          AND certification.verifier_allocation_id = allocation.id
         WHERE execution.id = runtime_guest_credentials.execution_id
           AND execution.domain_kind = 'workshop_certification'
           AND execution.generation = runtime_guest_credentials.generation
           AND execution.checkpoint_id = ?
           AND certification.id = ?
           AND certification.state = 'verifying'
           AND json_extract(certification.evidence_json, '$.phase') = 'awaiting_checkpoint_proof'
           AND json_extract(certification.evidence_json, '$.currentCheckpointOrdinal') = ?
           AND json_extract(
             certification.evidence_json,
             '$.checkpointProofs[' || CAST(? AS INTEGER) || '].checkpointId'
           ) = ?
       )`,
  )
    .bind(
      capabilityHash,
      expiresAt,
      input.now,
      input.generation.id,
      input.generation.execution_id,
      input.generation.generation,
      input.generation.checkpoint_bundle_id,
      input.generation.allocation_id,
      input.generation.checkpoint_id,
      input.generation.workspace_id,
      input.ordinal,
      input.ordinal,
      input.generation.checkpoint_id,
    )
    .run();
  if (rotated.meta.changes !== 1) return null;
  return {
    checkpoint_id: input.generation.checkpoint_id,
    signed_url: new URL(
      `/api/runtime/workspace-agent/checkpoints/${encodeURIComponent(capability)}`,
      input.generation.control_plane_base_url,
    ).toString(),
    sha256: input.generation.checkpoint_sha256,
    size_bytes: input.generation.checkpoint_size_bytes,
    compression: input.generation.checkpoint_compression,
    signature_b64: input.generation.checkpoint_signature_b64,
    signing_key_id: input.generation.checkpoint_signing_key_id,
    expires_at_unix_ms: expiresAt,
  };
}

async function prepareWorkshopProbeProgress(input: {
  env: Cloudflare.Env;
  generation: AuthenticatedGeneration;
  probes: readonly SanitizedProbe[];
  observedAt: number;
  sequence: number;
}): Promise<D1PreparedStatement[]> {
  if (
    !input.generation.session_id ||
    !input.generation.participant_user_id ||
    !input.generation.workspace_generation_id
  ) {
    throw new Error("workshop learner report is missing session identity");
  }
  const manifest =
    typeof input.generation.manifest_json === "string"
      ? (JSON.parse(input.generation.manifest_json) as WorkshopManifestV2)
      : input.generation.manifest_json;
  return prepareWorkshopProbeReport({
    database: input.env.DB,
    organizationId: input.generation.organization_id,
    sessionId: input.generation.session_id,
    participantUserId: input.generation.participant_user_id,
    manifest,
    probes: new Map(input.probes.map((probe) => [probe.id, probe])),
    observedAt: input.observedAt,
    acceptance: {
      executionId: input.generation.execution_id,
      allocationId: input.generation.allocation_id,
      generation: input.generation.generation,
      sequence: input.sequence,
      observedAt: input.observedAt,
    },
  });
}

async function handleArtifactGrant(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const authenticated = await authenticateGeneration(request, env);
  if (!authenticated.ok) return authenticated.response;
  if (authenticated.generation.domain_kind === "workshop_certification") {
    return jsonResponse(
      { error: "certification verifier artifacts are not retained" },
      403,
    );
  }
  const body = await readBoundedJson(request);
  const identity = parseIdentity(body?.identity);
  const kind = typeof body?.kind === "string" ? body.kind : "";
  const sha256 = typeof body?.sha256 === "string" ? body.sha256 : "";
  const sizeBytes = body?.size_bytes;
  if (
    body?.contract_version !== CONTRACT_VERSION ||
    !identity ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(kind) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_ARTIFACT_BYTES
  ) {
    return jsonResponse({ error: "invalid artifact grant request" }, 400);
  }
  if (!identitiesEqual(identity, authenticated.generation)) {
    return jsonResponse({ error: "stale runtime generation" }, 409);
  }
  const vms = await env.DB.prepare(
    `SELECT id, artifact_writes_sealed
     FROM runtime_vms WHERE execution_id = ? ORDER BY ordinal ASC LIMIT 2`,
  )
    .bind(identity.execution_id)
    .all<{ id: string; artifact_writes_sealed: number }>();
  if (vms.results.length !== 1 || vms.results[0]?.artifact_writes_sealed) {
    return jsonResponse({ error: "artifact uploads are unavailable" }, 409);
  }

  const now = Date.now();
  const expiresAt = Math.min(
    now + ARTIFACT_GRANT_TTL_MS,
    authenticated.generation.report_credential_expires_at,
  );
  const runtimeVmId = vms.results[0]?.id ?? "";
  if (kind === "terminal_recording") {
    const existing = await env.DB.prepare(
      `SELECT id, upload_status
       FROM runtime_artifacts
       WHERE runtime_vm_id = ? AND kind = ? AND sha256 = ? AND size_bytes = ?
       LIMIT 1`,
    )
      .bind(runtimeVmId, kind, sha256, sizeBytes)
      .first<{ id: string; upload_status: "pending" | "uploaded" }>();
    if (existing?.upload_status === "uploaded") {
      return jsonResponse({
        identity,
        artifact_id: existing.id,
        already_uploaded: true,
      });
    }
    if (existing?.upload_status === "pending") {
      const capability = randomCapability("iwa_upload");
      const tokenHash = await sha256Hex(capability);
      const rotated = await env.DB.prepare(
        `UPDATE runtime_artifact_upload_grants
         SET token_hash = ?, expires_at = ?, used_at = NULL
         WHERE artifact_id = ? AND execution_id = ? AND generation = ?
         RETURNING artifact_id`,
      )
        .bind(
          tokenHash,
          expiresAt,
          existing.id,
          identity.execution_id,
          identity.generation,
        )
        .first<{ artifact_id: string }>();
      if (rotated) {
        return jsonResponse({
          identity,
          artifact_id: existing.id,
          signed_upload_url: new URL(
            `/api/runtime/workspace-agent/artifacts/uploads/${encodeURIComponent(capability)}`,
            authenticated.generation.control_plane_base_url,
          ).toString(),
          expires_at_unix_ms: expiresAt,
        });
      }
    }
  }
  const artifactId = `warta_${createAppId()}`;
  const capability = randomCapability("iwa_upload");
  const tokenHash = await sha256Hex(capability);
  const r2Key = `runtime/workshops/${identity.workspace_id}/generations/${identity.generation}/artifacts/${artifactId}`;
  const inserted = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runtime_artifacts (
         id, execution_id, runtime_vm_id, ordinal, kind, filename,
         content_type, size_bytes, sha256, r2_key, upload_status, created_at
       ) SELECT ?, ?, ?, COALESCE(MAX(ordinal), -1) + 1, ?, ?,
                'application/octet-stream', ?, ?, ?, 'pending', ?
         FROM runtime_artifacts WHERE runtime_vm_id = ?`,
    ).bind(
      artifactId,
      identity.execution_id,
      runtimeVmId,
      kind,
      `${kind}-${artifactId}.bin`,
      sizeBytes,
      sha256,
      r2Key,
      now,
      runtimeVmId,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_artifact_upload_grants (
         artifact_id, execution_id, generation, token_hash, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      artifactId,
      identity.execution_id,
      identity.generation,
      tokenHash,
      expiresAt,
      now,
    ),
  ]);
  if (inserted.some((result) => result.meta.changes !== 1)) {
    return jsonResponse({ error: "artifact grant could not be created" }, 409);
  }
  return jsonResponse({
    identity,
    artifact_id: artifactId,
    signed_upload_url: new URL(
      `/api/runtime/workspace-agent/artifacts/uploads/${encodeURIComponent(capability)}`,
      authenticated.generation.control_plane_base_url,
    ).toString(),
    expires_at_unix_ms: expiresAt,
  });
}

async function handleArtifactUpload(
  request: Request,
  env: Cloudflare.Env,
  capability: string,
): Promise<Response> {
  if (request.method !== "PUT") return methodNotAllowed();
  if (!request.body)
    return jsonResponse({ error: "artifact body is required" }, 400);
  const now = Date.now();
  const tokenHash = await sha256Hex(capability);
  const row = await env.DB.prepare(
    `SELECT
       grant.artifact_id, grant.execution_id, grant.generation,
       artifact.r2_key, artifact.sha256, artifact.size_bytes,
       artifact.upload_status, vm.artifact_writes_sealed
     FROM runtime_artifact_upload_grants grant
     INNER JOIN runtime_artifacts artifact ON artifact.id = grant.artifact_id
     INNER JOIN runtime_vms vm
       ON vm.id = artifact.runtime_vm_id
      AND vm.execution_id = grant.execution_id
     INNER JOIN runtime_executions execution
       ON execution.id = grant.execution_id
      AND execution.generation = grant.generation
      AND execution.state IN ('queued', 'provisioning', 'ready')
     INNER JOIN workshop_workspaces workspace
       ON workspace.id = execution.domain_id
     INNER JOIN workshop_workspace_generations workspace_generation
       ON workspace_generation.id = workspace.current_generation_id
      AND workspace_generation.runtime_execution_id = execution.id
      AND workspace_generation.ordinal = execution.generation
     WHERE grant.token_hash = ?
       AND grant.expires_at > ?
       AND grant.used_at IS NULL
     LIMIT 1`,
  )
    .bind(tokenHash, now)
    .first<{
      artifact_id: string;
      execution_id: string;
      generation: number;
      r2_key: string;
      sha256: string;
      size_bytes: number;
      upload_status: string;
      artifact_writes_sealed: number;
    }>();
  if (!row) return unauthorized();
  if (row.upload_status !== "pending" || row.artifact_writes_sealed) {
    return jsonResponse({ error: "artifact upload is closed" }, 409);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength !== row.size_bytes ||
    request.headers.get("x-intar-artifact-sha256") !== row.sha256
  ) {
    return jsonResponse(
      { error: "artifact metadata does not match the grant" },
      400,
    );
  }
  try {
    await env.VM_RUN_ARTIFACTS_BUCKET.put(row.r2_key, request.body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        executionId: row.execution_id,
        generation: String(row.generation),
        artifactId: row.artifact_id,
      },
      sha256: hexToArrayBuffer(row.sha256),
    });
  } catch {
    return jsonResponse(
      { error: "artifact payload failed integrity validation" },
      422,
    );
  }
  const completed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE runtime_artifact_upload_grants
       SET used_at = ? WHERE artifact_id = ? AND token_hash = ? AND used_at IS NULL`,
    ).bind(now, row.artifact_id, tokenHash),
    env.DB.prepare(
      `UPDATE runtime_artifacts
       SET upload_status = 'uploaded', uploaded_at = ?
       WHERE id = ? AND upload_status = 'pending'`,
    ).bind(now, row.artifact_id),
  ]);
  if (completed.some((result) => result.meta.changes !== 1)) {
    return jsonResponse(
      { error: "artifact upload grant was already consumed" },
      409,
    );
  }
  return jsonResponse({ artifact_id: row.artifact_id, uploaded: true });
}

async function authenticateGeneration(
  request: Request,
  env: Cloudflare.Env,
): Promise<
  | { ok: true; credential: string; generation: AuthenticatedGeneration }
  | { ok: false; response: Response }
> {
  const credential = parseAuthorization(request, "Bearer");
  if (!credential) return { ok: false, response: unauthorized() };
  const hash = await sha256Hex(credential);
  const now = Date.now();
  const generation = await env.DB.prepare(
    `SELECT
       guest.id,
       guest.execution_id,
       guest.workspace_id,
       guest.generation,
       guest.control_plane_base_url,
       guest.report_credential_expires_at,
       guest.checkpoint_bundle_id,
       artifact.checkpoint_id,
       artifact.r2_key AS checkpoint_r2_key,
       artifact.sha256 AS checkpoint_sha256,
       artifact.size_bytes AS checkpoint_size_bytes,
       artifact.compression AS checkpoint_compression,
       artifact.signature_b64 AS checkpoint_signature_b64,
       artifact.signing_key_id AS checkpoint_signing_key_id,
       execution.domain_kind,
       execution.provider_kind,
       allocation.id AS allocation_id,
       allocation.state AS allocation_state,
       allocation.recording_drain_completed_at,
       workspace_generation.id AS workspace_generation_id,
       execution.organization_id,
       workspace.session_id,
       workspace.user_id AS participant_user_id,
       COALESCE(learner_revision.manifest_json, certification_revision.manifest_json) AS manifest_json
     FROM runtime_guest_credentials guest
     INNER JOIN runtime_executions execution
       ON execution.id = guest.execution_id
      AND execution.domain_id = guest.workspace_id
      AND execution.generation = guest.generation
      AND execution.domain_kind IN ('workshop', 'workshop_certification')
      AND execution.provider_kind IN ('hetzner_cloud', 'gcp_compute')
      AND execution.state IN ('queued', 'provisioning', 'ready')
     LEFT JOIN workshop_workspaces workspace
       ON execution.domain_kind = 'workshop'
      AND workspace.id = execution.domain_id
     LEFT JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.organization_id = execution.organization_id
     LEFT JOIN workshop_template_revisions learner_revision
       ON learner_revision.id = session.template_revision_id
     LEFT JOIN workshop_workspace_generations workspace_generation
       ON workspace_generation.id = workspace.current_generation_id
      AND workspace_generation.runtime_execution_id = execution.id
      AND workspace_generation.ordinal = execution.generation
     LEFT JOIN workshop_session_runtime_selections selection
       ON selection.session_id = session.id
      AND selection.provider_kind = execution.provider_kind
      AND selection.connection_id = execution.provider_connection_id
     LEFT JOIN workshop_runtime_profile_certifications learner_certification
       ON learner_certification.runtime_profile_id = selection.runtime_profile_id
      AND learner_certification.connection_id = selection.connection_id
     LEFT JOIN workshop_runtime_profile_certifications certification
       ON execution.domain_kind = 'workshop_certification'
      AND certification.id = execution.domain_id
      AND certification.connection_id = execution.provider_connection_id
     LEFT JOIN workshop_runtime_profiles certification_profile
       ON certification_profile.id = certification.runtime_profile_id
      AND certification_profile.provider_kind = execution.provider_kind
     LEFT JOIN workshop_template_revisions certification_revision
       ON certification_revision.id = certification_profile.template_revision_id
     INNER JOIN runtime_checkpoint_bundles artifact
       ON artifact.id = guest.checkpoint_bundle_id
      AND artifact.template_revision_id = COALESCE(
        learner_revision.id,
        certification_revision.id
      )
      AND artifact.checkpoint_id = execution.checkpoint_id
     INNER JOIN runtime_provider_allocations allocation
       ON allocation.execution_id = guest.execution_id
      AND allocation.runtime_profile_id = COALESCE(
        selection.runtime_profile_id,
        certification_profile.id
      )
      AND allocation.connection_id = execution.provider_connection_id
      AND allocation.provider_kind = execution.provider_kind
      AND allocation.state NOT IN ('deleting', 'deleted', 'cleanup_pending')
     WHERE guest.report_credential_hash = ?
       AND guest.bootstrap_consumed_at IS NOT NULL
       AND guest.report_credential_revoked_at IS NULL
       AND guest.report_credential_expires_at > ?
       AND (
         (
           execution.domain_kind = 'workshop'
           AND workspace_generation.id IS NOT NULL
           AND learner_certification.state = 'verified'
           AND learner_certification.deletion_confirmed_at IS NOT NULL
           AND (
             session.state IN ('lobby', 'live')
             OR (
               session.state IN ('ended', 'cancelled')
               AND allocation.state = 'draining'
             )
           )
         )
         OR (
           execution.domain_kind = 'workshop_certification'
           AND certification.state IN ('pending', 'verifying')
           AND certification.verifier_allocation_id = allocation.id
         )
       )
     LIMIT 1`,
  )
    .bind(hash, now)
    .first<AuthenticatedGeneration>();
  return generation
    ? { ok: true, credential, generation }
    : { ok: false, response: unauthorized() };
}

async function loadTerminalTarget(
  env: Cloudflare.Env,
  executionId: string,
): Promise<RuntimeVmTerminalRow | null> {
  return env.DB.prepare(
    `SELECT
       vm.id AS runtime_vm_id,
       vm.vm_id,
       allocation.external_ipv4
     FROM runtime_vms vm
     INNER JOIN runtime_provider_allocations allocation
       ON allocation.execution_id = vm.execution_id
     INNER JOIN runtime_vm_access_keys access
       ON access.runtime_vm_id = vm.id
      AND access.execution_id = vm.execution_id
     WHERE vm.execution_id = ?
     ORDER BY vm.ordinal ASC
     LIMIT 1`,
  )
    .bind(executionId)
    .first<RuntimeVmTerminalRow>();
}

function parseReport(
  body: Record<string, unknown> | null,
  credential: string,
): SanitizedReport | null {
  if (!body || body.contract_version !== CONTRACT_VERSION) return null;
  const identity = parseIdentity(body.identity);
  const sequence = body.sequence;
  const checkpointId = body.checkpoint_id;
  const bootId = body.boot_id;
  const phase = body.phase;
  const health = body.health;
  const terminalReady = body.terminal_ready;
  const recordingDrainCompleted = body.recording_drain_completed ?? false;
  const reportedAt = body.reported_at_unix_ms;
  if (
    !identity ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    typeof checkpointId !== "string" ||
    !validId(checkpointId) ||
    typeof bootId !== "string" ||
    !validLinuxBootId(bootId) ||
    typeof phase !== "string" ||
    !PHASES.has(phase) ||
    typeof health !== "string" ||
    !HEALTH.has(health) ||
    typeof terminalReady !== "boolean" ||
    typeof recordingDrainCompleted !== "boolean" ||
    typeof reportedAt !== "number" ||
    !Number.isSafeInteger(reportedAt) ||
    !Array.isArray(body.ssh_host_keys_openssh) ||
    body.ssh_host_keys_openssh.length > 16 ||
    !Array.isArray(body.completed_module_ids) ||
    body.completed_module_ids.length > 256 ||
    !Array.isArray(body.probes) ||
    body.probes.length > 512
  ) {
    return null;
  }
  const hostKeys = [...new Set(body.ssh_host_keys_openssh)].sort();
  if (
    hostKeys.some(
      (key) =>
        typeof key !== "string" ||
        key.length > 4096 ||
        /[\r\n\0]/.test(key) ||
        !(key.startsWith("ssh-") || key.startsWith("ecdsa-")),
    )
  ) {
    return null;
  }
  if (terminalReady && hostKeys.length === 0) return null;
  const completedModuleIds = body.completed_module_ids;
  if (
    completedModuleIds.some(
      (moduleId) => typeof moduleId !== "string" || !validId(moduleId),
    ) ||
    new Set(completedModuleIds).size !== completedModuleIds.length
  ) {
    return null;
  }
  const probes: SanitizedProbe[] = [];
  const probeIds = new Set<string>();
  for (const candidate of body.probes) {
    if (!isRecord(candidate)) return null;
    const id = candidate.id;
    const status = candidate.status;
    const observedAt = candidate.observed_at_unix_ms;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      /[\r\n\0]/.test(id) ||
      probeIds.has(id) ||
      typeof status !== "string" ||
      !PROBE_STATUS.has(status) ||
      typeof observedAt !== "number" ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0
    ) {
      return null;
    }
    probeIds.add(id);
    const probeError = sanitizeError(candidate.error, [credential]);
    if (probeError === null) return null;
    probes.push({
      id,
      status: status as SanitizedProbe["status"],
      observed_at_unix_ms: observedAt,
      ...(probeError === undefined ? {} : { error: probeError }),
    });
  }
  const error =
    body.error === undefined
      ? undefined
      : sanitizeError(body.error, [credential]);
  if (error === null) return null;
  return {
    contract_version: CONTRACT_VERSION,
    identity,
    sequence,
    checkpoint_id: checkpointId,
    boot_id: bootId,
    phase: phase as SanitizedReport["phase"],
    health: health as SanitizedReport["health"],
    terminal_ready: terminalReady,
    recording_drain_completed: recordingDrainCompleted,
    completed_module_ids: completedModuleIds as string[],
    ssh_host_keys_openssh: hostKeys as string[],
    probes,
    ...(error === undefined ? {} : { error }),
    reported_at_unix_ms: reportedAt,
  };
}

function validLinuxBootId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}

function sanitizeError(
  value: unknown,
  secrets: readonly string[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096) return null;
  let sanitized = value.replace(/[\r\0]/g, "");
  for (const secret of secrets)
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  sanitized = sanitized.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[REDACTED]";
    }
  });
  return sanitized.slice(0, 1024);
}

function parseIdentity(value: unknown): SanitizedReport["identity"] | null {
  if (!isRecord(value)) return null;
  const executionId = value.execution_id;
  const workspaceId = value.workspace_id;
  const generation = value.generation;
  if (
    typeof executionId !== "string" ||
    !validId(executionId) ||
    typeof workspaceId !== "string" ||
    !validId(workspaceId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    return null;
  }
  return {
    execution_id: executionId,
    workspace_id: workspaceId,
    generation,
  };
}

function identitiesEqual(
  identity: SanitizedReport["identity"],
  row: Pick<CredentialRow, "execution_id" | "workspace_id" | "generation">,
): boolean {
  return (
    identity.execution_id === row.execution_id &&
    identity.workspace_id === row.workspace_id &&
    identity.generation === row.generation
  );
}

function providerState(phase: SanitizedReport["phase"]): string {
  if (phase === "ready") return "ready";
  if (phase === "degraded") return "degraded";
  if (phase === "failed") return "failed";
  return "bootstrapping";
}

function preferredHostKey(keys: readonly string[]): string {
  return keys.find((key) => key.startsWith("ssh-ed25519 ")) ?? keys[0] ?? "";
}

function parseAuthorization(request: Request, scheme: string): string | null {
  const value = request.headers.get("authorization");
  if (!value || value.includes(",")) return null;
  const prefix = `${scheme} `;
  if (!value.startsWith(prefix)) return null;
  const token = value.slice(prefix.length);
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}

async function readBoundedJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES)
    return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validVersion(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function randomCapability(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${prefix}_${encoded}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method not allowed" }, 405);
}

function unauthorized(): Response {
  return jsonResponse(
    { error: "invalid or expired workspace credential" },
    401,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  setPrivateNoStore(headers);
  return Response.json(body, { status, headers });
}

function setPrivateNoStore(headers: Headers): void {
  headers.set("cache-control", "private, no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
}
