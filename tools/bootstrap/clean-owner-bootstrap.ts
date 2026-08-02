#!/usr/bin/env bun

import { readFileSync } from "node:fs";

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const DATABASE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const COMMISSIONING_ID = "first-owner-v1";

export type CleanOwnerIdentity = {
  githubLogin: string;
  githubId: string;
};

export type CleanD1CommissioningProvenance = CleanOwnerIdentity & {
  databaseName: string;
  databaseId: string;
  baselineSha256: string;
  sourceSha: string;
  applyRunId: string;
  applyRunAttempt: 1;
};

export type CleanOwnerBootstrapState = {
  allowlistCount: number;
  matchingAllowlistCount: number;
  userCount: number;
  matchingUserCount: number;
  userId: string | null;
  userRole: string | null;
  accountCount: number;
  matchingGithubAccountCount: number;
  matchingGithubUserAccountCount: number;
  githubAccountUserId: string | null;
  organizationCount: number;
  memberCount: number;
  commissioningCount: number;
  commissioningId: string | null;
  commissioningDatabaseName: string | null;
  commissioningDatabaseId: string | null;
  commissioningBaselineSha256: string | null;
  commissioningSourceSha: string | null;
  commissioningOwnerGithubLogin: string | null;
  commissioningOwnerGithubId: string | null;
  commissioningApplyRunId: string | null;
  commissioningApplyRunAttempt: number | null;
  commissioningStatus: string | null;
  commissioningOwnerUserId: string | null;
};

export type BaselineSchemaObject = {
  type: "index" | "table" | "trigger" | "view";
  name: string;
  tblName: string;
  sql: string;
};

export function validateCleanOwnerIdentity(
  githubLogin: string,
  githubId: string,
): CleanOwnerIdentity {
  const login = githubLogin.trim();
  const id = githubId.trim();
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    throw new TypeError("bootstrap owner GitHub login is invalid");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(id)) {
    throw new TypeError("bootstrap owner GitHub ID is invalid");
  }
  return { githubLogin: login.toLowerCase(), githubId: id };
}

export function validateCleanD1CommissioningProvenance(
  value: Omit<CleanD1CommissioningProvenance, "applyRunAttempt"> & {
    applyRunAttempt?: number;
  },
): CleanD1CommissioningProvenance {
  const identity = validateCleanOwnerIdentity(
    value.githubLogin,
    value.githubId,
  );
  const databaseName = value.databaseName.trim();
  const databaseId = value.databaseId.trim();
  const baselineSha256 = value.baselineSha256.trim();
  const sourceSha = value.sourceSha.trim();
  const applyRunId = value.applyRunId.trim();
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new TypeError("clean D1 database name is invalid");
  }
  if (!DATABASE_ID_PATTERN.test(databaseId)) {
    throw new TypeError("clean D1 database ID is invalid");
  }
  if (!SHA256_PATTERN.test(baselineSha256)) {
    throw new TypeError("clean D1 baseline SHA-256 is invalid");
  }
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new TypeError("clean D1 source SHA is invalid");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(applyRunId)) {
    throw new TypeError("clean D1 apply run ID is invalid");
  }
  if ((value.applyRunAttempt ?? 1) !== 1) {
    throw new TypeError("clean D1 apply run must be its first attempt");
  }
  return {
    ...identity,
    databaseName,
    databaseId,
    baselineSha256,
    sourceSha,
    applyRunId,
    applyRunAttempt: 1,
  };
}

