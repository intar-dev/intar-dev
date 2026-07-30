import { createAppId } from "@/lib/id";

const CONTRACT_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const CHECKPOINT_DOWNLOAD_TTL_MS = 20 * 60_000;
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

interface VerificationIdentity {
  execution_id: string;
  workspace_id: string;
  generation: number;
}

interface BootstrapRow {
  attempt_id: string;
  provider_checkpoint_id: string;
  ordinal: number;
  control_plane_base_url: string;
  report_credential_expires_at: number;
  checkpoint_id: string;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  compression: "none" | "gzip" | "zstd";
  signature_b64: string;
  signing_key_id: string;
}

interface AuthenticatedAttempt extends BootstrapRow {
  expected_probes_json:
    | string
    | Array<{ moduleId: string; probeId: string }>;
  checkpoint_first_downloaded_at: number | null;
  state: string;
  last_report_sequence: number;
}

interface VerifierProbe {
  id: string;
  status: "unknown" | "pass" | "fail";
  observed_at_unix_ms: number;
  error?: string;
}

interface VerifierReport {
  contract_version: 1;
  identity: VerificationIdentity;
  sequence: number;
  phase: string;
  health: string;
  terminal_ready: boolean;
  recording_drain_completed: boolean;
  ssh_host_keys_openssh: string[];
  probes: VerifierProbe[];
  error?: string;
  reported_at_unix_ms: number;
}

export async function handleWorkshopPublicationVerifierRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/runtime/workshop-publication-verifier/bootstrap") {
    return handleBootstrap(request, env);
  }
  if (path === "/api/runtime/workshop-publication-verifier/reports") {
    return handleReport(request, env);
  }
  const checkpoint = path.match(
    /^\/api\/runtime\/workshop-publication-verifier\/checkpoints\/([A-Za-z0-9_-]{32,128})$/,
  );
  if (checkpoint) {
    return handleCheckpointDownload(request, env, checkpoint[1] ?? "");
  }
  if (path.startsWith("/api/runtime/workshop-publication-verifier/")) {
    return json({ error: "not found" }, 404);
  }
  return null;
}

