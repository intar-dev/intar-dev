import { readFile } from "node:fs/promises";
// @ts-expect-error The migration harness runs under Bun; the Worker build must
// not load Bun's global type declarations into the Cloudflare program.
import { Database } from "bun:sqlite";

const baseline = await readFile(
  new URL("../drizzle/0000_baseline.sql", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../drizzle/0001_host_cpu_reservations.sql", import.meta.url),
  "utf8",
);

checkDrainedCutover();
checkLiveDesiredVmRefusal();
checkConnectedClientRefusal();
checkEnabledPlacementRefusal();

interface SeedOptions {
  desiredPhase: "absent" | "running";
  connected?: boolean;
  scenarioEnabled?: boolean;
}

function checkDrainedCutover(): void {
  const db = seededDatabase({ desiredPhase: "absent" });
  try {
    executeStatements(db, migration);
    const desired = db
      .query<{
        version: number;
        schemaVersion: number;
        jsonVersion: number;
        cachedImages: number;
        vms: number;
        builds: number;
      }, []>(
        `SELECT
           version,
           json_extract(doc_json, '$.schema_version') AS schemaVersion,
           json_extract(doc_json, '$.version') AS jsonVersion,
           json_array_length(doc_json, '$.cached_images') AS cachedImages,
           json_array_length(doc_json, '$.vms') AS vms,
           json_array_length(doc_json, '$.builds') AS builds
         FROM host_desired_state`,
      )
      .get();
    assert(desired !== null, "V6 migration removed desired host state");
    assert(desired.version === 25, "V6 migration did not bump SQL desired version");
    assert(desired.schemaVersion === 3, "V6 migration did not write schema 3");
    assert(desired.jsonVersion === 25, "V6 migration did not bump JSON desired version");
    assert(
      desired.cachedImages === 0 && desired.vms === 0 && desired.builds === 0,
      "V6 migration did not clear old desired payloads",
    );
    assert(
      scalar(db, "SELECT count(*) AS value FROM host_actual_state") === 0,
      "V6 migration retained an old actual report",
    );
    assert(
      scalar(
        db,
        "SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'host_cpu_reservations'",
      ) === 1,
      "V6 migration did not create CPU reservations",
    );
    const cpuColumns = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('vm_scenario_vms') WHERE name IN ('cpu', 'cpu_millis', 'vcpu_count') ORDER BY name",
      )
      .all()
      .map((row: { name: string }) => row.name);
    assert(
      JSON.stringify(cpuColumns) === JSON.stringify(["cpu_millis", "vcpu_count"]),
      "V6 migration did not replace the catalog CPU columns",
    );
  } finally {
    db.close();
  }
}

function checkLiveDesiredVmRefusal(): void {
  assertCutoverRefused(
    { desiredPhase: "running" },
    "a running desired VM",
  );
}

function checkConnectedClientRefusal(): void {
  assertCutoverRefused(
    { desiredPhase: "absent", connected: true },
    "a connected V5 bridge client",
  );
}

function checkEnabledPlacementRefusal(): void {
  assertCutoverRefused(
    { desiredPhase: "absent", scenarioEnabled: true },
    "enabled scenario placement",
  );
}

function assertCutoverRefused(options: SeedOptions, reason: string): void {
  const db = seededDatabase(options);
  try {
    let refusal: unknown;
    try {
      executeStatements(db, migration);
    } catch (error) {
      refusal = error;
    }
    assert(refusal instanceof Error, `V6 migration accepted ${reason}`);
    assert(
      refusal.message.includes("_intar_v6_cutover_guard_drained"),
      `V6 migration failed outside the drain guard: ${refusal.message}`,
    );
    assert(
      scalar(
        db,
        "SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name = 'host_cpu_reservations'",
      ) === 0,
      "V6 migration mutated catalog tables before its drain guard",
    );
  } finally {
    db.close();
  }
}

function seededDatabase(options: SeedOptions): Database {
  const db = new Database(":memory:", { strict: true });
  executeStatements(db, baseline);
  db.query(
    "INSERT INTO agent_hosts (id, user_id, name, scenario_enabled, connected) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "host-a",
    "user-a",
    "host-a",
    options.scenarioEnabled ? 1 : 0,
    options.connected ? 1 : 0,
  );
  db.query(
    "INSERT INTO host_desired_state (host_id, version, doc_json) VALUES (?, ?, ?)",
  ).run(
    "host-a",
    24,
    JSON.stringify({
      schema_version: 2,
      host_id: "host-a",
      version: 24,
      generated_at_unix_ms: 1,
      cached_images: [{ image_sha256: "a".repeat(64) }],
      vms: [{ desired_phase: options.desiredPhase, cpu_count: 1 }],
      builds: [],
    }),
  );
  db.query(
    "INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json) VALUES (?, ?, ?, ?)",
  ).run(
    "host-a",
    24,
    1,
    JSON.stringify({
      schema_version: 2,
      host_id: "host-a",
      vms: [],
      builds: [],
    }),
  );
  return db;
}

function executeStatements(db: Database, sql: string): void {
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed !== "") {
      db.query(trimmed).run();
    }
  }
}

function scalar(db: Database, sql: string): number {
  const row = db.query<{ value: number }, []>(sql).get();
  assert(row !== null, `query returned no scalar value: ${sql}`);
  return row.value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
