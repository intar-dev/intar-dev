import type { D1Statement, D1WriteClient } from "./d1-rest-client";
import type { GeneratedMigrationApplyEvidence } from "./apply-generated-migrations";

export interface MetalReleaseArtifacts {
  buildArtifactId: string;
  buildArtifactDigest: string;
  guestToolsPinSha256: string;
}

export interface MetalRetirementIdentity {
  artifacts?: MetalReleaseArtifacts;
  operationId: string;
  databaseId: string;
  revision: string;
}
export interface MetalRetirementEvidence extends MetalRetirementIdentity {
  schemaVersion: 1;
  hostIds: string[];
  lastLeaseExpiresAt: string | number | boolean | null;
  retiredAt: number;
  migrations: GeneratedMigrationApplyEvidence;
  runtimeRetiredAt?: number;
}

export const METAL_GATES = ["image_cutover", "personal_metal_registration", "platform_metal_registration"] as const;

export async function closeMetalGates(client: D1WriteClient, now = Date.now()): Promise<void> {
  await client.batch([
    assertion("NOT EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'personal_metal_retirement' AND state = 'open')"),
    ...[...METAL_GATES, "personal_metal_retirement"].map(key => ({
      sql: "INSERT INTO runtime_operation_gates (key, state, updated_at) VALUES (?, 'drained', ?) ON CONFLICT(key) DO UPDATE SET state = 'drained', updated_at = excluded.updated_at",
      params: [key, now],
    })),
  ]);
}

export const closedMetalGates = "(SELECT count(*) FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration', 'platform_metal_registration') AND state = 'drained') = 3";

/** A single D1 transaction. Host IDs and every history FK stay unchanged. */
export async function retireMetalFleet(client: D1WriteClient, now = Date.now(), operation?: MetalRetirementIdentity & { migrations: GeneratedMigrationApplyEvidence }) {
  const hosts = await client.query("SELECT id FROM agent_hosts ORDER BY id");
  const hostIds = hosts.rows.map(row => String(row.id));
  const leases = await client.query("SELECT max(lease_expires_at) AS deadline FROM runtime_executions");
  const retirement = { hostIds, lastLeaseExpiresAt: leases.rows[0]?.deadline ?? null, retiredAt: now };
  await client.batch([
    assertion(closedMetalGates),
    assertion("EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'personal_metal_retirement' AND state = 'drained')"),
    ...(operation ? [assertion("EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'personal_metal_retirement' AND evidence_json IS NULL)")] : []),
    // A repeat does not rotate generations again. Null scope can never enroll
    // or authenticate; replacement servers must have new IDs and credentials.
    { sql: `UPDATE agent_hosts SET credential_generation = credential_generation + CASE WHEN disabled = 0 OR scope IS NOT NULL THEN 1 ELSE 0 END,
      scope = NULL, disabled = 1, scenario_enabled = 0, connected = 0,
      active_session_id = NULL, disconnected_at = coalesce(disconnected_at, ?), updated_at = ?`, params: [now, now] },
    { sql: "UPDATE agent_bootstrap_tokens SET revoked_at = ? WHERE revoked_at IS NULL", params: [now] },
    { sql: "UPDATE host_enrollments SET revoked_at = ? WHERE revoked_at IS NULL", params: [now] },
    { sql: "UPDATE image_builds SET status = 'failed', phase = 'failed', error = 'Host retired for personal metal release.', updated_at = ? WHERE status IN ('queued', 'assigned', 'building')", params: [now] },
    { sql: `UPDATE scenario_runs SET state = 'failed', state_rank = 8, active_key = NULL,
      state_json = json_set(state_json, '$.phase', 'failed'), failed_at = coalesce(failed_at, ?), updated_at = ?
      WHERE state NOT IN ('completed', 'failed')`, params: [now, now] },
    { sql: "UPDATE scenario_runs SET active_key = NULL, route_cleanup_id = NULL WHERE active_key IS NOT NULL OR route_cleanup_id IS NOT NULL" },
    { sql: "UPDATE runtime_executions SET state = 'archived', lease_expires_at = NULL, ended_at = coalesce(ended_at, ?), updated_at = ? WHERE state <> 'archived' OR lease_expires_at IS NOT NULL", params: [now, now] },
    // Retain uploaded artifacts and incomplete upload evidence. Seal the VMs,
    // erase attach secrets, and end terminal sessions without claiming upload
    // success or physical VM absence.
    { sql: `UPDATE runtime_vms SET artifact_writes_sealed = 1,
      terminal_host = NULL, terminal_port = NULL, terminal_username = NULL,
      terminal_host_key_openssh = NULL, terminal_private_key_ciphertext_b64 = NULL,
      terminal_private_key_iv_b64 = NULL, terminal_observed_at = NULL, terminal_attached_at = NULL, updated_at = ?`, params: [now] },
    { sql: "UPDATE runtime_terminal_sessions SET ended_at = max(started_at, ?) WHERE ended_at IS NULL", params: [now] },
    ...["personal_image_preparations", "runtime_vm_access_keys", "scenario_run_ssh_keys", "active_runtime_slots", "host_cpu_reservations", "host_resource_reservations",
      "host_desired_state", "host_actual_state", "runtime_vm_actual_state", "image_build_coordination_locks"].map(table => ({ sql: `DELETE FROM ${table}` })),
    ...(operation ? [{
      sql: "UPDATE runtime_operation_gates SET evidence_json = ?, updated_at = ? WHERE key = 'personal_metal_retirement'",
      params: [JSON.stringify({ schemaVersion: 1, ...operation, ...retirement }), now],
    }] : []),
  ]);
  await verifyRetiredMetalFleet(client, hostIds);
  return retirement;
}

