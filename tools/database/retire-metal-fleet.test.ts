import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { D1StatementResult, D1Value, D1WriteClient } from "./d1-rest-client";
import { expectedGeneratedD1Schema } from "./generated-d1-schema";
import { rehearsalSeedStatements } from "./rehearse-removal-migration";
import { closeMetalGates, retireMetalFleet, verifyRetiredMetalFleet } from "./retire-metal-fleet";
import { applyGeneratedMigrations } from "./apply-generated-migrations";
import { HOST_REFERENCE_TABLES } from "./preserve-host-references";
import { releasePersonalMetal } from "../deploy/release-personal-metal";

const databases: Database[] = [];
const evidenceDirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of evidenceDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(count?: number) {
  const proof = expectedGeneratedD1Schema(count);
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const type of ["table", "index"]) for (const object of proof.objects.filter(object => object.type === type)) db.exec(object.sql);
  for (const marker of proof.migrations) db.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(marker.hash, marker.createdAt);
  const query = (sql: string, params: readonly D1Value[] = []): D1StatementResult => ({ rows: db.query(sql).all(...params) as never, changes: null });
  const client: D1WriteClient = {
    query: async (sql, params) => query(sql, params),
    batch: async statements => db.transaction(() => statements.map(statement => query(statement.sql, statement.params)))(),
  };
  for (const statement of rehearsalSeedStatements()) query(statement.sql, statement.params);
  return { db, client, query };
}
function seedEphemeral(db: Database) {
  db.exec(`UPDATE user SET metal_placement = 'personal';
    UPDATE agent_hosts SET scope = 'personal', credential_generation = 4, connected = 1, active_session_id = 'session';
    UPDATE runtime_executions SET lease_expires_at = 9999999;
    INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('member', 'org-1', 'user-1', 'owner', 1);
    INSERT INTO course_catalogs (scope_key, organization_id, source_revision, catalog_json, created_at, updated_at) VALUES ('organization:org-1', 'org-1', 'rev', '{}', 1, 1);
    INSERT INTO host_desired_state (host_id, version, doc_json) VALUES ('host-1', 2, '{"vms":[{"desired_phase":"running"}]}');
    INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json) VALUES ('host-1', 1, 1, '{}');
    INSERT INTO agent_bootstrap_tokens (id, host_id, token_hash, credential_generation) VALUES ('token', 'host-1', 'hash', 4);
    INSERT INTO host_cpu_reservations (run_id, host_id, cpu_millis, state) VALUES ('run-1', 'host-1', 1000, 'committed');
    INSERT INTO host_resource_reservations (execution_id, host_id, cpu_millis, memory_mib, worst_case_disk_mib) VALUES ('run-1', 'host-1', 1000, 1024, 4096);
    INSERT INTO active_runtime_slots (user_id, execution_id) VALUES ('user-1', 'run-1');
    INSERT INTO runtime_vm_actual_state (runtime_vm_id, execution_id, host_id, phase, report_json, observed_at) VALUES ('runtime-vm-1', 'run-1', 'host-1', 'ready', '{}', 1);`);
}

test("host rebuild preserves every inbound reference and historical null scope", async () => {
  const { db, client, query } = fixture(23);
  seedEphemeral(db);
  db.exec("UPDATE agent_hosts SET scope = NULL, organization_id = 'org-1'");
  const actualReferences = query("SELECT m.name FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = 'agent_hosts'").rows.map(row => row.name).sort();
  expect(actualReferences).toEqual([...HOST_REFERENCE_TABLES].sort());
  const tables = [...HOST_REFERENCE_TABLES, "runtime_vms", "runtime_artifacts", "member", "course_catalogs"];
  // Migration 0026 adds only a nullable cleanup marker. Every old column,
  // row and inbound reference must still be identical after all migrations.
  const before = tables.map(table => query(`SELECT * FROM ${table}`).rows
    .map(row => table === "scenario_runs" ? { ...row, route_cleanup_id: null } : row));
  await applyGeneratedMigrations(client);
  expect(tables.map(table => query(`SELECT * FROM ${table}`).rows)).toEqual(before);
  expect(query("SELECT scope, owner_removal_id, owner_removal_completed_at FROM agent_hosts").rows)
    .toEqual([{ scope: null, owner_removal_id: null, owner_removal_completed_at: null }]);
  expect(query("PRAGMA foreign_key_check").rows).toEqual([]);
  expect(() => db.exec("UPDATE agent_hosts SET scope = 'organization'")).toThrow();
  expect(() => db.exec("UPDATE agent_hosts SET scope = 'personal', role = 'builder'")).toThrow();
});