async function handleBootstrap(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const capability = parseAuthorization(request, "Intar-Bootstrap");
  if (!capability) return unauthorized();
  const body = await readJson(request);
  const identity = parseIdentity(body?.identity);
  if (
    body?.contract_version !== CONTRACT_VERSION ||
    !identity ||
    typeof body?.agent_version !== "string" ||
    body.agent_version.length < 1 ||
    body.agent_version.length > 128
  ) {
    return json({ error: "invalid bootstrap request" }, 400);
  }
  const now = Date.now();
  const capabilityHash = await sha256Hex(capability);
  const row = await env.DB.prepare(
    `SELECT
       attempt.id AS attempt_id,
       attempt.provider_checkpoint_id,
       attempt.ordinal,
       attempt.control_plane_base_url,
       attempt.report_credential_expires_at,
       checkpoint.checkpoint_id,
       checkpoint.r2_key,
       checkpoint.sha256,
       checkpoint.size_bytes,
       checkpoint.compression,
       checkpoint.signature_b64,
       checkpoint.signing_key_id
     FROM workshop_publication_provider_attempts attempt
     INNER JOIN workshop_publication_provider_checkpoints checkpoint
       ON checkpoint.id = attempt.provider_checkpoint_id
      AND checkpoint.verification_status IN ('allocating', 'bootstrapping', 'applying')
     INNER JOIN workshop_publications publication
       ON publication.id = checkpoint.publication_id
      AND publication.status = 'building'
      AND publication.provider_verification_state = 'verifying'
     WHERE attempt.bootstrap_token_hash = ?
       AND attempt.bootstrap_consumed_at IS NULL
       AND attempt.bootstrap_expires_at > ?
       AND attempt.report_credential_expires_at > ?
       AND attempt.state IN ('allocating', 'bootstrapping')
     LIMIT 1`,
  )
    .bind(capabilityHash, now, now)
    .first<BootstrapRow>();
  if (!row || !identityMatches(identity, row)) return unauthorized();

  const reportCredential = randomCapability("iwpv_report");
  const checkpointCapability = randomCapability("iwpv_checkpoint");
  const reportHash = await sha256Hex(reportCredential);
  const checkpointHash = await sha256Hex(checkpointCapability);
  const checkpointExpiresAt = Math.min(
    now + CHECKPOINT_DOWNLOAD_TTL_MS,
    row.report_credential_expires_at,
  );
  // Keep the one-use credential exchange on the sequence-fenced attempt row.
  // The minute sweep derives the checkpoint state only after this write has
  // committed, avoiding a losing bootstrap request mutating the checkpoint.
  const result = await env.DB.prepare(
    `UPDATE workshop_publication_provider_attempts
     SET bootstrap_consumed_at = ?, report_credential_hash = ?,
         report_credential_issued_at = ?,
         checkpoint_download_token_hash = ?,
         checkpoint_download_expires_at = ?,
         state = 'applying', updated_at = ?
     WHERE id = ? AND bootstrap_token_hash = ?
       AND bootstrap_consumed_at IS NULL AND bootstrap_expires_at > ?
       AND state IN ('allocating', 'bootstrapping')`,
  )
    .bind(
      now,
      reportHash,
      now,
      checkpointHash,
      checkpointExpiresAt,
      now,
      row.attempt_id,
      capabilityHash,
      now,
    )
    .run();
  if (result.meta.changes !== 1) {
    return unauthorized();
  }

  return json({
    contract_version: CONTRACT_VERSION,
    identity,
    report_credential: reportCredential,
    checkpoint: {
      checkpoint_id: row.checkpoint_id,
      signed_url: new URL(
        `/api/runtime/workshop-publication-verifier/checkpoints/${encodeURIComponent(checkpointCapability)}`,
        row.control_plane_base_url,
      ).toString(),
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      compression: row.compression,
      signature_b64: row.signature_b64,
      signing_key_id: row.signing_key_id,
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
    `SELECT attempt.id, checkpoint.r2_key, checkpoint.sha256,
            checkpoint.size_bytes, checkpoint.compression
     FROM workshop_publication_provider_attempts attempt
     INNER JOIN workshop_publication_provider_checkpoints checkpoint
       ON checkpoint.id = attempt.provider_checkpoint_id
     INNER JOIN workshop_publications publication
       ON publication.id = checkpoint.publication_id
      AND publication.status = 'building'
      AND publication.provider_verification_state = 'verifying'
     WHERE attempt.checkpoint_download_token_hash = ?
       AND attempt.checkpoint_download_expires_at > ?
       AND attempt.report_credential_revoked_at IS NULL
       AND attempt.state IN ('applying', 'bootstrapping')
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
    return json({ error: "checkpoint unavailable" }, 404);
  }
  await env.DB.prepare(
    `UPDATE workshop_publication_provider_attempts
     SET checkpoint_first_downloaded_at =
           coalesce(checkpoint_first_downloaded_at, ?),
         updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, row.id)
    .run();
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(row.size_bytes),
    "x-intar-checkpoint-sha256": row.sha256,
    "x-intar-checkpoint-compression": row.compression,
  });
  setNoStore(headers);
  return new Response(object.body, { headers });
}

