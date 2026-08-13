import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type {
  D1Row,
  D1Statement,
  D1StatementResult,
  D1Value,
  D1WriteClient,
} from "./d1-rest-client";
import {
  parseArguments,
  SOURCE_QUIESCENCE_CONFIRMATION,
} from "./quiesce-production-d1-source";
import { runProductionD1SourceQuiescence } from "./production-d1-source-quiescence";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));

describe("production D1 source quiescence CLI", () => {
  test("requires exact source identity and confirmation", () => {
    expect(
      parseArguments([
        "--dry-run",
        "--source-database-id",
        SOURCE_ID,
        "--confirm-source-database-id",
        SOURCE_ID,
        "--confirmation",
        SOURCE_QUIESCENCE_CONFIRMATION,
        "--evidence",
        "evidence.json",
      ]),
    ).toMatchObject({ mode: "dry-run", sourceDatabaseId: SOURCE_ID });
    expect(() =>
      parseArguments([
        "--apply",
        "--source-database-id",
        SOURCE_ID,
        "--confirm-source-database-id",
        "22222222-2222-4222-8222-222222222222",
        "--confirmation",
        SOURCE_QUIESCENCE_CONFIRMATION,
        "--evidence",
        "evidence.json",
      ]),
    ).toThrow("does not match");
    expect(() =>
      parseArguments([
        "--apply",
        "--source-database-id",
        SOURCE_ID,
        "--confirm-source-database-id",
        SOURCE_ID,
        "--confirmation",
        "close enough",
        "--evidence",
        "evidence.json",
      ]),
    ).toThrow(SOURCE_QUIESCENCE_CONFIRMATION);
  });
});