test("retirement requires closed gates and keeps placement, content, FKs and artifacts", async () => {
  const { db, client, query } = fixture();
  seedEphemeral(db);
  db.exec("UPDATE scenario_runs SET route_cleanup_id = 'old-cleanup'");
  const before = ["user", "organization", "member", "course_catalogs", "runtime_artifacts"].map(table => query(`SELECT * FROM ${table}`).rows);
  await expect(retireMetalFleet(client, 1000)).rejects.toThrow();
  expect(query("SELECT disabled FROM agent_hosts").rows).toEqual([{ disabled: 0 }]);
  await closeMetalGates(client, 500);
  const result = await retireMetalFleet(client, 1000);
  expect(result).toEqual({ hostIds: ["host-1"], retiredAt: 1000, lastLeaseExpiresAt: 9999999 });
  expect(["user", "organization", "member", "course_catalogs", "runtime_artifacts"].map(table => query(`SELECT * FROM ${table}`).rows)).toEqual(before);
  expect(query("SELECT id, scope, credential_generation, owner_removal_id, disabled FROM agent_hosts").rows)
    .toEqual([{ id: "host-1", scope: null, credential_generation: 5, owner_removal_id: null, disabled: 1 }]);
  expect(query("SELECT host_id, state, lease_expires_at FROM runtime_executions").rows).toEqual([{ host_id: "host-1", state: "archived", lease_expires_at: null }]);
  expect(query("SELECT artifact_writes_sealed FROM runtime_vms").rows).toEqual([{ artifact_writes_sealed: 1 }]);
  expect(query("SELECT state, active_key, host_id, route_cleanup_id FROM scenario_runs").rows)
    .toEqual([{ state: "failed", active_key: null, host_id: "host-1", route_cleanup_id: null }]);
  for (const table of ["host_desired_state", "host_actual_state", "runtime_vm_actual_state", "active_runtime_slots", "host_resource_reservations", "host_cpu_reservations"]) expect(query(`SELECT * FROM ${table}`).rows).toEqual([]);
  await retireMetalFleet(client, 2000);
  expect(query("SELECT credential_generation FROM agent_hosts").rows).toEqual([{ credential_generation: 5 }]);
  expect(query("PRAGMA foreign_key_check").rows).toEqual([]);
});

test.each(["completed", "failed"])("retirement clears pending cleanup for an already %s run without changing its history", async state => {
  const { db, client, query } = fixture();
  seedEphemeral(db);
  db.query("UPDATE scenario_runs SET state = ?, active_key = NULL, route_cleanup_id = 'old-cleanup'").run(state);
  const before = query("SELECT * FROM scenario_runs").rows;
  await closeMetalGates(client);
  await retireMetalFleet(client);
  expect(query("SELECT * FROM scenario_runs").rows).toEqual(before.map(row => ({ ...row, route_cleanup_id: null })));
  db.exec("UPDATE scenario_runs SET route_cleanup_id = 'unretired-cleanup'");
  await expect(verifyRetiredMetalFleet(client, ["host-1"])).rejects.toThrow("old fleet retirement is incomplete");
  await retireMetalFleet(client);
  expect(query("SELECT route_cleanup_id FROM scenario_runs").rows).toEqual([{ route_cleanup_id: null }]);
});

test("a failed retirement transaction restores credentials, runs, desired state and placement", async () => {
  const { db, client, query } = fixture();
  seedEphemeral(db);
  db.exec("UPDATE scenario_runs SET route_cleanup_id = 'old-cleanup'");
  await closeMetalGates(client);
  const before = query("SELECT * FROM agent_hosts").rows;
  const broken: D1WriteClient = { ...client, batch: statements => client.batch([...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]) };
  await expect(retireMetalFleet(broken)).rejects.toThrow();
  expect(query("SELECT * FROM agent_hosts").rows).toEqual(before);
  expect(query("SELECT active_key FROM scenario_runs").rows[0]?.active_key).toBe("user-1");
  expect(query("SELECT route_cleanup_id FROM scenario_runs").rows[0]?.route_cleanup_id).toBe("old-cleanup");
  expect(query("SELECT count(*) AS count FROM host_desired_state").rows[0]?.count).toBe(1);
});