async function handleReport(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const credential = parseAuthorization(request, "Bearer");
  if (!credential) return unauthorized();
  const now = Date.now();
  const credentialHash = await sha256Hex(credential);
  const attempt = await env.DB.prepare(
    `SELECT
       attempt.id AS attempt_id,
       attempt.provider_checkpoint_id,
       attempt.ordinal,
       attempt.control_plane_base_url,
       attempt.report_credential_expires_at,
       attempt.checkpoint_first_downloaded_at,
       attempt.state,
       attempt.last_report_sequence,
       checkpoint.checkpoint_id,
       checkpoint.r2_key,
       checkpoint.sha256,
       checkpoint.size_bytes,
       checkpoint.compression,
       checkpoint.signature_b64,
       checkpoint.signing_key_id,
       checkpoint.expected_probes_json
     FROM workshop_publication_provider_attempts attempt
     INNER JOIN workshop_publication_provider_checkpoints checkpoint
       ON checkpoint.id = attempt.provider_checkpoint_id
     INNER JOIN workshop_publications publication
       ON publication.id = checkpoint.publication_id
      AND publication.status = 'building'
      AND publication.provider_verification_state = 'verifying'
     WHERE attempt.report_credential_hash = ?
       AND attempt.bootstrap_consumed_at IS NOT NULL
       AND attempt.report_credential_revoked_at IS NULL
       AND attempt.report_credential_expires_at > ?
       AND attempt.state IN ('applying', 'bootstrapping')
     LIMIT 1`,
  )
    .bind(credentialHash, now)
    .first<AuthenticatedAttempt>();
  if (!attempt) return unauthorized();
  const body = await readJson(request);
  const report = parseReport(body);
  if (!report) return json({ error: "invalid report" }, 400);
  if (!identityMatches(report.identity, attempt)) {
    return json({ error: "stale verifier attempt" }, 409);
  }
  if (report.sequence <= attempt.last_report_sequence) {
    return json({ error: "stale report sequence" }, 409);
  }

  const expectedProbeIds = jsonExpectedProbes(attempt.expected_probes_json).map(
    (probe) => probe.probeId,
  );
  const probeById = new Map(report.probes.map((probe) => [probe.id, probe]));
  const proofSucceeded =
    attempt.checkpoint_first_downloaded_at !== null &&
    report.phase === "ready" &&
    report.health === "healthy" &&
    report.terminal_ready &&
    report.ssh_host_keys_openssh.length > 0 &&
    expectedProbeIds.length > 0 &&
    expectedProbeIds.every((probeId) => probeById.get(probeId)?.status === "pass");
  const proofFailed =
    report.phase === "failed" || report.health === "failed";
  const safeError = report.error?.slice(0, 500) ?? null;
  const attemptState = proofSucceeded
    ? "proof_succeeded"
    : proofFailed
      ? "failed"
      : "applying";
  // Keep the monotonic report latch on one row. The verifier sweep derives
  // the checkpoint transition from this attempt after the write commits.
  // Updating both rows in a successful D1 batch would let a concurrently
  // losing report mutate the checkpoint even when its sequence-fenced attempt
  // update changed zero rows.
  const result = await env.DB.prepare(
    `UPDATE workshop_publication_provider_attempts
     SET last_report_sequence = ?, last_report_phase = ?,
         last_report_health = ?, last_report_at = ?, report_json = ?,
         state = ?, proof_report_sequence = CASE WHEN ? = 1 THEN ? ELSE proof_report_sequence END,
         proof_verified_at = CASE WHEN ? = 1 THEN ? ELSE proof_verified_at END,
         last_error_code = CASE WHEN ? = 1 THEN 'guest_reported_failure' ELSE last_error_code END,
         error = coalesce(?, error), updated_at = ?
     WHERE id = ? AND last_report_sequence < ?
       AND (? = 0 OR checkpoint_first_downloaded_at IS NOT NULL)
       AND state IN ('applying', 'bootstrapping')`,
  )
    .bind(
      report.sequence,
      report.phase,
      report.health,
      now,
      JSON.stringify(report),
      attemptState,
      proofSucceeded ? 1 : 0,
      report.sequence,
      proofSucceeded ? 1 : 0,
      now,
      proofFailed ? 1 : 0,
      safeError,
      now,
      attempt.attempt_id,
      report.sequence,
      proofSucceeded ? 1 : 0,
    )
    .run();
  if (result.meta.changes !== 1) {
    return json({ error: "stale report sequence" }, 409);
  }
  return json({
    accepted_sequence: report.sequence,
    drain_recordings: false,
  });
}