describe("production D1 source quiescence", () => {
  test("preflights without mutation, then retires capabilities and observations", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      const dryRun = await runProductionD1SourceQuiescence({
        mode: "dry-run",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        source,
        now: NOW,
      });
      expect(dryRun.status).toBe("quiescence_preflight_passed");
      expect(dryRun.after).toBeNull();
      expect(
        Object.fromEntries(dryRun.before.map(({ id, count }) => [id, count])),
      ).toMatchObject({
        agent_bootstrap: 1,
        registry_tokens: 1,
        host_actual_state: 1,
      });
      expect(activeCapabilityCounts(source.database)).toEqual({
        agent: 1,
        registry: 1,
        actual: 1,
      });

      const applied = await runProductionD1SourceQuiescence({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        source,
        now: NOW,
      });
      expect(applied.status).toBe("source_quiesced");
      expect(applied.changes).toEqual({
        agentBootstrapTokensRevoked: 1,
        workshopRegistryTokensRevoked: 1,
        hostActualStateDeleted: 1,
        providerReconciliationsTerminalized: 0,
      });
      expect(applied.after?.every(({ count }) => count === 0)).toBe(true);
      expect(activeCapabilityCounts(source.database)).toEqual({
        agent: 0,
        registry: 0,
        actual: 0,
      });
      expect(
        source.database.query(`SELECT count(*) AS count FROM agent_hosts`).get(),
      ).toEqual({ count: 1 });
      expect(
        source.database
          .query(`SELECT revoked_at FROM agent_bootstrap_tokens`)
          .get(),
      ).toEqual({ revoked_at: NOW });
      expect(
        source.database
          .query(`SELECT revoked_at FROM workshop_registry_tokens`)
          .get(),
      ).toEqual({ revoked_at: NOW });

      const repeated = await runProductionD1SourceQuiescence({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        source,
        now: NOW + 1,
      });
      expect(repeated.changes).toEqual({
        agentBootstrapTokensRevoked: 0,
        workshopRegistryTokensRevoked: 0,
        hostActualStateDeleted: 0,
        providerReconciliationsTerminalized: 0,
      });
    } finally {
      source.close();
    }
  });

  test("fails before mutation when a host is still connected", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      source.database
        .query(`UPDATE agent_hosts SET connected = 1 WHERE id = 'host-1'`)
        .run();
      await expect(
        runProductionD1SourceQuiescence({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          source,
          now: NOW,
        }),
      ).rejects.toThrow("connected_hosts=1");
      expect(activeCapabilityCounts(source.database)).toEqual({
        agent: 1,
        registry: 1,
        actual: 1,
      });
    } finally {
      source.close();
    }
  });

  test("fails before mutation when another source gate is active", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      source.database
        .query(
          `INSERT INTO invitation
             (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "invite-1",
          "org-1",
          "invitee@example.test",
          "member",
          "pending",
          NOW + 10_000,
          NOW - 1_000,
          "user-1",
        );
      await expect(
        runProductionD1SourceQuiescence({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          source,
          now: NOW,
        }),
      ).rejects.toThrow("organization_invitations=1");
      expect(activeCapabilityCounts(source.database).agent).toBe(1);
    } finally {
      source.close();
    }
  });

  test("terminalizes only reconciliation rows with complete deletion proof", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      seedTerminalProviderReconciliation(source.database);

      const dryRun = await runProductionD1SourceQuiescence({
        mode: "dry-run",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        source,
        now: NOW,
      });
      expect(
        dryRun.before.find(({ id }) => id === "provider_reconciliation"),
      ).toMatchObject({ count: 1, quiesceable: true });

      const applied = await runProductionD1SourceQuiescence({
        mode: "apply",
        accountId: "account",
        sourceDatabaseId: SOURCE_ID,
        source,
        now: NOW,
      });
      expect(applied.changes.providerReconciliationsTerminalized).toBe(1);
      expect(applied.after?.every(({ count }) => count === 0)).toBe(true);
      expect(
        source.database
          .query(
            `SELECT desired_state, observed_state, claim_id, claim_expires_at,
                    consecutive_failures, last_reconciled_at, updated_at
             FROM runtime_provider_reconciliation
             WHERE allocation_id = 'allocation-terminal'`,
          )
          .get(),
      ).toEqual({
        desired_state: "deleted",
        observed_state: "deleted",
        claim_id: null,
        claim_expires_at: null,
        consecutive_failures: 0,
        last_reconciled_at: NOW,
        updated_at: NOW,
      });
      expect(
        source.database
          .query(
            `SELECT state, deletion_confirmed_at
             FROM runtime_provider_allocations
             WHERE id = 'allocation-terminal'`,
          )
          .get(),
      ).toEqual({ state: "deleted", deletion_confirmed_at: NOW - 2_000 });
    } finally {
      source.close();
    }
  });

  test("refuses every incomplete provider deletion proof before mutation", async () => {
    const unsafeCases = [
      {
        name: "desired state",
        sql: "UPDATE runtime_provider_reconciliation SET desired_state = 'ready'",
      },
      {
        name: "allocation state",
        sql: "UPDATE runtime_provider_allocations SET state = 'failed' WHERE id = 'allocation-terminal'",
      },
      {
        name: "deletion confirmation",
        sql: "UPDATE runtime_provider_allocations SET deletion_confirmed_at = NULL WHERE id = 'allocation-terminal'",
      },
      {
        name: "archived execution",
        sql: "UPDATE runtime_executions SET state = 'failed' WHERE id = 'execution-terminal'",
      },
      {
        name: "resource disappearance",
        sql: "UPDATE runtime_provider_resources SET disappearance_confirmed_at = NULL WHERE allocation_id = 'allocation-terminal'",
      },
      {
        name: "terminal operation",
        sql: "UPDATE runtime_provider_operations SET state = 'retryable' WHERE allocation_id = 'allocation-terminal'",
      },
      {
        name: "live reconciliation claim",
        sql: `UPDATE runtime_provider_reconciliation
              SET claim_id = 'live-claim', claim_expires_at = ${NOW + 1_000}
              WHERE allocation_id = 'allocation-terminal'`,
      },
    ] as const;

    for (const unsafe of unsafeCases) {
      const source = generatedDatabase();
      try {
        seedQuiesceableRows(source.database);
        seedTerminalProviderReconciliation(source.database);
        source.database.exec(unsafe.sql);
        await expect(
          runProductionD1SourceQuiescence({
            mode: "apply",
            accountId: "account",
            sourceDatabaseId: SOURCE_ID,
            source,
            now: NOW,
          }),
        ).rejects.toThrow("provider_reconciliation=1");
        expect(activeCapabilityCounts(source.database)).toEqual({
          agent: 1,
          registry: 1,
          actual: 1,
        });
        expect(
          source.database
            .query(
              `SELECT observed_state FROM runtime_provider_reconciliation
               WHERE allocation_id = 'allocation-terminal'`,
            )
            .get(),
        ).toEqual({ observed_state: "cleanup_pending" });
      } catch (error) {
        throw new Error(`${unsafe.name}: ${String(error)}`);
      } finally {
        source.close();
      }
    }
  });

  test("fails closed when terminal proof changes after preflight", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      seedTerminalProviderReconciliation(source.database);
      const raced: D1WriteClient = {
        query: source.query.bind(source),
        batchRead: source.batchRead.bind(source),
        batch: async (statements) => {
          source.database
            .query(
              `UPDATE runtime_provider_allocations
               SET deletion_confirmed_at = NULL
               WHERE id = 'allocation-terminal'`,
            )
            .run();
          return source.batch(statements);
        },
      };
      await expect(
        runProductionD1SourceQuiescence({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          source: raced,
          now: NOW,
        }),
      ).rejects.toThrow(
        "source is not quiescent after capability retirement: provider_reconciliation=1",
      );
      expect(
        source.database
          .query(
            `SELECT observed_state FROM runtime_provider_reconciliation
             WHERE allocation_id = 'allocation-terminal'`,
          )
          .get(),
      ).toEqual({ observed_state: "cleanup_pending" });
    } finally {
      source.close();
    }
  });

  test("reports malformed batch responses without claiming success", async () => {
    const source = generatedDatabase();
    try {
      seedQuiesceableRows(source.database);
      const malformed: D1WriteClient = {
        query: source.query.bind(source),
        batchRead: source.batchRead.bind(source),
        batch: async () => [],
      };
      await expect(
        runProductionD1SourceQuiescence({
          mode: "apply",
          accountId: "account",
          sourceDatabaseId: SOURCE_ID,
          source: malformed,
          now: NOW,
        }),
      ).rejects.toThrow("0 results for 4 statements");
    } finally {
      source.close();
    }
  });
});

class SqliteClient implements D1WriteClient {
  constructor(readonly database: Database) {}

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    return execute(this.database, { sql, params });
  }

  async batchRead(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return statements.map((statement) => execute(this.database, statement));
  }

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return this.database.transaction(() =>
      statements.map((statement) => execute(this.database, statement)),
    )();
  }

  close(): void {
    this.database.close(false);
  }
}

function generatedDatabase(): SqliteClient {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  const baseline = readFileSync(`${webRoot}migrations/0000_init.sql`, "utf8");
  for (const statement of baseline
    .split("--> statement-breakpoint")
    .map((value) => value.trim())
    .filter(Boolean)) {
    database.exec(statement);
  }
  database.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  const journal = JSON.parse(
    readFileSync(`${webRoot}migrations/meta/_journal.json`, "utf8"),
  ) as { entries: Array<{ when: number }> };
  database
    .query(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
    .run(
      createHash("sha256").update(baseline).digest("hex"),
      journal.entries[0]!.when,
    );
  return new SqliteClient(database);
}

function execute(
  database: Database,
  statement: D1Statement,
): D1StatementResult {
  const prepared = database.query(statement.sql);
  const params = [...(statement.params ?? [])];
  if (/^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(statement.sql)) {
    return {
      rows: prepared.all(...params) as D1Row[],
      changes: null,
    };
  }
  const result = prepared.run(...params);
  return { rows: [], changes: result.changes };
}

function seedQuiesceableRows(database: Database): void {
  database
    .query(
      `INSERT INTO user
         (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "user-1",
      "User One",
      "user@example.test",
      1,
      NOW - 10_000,
      NOW - 10_000,
      "admin",
      0,
    );
  database
    .query(`INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)`)
    .run("org-1", "Organization", "organization", NOW - 10_000);
  database
    .query(
      `INSERT INTO agent_hosts
         (id, user_id, name, role, scenario_enabled, disabled, connected, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "host-1",
      "user-1",
      "Host",
      "agent",
      1,
      0,
      0,
      NOW - 10_000,
      NOW - 10_000,
    );
  database
    .query(
      `INSERT INTO agent_bootstrap_tokens
         (id, host_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("bootstrap-1", "host-1", "a".repeat(64), null, null, NOW - 9_000);
  database
    .query(
      `INSERT INTO workshop_registry_tokens
         (id, organization_id, name, token_prefix, token_hash, created_by, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "registry-1",
      "org-1",
      "Registry",
      "token",
      "b".repeat(64),
      "user-1",
      null,
      null,
      NOW - 8_000,
    );
  database
    .query(
      `INSERT INTO host_actual_state
         (host_id, applied_desired_version, observed_at, report_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("host-1", 0, NOW - 1_000, "{}", NOW - 1_000, NOW - 1_000);
}

function seedTerminalProviderReconciliation(database: Database): void {
  database.transaction(() => {
    database
      .query(
        `INSERT INTO provider_connections
           (id, organization_id, provider_kind, display_name, state,
            external_project_id, project_fingerprint, created_by,
            last_validated_at, disconnected_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "connection-terminal",
        "org-1",
        "hetzner_cloud",
        "Terminal provider",
        "disconnected",
        "project-terminal",
        "fingerprint-terminal",
        "user-1",
        NOW - 10_000,
        NOW - 2_000,
        NOW - 20_000,
        NOW - 2_000,
      );
    database
      .query(
        `INSERT INTO workshop_templates
           (id, organization_id, slug, title, summary, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "template-terminal",
        "org-1",
        "terminal-provider",
        "Terminal provider",
        "Terminal provider fixture",
        "user-1",
        NOW - 20_000,
        NOW - 20_000,
      );
    database
      .query(
        `INSERT INTO workshop_template_revisions
           (id, template_id, revision, source_revision, content_hash,
            manifest_json, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "revision-terminal",
        "template-terminal",
        1,
        "fixture",
        "content-terminal",
        "{}",
        "user-1",
        NOW - 19_000,
      );
    database
      .query(
        `INSERT INTO workshop_runtime_profiles
           (id, template_revision_id, profile_id, provider_kind, vm_id,
            machine_type, system_image, resolved_image_id, root_disk_type,
            architecture, cpu_millis, memory_mib, disk_mib, locations_json,
            configuration_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "profile-terminal",
        "revision-terminal",
        "hetzner-terminal",
        "hetzner_cloud",
        "learner",
        "cpx42",
        "debian-13",
        "debian-image",
        "local",
        "x86_64",
        4_000,
        16_384,
        32_768,
        '["nbg1"]',
        "{}",
        NOW - 18_000,
      );
    database
      .query(
        `INSERT INTO provider_price_observations
           (id, provider_kind, connection_id, runtime_profile_id, currency,
            source, raw_observation_json, observed_at, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "price-terminal",
        "hetzner_cloud",
        "connection-terminal",
        "profile-terminal",
        "EUR",
        "fixture",
        "{}",
        NOW - 17_000,
        NOW + 10_000,
        NOW - 17_000,
      );
    database
      .query(
        `INSERT INTO runtime_executions
           (id, user_id, organization_id, provider_kind,
            provider_connection_id, domain_kind, domain_id, generation,
            state, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "execution-terminal",
        "user-1",
        "org-1",
        "hetzner_cloud",
        "connection-terminal",
        "workshop",
        "workspace-terminal",
        1,
        "archived",
        NOW - 2_000,
        NOW - 16_000,
        NOW - 2_000,
      );
    database
      .query(
        `INSERT INTO runtime_provider_allocations
           (id, execution_id, connection_id, runtime_profile_id,
            price_observation_id, provider_kind, deterministic_name,
            machine_type, resolved_image_id, location_attempts_json, location,
            location_attempt, location_attempt_started_at, state,
            deletion_requested_at, deletion_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "allocation-terminal",
        "execution-terminal",
        "connection-terminal",
        "profile-terminal",
        "price-terminal",
        "hetzner_cloud",
        "intar-terminal",
        "cpx42",
        "debian-image",
        '["nbg1"]',
        "nbg1",
        1,
        NOW - 16_000,
        "deleted",
        NOW - 3_000,
        NOW - 2_000,
        NOW - 16_000,
        NOW - 2_000,
      );
    database
      .query(
        `INSERT INTO runtime_provider_resources
           (id, allocation_id, provider_kind, resource_kind,
            provider_resource_id, location_attempt, location, provider_state,
            configuration_json, disappearance_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "resource-terminal",
        "allocation-terminal",
        "hetzner_cloud",
        "instance",
        "12345",
        1,
        "nbg1",
        "deleted",
        "{}",
        NOW - 2_000,
        NOW - 15_000,
        NOW - 2_000,
      );
    database
      .query(
        `INSERT INTO runtime_provider_operations
           (id, allocation_id, provider_kind, operation_kind,
            location_attempt, request_id, state, attempt, completed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "operation-terminal",
        "allocation-terminal",
        "hetzner_cloud",
        "delete_server",
        1,
        "request-terminal",
        "succeeded",
        1,
        NOW - 2_000,
        NOW - 4_000,
        NOW - 2_000,
      );
    database
      .query(
        `INSERT INTO runtime_provider_reconciliation
           (allocation_id, desired_state, observed_state, sweep_after,
            claim_id, claim_expires_at, consecutive_failures,
            last_reconciled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "allocation-terminal",
        "deleted",
        "cleanup_pending",
        NOW - 2_000,
        null,
        null,
        3,
        NOW - 3_000,
        NOW - 2_000,
      );
  })();
}

function activeCapabilityCounts(database: Database): {
  agent: number;
  registry: number;
  actual: number;
} {
  return database
    .query(
      `SELECT
         (SELECT count(*) FROM agent_bootstrap_tokens WHERE revoked_at IS NULL) AS agent,
         (SELECT count(*) FROM workshop_registry_tokens WHERE revoked_at IS NULL) AS registry,
         (SELECT count(*) FROM host_actual_state) AS actual`,
    )
    .get() as { agent: number; registry: number; actual: number };
}