function releaseFixture(count?: number) {
  const f = fixture(count);
  seedEphemeral(f.db);
  const calls: string[] = [];
  const evidenceDir = mkdtempSync(join(tmpdir(), "intar-personal-metal-proof-"));
  evidenceDirs.push(evidenceDir);
  const evidencePath = join(evidenceDir, "staging-report.txt");
  writeFileSync(evidencePath, "revision: revision\nStaging installer, ownership, browser NAT, native SSH NAT, workspace app NAT test output.\n");
  const personalMetalProof = { revision: "revision", installerPassed: true, ownershipPassed: true, browserNatPassed: true,
    nativeSshNatPassed: true, workspaceAppsNatPassed: true, evidencePath };
  return { ...f, calls, personalMetalProof, input: {
    client: f.client, databaseId: "db", revision: "revision", evidenceDir,
    deploy: async (maintenance: boolean) => { calls.push(`deploy:${maintenance}`); },
    drainRequests: async () => { calls.push("drain"); },
    collector: async (action: "hold" | "release") => {
      calls.push(`collector:${action}`);
      if (action === "hold") f.db.exec("INSERT INTO image_registry_admission (key, protocol_version, paused_at) VALUES ('image_registry_admission', 1, 1) ON CONFLICT(key) DO UPDATE SET paused_at = 1");
      else f.db.exec("UPDATE image_registry_admission SET paused_at = NULL");
    },
    proveMaintenance: async () => { calls.push("maintenance"); },
    retireRuntime: async (hostId: string) => { calls.push(`retire:${hostId}`); },
  } };
}

test("release deploy retires the fleet and requires separate registration and admission actions", async () => {
  const { db, query, input, calls, personalMetalProof } = releaseFixture();
  const evidence = await releasePersonalMetal({ ...input, action: "deploy" });
  expect(calls).toEqual(["collector:hold", "deploy:true", "drain", "maintenance", "maintenance", "retire:host-1", "maintenance"]);
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'image_cutover'").rows[0]?.state).toBe("drained");
  const checks = { revision: "revision", stoppedHostIds: ["host-1"], gatewayRoutes: 0, gatewaySessions: 0, hosts: [] };
  const reopen = { ...input, evidence: evidence as any, checks };
  await expect(releasePersonalMetal({ ...reopen, action: "open-platform-registration", checks: { ...checks, stoppedHostIds: [] } })).rejects.toThrow("matching retirement evidence");
  await releasePersonalMetal({ ...reopen, action: "open-platform-registration" });
  expect(calls.at(-1)).toBe("deploy:false");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").rows[0]?.state).toBe("drained");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'platform_metal_registration'").rows[0]?.state).toBe("open");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'image_cutover'").rows[0]?.state).toBe("drained");
  await expect(releasePersonalMetal({ ...reopen, action: "open-admission" })).rejects.toThrow("personal metal proof");
  await expect(releasePersonalMetal({ ...reopen, action: "open-admission", checks: { ...checks, personalMetalProof } })).rejects.toThrow("fresh platform agent and builder");
  const fleet = { ...checks, hosts: seedFreshPlatformFleet(db), personalMetalProof };
  await expect(releasePersonalMetal({ ...reopen, action: "open-admission", checks: { ...fleet, hosts: fleet.hosts.map((host, index) => index === 0 ? { ...host, id: "host-1" } : host) } })).rejects.toThrow("fresh fleet checks failed");
  const source = readFileSync(personalMetalProof.evidencePath);
  const result = await releasePersonalMetal({ ...reopen, action: "open-admission", checks: fleet });
  expect(calls.at(-1)).toBe("collector:release");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").rows[0]?.state).toBe("open");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'image_cutover'").rows[0]?.state).toBe("open");
  const stored = JSON.parse(readFileSync(join(input.evidenceDir, "personal-metal-proof.json"), "utf8"));
  expect(result.personalMetalProof).toEqual(stored);
  expect(stored).toMatchObject({ ...personalMetalProof, evidencePath: join(input.evidenceDir, "personal-metal-proof.evidence"),
    evidenceSha256: createHash("sha256").update(source).digest("hex") });
  rmSync(personalMetalProof.evidencePath);
  expect(readFileSync(stored.evidencePath)).toEqual(source);
  const before = ["agent_hosts", "agent_bootstrap_tokens", "host_actual_state", "runtime_operation_gates"].map(table => query(`SELECT * FROM ${table}`).rows);
  const callCount = calls.length;
  expect(await releasePersonalMetal({ ...input, action: "deploy" })).toEqual(evidence);
  expect(calls).toHaveLength(callCount);
  expect(["agent_hosts", "agent_bootstrap_tokens", "host_actual_state", "runtime_operation_gates"].map(table => query(`SELECT * FROM ${table}`).rows)).toEqual(before);
});