export function cleanOwnerStateSql(
  githubLogin: string,
  githubId: string,
): string {
  const identity = validateCleanOwnerIdentity(githubLogin, githubId);
  const login = identity.githubLogin;
  const accountId = identity.githubId;
  return `SELECT
  (SELECT count(*) FROM access_allowlist) AS allowlist_count,
  (SELECT count(*) FROM access_allowlist WHERE github_username = '${login}') AS matching_allowlist_count,
  (SELECT count(*) FROM user) AS user_count,
  (SELECT count(*) FROM user WHERE lower(username) = '${login}') AS matching_user_count,
  (SELECT id FROM user WHERE lower(username) = '${login}' LIMIT 1) AS user_id,
  (SELECT role FROM user WHERE lower(username) = '${login}' LIMIT 1) AS user_role,
  (SELECT count(*) FROM account) AS account_count,
  (SELECT count(*) FROM account WHERE provider_id = 'github' AND account_id = '${accountId}') AS matching_github_account_count,
  (SELECT count(*) FROM account AS a INNER JOIN user AS u ON u.id = a.user_id WHERE a.provider_id = 'github' AND a.account_id = '${accountId}' AND lower(u.username) = '${login}') AS matching_github_user_account_count,
  (SELECT user_id FROM account WHERE provider_id = 'github' AND account_id = '${accountId}' LIMIT 1) AS github_account_user_id,
  (SELECT count(*) FROM organization) AS organization_count,
  (SELECT count(*) FROM member) AS member_count,
  (SELECT count(*) FROM clean_d1_commissioning) AS commissioning_count,
  (SELECT id FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_id,
  (SELECT database_name FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_database_name,
  (SELECT database_id FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_database_id,
  (SELECT baseline_sha256 FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_baseline_sha256,
  (SELECT source_sha FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_source_sha,
  (SELECT owner_github_login FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_owner_github_login,
  (SELECT owner_github_id FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_owner_github_id,
  (SELECT apply_run_id FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_apply_run_id,
  (SELECT apply_run_attempt FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_apply_run_attempt,
  (SELECT status FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_status,
  (SELECT owner_user_id FROM clean_d1_commissioning WHERE id = '${COMMISSIONING_ID}' LIMIT 1) AS commissioning_owner_user_id;`;
}

export function resumeCleanOwnerSql(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
): string {
  assertResumableCleanOwnerState(state, expected);
  const timestamp = "cast(unixepoch('subsecond') * 1000 as integer)";
  const emptyIdentity = `(SELECT count(*) FROM user) = 0
  AND (SELECT count(*) FROM account) = 0
  AND (SELECT count(*) FROM organization) = 0
  AND (SELECT count(*) FROM member) = 0
  AND (SELECT count(*) FROM access_allowlist) IN (0, 1)
  AND (SELECT count(*) FROM access_allowlist WHERE github_username = '${expected.githubLogin}') = (SELECT count(*) FROM access_allowlist)`;
  const statements: string[] = [];

  if (state.commissioningCount === 0) {
    statements.push(`INSERT INTO clean_d1_commissioning (
  id, database_name, database_id, baseline_sha256, source_sha,
  owner_github_login, owner_github_id, apply_run_id, apply_run_attempt,
  status, owner_user_id, created_at, updated_at
)
SELECT
  '${COMMISSIONING_ID}', '${expected.databaseName}', '${expected.databaseId}',
  '${expected.baselineSha256}', '${expected.sourceSha}',
  '${expected.githubLogin}', '${expected.githubId}', '${expected.applyRunId}', 1,
  'allowlisted', NULL, ${timestamp}, ${timestamp}
WHERE (SELECT count(*) FROM clean_d1_commissioning) = 0
  AND (SELECT count(*) FROM access_allowlist) = 0
  AND ${emptyIdentity};
INSERT INTO access_allowlist (
  github_username, approved_by, approved_at
)
SELECT '${expected.githubLogin}', NULL, ${timestamp}
WHERE (SELECT count(*) FROM access_allowlist) = 0
  AND (SELECT count(*) FROM user) = 0
  AND (SELECT count(*) FROM account) = 0
  AND (SELECT count(*) FROM organization) = 0
  AND (SELECT count(*) FROM member) = 0
  AND (SELECT count(*) FROM clean_d1_commissioning
       WHERE id = '${COMMISSIONING_ID}'
         AND database_name = '${expected.databaseName}'
         AND database_id = '${expected.databaseId}'
         AND baseline_sha256 = '${expected.baselineSha256}'
         AND source_sha = '${expected.sourceSha}'
         AND owner_github_login = '${expected.githubLogin}'
         AND owner_github_id = '${expected.githubId}'
         AND apply_run_id = '${expected.applyRunId}'
         AND apply_run_attempt = 1
         AND status = 'allowlisted'
         AND owner_user_id IS NULL) = 1;`);
  } else {
    statements.push(`UPDATE clean_d1_commissioning
SET source_sha = '${expected.sourceSha}',
    apply_run_id = '${expected.applyRunId}',
    apply_run_attempt = 1,
    updated_at = ${timestamp}
WHERE id = '${COMMISSIONING_ID}'
  AND database_name = '${expected.databaseName}'
  AND database_id = '${expected.databaseId}'
  AND baseline_sha256 = '${expected.baselineSha256}'
  AND source_sha = '${state.commissioningSourceSha}'
  AND owner_github_login = '${expected.githubLogin}'
  AND owner_github_id = '${expected.githubId}'
  AND apply_run_id = '${state.commissioningApplyRunId}'
  AND apply_run_attempt = 1
  AND status = 'allowlisted'
  AND owner_user_id IS NULL
  AND (SELECT count(*) FROM clean_d1_commissioning) = 1
  AND (SELECT count(*) FROM access_allowlist) = 1
  AND (SELECT count(*) FROM access_allowlist WHERE github_username = '${expected.githubLogin}') = 1
  AND ${emptyIdentity};`);
  }
  return statements.join("\n");
}