function parseReport(value: unknown): VerifierReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const identity = parseIdentity(input.identity);
  if (
    input.contract_version !== CONTRACT_VERSION ||
    !identity ||
    !Number.isSafeInteger(input.sequence) ||
    Number(input.sequence) < 1 ||
    typeof input.phase !== "string" ||
    !PHASES.has(input.phase) ||
    typeof input.health !== "string" ||
    !HEALTH.has(input.health) ||
    typeof input.terminal_ready !== "boolean" ||
    typeof input.recording_drain_completed !== "boolean" ||
    !Number.isSafeInteger(input.reported_at_unix_ms) ||
    !Array.isArray(input.ssh_host_keys_openssh) ||
    input.ssh_host_keys_openssh.length > 16 ||
    input.ssh_host_keys_openssh.some(
      (key) =>
        typeof key !== "string" ||
        key.length < 16 ||
        key.length > 16_384 ||
        /[\r\n\0]/.test(key),
    ) ||
    !Array.isArray(input.probes) ||
    input.probes.length > 512
  ) {
    return null;
  }
  const probes: VerifierProbe[] = [];
  const seen = new Set<string>();
  for (const raw of input.probes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const probe = raw as Record<string, unknown>;
    if (
      typeof probe.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(probe.id) ||
      seen.has(probe.id) ||
      typeof probe.status !== "string" ||
      !PROBE_STATUS.has(probe.status) ||
      !Number.isSafeInteger(probe.observed_at_unix_ms)
    ) {
      return null;
    }
    seen.add(probe.id);
    const error =
      typeof probe.error === "string" && probe.error.length <= 500
        ? probe.error
        : undefined;
    probes.push({
      id: probe.id,
      status: probe.status as VerifierProbe["status"],
      observed_at_unix_ms: Number(probe.observed_at_unix_ms),
      ...(error ? { error } : {}),
    });
  }
  const error =
    typeof input.error === "string" && input.error.length <= 500
      ? input.error
      : undefined;
  return {
    contract_version: 1,
    identity,
    sequence: Number(input.sequence),
    phase: input.phase,
    health: input.health,
    terminal_ready: input.terminal_ready,
    recording_drain_completed: input.recording_drain_completed,
    ssh_host_keys_openssh: input.ssh_host_keys_openssh as string[],
    probes,
    ...(error ? { error } : {}),
    reported_at_unix_ms: Number(input.reported_at_unix_ms),
  };
}

function parseIdentity(value: unknown): VerificationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.execution_id !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(identity.execution_id) ||
    typeof identity.workspace_id !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(identity.workspace_id) ||
    !Number.isSafeInteger(identity.generation) ||
    Number(identity.generation) < 1
  ) {
    return null;
  }
  return {
    execution_id: identity.execution_id,
    workspace_id: identity.workspace_id,
    generation: Number(identity.generation),
  };
}

function identityMatches(
  identity: VerificationIdentity,
  row: {
    attempt_id: string;
    provider_checkpoint_id: string;
    ordinal: number;
  },
): boolean {
  return (
    identity.execution_id === row.attempt_id &&
    identity.workspace_id === row.provider_checkpoint_id &&
    identity.generation === row.ordinal
  );
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseAuthorization(
  request: Request,
  scheme: string,
): string | null {
  const value = request.headers.get("authorization");
  const prefix = `${scheme} `;
  if (
    !value ||
    !value.startsWith(prefix) ||
    value.length <= prefix.length ||
    value.length > 4_096
  ) {
    return null;
  }
  const token = value.slice(prefix.length);
  return /[\s\r\n\0]/.test(token) ? null : token;
}

function randomCapability(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${prefix}_${createAppId()}_${encoded}`;
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

function json(body: unknown, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  setNoStore(headers);
  return Response.json(body, { status, headers });
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function methodNotAllowed(): Response {
  return json({ error: "method not allowed" }, 405);
}

function setNoStore(headers: Headers): void {
  headers.set("cache-control", "private, no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
}

function jsonExpectedProbes(
  value: string | Array<{ moduleId: string; probeId: string }>,
): Array<{ moduleId: string; probeId: string }> {
  let parsed: unknown = value;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is { moduleId: string; probeId: string } =>
      !!entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).moduleId === "string" &&
      typeof (entry as Record<string, unknown>).probeId === "string",
  );
}