function seedFreshPlatformFleet(db: Database) {
  for (const role of ["agent", "builder"] as const) {
    const now = Date.now();
    db.query("INSERT INTO agent_hosts (id, user_id, name, scope, role, credential_generation, connected, active_session_id, agent_version, last_heartbeat_at, created_at) VALUES (?, 'user-1', ?, 'platform', ?, 1, 1, 'fresh-session', 'new-version', ?, ?)").run(role, role, role, now, now);
    db.query("INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json, updated_at) VALUES (?, 1, ?, '{}', ?)").run(role, now, now);
    db.query("INSERT INTO agent_bootstrap_tokens (id, host_id, token_hash, credential_generation) VALUES (?, ?, 'new-hash', 1)").run(role, role);
  }
  return (["agent", "builder"] as const).map(role => ({ id: role, role, agentVersion: "new-version", doctorPassed: true, imagesReady: true, gatewayPassed: true }));
}

async function admissionFixture() {
  const f = releaseFixture();
  const evidence = await releasePersonalMetal({ ...f.input, action: "deploy" });
  if (!("hostIds" in evidence)) throw new Error("retirement evidence missing");
  const checks = { revision: "revision", stoppedHostIds: ["host-1"], gatewayRoutes: 0, gatewaySessions: 0, hosts: [] };
  await releasePersonalMetal({ ...f.input, action: "open-platform-registration", evidence, checks });
  return { ...f, admission: { ...f.input, action: "open-admission" as const, evidence,
    checks: { ...checks, hosts: seedFreshPlatformFleet(f.db), personalMetalProof: f.personalMetalProof } } };
}

test.each(["installerPassed", "ownershipPassed", "browserNatPassed", "nativeSshNatPassed", "workspaceAppsNatPassed"])("admission refuses missing, false, or non-boolean %s", async check => {
  const { admission, calls, query } = await admissionFixture();
  for (const value of [undefined, false, "true"]) {
    const checks = JSON.parse(JSON.stringify({ ...admission.checks, personalMetalProof: { ...admission.checks.personalMetalProof, [check]: value } }));
    await expect(releasePersonalMetal({ ...admission, checks })).rejects.toThrow(`${check}=true`);
    expect(calls).not.toContain("collector:release");
    expect(query("SELECT state FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration')").rows).toEqual([{ state: "drained" }, { state: "drained" }]);
  }
});

test("admission refuses proof for another revision or missing and empty supporting evidence", async () => {
  const { admission, calls, query } = await admissionFixture();
  const proof = admission.checks.personalMetalProof;
  for (const personalMetalProof of [{ ...proof, revision: "other-revision" }, { ...proof, evidencePath: "" }, { ...proof, evidencePath: join(admission.evidenceDir, "missing.txt") }]) {
    await expect(releasePersonalMetal({ ...admission, checks: { ...admission.checks, personalMetalProof } })).rejects.toThrow();
  }
  writeFileSync(proof.evidencePath, "");
  await expect(releasePersonalMetal(admission)).rejects.toThrow("supporting evidence is empty");
  expect(calls).not.toContain("collector:release");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration')").rows).toEqual([{ state: "drained" }, { state: "drained" }]);
});

test("admission stays closed if the proof cannot be saved", async () => {
  const { admission, calls, query } = await admissionFixture();
  await expect(releasePersonalMetal({ ...admission, evidenceDir: join(admission.evidenceDir, "missing-directory") })).rejects.toThrow();
  expect(calls).not.toContain("collector:release");
  expect(query("SELECT state FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration')").rows).toEqual([{ state: "drained" }, { state: "drained" }]);
});