export function finalizeCleanOwnerSql(
  expected: CleanD1CommissioningProvenance,
  userId: string,
): string {
  const canonicalUserId = userId.trim();
  if (!APP_ID_PATTERN.test(canonicalUserId)) {
    throw new TypeError("bootstrap owner user ID is invalid");
  }
  const timestamp = "cast(unixepoch('subsecond') * 1000 as integer)";
  const exactOAuthState = `(SELECT count(*) FROM access_allowlist) = 1
  AND (SELECT count(*) FROM access_allowlist WHERE github_username = '${expected.githubLogin}') = 1
  AND (SELECT count(*) FROM user) = 1
  AND (SELECT count(*) FROM account) = 1
  AND (SELECT count(*) FROM account WHERE provider_id = 'github' AND account_id = '${expected.githubId}' AND user_id = '${canonicalUserId}') = 1
  AND (SELECT count(*) FROM organization) = 0
  AND (SELECT count(*) FROM member) = 0`;
  const exactCommissioning = `database_name = '${expected.databaseName}'
  AND database_id = '${expected.databaseId}'
  AND baseline_sha256 = '${expected.baselineSha256}'
  AND source_sha = '${expected.sourceSha}'
  AND owner_github_login = '${expected.githubLogin}'
  AND owner_github_id = '${expected.githubId}'
  AND apply_run_id = '${expected.applyRunId}'
  AND apply_run_attempt = 1`;
  return `UPDATE user
SET role = 'admin', updated_at = ${timestamp}
WHERE id = '${canonicalUserId}'
  AND lower(username) = '${expected.githubLogin}'
  AND role IN ('user', 'admin')
  AND ${exactOAuthState}
  AND (SELECT count(*) FROM clean_d1_commissioning
       WHERE id = '${COMMISSIONING_ID}'
         AND ${exactCommissioning}
         AND ((status = 'allowlisted' AND owner_user_id IS NULL)
           OR (status = 'owner_finalized' AND owner_user_id = '${canonicalUserId}'))) = 1;
UPDATE clean_d1_commissioning
SET status = 'owner_finalized',
    owner_user_id = '${canonicalUserId}',
    updated_at = ${timestamp}
WHERE id = '${COMMISSIONING_ID}'
  AND ${exactCommissioning}
  AND ((status = 'allowlisted' AND owner_user_id IS NULL)
    OR (status = 'owner_finalized' AND owner_user_id = '${canonicalUserId}'))
  AND (SELECT count(*) FROM clean_d1_commissioning) = 1
  AND (SELECT count(*) FROM user WHERE id = '${canonicalUserId}' AND lower(username) = '${expected.githubLogin}' AND role = 'admin') = 1
  AND ${exactOAuthState};`;
}

