import { describe, expect, it } from "vitest";
import {
  classifyHostBenchmarkLeaseSchema,
  rowsFromSingleWranglerExecution,
} from "../../scripts/benchmark-contract-migration-core";

const nowDefault = "cast(unixepoch('subsecond') * 1000 as integer)";
const legacyColumns = [
  row(0, "host_id", "TEXT", 1, null, 1),
  row(1, "run_id", "TEXT", 1),
  row(2, "user_id", "TEXT", 1),
  row(3, "acquired_at", "INTEGER", 1, nowDefault),
  row(4, "updated_at", "INTEGER", 1, nowDefault),
];
const contractColumns = [
  ...legacyColumns,
  row(5, "contract_sha256", "TEXT", 1, "''"),
  row(6, "credential_not_before_unix_ms", "INTEGER", 1, "0"),
  row(7, "credential_expires_at_unix_ms", "INTEGER", 1, "0"),
];
const legacyTriggers = [
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
].map((name) => ({ name }));
const contractTriggers = [
  ...legacyTriggers,
  { name: "host_benchmark_lease_contract_is_immutable" },
  { name: "host_benchmark_lease_contract_is_valid" },
];

describe("production benchmark-contract schema classification", () => {
  it("recognizes only the exact legacy precondition", () => {
    expect(
      classifyHostBenchmarkLeaseSchema({
        columns: legacyColumns,
        triggers: legacyTriggers,
      }),
    ).toBe("legacy");
  });

  it("recognizes the exact postcondition independent of trigger row order", () => {
    expect(
      classifyHostBenchmarkLeaseSchema({
        columns: contractColumns,
        triggers: [...contractTriggers].reverse(),
      }),
    ).toBe("contract");
  });

  it.each([
    ["missing contract column", contractColumns.slice(0, -1), contractTriggers],
    [
      "partial contract columns",
      [...legacyColumns, contractColumns[5]],
      legacyTriggers,
    ],
    [
      "extra column",
      [...contractColumns, row(8, "unexpected", "TEXT", 0)],
      contractTriggers,
    ],
    [
      "wrong contract default",
      contractColumns.map((entry) =>
        entry.name === "contract_sha256"
          ? { ...entry, dflt_value: null }
          : entry,
      ),
      contractTriggers,
    ],
    [
      "missing contract trigger",
      contractColumns,
      contractTriggers.filter(
        (entry) => entry.name !== "host_benchmark_lease_contract_is_valid",
      ),
    ],
    [
      "extra relevant trigger",
      contractColumns,
      [...contractTriggers, { name: "host_benchmark_lease_unexpected" }],
    ],
    ["malformed trigger", contractColumns, [{ wrong: "name" }]],
    ["missing table", [], legacyTriggers],
  ])("fails closed for %s", (_label, columns, triggers) => {
    expect(classifyHostBenchmarkLeaseSchema({ columns, triggers })).toBe(
      "unknown",
    );
  });

  it("extracts one successful Wrangler result and rejects ambiguity", () => {
    expect(
      rowsFromSingleWranglerExecution([
        { success: true, results: contractColumns },
      ]),
    ).toEqual(contractColumns);
    expect(() => rowsFromSingleWranglerExecution([])).toThrow();
    expect(() =>
      rowsFromSingleWranglerExecution([{ success: false, results: [] }]),
    ).toThrow();
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