test.each(["open-platform-registration", "open-admission"] as const)("%s recovers a lost gate commit response without repeating side effects", async action => {
  const f = await admissionFixture();
  // The fixture has already opened platform registration. Reuse its completed
  // result to check recovery there; the admission transaction is still pending.
  if (action === "open-platform-registration") {
    f.db.exec("UPDATE runtime_operation_gates SET state = 'drained', evidence_json = NULL WHERE key = 'platform_metal_registration'");
  }
  const gate = action === "open-platform-registration" ? "platform_metal_registration" : "personal_metal_registration";
  let lost = false;
  const client: D1WriteClient = { ...f.client, batch: async statements => {
    const result = await f.client.batch(statements);
    if (!lost && statements.some(statement => statement.sql.includes("SET") &&
        statement.sql.includes("evidence_json = ?") && statement.sql.includes(`key = '${gate}'`))) {
      lost = true;
      throw new Error("gate response lost after commit");
    }
    return result;
  } };
  await expect(releasePersonalMetal({ ...f.admission, action, client })).rejects.toThrow("gate response lost after commit");
  expect(lost).toBe(true);
  const record = JSON.parse(String(f.query("SELECT evidence_json FROM runtime_operation_gates WHERE key = ?", [gate]).rows[0]?.evidence_json));
  expect(record).toMatchObject({ action, result: { databaseId: "db", revision: "revision" } });
  // Fleet health can change and an operator can close a gate after completion.
  // Recovery returns history; it must not reopen that gate or repeat deployment.
  f.db.exec("UPDATE agent_hosts SET connected = 0; UPDATE runtime_operation_gates SET state = 'drained' WHERE key = 'image_cutover'");
  const before = ["agent_hosts", "runtime_operation_gates"].map(table => f.query(`SELECT * FROM ${table}`).rows);
  f.calls.length = 0;
  rmSync(f.personalMetalProof.evidencePath);
  expect(await releasePersonalMetal({ ...f.admission, action })).toEqual(record.result);
  expect(f.calls).toEqual([]);
  expect(["agent_hosts", "runtime_operation_gates"].map(table => f.query(`SELECT * FROM ${table}`).rows)).toEqual(before);
  f.db.query("UPDATE runtime_operation_gates SET evidence_json = json_set(evidence_json, '$.operationId', 'another-release') WHERE key = ?").run(gate);
  await expect(releasePersonalMetal({ ...f.admission, action })).rejects.toThrow("gate evidence does not match");
});

test("admission rechecks fleet freshness at commit after a slow collector release", async () => {
  const f = await admissionFixture();
  let databaseNow = Date.now();
  const client: D1WriteClient = { ...f.client, batch: statements => f.client.batch(statements.map(statement => ({
    ...statement,
    // Control the database clock at each transaction, without a real two-minute wait.
    sql: statement.sql.replaceAll("unixepoch('subsecond')", String(databaseNow / 1000)),
  }))) };
  await expect(releasePersonalMetal({ ...f.admission, client, collector: async action => {
    await f.input.collector(action);
    databaseNow += 120_000;
  } })).rejects.toThrow("integer overflow");
  expect(f.calls.at(-1)).toBe("collector:release");
  expect(f.query("SELECT state, evidence_json FROM runtime_operation_gates WHERE key IN ('image_cutover', 'personal_metal_registration')").rows)
    .toEqual([{ state: "drained", evidence_json: null }, { state: "drained", evidence_json: null }]);
});

test("runtime retirement failure leaves every admission gate closed", async () => {
  const { input, query } = releaseFixture();
  await expect(releasePersonalMetal({ ...input, action: "deploy", retireRuntime: async () => { throw new Error("DO unavailable"); } })).rejects.toThrow("DO unavailable");
  expect(query("SELECT DISTINCT state FROM runtime_operation_gates").rows).toEqual([{ state: "drained" }]);
});