export function parseD1OwnerState(value: unknown): CleanOwnerBootstrapState {
  const row = singleD1Row(value, "clean owner state");
  return {
    allowlistCount: integer(row.allowlist_count, "allowlist_count"),
    matchingAllowlistCount: integer(
      row.matching_allowlist_count,
      "matching_allowlist_count",
    ),
    userCount: integer(row.user_count, "user_count"),
    matchingUserCount: integer(row.matching_user_count, "matching_user_count"),
    userId: nullableString(row.user_id, "user_id"),
    userRole: nullableString(row.user_role, "user_role"),
    accountCount: integer(row.account_count, "account_count"),
    matchingGithubAccountCount: integer(
      row.matching_github_account_count,
      "matching_github_account_count",
    ),
    matchingGithubUserAccountCount: integer(
      row.matching_github_user_account_count,
      "matching_github_user_account_count",
    ),
    githubAccountUserId: nullableString(
      row.github_account_user_id,
      "github_account_user_id",
    ),
    organizationCount: integer(row.organization_count, "organization_count"),
    memberCount: integer(row.member_count, "member_count"),
    commissioningCount: integer(row.commissioning_count, "commissioning_count"),
    commissioningId: nullableString(row.commissioning_id, "commissioning_id"),
    commissioningDatabaseName: nullableString(
      row.commissioning_database_name,
      "commissioning_database_name",
    ),
    commissioningDatabaseId: nullableString(
      row.commissioning_database_id,
      "commissioning_database_id",
    ),
    commissioningBaselineSha256: nullableString(
      row.commissioning_baseline_sha256,
      "commissioning_baseline_sha256",
    ),
    commissioningSourceSha: nullableString(
      row.commissioning_source_sha,
      "commissioning_source_sha",
    ),
    commissioningOwnerGithubLogin: nullableString(
      row.commissioning_owner_github_login,
      "commissioning_owner_github_login",
    ),
    commissioningOwnerGithubId: nullableString(
      row.commissioning_owner_github_id,
      "commissioning_owner_github_id",
    ),
    commissioningApplyRunId: nullableString(
      row.commissioning_apply_run_id,
      "commissioning_apply_run_id",
    ),
    commissioningApplyRunAttempt: nullableInteger(
      row.commissioning_apply_run_attempt,
      "commissioning_apply_run_attempt",
    ),
    commissioningStatus: nullableString(
      row.commissioning_status,
      "commissioning_status",
    ),
    commissioningOwnerUserId: nullableString(
      row.commissioning_owner_user_id,
      "commissioning_owner_user_id",
    ),
  };
}

export function assertResumableCleanOwnerState(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
): void {
  assertEmptyIdentityState(state);
  if (
    state.allowlistCount < 0 ||
    state.allowlistCount > 1 ||
    state.matchingAllowlistCount !== state.allowlistCount
  ) {
    throw new Error("clean D1 contains an unrelated first-owner allowlist");
  }
  if (state.commissioningCount === 0) {
    if (state.allowlistCount !== 0) {
      throw new Error("clean D1 contains an orphan first-owner allowlist");
    }
    assertCommissioningFieldsAbsent(state);
    return;
  }
  if (state.commissioningCount !== 1) {
    throw new Error("clean D1 contains multiple commissioning receipts");
  }
  assertStoredCommissioningProvenance(state, expected, false);
  if (
    state.allowlistCount !== 1 ||
    state.matchingAllowlistCount !== 1 ||
    state.commissioningStatus !== "allowlisted" ||
    state.commissioningOwnerUserId !== null
  ) {
    throw new Error("clean D1 commissioning receipt cannot be resumed");
  }
}

export function assertSeededCleanOwnerState(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
): void {
  assertEmptyIdentityState(state);
  if (state.allowlistCount !== 1 || state.matchingAllowlistCount !== 1) {
    throw new Error("clean D1 first-owner allowlist seed is invalid");
  }
  assertStoredCommissioningProvenance(state, expected, true);
  if (
    state.commissioningStatus !== "allowlisted" ||
    state.commissioningOwnerUserId !== null
  ) {
    throw new Error("clean D1 first-owner commissioning state is invalid");
  }
}