/** SELECT * also reads the pre-migration gate without assuming the new column exists. */
export async function loadMetalRetirementEvidence(client: D1WriteClient, identity: MetalRetirementIdentity) {
  const row = (await client.query("SELECT * FROM runtime_operation_gates WHERE key = 'personal_metal_retirement'")).rows[0];
  if (row?.evidence_json == null) {
    if (row?.state === "open") throw new Error("completed retirement has no recoverable evidence");
    return null;
  }
  const evidence = JSON.parse(String(row.evidence_json)) as MetalRetirementEvidence;
  if (evidence.schemaVersion !== 1 || evidence.operationId !== identity.operationId || evidence.databaseId !== identity.databaseId ||
      evidence.revision !== identity.revision || !Array.isArray(evidence.hostIds) || evidence.hostIds.some(id => typeof id !== "string") ||
      !Number.isSafeInteger(evidence.retiredAt) || !evidence.migrations?.schemaSha256 ||
      !["open", "drained"].includes(String(row.state)) || (row.state === "open" && !Number.isSafeInteger(evidence.runtimeRetiredAt))) {
    throw new Error("retirement evidence does not match this release operation and database");
  }
  return { complete: row.state === "open", evidence };
}

export async function completeMetalRetirement(client: D1WriteClient, evidence: MetalRetirementEvidence) {
  const completed = { ...evidence, runtimeRetiredAt: Date.now() };
  await client.batch([
    assertion(closedMetalGates),
    { sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM runtime_operation_gates WHERE key = 'personal_metal_retirement'
        AND state = 'drained' AND evidence_json = ?) THEN 0 ELSE abs(-9223372036854775808) END`, params: [JSON.stringify(evidence)] },
    { sql: "UPDATE runtime_operation_gates SET state = 'open', evidence_json = ?, updated_at = ? WHERE key = 'personal_metal_retirement'",
      params: [JSON.stringify(completed), completed.runtimeRetiredAt] },
  ]);
  return completed;
}

/** A paused D1 gate has no expiry and blocks every collector isolate. */
export async function verifyMetalCollectorHold(client: D1WriteClient): Promise<void> {
  const proof = await client.query(`SELECT paused_at FROM image_registry_admission
    WHERE key = 'image_registry_admission' AND paused_at IS NOT NULL AND state = 'open' AND sweep_token IS NULL`);
  if (proof.rows.length !== 1) throw new Error("maintenance resume requires a paused, idle collector in D1");
}

export async function verifyRetiredMetalFleet(client: D1WriteClient, hostIds: readonly string[]): Promise<void> {
  for (const hostId of hostIds) {
    const row = await client.query(`SELECT id FROM agent_hosts WHERE id = ? AND scope IS NULL AND disabled = 1
      AND connected = 0 AND active_session_id IS NULL AND scenario_enabled = 0`, [hostId]);
    if (row.rows.length !== 1) throw new Error(`old host is missing or active: ${hostId}`);
  }
  const invalid = await client.query(`SELECT
    (SELECT count(*) FROM runtime_executions e JOIN agent_hosts h ON h.id = e.host_id WHERE h.scope IS NULL AND (e.state <> 'archived' OR e.lease_expires_at IS NOT NULL)) +
    (SELECT count(*) FROM runtime_vms vm JOIN runtime_executions e ON e.id = vm.execution_id JOIN agent_hosts h ON h.id = e.host_id WHERE h.scope IS NULL AND vm.artifact_writes_sealed <> 1) +
    (SELECT count(*) FROM host_desired_state d JOIN agent_hosts h ON h.id = d.host_id WHERE h.scope IS NULL) +
    (SELECT count(*) FROM scenario_runs r JOIN agent_hosts h ON h.id = r.host_id WHERE h.scope IS NULL AND r.route_cleanup_id IS NOT NULL) +
    (SELECT count(*) FROM agent_bootstrap_tokens t JOIN agent_hosts h ON h.id = t.host_id WHERE h.scope IS NULL AND t.revoked_at IS NULL) AS count`);
  if (invalid.rows[0]?.count !== 0) throw new Error("old fleet retirement is incomplete");
  if ((await client.query("PRAGMA foreign_key_check")).rows.length) throw new Error("retirement has foreign key violations");
}

export function assertion(condition: string): D1Statement {
  // SQLite integer overflow aborts the D1 batch, including all earlier writes.
  return { sql: `SELECT CASE WHEN (${condition}) THEN 0 ELSE abs(-9223372036854775808) END` };
}