test.each(["drain", "runtime"])("deploy resumes after %s fails with the collector endpoint fenced by maintenance", async phase => {
  // Start before the recovery-field migration to cover an interrupted upgrade.
  const { input, query, calls } = releaseFixture(27);
  let maintenance = false;
  let fail = true;
  const retryInput = { ...input, action: "deploy" as const,
    deploy: async (closed: boolean) => { maintenance = closed; await input.deploy(closed); },
    proveMaintenance: async () => { if (!maintenance) throw new Error("maintenance is open"); await input.proveMaintenance(); },
    collector: async (action: "hold" | "release") => {
      if (maintenance) throw new Error("503 maintenance");
      await input.collector(action);
    },
    drainRequests: async () => { if (fail && phase === "drain") throw new Error("interrupted drain"); await input.drainRequests(); },
    retireRuntime: async (id: string) => { if (fail && phase === "runtime") throw new Error("DO unavailable"); await input.retireRuntime(id); },
  };
  await expect(releasePersonalMetal(retryInput)).rejects.toThrow(phase === "drain" ? "interrupted drain" : "DO unavailable");
  expect(maintenance).toBe(true);
  const checkpoint = query("SELECT * FROM runtime_operation_gates WHERE key = 'personal_metal_retirement'").rows[0];
  fail = false;
  const recovered = await releasePersonalMetal(retryInput);
  expect(recovered).toMatchObject({ hostIds: ["host-1"], lastLeaseExpiresAt: 9999999 });
  expect(calls.filter(call => call === "retire:host-1")).toHaveLength(1);
  expect(calls.filter(call => call === "deploy:true")).toHaveLength(phase === "drain" ? 2 : 1);
  if (phase === "runtime") expect(recovered).toMatchObject(JSON.parse(String(checkpoint?.evidence_json)));
  expect(query("SELECT credential_generation FROM agent_hosts").rows).toEqual([{ credential_generation: 5 }]);
  expect(query("SELECT DISTINCT state FROM runtime_operation_gates WHERE key <> 'personal_metal_retirement'").rows).toEqual([{ state: "drained" }]);
});

test.each(["no pause", "active sweep", "maintenance open"])("maintenance retry refuses %s without a proved collector hold", async failure => {
  const { db, input, query, calls } = releaseFixture();
  await expect(releasePersonalMetal({ ...input, action: "deploy", retireRuntime: async () => { throw new Error("DO unavailable"); } })).rejects.toThrow();
  if (failure === "no pause") db.exec("UPDATE image_registry_admission SET paused_at = NULL");
  if (failure === "active sweep") db.exec("UPDATE image_registry_admission SET state = 'sweeping', sweep_token = 'active'");
  calls.length = 0;
  await expect(releasePersonalMetal({ ...input, action: "deploy",
    collector: async () => { throw new Error("503 maintenance"); },
    proveMaintenance: async () => { if (failure === "maintenance open") throw new Error("maintenance is open"); },
  })).rejects.toThrow(failure === "maintenance open" ? "maintenance is open" : "paused, idle collector");
  expect(calls).toEqual([]);
  expect(query("SELECT DISTINCT state FROM runtime_operation_gates").rows).toEqual([{ state: "drained" }]);
});

test.each(["database retirement", "completion"])("deploy recovers durable evidence after the %s commit response is lost", async phase => {
  const fixture = releaseFixture();
  const { query, calls } = fixture;
  const artifacts = { buildArtifactId: "123", buildArtifactDigest: `sha256:${"a".repeat(64)}`, guestToolsPinSha256: "b".repeat(64) };
  const input = { ...fixture.input, artifacts };
  let lost = false;
  const client: D1WriteClient = { ...input.client, batch: async statements => {
    const result = await input.client.batch(statements);
    const checkpoint = statements.some(statement => phase === "completion"
      ? statement.sql.startsWith("UPDATE runtime_operation_gates SET state = 'open', evidence_json")
      : statement.sql.startsWith("UPDATE runtime_operation_gates SET evidence_json"));
    if (checkpoint && !lost) { lost = true; throw new Error("response lost after commit"); }
    return result;
  } };
  await expect(releasePersonalMetal({ ...input, client, action: "deploy" })).rejects.toThrow("response lost after commit");
  const saved = JSON.parse(String(query("SELECT evidence_json FROM runtime_operation_gates WHERE key = 'personal_metal_retirement'").rows[0]?.evidence_json));
  expect(saved).toMatchObject({ hostIds: ["host-1"], lastLeaseExpiresAt: 9999999, databaseId: "db", revision: "revision" });
  expect(saved.migrations.schemaSha256).toBeTruthy();
  expect(saved.operationId).toHaveLength(64);
  expect(saved.artifacts).toEqual(artifacts);
  calls.length = 0;
  // A fresh CI runner cannot substitute another build or pin at the same SHA.
  for (const changed of [undefined, { ...artifacts, buildArtifactId: "456" },
    { ...artifacts, buildArtifactDigest: `sha256:${"c".repeat(64)}` }, { ...artifacts, guestToolsPinSha256: "d".repeat(64) }]) {
    for (const action of ["deploy", "open-platform-registration", "open-admission"] as const) {
      await expect(releasePersonalMetal({ ...input, artifacts: changed, action })).rejects.toThrow("does not match this release operation");
    }
  }
  expect(calls).toEqual([]);
  // No local deploy.json and no in-memory evidence is supplied to the retry.
  const recovered = await releasePersonalMetal({ ...input, action: "deploy", collector: async () => { throw new Error("503 maintenance"); } });
  expect(recovered).toMatchObject(saved);
  if (phase === "completion") expect(calls).toEqual([]);
  else expect(calls).toEqual(["maintenance", "maintenance", "retire:host-1", "maintenance"]);
  expect(query("SELECT credential_generation FROM agent_hosts").rows).toEqual([{ credential_generation: 5 }]);
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_retirement'").rows).toEqual([{ state: "open" }]);
  await releasePersonalMetal({ ...input, action: "open-platform-registration", evidence: recovered,
    checks: { revision: "revision", stoppedHostIds: ["host-1"], gatewayRoutes: 0, gatewaySessions: 0, hosts: [] } });
  expect(query("SELECT state FROM runtime_operation_gates WHERE key = 'platform_metal_registration'").rows).toEqual([{ state: "open" }]);
});