export function assertFinalizableCleanOwnerState(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
): string {
  if (
    state.allowlistCount !== 1 ||
    state.matchingAllowlistCount !== 1 ||
    state.userCount !== 1 ||
    state.matchingUserCount !== 1 ||
    !state.userId ||
    !APP_ID_PATTERN.test(state.userId) ||
    (state.userRole !== "user" && state.userRole !== "admin") ||
    state.accountCount !== 1 ||
    state.matchingGithubAccountCount !== 1 ||
    state.matchingGithubUserAccountCount !== 1 ||
    state.githubAccountUserId !== state.userId ||
    state.organizationCount !== 0 ||
    state.memberCount !== 0
  ) {
    throw new Error("clean D1 first-owner finalization precondition failed");
  }
  assertStoredCommissioningProvenance(state, expected, true);
  const validReceiptState =
    (state.commissioningStatus === "allowlisted" &&
      state.commissioningOwnerUserId === null) ||
    (state.commissioningStatus === "owner_finalized" &&
      state.commissioningOwnerUserId === state.userId);
  if (!validReceiptState) {
    throw new Error("clean D1 first-owner commissioning state is invalid");
  }
  return state.userId;
}

export function assertFinalizedCleanOwnerState(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
): string {
  const userId = assertFinalizableCleanOwnerState(state, expected);
  if (
    state.userRole !== "admin" ||
    state.commissioningStatus !== "owner_finalized" ||
    state.commissioningOwnerUserId !== userId
  ) {
    throw new Error("clean D1 first owner is not finalized");
  }
  return userId;
}

export function parseD1SchemaInventory(value: unknown): BaselineSchemaObject[] {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new TypeError("clean D1 schema inventory response is invalid");
  }
  const query = value[0];
  if (query.success !== true || !Array.isArray(query.results)) {
    throw new TypeError("clean D1 schema inventory query failed");
  }
  const objects = query.results.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.tbl_name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new TypeError("clean D1 schema inventory row is invalid");
    }
    if (
      !(["index", "table", "trigger", "view"] as const).includes(
        row.type as BaselineSchemaObject["type"],
      )
    ) {
      throw new TypeError("clean D1 schema inventory type is invalid");
    }
    return {
      type: row.type as BaselineSchemaObject["type"],
      name: row.name,
      tblName: row.tbl_name,
      sql: normalizeSchemaSql(row.sql),
    };
  });
  return objects.sort(compareSchemaObjects);
}

export function assertBaselineSchemaInventory(
  actual: BaselineSchemaObject[],
  expected: BaselineSchemaObject[],
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "clean D1 schema does not exactly match the pinned baseline",
    );
  }
}

export function applicationTableCountsSql(baselineSql: string): string {
  const names = [
    ...baselineSql.matchAll(
      /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z0-9_]+)[`"\]]?/gimu,
    ),
  ].map((match) => match[1]!);
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new TypeError("clean D1 baseline table inventory is invalid");
  }
  names.sort((left, right) => left.localeCompare(right));
  return `SELECT\n${names
    .map((name) => `  (SELECT count(*) FROM "${name}") AS "${name}"`)
    .join(",\n")};`;
}

export function parseD1TableCounts(value: unknown): Record<string, number> {
  const row = singleD1Row(value, "clean D1 table counts");
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(row)) {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) {
      throw new TypeError("clean D1 table-count name is invalid");
    }
    counts[name] = integer(value, `table count ${name}`);
  }
  return counts;
}

export function assertApplyTableCounts(
  counts: Record<string, number>,
  baselineSql: string,
  mode: "resumable" | "seeded",
): void {
  const expectedNames = [
    ...baselineSql.matchAll(
      /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z0-9_]+)[`"\]]?/gimu,
    ),
  ]
    .map((match) => match[1]!)
    .sort((left, right) => left.localeCompare(right));
  const actualNames = Object.keys(counts).sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("clean D1 table-count inventory is incomplete");
  }
  const expectedCommissioningCount =
    mode === "seeded" ? 1 : counts.clean_d1_commissioning;
  if (
    (expectedCommissioningCount !== 0 && expectedCommissioningCount !== 1) ||
    counts.access_allowlist !== expectedCommissioningCount ||
    counts.clean_d1_commissioning !== expectedCommissioningCount
  ) {
    throw new Error("clean D1 commissioning row counts are invalid");
  }
  for (const [name, count] of Object.entries(counts)) {
    if (
      name !== "access_allowlist" &&
      name !== "clean_d1_commissioning" &&
      count !== 0
    ) {
      throw new Error(`clean D1 table ${name} contains unrelated state`);
    }
  }
}

