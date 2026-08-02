import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertBaselineSchemaInventory,
  assertFinalizableCleanOwnerState,
  assertFinalizedCleanOwnerState,
  assertResumableCleanOwnerState,
  assertSeededCleanOwnerState,
  applicationTableCountsSql,
  assertApplyTableCounts,
  cleanOwnerStateSql,
  finalizeCleanOwnerSql,
  parseD1OwnerState,
  parseD1SchemaInventory,
  parseD1TableCounts,
  resumeCleanOwnerSql,
  validateCleanD1CommissioningProvenance,
  validateCleanOwnerIdentity,
  type CleanD1CommissioningProvenance,
  type CleanOwnerBootstrapState,
} from "./clean-owner-bootstrap";

const baseline = readFileSync(
  resolve(
    import.meta.dir,
    "../../apps/web/migrations/0000_clean_multicloud.sql",
  ),
  "utf8",
);
const statements = baseline
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);
const provenance = validateCleanD1CommissioningProvenance({
  githubLogin: "owner-login",
  githubId: "362487",
  databaseName: "intar-dev-control-plane-v2-20260801",
  databaseId: "11111111-2222-4333-8444-555555555555",
  baselineSha256: "a".repeat(64),
  sourceSha: "b".repeat(40),
  applyRunId: "123456789",
  applyRunAttempt: 1,
});

