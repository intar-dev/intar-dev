import { readFile } from "node:fs/promises";
// @ts-expect-error The migration harness runs under Bun; the Worker build must
// not load Bun's global type declarations into the Cloudflare program.
import { Database } from "bun:sqlite";

const baseline = await readFile(
  new URL("../drizzle/0000_baseline.sql", import.meta.url),
  "utf8",
);
const v6Migration = await readFile(
  new URL("../drizzle/0001_host_cpu_reservations.sql", import.meta.url),
  "utf8",
);
const bootCpuMigration = await readFile(
  new URL("../drizzle/0003_boot_cpu_reservation_phases.sql", import.meta.url),
  "utf8",
);

checkDrainedCutover();
checkLiveDesiredVmRefusal();
checkConnectedClientRefusal();
checkEnabledPlacementRefusal();
checkBootCpuDrainedCutover();
checkBootCpuEnabledPlacementRefusal();
checkBootCpuConnectedHostRefusal();
checkBootCpuActiveBuildRefusal();
checkBootCpuActiveReservationRefusal();
checkBootCpuActiveRunRefusal();
checkBootCpuLiveDesiredVmRefusal();
checkBootCpuActualVmRefusal();

interface SeedOptions {
  desiredPhase: "absent" | "running";
  connected?: boolean;
  scenarioEnabled?: boolean;
}

interface BootCpuSeedOptions {
  scenarioEnabled?: boolean;
  connected?: boolean;
  activeBuild?: boolean;
  activeReservation?: boolean;
  activeRun?: boolean;
  desiredPhase?: "absent" | "running";
  actualVm?: boolean;
}

function checkDrainedCutover(): void {
  const db = seededDatabase({ desiredPhase: "absent" });
  try {
    executeStatements(db, v6Migration);
    const desired = db
      .query<
        {
          version: number;
          schemaVersion: number;
          jsonVersion: number;
          cachedImages: number;
          vms: number;
          builds: number;
        },
        []
      >(
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
    assert(
      desired.version === 25,
      "V6 migration did not bump SQL desired version",
    );
    assert(desired.schemaVersion === 3, "V6 migration did not write schema 3");
    assert(
      desired.jsonVersion === 25,
      "V6 migration did not bump JSON desired version",
    );
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
      JSON.stringify(cpuColumns) ===
        JSON.stringify(["cpu_millis", "vcpu_count"]),
      "V6 migration did not replace the catalog CPU columns",
    );
  } finally {
    db.close();
  }
}

