import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { claimHostEnrollment } from "../../apps/web/src/lib/host-enrollment";
import { sha256Hex } from "../../apps/web/src/control-plane/auth";

test("an enrollment can only bind one credential and cannot revive revoked access", async () => {
  const sqlite = new Database(":memory:");
  const prepared = (query: string, values: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepared(query, args),
    first: async () => sqlite.prepare(query).get(...values as never[]),
    run: async () => sqlite.prepare(query).run(...values as never[]),
  });
  const db = {
    prepare: prepared,
    batch: async (statements: Array<ReturnType<typeof prepared>>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  try {
    sqlite.exec("CREATE TABLE user (id TEXT, role TEXT, banned INTEGER, deleted_at INTEGER); CREATE TABLE access_allowlist (user_id TEXT, state TEXT, source_invite_id TEXT, source_lease_id TEXT, granted_at INTEGER); CREATE TABLE host_enrollments (token_hash TEXT PRIMARY KEY, host_id TEXT, user_id TEXT, name TEXT, scope TEXT, role TEXT, source_invite_id TEXT, source_lease_id TEXT, granted_at INTEGER, expires_at INTEGER, claimed_at INTEGER, credential_hash TEXT, revoked_at INTEGER); CREATE TABLE agent_hosts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, scope TEXT, role TEXT, credential_generation INTEGER, scenario_enabled INTEGER, disabled INTEGER, connected INTEGER, created_at INTEGER, updated_at INTEGER); CREATE TABLE agent_bootstrap_tokens (id TEXT PRIMARY KEY, host_id TEXT, token_hash TEXT, credential_generation INTEGER, created_at INTEGER, revoked_at INTEGER, expires_at INTEGER); INSERT INTO user VALUES ('alice', 'user', 0, NULL); INSERT INTO access_allowlist VALUES ('alice', 'active', 'invite', 'lease', 1);");
    sqlite.exec("CREATE TABLE runtime_operation_gates (key TEXT PRIMARY KEY, state TEXT); INSERT INTO runtime_operation_gates VALUES ('personal_metal_registration', 'open')");
    const token = "a".repeat(64), secret = "b".repeat(64);
    sqlite.prepare("INSERT INTO host_enrollments VALUES (?, 'host-a', 'alice', 'Server', 'personal', 'agent', 'invite', 'lease', 1, ?, NULL, NULL, NULL)")
      .run(await sha256Hex(token), Date.now() + 900000);
    const claim = await claimHostEnrollment(db, token, secret);
    expect(claim).toEqual({ hostId: "host-a", ownerUserId: "alice", scope: "personal", credentialGeneration: 1 });
    expect(sqlite.prepare("SELECT scenario_enabled FROM agent_hosts").get()).toEqual({ scenario_enabled: 1 });
    expect(await claimHostEnrollment(db, token, secret)).toEqual(claim);
    expect(await claimHostEnrollment(db, token, "c".repeat(64))).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS count FROM agent_hosts").get()).toEqual({ count: 1 });
    sqlite.exec("UPDATE agent_bootstrap_tokens SET revoked_at = 1");
    expect(await claimHostEnrollment(db, token, secret)).toBeNull();
    sqlite.exec("UPDATE agent_hosts SET disabled = 1");
    expect(await claimHostEnrollment(db, token, secret)).toBeNull();
  } finally { sqlite.close(); }
});
