export type HostCpuReservationSchema = "legacy" | "boot_phase" | "unknown";

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
  column(0, "run_id", "TEXT", 1, null, 1),
  column(1, "host_id", "TEXT", 1),
  column(2, "cpu_millis", "INTEGER", 1),
  column(3, "state", "TEXT", 1),
  column(4, "expires_at", "INTEGER", 0),
  column(5, "created_at", "INTEGER", 1, NOW_MS_DEFAULT),
  column(6, "updated_at", "INTEGER", 1, NOW_MS_DEFAULT),
];

const BOOT_PHASE_SCHEMA: readonly CanonicalColumn[] = [
  column(0, "run_id", "TEXT", 1, null, 1),
  column(1, "host_id", "TEXT", 1),
  column(2, "cpu_millis", "INTEGER", 1),
  column(3, "steady_cpu_millis", "INTEGER", 1),
  column(4, "boot_cpu_millis", "INTEGER", 1),
  column(5, "quota_phase", "TEXT", 1),
  column(6, "state", "TEXT", 1),
  column(7, "expires_at", "INTEGER", 0),
  column(8, "created_at", "INTEGER", 1, NOW_MS_DEFAULT),
  column(9, "updated_at", "INTEGER", 1, NOW_MS_DEFAULT),
];

/**
 * Classify only the two schemas that the production cutover understands.
 * Column order, type, nullability, default, and primary-key position must all
 * match. Any missing, extra, malformed, or partially migrated column fails
 * closed as `unknown`.
 */
export function classifyHostCpuReservationSchema(
  rows: readonly unknown[],
): HostCpuReservationSchema {
  const canonical = canonicalizeRows(rows);
  if (canonical === null) return "unknown";
  if (schemasEqual(canonical, LEGACY_SCHEMA)) return "legacy";
  if (schemasEqual(canonical, BOOT_PHASE_SCHEMA)) return "boot_phase";
  return "unknown";
}

export function describeHostCpuReservationSchema(
  rows: readonly unknown[],
): string {
  const canonical = canonicalizeRows(rows);
  if (canonical === null) return "malformed PRAGMA table_info result";
  if (canonical.length === 0) return "table is missing or has no columns";
  return canonical
    .map(
      (entry) =>
        `${entry.cid}:${entry.name}:${entry.type}:notnull=${entry.notNull}:default=${entry.defaultValue ?? "NULL"}:pk=${entry.primaryKey}`,
    )
    .join(", ");
}

export function tableInfoRowsFromWranglerJson(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(
      "Wrangler schema query returned an unexpected result count",
    );
  }
  const execution = value[0];
  if (!isRecord(execution) || execution.success !== true) {
    throw new Error("Wrangler schema query did not report success");
  }
  if (!Array.isArray(execution.results)) {
    throw new Error("Wrangler schema query omitted its result rows");
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
      if (character === quote && value[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
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
  if (actual.length !== expected.length) return false;
  return actual.every((entry, index) => {
    const target = expected[index];
    return (
      target !== undefined && JSON.stringify(entry) === JSON.stringify(target)
    );
  });
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