function assertEmptyIdentityState(state: CleanOwnerBootstrapState): void {
  if (
    state.userCount !== 0 ||
    state.matchingUserCount !== 0 ||
    state.userId !== null ||
    state.userRole !== null ||
    state.accountCount !== 0 ||
    state.matchingGithubAccountCount !== 0 ||
    state.matchingGithubUserAccountCount !== 0 ||
    state.githubAccountUserId !== null ||
    state.organizationCount !== 0 ||
    state.memberCount !== 0
  ) {
    throw new Error(
      "clean D1 contains pre-existing identity or organization state",
    );
  }
}

function assertCommissioningFieldsAbsent(
  state: CleanOwnerBootstrapState,
): void {
  if (
    state.commissioningId !== null ||
    state.commissioningDatabaseName !== null ||
    state.commissioningDatabaseId !== null ||
    state.commissioningBaselineSha256 !== null ||
    state.commissioningSourceSha !== null ||
    state.commissioningOwnerGithubLogin !== null ||
    state.commissioningOwnerGithubId !== null ||
    state.commissioningApplyRunId !== null ||
    state.commissioningApplyRunAttempt !== null ||
    state.commissioningStatus !== null ||
    state.commissioningOwnerUserId !== null
  ) {
    throw new Error("clean D1 commissioning receipt fields are inconsistent");
  }
}

function assertStoredCommissioningProvenance(
  state: CleanOwnerBootstrapState,
  expected: CleanD1CommissioningProvenance,
  requireCurrentRun: boolean,
): void {
  if (
    state.commissioningCount !== 1 ||
    state.commissioningId !== COMMISSIONING_ID ||
    !state.commissioningDatabaseName ||
    !state.commissioningDatabaseId ||
    !state.commissioningBaselineSha256 ||
    !state.commissioningSourceSha ||
    !state.commissioningOwnerGithubLogin ||
    !state.commissioningOwnerGithubId ||
    !state.commissioningApplyRunId ||
    state.commissioningApplyRunAttempt !== 1
  ) {
    throw new Error("clean D1 commissioning receipt is incomplete");
  }
  const stored = validateCleanD1CommissioningProvenance({
    databaseName: state.commissioningDatabaseName,
    databaseId: state.commissioningDatabaseId,
    baselineSha256: state.commissioningBaselineSha256,
    sourceSha: state.commissioningSourceSha,
    githubLogin: state.commissioningOwnerGithubLogin,
    githubId: state.commissioningOwnerGithubId,
    applyRunId: state.commissioningApplyRunId,
    applyRunAttempt: state.commissioningApplyRunAttempt,
  });
  if (
    stored.databaseName !== expected.databaseName ||
    stored.databaseId !== expected.databaseId ||
    stored.baselineSha256 !== expected.baselineSha256 ||
    stored.githubLogin !== expected.githubLogin ||
    stored.githubId !== expected.githubId ||
    stored.sourceSha !== expected.sourceSha ||
    (requireCurrentRun && stored.applyRunId !== expected.applyRunId)
  ) {
    throw new Error("clean D1 commissioning provenance does not match");
  }
}

