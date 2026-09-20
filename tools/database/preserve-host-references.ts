import { randomUUID } from "node:crypto";
import type { D1Statement } from "./d1-rest-client";

// These are all inbound agent_hosts foreign keys at migration 0023. Moving
// the references inside the same deferred transaction prevents DROP TABLE
// from applying CASCADE/SET NULL to the history we must keep. The generated
// schema statements run unchanged, then the exact host IDs are restored.
export const HOST_REFERENCE_TABLES = [
  "agent_bootstrap_tokens", "host_actual_state", "host_cpu_reservations",
  "host_desired_state", "host_resource_reservations", "image_builds",
  "runtime_executions", "runtime_vm_actual_state", "scenario_runs",
] as const;

export function preserveHostReferences(statements: readonly string[]): D1Statement[] {
  if (!statements.includes("DROP TABLE `agent_hosts`;")) {
    throw new Error("host migration does not contain the expected generated rebuild");
  }
  const prefix = `migration-${randomUUID()}:`;
  return [
    { sql: "PRAGMA defer_foreign_keys=ON;" },
    // Overflow aborts the transaction if a stored host ID could collide with
    // a temporary reference. No host identity is changed, even temporarily.
    { sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM agent_hosts WHERE substr(id, 1, ?1) = ?2) THEN abs(-9223372036854775808) ELSE 0 END", params: [prefix.length, prefix] },
    ...HOST_REFERENCE_TABLES.map(table => ({
      sql: `UPDATE ${table} SET host_id = ?1 || host_id WHERE host_id IS NOT NULL`,
      params: [prefix],
    })),
    ...statements.filter(sql => !/^PRAGMA defer_foreign_keys=/u.test(sql)).map(sql => ({ sql })),
    ...HOST_REFERENCE_TABLES.map(table => ({
      sql: `UPDATE ${table} SET host_id = substr(host_id, ?1) WHERE host_id IS NOT NULL`,
      params: [prefix.length + 1],
    })),
    { sql: "PRAGMA defer_foreign_keys=OFF;" },
  ];
}
