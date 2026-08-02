import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

const drainSql = readFileSync(
  fileURLToPath(new URL("./legacy-drain.sql", import.meta.url)),
  "utf8",
);

describe("legacy drain query", () => {
  test("keeps terminal lifecycle residue out of blocking counts", () => {
    const db = legacyDatabase();
    db.exec(`
      INSERT INTO host_desired_state VALUES (
        'host-history', 9,
        '{"vms":[{"desired_phase":"absent"}],"builds":[]}'
      );
      INSERT INTO runtime_executions VALUES ('execution-ended', 1700000000000);
      INSERT INTO runtime_vm_actual_state VALUES ('execution-ended', 'ready');
      INSERT INTO workshop_publications VALUES ('publication-failed', 'failed', 'failed');
      INSERT INTO workshop_publications VALUES ('publication-published', 'published', 'verified');
      INSERT INTO workshop_publication_checkpoints VALUES ('publication-failed', 'pending');
      INSERT INTO workshop_publication_checkpoints VALUES ('publication-published', 'building');
      INSERT INTO workshop_publication_provider_checkpoints VALUES ('publication-failed', 'pending');
      INSERT INTO workshop_publication_provider_checkpoints VALUES ('publication-published', 'cleanup_pending');
    `);

    const row = queryDrain(db);
    expect(row.host_desired_vm_entries).toBe(0);
    expect(row.nonabsent_runtime_vm_actual_states).toBe(0);
    expect(row.active_workshop_publication_checkpoints).toBe(0);
    expect(row.active_publication_provider_checkpoints).toBe(0);
    expect(row.residual_host_desired_vm_entries).toBe(1);
    expect(row.residual_nonabsent_runtime_vm_actual_states).toBe(1);
    expect(row.residual_workshop_publication_checkpoints).toBe(2);
    expect(row.residual_publication_provider_checkpoints).toBe(2);
  });

  test("blocks active lifecycle state and malformed desired VM entries", () => {
    const db = legacyDatabase();
    db.exec(`
      INSERT INTO host_desired_state VALUES (
        'host-active', 1,
        '{"vms":[{"desired_phase":"running"},{"vm_name":"missing-phase"}],"builds":[]}'
      );
      INSERT INTO runtime_executions VALUES ('execution-live', NULL);
      INSERT INTO runtime_vm_actual_state VALUES ('execution-live', 'ready');
      INSERT INTO workshop_publications VALUES ('publication-live', 'building', 'verifying');
      INSERT INTO workshop_publication_checkpoints VALUES ('publication-live', 'pending');
      INSERT INTO workshop_publication_provider_checkpoints VALUES ('publication-live', 'applying');
    `);

    const row = queryDrain(db);
    expect(row.host_desired_vm_entries).toBe(2);
    expect(row.nonabsent_runtime_vm_actual_states).toBe(1);
    expect(row.active_workshop_publication_checkpoints).toBe(1);
    expect(row.active_publication_provider_checkpoints).toBe(1);
  });

  test("retains strict freshness checks for enabled hosts", () => {
    const db = legacyDatabase();
    db.exec(`
      INSERT INTO agent_hosts VALUES (
        'builder-1', 0, 'builder', 0, 0, NULL
      );
    `);
    expect(queryDrain(db).untrustworthy_enabled_host_reports).toBe(1);

    const now = Date.now();
    db.prepare(
      "UPDATE agent_hosts SET connected = 1, last_heartbeat_at = ? WHERE id = 'builder-1'",
    ).run(now);
    db.prepare(
      "INSERT INTO host_desired_state VALUES ('builder-1', 4, ?)",
    ).run('{"vms":[],"builds":[]}');
    db.prepare(
      "INSERT INTO host_actual_state VALUES ('builder-1', 4, ?, ?)",
    ).run(now, '{"vms":[],"builds":[]}');

    expect(queryDrain(db).untrustworthy_enabled_host_reports).toBe(0);
  });
});

function queryDrain(db: DatabaseSync): Record<string, number> {
  return db.prepare(drainSql).get() as Record<string, number>;
}

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE active_runtime_slots (id TEXT);
    CREATE TABLE runtime_executions (id TEXT PRIMARY KEY, ended_at INTEGER);
    CREATE TABLE hetzner_allocations (deletion_confirmed_at INTEGER);
    CREATE TABLE workshop_publication_provider_attempts (deletion_confirmed_at INTEGER);
    CREATE TABLE runtime_provider_cost_ledger (deletion_confirmed_at INTEGER);
    CREATE TABLE workshop_publication_provider_cost_ledger (deletion_confirmed_at INTEGER);
    CREATE TABLE organization_provider_connections (state TEXT, active_credential_version_id TEXT);
    CREATE TABLE runtime_terminal_sessions (ended_at INTEGER);
    CREATE TABLE runtime_artifacts (upload_status TEXT);
    CREATE TABLE runtime_provider_artifact_upload_grants (used_at INTEGER, expires_at INTEGER);
    CREATE TABLE workshop_assist_grants (revoked_at INTEGER, expires_at INTEGER);
    CREATE TABLE workshop_help_requests (status TEXT);
    CREATE TABLE workshop_route_issuance_intents (state TEXT);
    CREATE TABLE runtime_allocation_locks (id TEXT);
    CREATE TABLE host_resource_reservations (released_at INTEGER);
    CREATE TABLE host_cpu_reservations (id TEXT);
    CREATE TABLE image_builds (status TEXT);
    CREATE TABLE image_build_coordination_locks (id TEXT);
    CREATE TABLE host_desired_state (host_id TEXT PRIMARY KEY, version INTEGER, doc_json TEXT);
    CREATE TABLE host_actual_state (
      host_id TEXT PRIMARY KEY,
      applied_desired_version INTEGER,
      updated_at INTEGER,
      report_json TEXT
    );
    CREATE TABLE runtime_vm_actual_state (execution_id TEXT, phase TEXT);
    CREATE TABLE agent_hosts (
      id TEXT PRIMARY KEY,
      disabled INTEGER,
      role TEXT,
      scenario_enabled INTEGER,
      connected INTEGER,
      last_heartbeat_at INTEGER
    );
    CREATE TABLE workshop_publications (
      id TEXT PRIMARY KEY,
      status TEXT,
      provider_verification_state TEXT
    );
    CREATE TABLE workshop_publication_checkpoints (publication_id TEXT, status TEXT);
    CREATE TABLE workshop_publication_provider_checkpoints (
      publication_id TEXT,
      verification_status TEXT
    );
    CREATE TABLE workshop_sessions (state TEXT);
    CREATE TABLE workshop_workspaces (state TEXT);
    CREATE TABLE workshop_workspace_generations (state TEXT);
    CREATE TABLE scenario_runs (active_key TEXT);
  `);
  return db;
}
