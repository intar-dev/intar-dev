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
    sqlite.exec("CREATE TABLE user (id TEXT, role TEXT, banned INTEGER, deleted_at INTEGER); CREATE TABLE member (user_id TEXT, organization_id TEXT, role TEXT); CREATE TABLE host_enrollments (token_hash TEXT PRIMARY KEY, host_id TEXT, user_id TEXT, name TEXT, scope TEXT, role TEXT, organization_id TEXT, expires_at INTEGER, claimed_at INTEGER, credential_hash TEXT, revoked_at INTEGER); CREATE TABLE agent_hosts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, scope TEXT, role TEXT, organization_id TEXT, credential_generation INTEGER, scenario_enabled INTEGER, disabled INTEGER, connected INTEGER, created_at INTEGER, updated_at INTEGER); CREATE TABLE agent_bootstrap_tokens (id TEXT PRIMARY KEY, host_id TEXT, token_hash TEXT, credential_generation INTEGER, created_at INTEGER, revoked_at INTEGER, expires_at INTEGER); INSERT INTO user VALUES ('alice', 'user', 0, NULL);");
    sqlite.exec("CREATE TABLE runtime_operation_gates (key TEXT PRIMARY KEY, state TEXT); INSERT INTO runtime_operation_gates VALUES ('personal_metal_registration', 'open')");
    const token = "a".repeat(64), secret = "b".repeat(64);
    const enroll = async (enrollmentToken: string, hostId: string, owner: string) =>
      sqlite.prepare("INSERT INTO host_enrollments VALUES (?, ?, ?, 'Server', 'personal', 'agent', NULL, ?, NULL, NULL, NULL)")
        .run(await sha256Hex(enrollmentToken), hostId, owner, Date.now() + 900000);
    await enroll(token, "host-a", "alice");
    const claim = await claimHostEnrollment(db, token, secret);
    expect(claim).toEqual({ hostId: "host-a", ownerUserId: "alice", scope: "personal", organizationId: null, credentialGeneration: 1 });
    expect(sqlite.prepare("SELECT scenario_enabled FROM agent_hosts").get()).toEqual({ scenario_enabled: 1 });
    expect(await claimHostEnrollment(db, token, secret)).toEqual(claim);
    expect(await claimHostEnrollment(db, token, "c".repeat(64))).toBeNull();
    expect(sqlite.prepare("SELECT count(*) AS count FROM agent_hosts").get()).toEqual({ count: 1 });
    sqlite.exec("UPDATE agent_bootstrap_tokens SET revoked_at = 1");
    expect(await claimHostEnrollment(db, token, secret)).toBeNull();
    sqlite.exec("UPDATE agent_hosts SET disabled = 1");
    expect(await claimHostEnrollment(db, token, secret)).toBeNull();

    // A revoked owner can neither claim a pending enrollment nor recover a finished claim.
    sqlite.exec("INSERT INTO user VALUES ('bob', 'user', NULL, NULL), ('carol', 'user', NULL, NULL)");
    const bobToken = "d".repeat(64), bobSecret = "e".repeat(64), carolToken = "f".repeat(64);
    await enroll(bobToken, "host-b", "bob");
    await enroll(carolToken, "host-c", "carol");
    expect(await claimHostEnrollment(db, bobToken, bobSecret)).toMatchObject({ hostId: "host-b", ownerUserId: "bob" });
    sqlite.exec("UPDATE user SET banned = 1 WHERE id IN ('bob', 'carol')");
    expect(await claimHostEnrollment(db, bobToken, bobSecret)).toBeNull();
    expect(await claimHostEnrollment(db, carolToken, secret)).toBeNull();
    expect(sqlite.prepare("SELECT id FROM agent_hosts ORDER BY id").all()).toEqual([{ id: "host-a" }, { id: "host-b" }]);
  } finally { sqlite.close(); }
});
