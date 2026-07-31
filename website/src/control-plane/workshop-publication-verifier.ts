import { createAppId } from "@/lib/id";

const CONTRACT_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const CHECKPOINT_DOWNLOAD_TTL_MS = 20 * 60_000;
// Kino starts before checkpoint reconstruction and may retain the result of a
// 120-second run that began just before readiness. Allow that run, one full
// post-ready run, scheduling, and report jitter before declaring it stuck.
const PROBE_FAILURE_PERSISTENCE_MS = 5 * 60_000;
const PROBE_FAILURE_SINCE_KEY = "_intar_probe_failure_since_unix_ms";
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
  covered_module_ids_json: string | string[];
  expected_probes_json: string | Array<{ moduleId: string; probeId: string }>;
  verification_basis_checkpoint_id: string | null;
  checkpoint_first_downloaded_at: number | null;
  state: string;
  last_report_sequence: number;
  report_json: string | Record<string, unknown> | null;
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
  completed_module_ids: string[];
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
       attempt.report_json,
       checkpoint.checkpoint_id,
       checkpoint.r2_key,
       checkpoint.sha256,
       checkpoint.size_bytes,
       checkpoint.compression,
       checkpoint.signature_b64,
       checkpoint.signing_key_id,
       checkpoint.covered_module_ids_json,
       checkpoint.expected_probes_json,
       checkpoint.verification_basis_checkpoint_id
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
  const expectedProbeIds = jsonExpectedProbes(attempt.expected_probes_json).map(
    (probe) => probe.probeId,
  );
  const expectedModuleIds = jsonStringArray(
    attempt.covered_module_ids_json,
    256,
  );
  if (expectedProbeIds.length === 0 || expectedModuleIds.length === 0) {
    return json({ error: "invalid verifier checkpoint contract" }, 409);
  }
  const report = parseReport(
    body,
    [credential],
    new Set(expectedProbeIds),
    expectedModuleIds,
  );
  if (!report) return json({ error: "invalid report" }, 400);
  if (!identityMatches(report.identity, attempt)) {
    return json({ error: "stale verifier attempt" }, 409);
  }
  if (report.sequence <= attempt.last_report_sequence) {
    return json({ error: "stale report sequence" }, 409);
  }

  const probeById = new Map(report.probes.map((probe) => [probe.id, probe]));
  const previousReport = parseStoredReport(
    attempt.report_json,
    new Set(expectedProbeIds),
    expectedModuleIds,
  );
  const failedProbeIds = failedExpectedProbeIds(report, expectedProbeIds);
  const previousFailedProbeIds = new Set(
    previousReport
      ? failedExpectedProbeIds(previousReport, expectedProbeIds)
      : [],
  );
  const previousFailureSince = parseStoredFailureSince(
    attempt.report_json,
    expectedProbeIds,
    now,
  );
  const failureSince = new Map<string, number>();
  // The workspace agent awaits each report before reserving the next one.
  // Sequence gaps can still follow a transport failure, so a gap must never
  // inherit a failure window from a report the control plane did not observe.
  const adjacentReport = report.sequence === attempt.last_report_sequence + 1;
  if (
    attempt.checkpoint_first_downloaded_at !== null &&
    readyForProof(report)
  ) {
    for (const probeId of failedProbeIds) {
      failureSince.set(
        probeId,
        adjacentReport &&
          previousReport !== null &&
          readyForProof(previousReport) &&
          previousFailedProbeIds.has(probeId)
          ? (previousFailureSince.get(probeId) ?? now)
          : now,
      );
    }
  }
  const persistentFailedProbeIds = failedProbeIds.filter(
    (probeId) =>
      now - (failureSince.get(probeId) ?? now) >= PROBE_FAILURE_PERSISTENCE_MS,
  );
  const persistentProbeFailure =
    attempt.checkpoint_first_downloaded_at !== null &&
    readyForProof(report) &&
    persistentFailedProbeIds.length > 0;
  const proofSucceeded =
    attempt.checkpoint_first_downloaded_at !== null &&
    readyForProof(report) &&
    expectedProbeIds.length > 0 &&
    expectedProbeIds.every(
      (probeId) => probeById.get(probeId)?.status === "pass",
    ) &&
    (attempt.verification_basis_checkpoint_id === null ||
      arraysEqual(report.completed_module_ids, expectedModuleIds));
  const proofFailed =
    report.phase === "failed" ||
    report.health === "failed" ||
    persistentProbeFailure;
  const failureCode = persistentProbeFailure
    ? "publication_verifier_probe_persisted"
    : proofFailed
      ? "guest_reported_failure"
      : null;
  const safeError = persistentProbeFailure
    ? `required workshop probes remained failed after readiness: ${persistentFailedProbeIds.join(", ")}`.slice(
        0,
        500,
      )
    : (report.error?.slice(0, 500) ?? null);
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
         last_error_code = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error_code END,
         error = coalesce(?, error), updated_at = ?
     WHERE id = ? AND last_report_sequence = ?
       AND (? = 0 OR checkpoint_first_downloaded_at IS NOT NULL)
       AND state IN ('applying', 'bootstrapping')`,
  )
    .bind(
      report.sequence,
      report.phase,
      report.health,
      now,
      JSON.stringify({
        ...report,
        [PROBE_FAILURE_SINCE_KEY]: Object.fromEntries(failureSince),
      }),
      attemptState,
      proofSucceeded ? 1 : 0,
      report.sequence,
      proofSucceeded ? 1 : 0,
      now,
      failureCode,
      failureCode,
      safeError,
      now,
      attempt.attempt_id,
      attempt.last_report_sequence,
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

function parseReport(
  value: unknown,
  secrets: readonly string[] = [],
  expectedProbeIds?: ReadonlySet<string>,
  expectedModuleIds: readonly string[] = [],
): VerifierReport | null {
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
    !Array.isArray(input.probes) ||
    input.probes.length > 512
  ) {
    return null;
  }
  const hostKeys = parseHostKeys(input.ssh_host_keys_openssh);
  if (!hostKeys || (input.terminal_ready && hostKeys.length === 0)) return null;
  const completedModuleIds = jsonStringArray(
    input.completed_module_ids ?? [],
    256,
  );
  if (
    completedModuleIds.length > expectedModuleIds.length ||
    completedModuleIds.some(
      (moduleId, index) => moduleId !== expectedModuleIds[index],
    )
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
      (expectedProbeIds !== undefined && !expectedProbeIds.has(probe.id)) ||
      typeof probe.status !== "string" ||
      !PROBE_STATUS.has(probe.status) ||
      !Number.isSafeInteger(probe.observed_at_unix_ms)
    ) {
      return null;
    }
    seen.add(probe.id);
    const error = sanitizeError(probe.error, secrets);
    if (error === null) return null;
    probes.push({
      id: probe.id,
      status: probe.status as VerifierProbe["status"],
      observed_at_unix_ms: Number(probe.observed_at_unix_ms),
      ...(error === undefined ? {} : { error }),
    });
  }
  const error =
    input.error === undefined ? undefined : sanitizeError(input.error, secrets);
  if (error === null) return null;
  const report: VerifierReport = {
    contract_version: 1,
    identity,
    sequence: Number(input.sequence),
    phase: input.phase,
    health: input.health,
    terminal_ready: input.terminal_ready,
    recording_drain_completed: input.recording_drain_completed,
    completed_module_ids: completedModuleIds,
    ssh_host_keys_openssh: hostKeys,
    probes,
    ...(error === undefined ? {} : { error }),
    reported_at_unix_ms: Number(input.reported_at_unix_ms),
  };
  const serialized = JSON.stringify(report);
  if (
    secrets.some((secret) => secret.length > 0 && serialized.includes(secret))
  ) {
    return null;
  }
  return report;
}

function sanitizeError(
  value: unknown,
  secrets: readonly string[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096) return null;
  let sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  sanitized = sanitized.replace(
    /iwpv_(?:bootstrap|checkpoint|report)_[A-Za-z0-9_-]+/g,
    "[REDACTED]",
  );
  sanitized = sanitized.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return url.origin;
    } catch {
      return "[REDACTED]";
    }
  });
  const bounded = sanitized.slice(0, 500).trim();
  return bounded.length === 0 ? undefined : bounded;
}

function parseHostKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const hostKeys = new Set<string>();
  for (const raw of value) {
    if (
      typeof raw !== "string" ||
      raw.length < 16 ||
      raw.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(raw)
    ) {
      return null;
    }
    const [algorithm, blob] = raw.trim().split(/[ \t]+/);
    if (
      !algorithm ||
      !blob ||
      !/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/.test(
        algorithm,
      ) ||
      blob.length < 16 ||
      blob.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,3}$/.test(blob)
    ) {
      return null;
    }
    hostKeys.add(`${algorithm} ${blob}`);
  }
  return [...hostKeys].sort();
}

function parseStoredReport(
  value: string | Record<string, unknown> | null,
  expectedProbeIds: ReadonlySet<string>,
  expectedModuleIds: readonly string[],
): VerifierReport | null {
  const stored = parseStoredObject(value);
  return stored
    ? parseReport(stored, [], expectedProbeIds, expectedModuleIds)
    : null;
}

function parseStoredFailureSince(
  value: string | Record<string, unknown> | null,
  expectedProbeIds: string[],
  now: number,
): Map<string, number> {
  const stored = parseStoredObject(value);
  const raw = stored?.[PROBE_FAILURE_SINCE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return new Map();
  }
  const input = raw as Record<string, unknown>;
  const result = new Map<string, number>();
  for (const probeId of expectedProbeIds) {
    const timestamp = input[probeId];
    if (
      Number.isSafeInteger(timestamp) &&
      Number(timestamp) >= 0 &&
      Number(timestamp) <= now
    ) {
      result.set(probeId, Number(timestamp));
    }
  }
  return result;
}

function parseStoredObject(
  value: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readyForProof(report: VerifierReport): boolean {
  return (
    report.phase === "ready" &&
    report.health === "healthy" &&
    report.terminal_ready &&
    report.ssh_host_keys_openssh.length > 0
  );
}

function failedExpectedProbeIds(
  report: VerifierReport,
  expectedProbeIds: string[],
): string[] {
  const byId = new Map(report.probes.map((probe) => [probe.id, probe.status]));
  return [
    ...new Set(
      expectedProbeIds.filter((probeId) => byId.get(probeId) === "fail"),
    ),
  ];
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

function parseAuthorization(request: Request, scheme: string): string | null {
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

function jsonStringArray(value: unknown, maxLength: number): string[] {
  let parsed = value;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > maxLength) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(entry) ||
      seen.has(entry)
    ) {
      return [];
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
