import { describe, expect, it } from "vitest";
import {
  classifyHostCpuReservationSchema,
  tableInfoRowsFromWranglerJson,
} from "../../scripts/boot-cpu-migration-core";

const nowDefault = "cast(unixepoch('subsecond') * 1000 as integer)";

const legacyRows = [
  row(0, "run_id", "TEXT", 1, null, 1),
  row(1, "host_id", "TEXT", 1),
  row(2, "cpu_millis", "INTEGER", 1),
  row(3, "state", "TEXT", 1),
  row(4, "expires_at", "INTEGER", 0),
  row(5, "created_at", "INTEGER", 1, nowDefault),
  row(6, "updated_at", "INTEGER", 1, nowDefault),
];

const bootPhaseRows = [
  row(0, "run_id", "TEXT", 1, null, 1),
  row(1, "host_id", "TEXT", 1),
  row(2, "cpu_millis", "INTEGER", 1),
  row(3, "steady_cpu_millis", "INTEGER", 1),
  row(4, "boot_cpu_millis", "INTEGER", 1),
  row(5, "quota_phase", "TEXT", 1),
  row(6, "state", "TEXT", 1),
  row(7, "expires_at", "INTEGER", 0),
  row(8, "created_at", "INTEGER", 1, nowDefault),
  row(9, "updated_at", "INTEGER", 1, nowDefault),
];

describe("production boot CPU schema classification", () => {
  it("recognizes only the exact legacy schema", () => {
    expect(classifyHostCpuReservationSchema(legacyRows)).toBe("legacy");
    expect(
      classifyHostCpuReservationSchema(
        legacyRows.map((entry) => ({
          ...entry,
          type: entry.type.toLowerCase(),
        })),
      ),
    ).toBe("legacy");
  });

  it("recognizes the exact boot-phase schema and normalized SQL defaults", () => {
    const rows = bootPhaseRows.map((entry) => ({ ...entry }));
    rows[8] = { ...rows[8]!, dflt_value: `(${nowDefault})` };
    expect(classifyHostCpuReservationSchema(rows)).toBe("boot_phase");
  });

  it.each([
    [
      "missing column",
      bootPhaseRows.filter((entry) => entry.name !== "quota_phase"),
    ],
    ["extra column", [...bootPhaseRows, row(10, "unexpected", "TEXT", 0)]],
    [
      "partial migration",
      [
        ...legacyRows.slice(0, 3),
        row(3, "steady_cpu_millis", "INTEGER", 1),
        ...legacyRows.slice(3),
      ],
    ],
    [
      "wrong type",
      bootPhaseRows.map((entry) =>
        entry.name === "boot_cpu_millis" ? { ...entry, type: "TEXT" } : entry,
      ),
    ],
    [
      "wrong nullability",
      bootPhaseRows.map((entry) =>
        entry.name === "quota_phase" ? { ...entry, notnull: 0 } : entry,
      ),
    ],
    [
      "wrong default",
      bootPhaseRows.map((entry) =>
        entry.name === "created_at" ? { ...entry, dflt_value: "0" } : entry,
      ),
    ],
    [
      "wrong order",
      [bootPhaseRows[1], bootPhaseRows[0], ...bootPhaseRows.slice(2)],
    ],
    ["missing table", []],
    ["malformed row", [{ name: "run_id" }]],
  ])("fails closed for %s", (_label, rows) => {
    expect(classifyHostCpuReservationSchema(rows)).toBe("unknown");
  });

  it("extracts one successful Wrangler JSON result", () => {
    expect(
      tableInfoRowsFromWranglerJson([
        { success: true, results: bootPhaseRows, meta: { changed_db: false } },
      ]),
    ).toEqual(bootPhaseRows);
  });

  it.each([
    null,
    [],
    [{ success: false, results: [] }],
    [{ success: true }],
    [
      { success: true, results: [] },
      { success: true, results: [] },
    ],
  ])("rejects malformed Wrangler JSON %#", (value) => {
    expect(() => tableInfoRowsFromWranglerJson(value)).toThrow();
  });
});

function row(
  cid: number,
  name: string,
  type: string,
  notnull: 0 | 1,
  dfltValue: string | null = null,
  pk: 0 | 1 = 0,
) {
  return { cid, name, type, notnull, dflt_value: dfltValue, pk };
}