test.each(["pending", "complete"])("%s retirement refuses a different revision, database or operation", async state => {
  const { input, db, query, calls } = releaseFixture();
  if (state === "pending") await expect(releasePersonalMetal({ ...input, action: "deploy", retireRuntime: async () => { throw new Error("interrupted"); } })).rejects.toThrow();
  else await releasePersonalMetal({ ...input, action: "deploy" });
  calls.length = 0;
  const before = query("SELECT * FROM agent_hosts").rows;
  for (const change of [{ revision: "other" }, { databaseId: "other" }]) {
    await expect(releasePersonalMetal({ ...input, ...change, action: "deploy" })).rejects.toThrow("does not match this release operation");
  }
  db.exec("UPDATE runtime_operation_gates SET evidence_json = json_set(evidence_json, '$.operationId', 'other') WHERE key = 'personal_metal_retirement'");
  await expect(releasePersonalMetal({ ...input, action: "deploy" })).rejects.toThrow("does not match this release operation");
  expect(calls).toEqual([]);
  expect(query("SELECT * FROM agent_hosts").rows).toEqual(before);
});

test("retirement fails old queued builds with no host and preserves completed build history", async () => {
  const { db, client, query } = fixture();
  db.exec("INSERT INTO image_build_bundles (rev, organization_id, r2_key, meta_json) VALUES ('old-revision', 'org-1', 'old-bundle', '{}')");
  for (const status of ["queued", "assigned", "building", "succeeded", "failed", "stale"]) {
    db.query("INSERT INTO image_builds (id, organization_id, scenario_id, arch, rev, content_hash, status, phase, host_id) VALUES (?, 'org-1', ?, 'x86_64', 'old-revision', ?, ?, ?, ?)")
      .run(status, status, status, status, status, status === "queued" ? null : "host-1");
  }
  const history = query("SELECT * FROM image_builds WHERE status IN ('succeeded', 'failed', 'stale') ORDER BY id").rows;
  await closeMetalGates(client);
  await retireMetalFleet(client);
  expect(query("SELECT id, status, phase, host_id, organization_id FROM image_builds WHERE id IN ('queued', 'assigned', 'building') ORDER BY id").rows)
    .toEqual(["assigned", "building", "queued"].map(id => ({ id, status: "failed", phase: "failed", host_id: id === "queued" ? null : "host-1", organization_id: "org-1" })));
  // This is the scheduler's eligibility predicate for unassigned work.
  expect(query("SELECT id FROM image_builds WHERE status = 'queued' AND host_id IS NULL").rows).toEqual([]);
  expect(query("SELECT * FROM image_builds WHERE id IN ('succeeded', 'failed', 'stale') ORDER BY id").rows).toEqual(history);
  expect(query("PRAGMA foreign_key_check").rows).toEqual([]);
});

test("the release CLI rejects missing arguments before any remote access", () => {
  const result = Bun.spawnSync(["bun", "tools/deploy/release-personal-metal.ts"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("usage: bun tools/deploy/release-personal-metal.ts");
});