function singleD1Row(value: unknown, name: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new TypeError(`${name} response is invalid`);
  }
  const query = value[0];
  if (
    query.success !== true ||
    !Array.isArray(query.results) ||
    query.results.length !== 1 ||
    !isRecord(query.results[0])
  ) {
    throw new TypeError(`${name} query did not succeed exactly once`);
  }
  return query.results[0];
}

function compareSchemaObjects(
  left: BaselineSchemaObject,
  right: BaselineSchemaObject,
): number {
  return (
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name)
  );
}

function normalizeSchemaSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  return integer(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  return value;
}

function provenanceFromArgs(args: string[]): CleanD1CommissioningProvenance {
  if (args.length !== 7) {
    throw new TypeError(
      "clean D1 commissioning provenance arguments are invalid",
    );
  }
  return validateCleanD1CommissioningProvenance({
    githubLogin: args[0]!,
    githubId: args[1]!,
    databaseName: args[2]!,
    databaseId: args[3]!,
    baselineSha256: args[4]!,
    sourceSha: args[5]!,
    applyRunId: args[6]!,
    applyRunAttempt: 1,
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "identity" && args.length === 2) {
    process.stdout.write(
      `${JSON.stringify(validateCleanOwnerIdentity(args[0]!, args[1]!))}\n`,
    );
    return;
  }
  if (command === "state-sql" && args.length === 2) {
    process.stdout.write(`${cleanOwnerStateSql(args[0]!, args[1]!)}\n`);
    return;
  }
  if (command === "assert-resumable" && args.length === 8) {
    assertResumableCleanOwnerState(
      readD1State(args[0]!),
      provenanceFromArgs(args.slice(1)),
    );
    return;
  }
  if (command === "resume-sql" && args.length === 8) {
    const state = readD1State(args[0]!);
    const expected = provenanceFromArgs(args.slice(1));
    process.stdout.write(`${resumeCleanOwnerSql(state, expected)}\n`);
    return;
  }
  if (command === "assert-seeded" && args.length === 8) {
    assertSeededCleanOwnerState(
      readD1State(args[0]!),
      provenanceFromArgs(args.slice(1)),
    );
    return;
  }
  if (command === "assert-finalizable" && args.length === 8) {
    process.stdout.write(
      `${assertFinalizableCleanOwnerState(
        readD1State(args[0]!),
        provenanceFromArgs(args.slice(1)),
      )}\n`,
    );
    return;
  }
  if (command === "finalize-sql" && args.length === 8) {
    const expected = provenanceFromArgs([args[0]!, args[1]!, ...args.slice(3)]);
    process.stdout.write(`${finalizeCleanOwnerSql(expected, args[2]!)}\n`);
    return;
  }
  if (command === "assert-finalized" && args.length === 8) {
    process.stdout.write(
      `${assertFinalizedCleanOwnerState(
        readD1State(args[0]!),
        provenanceFromArgs(args.slice(1)),
      )}\n`,
    );
    return;
  }
  if (command === "assert-baseline-inventory" && args.length === 2) {
    assertBaselineSchemaInventory(
      parseD1SchemaInventory(
        JSON.parse(readFileSync(args[0]!, "utf8")) as unknown,
      ),
      parseD1SchemaInventory(
        JSON.parse(readFileSync(args[1]!, "utf8")) as unknown,
      ),
    );
    return;
  }
  if (command === "table-counts-sql" && args.length === 1) {
    process.stdout.write(
      `${applicationTableCountsSql(readFileSync(args[0]!, "utf8"))}\n`,
    );
    return;
  }
  if (
    command === "assert-apply-table-counts" &&
    args.length === 3 &&
    (args[2] === "resumable" || args[2] === "seeded")
  ) {
    assertApplyTableCounts(
      parseD1TableCounts(JSON.parse(readFileSync(args[0]!, "utf8")) as unknown),
      readFileSync(args[1]!, "utf8"),
      args[2],
    );
    return;
  }
  throw new TypeError("unsupported clean owner bootstrap command");
}

function readD1State(path: string): CleanOwnerBootstrapState {
  return parseD1OwnerState(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

if (import.meta.main) {
  await main();
}
