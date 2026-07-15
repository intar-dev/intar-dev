export type HostBenchmarkLeaseSchema = "legacy" | "contract" | "unknown";

interface CanonicalColumn {
  cid: number;
  name: string;
  type: string;
  notNull: 0 | 1;
  defaultValue: string | null;
  primaryKey: 0 | 1;
}

const NOW_MS_DEFAULT = "cast(unixepoch('subsecond')*1000asinteger)";

const LEGACY_SCHEMA: readonly CanonicalColumn[] = [
  column(0, "host_id", "TEXT", 1, null, 1),
  column(1, "run_id", "TEXT", 1),
  column(2, "user_id", "TEXT", 1),
  column(3, "acquired_at", "INTEGER", 1, NOW_MS_DEFAULT),
  column(4, "updated_at", "INTEGER", 1, NOW_MS_DEFAULT),
];

// SQLite appends ALTER TABLE ADD COLUMN fields after the legacy columns.
const CONTRACT_SCHEMA: readonly CanonicalColumn[] = [
  ...LEGACY_SCHEMA,
  column(5, "contract_sha256", "TEXT", 1, "''"),
  column(6, "credential_not_before_unix_ms", "INTEGER", 1, "0"),
  column(7, "credential_expires_at_unix_ms", "INTEGER", 1, "0"),
];

const LEGACY_TRIGGERS = [
  "host_benchmark_lease_blocks_cross_run_reservation_insert",
  "host_benchmark_lease_blocks_cross_run_reservation_update",
  "host_benchmark_lease_blocks_desired_state_delete",
  "host_benchmark_lease_blocks_foreign_desired_vm",
  "host_benchmark_lease_blocks_scenario_enable",
  "host_benchmark_lease_freezes_cache_and_build_desired_state",
  "host_benchmark_lease_identity_is_immutable",
  "host_benchmark_lease_requires_scheduling_disabled",
  "host_benchmark_lease_requires_zero_reservations",
  "host_desired_running_vm_requires_active_run_insert",
  "host_desired_running_vm_requires_active_run_update",
] as const;

const CONTRACT_TRIGGERS = [
  ...LEGACY_TRIGGERS,
  "host_benchmark_lease_contract_is_immutable",
  "host_benchmark_lease_contract_is_valid",
].sort();

/**
 * Accept only the exact pre-0005 or post-0005 table and named trigger set.
 * Missing, reordered, extra, partially added, or malformed state fails closed.
 */
export function classifyHostBenchmarkLeaseSchema(input: {
  columns: readonly unknown[];
  triggers: readonly unknown[];
}): HostBenchmarkLeaseSchema {
  const columns = canonicalizeRows(input.columns);
  const triggers = canonicalizeTriggerNames(input.triggers);
  if (columns === null || triggers === null) return "unknown";
  if (
    schemasEqual(columns, LEGACY_SCHEMA) &&
    stringArraysEqual(triggers, [...LEGACY_TRIGGERS].sort())
  ) {
    return "legacy";
  }
  if (
    schemasEqual(columns, CONTRACT_SCHEMA) &&
    stringArraysEqual(triggers, CONTRACT_TRIGGERS)
  ) {
    return "contract";
  }
  return "unknown";
}

export function describeHostBenchmarkLeaseSchema(input: {
  columns: readonly unknown[];
  triggers: readonly unknown[];
}): string {
  const columns = canonicalizeRows(input.columns);
  const triggers = canonicalizeTriggerNames(input.triggers);
  const columnDescription =
    columns === null
      ? "malformed PRAGMA table_info result"
      : columns.length === 0
        ? "table is missing or has no columns"
        : columns
            .map(
              (entry) =>
                `${entry.cid}:${entry.name}:${entry.type}:notnull=${entry.notNull}:default=${entry.defaultValue ?? "NULL"}:pk=${entry.primaryKey}`,
            )
            .join(", ");
  const triggerDescription =
    triggers === null ? "malformed trigger result" : triggers.join(", ");
  return `columns=[${columnDescription}] triggers=[${triggerDescription}]`;
}

export function rowsFromSingleWranglerExecution(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Wrangler query returned an unexpected result count");
  }
  const execution = value[0];
  if (!isRecord(execution) || execution.success !== true) {
    throw new Error("Wrangler query did not report success");
  }
  if (!Array.isArray(execution.results)) {
    throw new Error("Wrangler query omitted its result rows");
  }
  return execution.results;
}

function canonicalizeRows(rows: readonly unknown[]): CanonicalColumn[] | null {
  const canonical: CanonicalColumn[] = [];
  for (const row of rows) {
    if (!isRecord(row)) return null;
    const { cid, name, type, notnull, dflt_value: defaultValue, pk } = row;
    if (
      !Number.isInteger(cid) ||
      typeof cid !== "number" ||
      typeof name !== "string" ||
      typeof type !== "string" ||
      (notnull !== 0 && notnull !== 1) ||
      (pk !== 0 && pk !== 1) ||
      (defaultValue !== null && typeof defaultValue !== "string")
    ) {
      return null;
    }
    const normalizedDefault = normalizeDefault(defaultValue);
    if (normalizedDefault === undefined) return null;
    canonical.push({
      cid,
      name,
      type: type.trim().toUpperCase(),
      notNull: notnull,
      defaultValue: normalizedDefault,
      primaryKey: pk,
    });
  }
  return canonical;
}

function canonicalizeTriggerNames(rows: readonly unknown[]): string[] | null {
  const names: string[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.name !== "string" || !row.name) {
      return null;
    }
    names.push(row.name);
  }
  const unique = new Set(names);
  return unique.size === names.length ? [...unique].sort() : null;
}

function normalizeDefault(value: string | null): string | null | undefined {
  if (value === null) return null;
  let normalized = value.trim();
  if (normalized.length === 0) return undefined;
  while (hasSingleOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.toLowerCase().replaceAll(/\s+/g, "");
}

function hasSingleOuterParentheses(value: string): boolean {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (character === quote && value[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index !== value.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === null;
}

function schemasEqual(
  actual: readonly CanonicalColumn[],
  expected: readonly CanonicalColumn[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => {
      const target = expected[index];
      return (
        target !== undefined && JSON.stringify(entry) === JSON.stringify(target)
      );
    })
  );
}

function stringArraysEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index])
  );
}

function column(
  cid: number,
  name: string,
  type: string,
  notNull: 0 | 1,
  defaultValue: string | null = null,
  primaryKey: 0 | 1 = 0,
): CanonicalColumn {
  return { cid, name, type, notNull, defaultValue, primaryKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