function checkLiveDesiredVmRefusal(): void {
  assertCutoverRefused({ desiredPhase: "running" }, "a running desired VM");
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
      executeStatements(db, v6Migration);
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

function checkBootCpuDrainedCutover(): void {
  const db = seededBootCpuDatabase();
  try {
    executeStatements(db, bootCpuMigration);
    const columns = tableColumns(db, "host_cpu_reservations");
    assert(
      JSON.stringify(columns) ===
        JSON.stringify([
          "run_id",
          "host_id",
          "cpu_millis",
          "steady_cpu_millis",
          "boot_cpu_millis",
          "quota_phase",
          "state",
          "expires_at",
          "created_at",
          "updated_at",
        ]),
      `boot CPU migration wrote unexpected reservation columns: ${columns.join(", ")}`,
    );
    assert(
      scalar(db, "SELECT count(*) AS value FROM host_cpu_reservations") === 0,
      "boot CPU migration retained an old reservation",
    );
    assert(
      scalar(
        db,
        "SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name = '_intar_boot_cpu_cutover_guard'",
      ) === 0,
      "boot CPU migration retained its cutover guard after success",
    );
  } finally {
    db.close();
  }
}

function checkBootCpuEnabledPlacementRefusal(): void {
  assertBootCpuCutoverRefused(
    { scenarioEnabled: true },
    "enabled agent scenario placement",
  );
}

function checkBootCpuConnectedHostRefusal(): void {
  assertBootCpuCutoverRefused({ connected: true }, "a connected host");
}

function checkBootCpuActiveBuildRefusal(): void {
  assertBootCpuCutoverRefused({ activeBuild: true }, "a queued image build");
}

function checkBootCpuActiveReservationRefusal(): void {
  assertBootCpuCutoverRefused(
    { activeReservation: true },
    "an active CPU reservation",
  );
}

function checkBootCpuActiveRunRefusal(): void {
  assertBootCpuCutoverRefused({ activeRun: true }, "an active scenario run");
}

function checkBootCpuLiveDesiredVmRefusal(): void {
  assertBootCpuCutoverRefused(
    { desiredPhase: "running" },
    "a running desired VM",
  );
}

function checkBootCpuActualVmRefusal(): void {
  assertBootCpuCutoverRefused({ actualVm: true }, "a reported actual VM");
}

function assertBootCpuCutoverRefused(
  options: BootCpuSeedOptions,
  reason: string,
): void {
  const db = seededBootCpuDatabase(options);
  try {
    let refusal: unknown;
    try {
      executeStatements(db, bootCpuMigration);
    } catch (error) {
      refusal = error;
    }
    assert(refusal instanceof Error, `boot CPU migration accepted ${reason}`);
    assert(
      refusal.message.includes("_intar_boot_cpu_cutover_guard_drained"),
      `boot CPU migration failed outside the drain guard: ${refusal.message}`,
    );
    assert(
      !tableColumns(db, "host_cpu_reservations").includes("steady_cpu_millis"),
      "boot CPU migration changed the reservation schema before its drain guard",
    );
  } finally {
    db.close();
  }
}

function seededBootCpuDatabase(options: BootCpuSeedOptions = {}): Database {
  const db = seededDatabase({ desiredPhase: "absent" });
  executeStatements(db, v6Migration);

  db.query(
    "UPDATE agent_hosts SET scenario_enabled = ?, connected = ? WHERE id = 'host-a'",
  ).run(options.scenarioEnabled ? 1 : 0, options.connected ? 1 : 0);

  const desired = db
    .query<
      { version: number; docJson: string },
      []
    >("SELECT version, doc_json AS docJson FROM host_desired_state WHERE host_id = 'host-a'")
    .get();
  assert(desired !== null, "V6 seed did not retain host desired state");
  const desiredDocument = JSON.parse(desired.docJson) as Record<
    string,
    unknown
  >;
  desiredDocument.vms = [{ desired_phase: options.desiredPhase ?? "absent" }];
  db.query(
    "UPDATE host_desired_state SET doc_json = ? WHERE host_id = 'host-a'",
  ).run(JSON.stringify(desiredDocument));

  db.query(
    "INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json) VALUES (?, ?, ?, ?)",
  ).run(
    "host-a",
    desired.version,
    2,
    JSON.stringify({
      schema_version: 3,
      host_id: "host-a",
      vms: options.actualVm ? [{ run_id: "run-actual" }] : [],
      builds: [],
    }),
  );

  if (options.activeRun) {
    insertScenarioRun(db, "run-active", true);
  }
  if (options.activeBuild) {
    db.query(
      "INSERT INTO image_build_bundles (rev, r2_key, kino_version, meta_json) VALUES (?, ?, ?, ?)",
    ).run("rev-active", "bundles/rev-active.tar.gz", "v0.2.2", "{}");
    db.query(
      `INSERT INTO image_builds (
         id, scenario_id, arch, rev, content_hash, kino_version, host_id,
         status, phase
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "build-active",
      "scenario-a",
      "x86_64",
      "rev-active",
      "a".repeat(64),
      "v0.2.2",
      "host-a",
      "queued",
      "queued",
    );
  }
  if (options.activeReservation) {
    insertScenarioRun(db, "run-reservation", false);
    db.query(
      "INSERT INTO host_cpu_reservations (run_id, host_id, cpu_millis, state, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run("run-reservation", "host-a", 1_000, "committed", null);
  }

  return db;
}

function insertScenarioRun(db: Database, runId: string, active: boolean): void {
  db.query(
    `INSERT INTO scenario_runs (
       run_id, user_id, host_id, scenario_id, scenario_name, title, tagline,
       briefing_markdown, objectives_json, difficulty, estimated_minutes,
       tags_json, hints_json, solution_markdown, vm_count, state, state_rank,
       active_key, state_json, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    "user-a",
    "host-a",
    "scenario-a",
    "scenario-a",
    "Scenario A",
    "Test",
    "Test briefing",
    "[]",
    "beginner",
    10,
    "[]",
    "[]",
    "Test solution",
    1,
    active ? "provisioning" : "completed",
    active ? 1 : 10,
    active ? "user-a" : null,
    "{}",
    active ? null : 1,
  );
}

function tableColumns(db: Database, table: string): string[] {
  assert(
    table === "host_cpu_reservations",
    `unsupported table column query: ${table}`,
  );
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info(?) ORDER BY cid",
    )
    .all(table)
    .map((row: { name: string }) => row.name);
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