describe("clean D1 first-owner bootstrap", () => {
  test("parses the exact single-query D1 JSON envelope", () => {
    const db = cleanDatabase();
    const row = db.query(cleanOwnerStateSql("owner-login", "362487")).get();
    expect(
      parseD1OwnerState([{ success: true, results: [row] }]),
    ).toMatchObject({
      allowlistCount: 0,
      userCount: 0,
      accountCount: 0,
      commissioningCount: 0,
    });
    expect(() => parseD1OwnerState([])).toThrow();
    expect(() =>
      parseD1OwnerState([{ success: false, results: [] }]),
    ).toThrow();
    db.close();
  });

  test("validates and canonicalizes protected identity and provenance", () => {
    expect(validateCleanOwnerIdentity("Ice-Puma", "362487")).toEqual({
      githubLogin: "ice-puma",
      githubId: "362487",
    });
    for (const login of [
      "",
      "-owner",
      "owner-",
      "owner_name",
      "a".repeat(40),
    ]) {
      expect(() => validateCleanOwnerIdentity(login, "362487")).toThrow();
    }
    for (const id of ["", "0", "-1", "1.5", "owner"]) {
      expect(() => validateCleanOwnerIdentity("owner", id)).toThrow();
    }
    expect(() =>
      validateCleanD1CommissioningProvenance({
        ...provenance,
        applyRunAttempt: 2,
      }),
    ).toThrow();
    expect(() =>
      validateCleanD1CommissioningProvenance({
        ...provenance,
        baselineSha256: "not-a-digest",
      }),
    ).toThrow();
  });

  test("requires the remote schema inventory to match every baseline object", () => {
    const db = cleanDatabase();
    const rows = db
      .query(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'trigger', 'view')
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '_cf_%'
           AND name != 'd1_migrations'
         ORDER BY type, name`,
      )
      .all();
    const actual = parseD1SchemaInventory([{ success: true, results: rows }]);
    expect(() => assertBaselineSchemaInventory(actual, actual)).not.toThrow();
    db.exec("CREATE TABLE unrelated_state (id TEXT PRIMARY KEY)");
    const withUnrelated = parseD1SchemaInventory([
      {
        success: true,
        results: db
          .query(
            `SELECT type, name, tbl_name, sql FROM sqlite_master
             WHERE type IN ('table', 'index', 'trigger', 'view')
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE '_cf_%'
               AND name != 'd1_migrations'`,
          )
          .all(),
      },
    ]);
    expect(() =>
      assertBaselineSchemaInventory(withUnrelated, actual),
    ).toThrow();
    db.close();
  });

  test("requires every application table to be empty except the atomic seed", () => {
    const db = cleanDatabase();
    expect(() =>
      assertApplyTableCounts(tableCounts(db), baseline, "resumable"),
    ).not.toThrow();
    commission(db, provenance);
    expect(() =>
      assertApplyTableCounts(tableCounts(db), baseline, "seeded"),
    ).not.toThrow();
    db.query(
      "INSERT INTO access_requests (id, github_username, status, created_at) VALUES (?, ?, 'pending', ?)",
    ).run("unexpected-request", "somebody", Date.now());
    expect(() =>
      assertApplyTableCounts(tableCounts(db), baseline, "seeded"),
    ).toThrow();
    db.close();
  });

  test("commissions once and finalizes the sole OAuth account idempotently", () => {
    const db = cleanDatabase();
    commission(db, provenance);
    expect(() =>
      assertSeededCleanOwnerState(state(db, provenance), provenance),
    ).not.toThrow();

    insertUser(db, "owner-user", "owner-login");
    insertAccount(db, "owner-user", "github", "362487");
    const before = state(db, provenance);
    expect(assertFinalizableCleanOwnerState(before, provenance)).toBe(
      "owner-user",
    );
    db.exec(finalizeCleanOwnerSql(provenance, "owner-user"));
    expect(
      assertFinalizedCleanOwnerState(state(db, provenance), provenance),
    ).toBe("owner-user");

    db.exec(finalizeCleanOwnerSql(provenance, "owner-user"));
    expect(
      assertFinalizedCleanOwnerState(state(db, provenance), provenance),
    ).toBe("owner-user");
    db.close();
  });

  test("resumes baseline-only and successful-seed/evidence-failure states", () => {
    const baselineOnly = cleanDatabase();
    commission(baselineOnly, provenance);
    expect(() =>
      assertSeededCleanOwnerState(state(baselineOnly, provenance), provenance),
    ).not.toThrow();
    baselineOnly.close();

    const old = withRun(provenance, "111");
    const evidenceFailure = cleanDatabase();
    commission(evidenceFailure, old);
    expect(() =>
      assertSeededCleanOwnerState(state(evidenceFailure, old), old),
    ).not.toThrow();
    commission(evidenceFailure, provenance);
    expect(() =>
      assertSeededCleanOwnerState(
        state(evidenceFailure, provenance),
        provenance,
      ),
    ).not.toThrow();
    evidenceFailure.close();
  });

  test("will not resume unrelated state or changed static provenance", () => {
    const changedDatabase = cleanDatabase();
    commission(changedDatabase, provenance);
    expect(() =>
      assertResumableCleanOwnerState(state(changedDatabase, provenance), {
        ...provenance,
        databaseId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ).toThrow();
    changedDatabase.close();

    const unrelatedAllowlist = cleanDatabase();
    insertAllowlist(unrelatedAllowlist, "somebody-else");
    expect(() =>
      assertResumableCleanOwnerState(
        state(unrelatedAllowlist, provenance),
        provenance,
      ),
    ).toThrow();
    unrelatedAllowlist.close();

    const orphanAllowlist = cleanDatabase();
    insertAllowlist(orphanAllowlist, provenance.githubLogin);
    expect(() =>
      assertResumableCleanOwnerState(
        state(orphanAllowlist, provenance),
        provenance,
      ),
    ).toThrow();
    orphanAllowlist.close();

    const orphanMarker = cleanDatabase();
    commission(orphanMarker, provenance);
    orphanMarker.exec("DELETE FROM access_allowlist");
    expect(() =>
      assertResumableCleanOwnerState(
        state(orphanMarker, provenance),
        provenance,
      ),
    ).toThrow();
    orphanMarker.close();

    const preexistingUser = cleanDatabase();
    insertUser(preexistingUser, "unexpected-user", "unexpected");
    expect(() =>
      assertResumableCleanOwnerState(
        state(preexistingUser, provenance),
        provenance,
      ),
    ).toThrow();
    preexistingUser.close();
  });

  test("requires exactly one matching GitHub account bound to the sole user", () => {
    for (const [providerId, accountId] of [
      ["gitlab", "362487"],
      ["github", "999999"],
    ] as const) {
      const db = cleanDatabase();
      commission(db, provenance);
      insertUser(db, "owner-user", "owner-login");
      insertAccount(db, "owner-user", providerId, accountId);
      expect(() =>
        assertFinalizableCleanOwnerState(state(db, provenance), provenance),
      ).toThrow();
      db.close();
    }

    const differentUser = cleanDatabase();
    commission(differentUser, provenance);
    insertUser(differentUser, "owner-user", "owner-login");
    insertUser(differentUser, "account-user", "account-user");
    insertAccount(differentUser, "account-user", "github", "362487");
    expect(() =>
      assertFinalizableCleanOwnerState(
        state(differentUser, provenance),
        provenance,
      ),
    ).toThrow();
    differentUser.close();

    const extraAccount = commissionedUserDatabase();
    insertAccount(
      extraAccount,
      "owner-user",
      "github",
      "999999",
      "extra-account",
    );
    expect(() =>
      assertFinalizableCleanOwnerState(
        state(extraAccount, provenance),
        provenance,
      ),
    ).toThrow();
    extraAccount.close();
  });

  test("the promotion SQL rechecks OAuth and identity state after preflight", () => {
    const db = commissionedUserDatabase();
    expect(
      assertFinalizableCleanOwnerState(state(db, provenance), provenance),
    ).toBe("owner-user");
    insertUser(db, "racing-user", "racing-user");
    insertAccount(db, "racing-user", "github", "987654", "racing-account");
    db.exec(finalizeCleanOwnerSql(provenance, "owner-user"));
    const role = db
      .query("SELECT role FROM user WHERE id = 'owner-user'")
      .get() as { role: string };
    const receipt = db
      .query("SELECT status FROM clean_d1_commissioning")
      .get() as { status: string };
    expect(role.role).toBe("user");
    expect(receipt.status).toBe("allowlisted");
    db.close();
  });

  test("will not finalize against a different apply run", () => {
    const db = commissionedUserDatabase();
    const differentRun = withRun(provenance, "987654321");
    expect(() =>
      assertFinalizableCleanOwnerState(state(db, differentRun), differentRun),
    ).toThrow();
    db.exec(finalizeCleanOwnerSql(differentRun, "owner-user"));
    expect(
      db.query("SELECT role FROM user WHERE id = 'owner-user'").get(),
    ).toMatchObject({ role: "user" });
    db.close();
  });

  test("rejects wrong login, organization, or membership before promotion", () => {
    const wrongLogin = commissionedUserDatabase();
    const other = { ...provenance, githubLogin: "other-owner" };
    expect(() =>
      assertFinalizableCleanOwnerState(state(wrongLogin, other), other),
    ).toThrow();
    wrongLogin.close();

    const organizationDatabase = commissionedUserDatabase();
    organizationDatabase
      .query(
        "INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("org-a", "Organization A", "org-a", Date.now());
    expect(() =>
      assertFinalizableCleanOwnerState(
        state(organizationDatabase, provenance),
        provenance,
      ),
    ).toThrow();
    organizationDatabase.close();

    const membershipDatabase = commissionedUserDatabase();
    membershipDatabase
      .query(
        "INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("org-a", "Organization A", "org-a", Date.now());
    membershipDatabase
      .query(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
      )
      .run("member-a", "org-a", "owner-user", Date.now());
    expect(() =>
      assertFinalizableCleanOwnerState(
        state(membershipDatabase, provenance),
        provenance,
      ),
    ).toThrow();
    membershipDatabase.close();
  });
});

function cleanDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  for (const statement of statements) db.exec(statement);
  return db;
}

function commissionedUserDatabase(): Database {
  const db = cleanDatabase();
  commission(db, provenance);
  insertUser(db, "owner-user", "owner-login");
  insertAccount(db, "owner-user", "github", "362487");
  return db;
}

function commission(
  db: Database,
  expected: CleanD1CommissioningProvenance,
): void {
  const before = state(db, expected);
  assertResumableCleanOwnerState(before, expected);
  db.exec(resumeCleanOwnerSql(before, expected));
}

function insertAllowlist(db: Database, login: string): void {
  db.query(
    "INSERT INTO access_allowlist (github_username, approved_by, approved_at) VALUES (?, NULL, ?)",
  ).run(login, Date.now());
}

function insertUser(db: Database, id: string, username: string): void {
  db.query(
    `INSERT INTO user (
       id, name, email, email_verified, created_at, updated_at,
       username, display_username, role
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'user')`,
  ).run(
    id,
    username,
    `${username}@example.invalid`,
    Date.now(),
    Date.now(),
    username,
    username,
  );
}

function insertAccount(
  db: Database,
  userId: string,
  providerId: string,
  accountId: string,
  id = "owner-account",
): void {
  db.query(
    `INSERT INTO account (
       id, account_id, provider_id, user_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, providerId, userId, Date.now(), Date.now());
}

function state(
  db: Database,
  expected: Pick<CleanD1CommissioningProvenance, "githubLogin" | "githubId">,
): CleanOwnerBootstrapState {
  const row = db
    .query(cleanOwnerStateSql(expected.githubLogin, expected.githubId))
    .get();
  return parseD1OwnerState([{ success: true, results: [row] }]);
}

function withRun(
  expected: CleanD1CommissioningProvenance,
  applyRunId: string,
): CleanD1CommissioningProvenance {
  return validateCleanD1CommissioningProvenance({
    ...expected,
    applyRunId,
  });
}

function tableCounts(db: Database): Record<string, number> {
  const row = db.query(applicationTableCountsSql(baseline)).get();
  return parseD1TableCounts([{ success: true, results: [row] }]);
}
