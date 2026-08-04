import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const patchSql = readFileSync(
  new URL(
    "./finalize-confirmed-provider-delete-operations.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("confirmed provider delete operation repair", () => {
  test("only terminalizes operations with a deleted allocation and an exact confirmed-absent resource", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(`
        CREATE TABLE runtime_provider_allocations (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          location_attempt INTEGER NOT NULL,
          deletion_confirmed_at INTEGER
        );
        CREATE TABLE runtime_provider_resources (
          id TEXT PRIMARY KEY,
          allocation_id TEXT NOT NULL,
          location_attempt INTEGER NOT NULL,
          resource_kind TEXT NOT NULL,
          disappearance_confirmed_at INTEGER
        );
        CREATE TABLE runtime_provider_operations (
          id TEXT PRIMARY KEY,
          allocation_id TEXT NOT NULL,
          operation_kind TEXT NOT NULL,
          location_attempt INTEGER NOT NULL,
          state TEXT NOT NULL,
          retry_at INTEGER,
          last_polled_at INTEGER,
          completed_at INTEGER,
          error_class TEXT,
          error_code TEXT,
          sanitized_result_json TEXT,
          updated_at INTEGER NOT NULL
        );

        INSERT INTO runtime_provider_allocations VALUES
          ('deleted', 'deleted', 1, 500),
          ('not-deleted', 'deleting', 1, NULL),
          ('resource-present', 'deleted', 1, 500),
          ('wrong-attempt', 'deleted', 2, 500);

        INSERT INTO runtime_provider_resources VALUES
          ('instance', 'deleted', 1, 'instance', 480),
          ('disk', 'deleted', 1, 'boot_disk', 485),
          ('ipv4', 'deleted', 1, 'ipv4', 490),
          ('ssh-key', 'deleted', 1, 'ssh_key', 495),
          ('not-deleted-instance', 'not-deleted', 1, 'instance', 480),
          ('present-instance', 'resource-present', 1, 'instance', NULL),
          ('old-attempt-instance', 'wrong-attempt', 1, 'instance', 480);

        INSERT INTO runtime_provider_operations VALUES
          ('server', 'deleted', 'delete_server', 1, 'running', 600, NULL, NULL,
           'provider', 'action_missing', '{"providerState":"running"}', 100),
          ('server-action', 'deleted', 'delete_server:provider-operation', 1,
           'retryable', 600, NULL, NULL, 'provider', 'action_missing', NULL, 100),
          ('instance-delete', 'deleted', 'delete_instance', 1, 'pending', NULL,
           NULL, NULL, NULL, NULL, NULL, 100),
          ('disk-delete', 'deleted', 'delete_disk:provider-operation', 1,
           'running', 600, NULL, NULL, NULL, NULL, NULL, 100),
          ('ipv4-delete', 'deleted', 'delete_primary_ip', 1, 'running', 600,
           NULL, NULL, NULL, NULL, NULL, 100),
          ('ssh-delete', 'deleted', 'delete_ssh_key', 1, 'running', 600, NULL,
           NULL, NULL, NULL, NULL, 100),
          ('unrelated', 'deleted', 'reconcile', 1, 'running', 600, NULL, NULL,
           NULL, NULL, NULL, 100),
          ('not-deleted-operation', 'not-deleted', 'delete_server', 1,
           'running', 600, NULL, NULL, NULL, NULL, NULL, 100),
          ('present-resource-operation', 'resource-present', 'delete_server', 1,
           'running', 600, NULL, NULL, NULL, NULL, NULL, 100),
          ('wrong-attempt-operation', 'wrong-attempt', 'delete_server', 1,
           'running', 600, NULL, NULL, NULL, NULL, NULL, 100);
      `);

      database.exec(patchSql);
      database.exec(patchSql);

      const repaired = database
        .query(
          `SELECT id, state, retry_at, completed_at, error_class, error_code,
                  json_extract(sanitized_result_json, '$.confirmedAbsent') AS confirmed_absent,
                  json_extract(sanitized_result_json, '$.historicalRepair') AS historical_repair,
                  json_extract(sanitized_result_json, '$.providerState') AS provider_state
           FROM runtime_provider_operations
           WHERE id IN (
             'server', 'server-action', 'instance-delete', 'disk-delete',
             'ipv4-delete', 'ssh-delete'
           )
           ORDER BY id`,
        )
        .all();
      expect(repaired).toEqual([
        operation("disk-delete", 500),
        operation("instance-delete", 500),
        operation("ipv4-delete", 500),
        operation("server", 500, "running"),
        operation("server-action", 500),
        operation("ssh-delete", 500),
      ]);

      const untouched = database
        .query(
          `SELECT id, state, retry_at, completed_at
           FROM runtime_provider_operations
           WHERE id IN (
             'unrelated', 'not-deleted-operation',
             'present-resource-operation', 'wrong-attempt-operation'
           )
           ORDER BY id`,
        )
        .all();
      expect(untouched).toEqual([
        openOperation("not-deleted-operation"),
        openOperation("present-resource-operation"),
        openOperation("unrelated"),
        openOperation("wrong-attempt-operation"),
      ]);
    } finally {
      database.close(false);
    }
  });
});

function operation(id: string, completedAt: number, providerState: string | null = null) {
  return {
    id,
    state: "succeeded",
    retry_at: null,
    completed_at: completedAt,
    error_class: null,
    error_code: null,
    confirmed_absent: 1,
    historical_repair: 1,
    provider_state: providerState,
  };
}

function openOperation(id: string) {
  return {
    id,
    state: "running",
    retry_at: 600,
    completed_at: null,
  };
}
