import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("./retire-unused-legacy-host.sh", import.meta.url)),
  "utf8",
);
const workflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/clean-d1-cutover.yml", import.meta.url),
  ),
  "utf8",
);

describe("unused legacy host retirement", () => {
  test("permits only the guarded host disable and bootstrap-token revoke", () => {
    expect(script).not.toMatch(/\b(?:delete|drop|alter|insert|replace)\b/i);
    expect(script).not.toMatch(/update\s+workshop_publications/i);

    const mutations = [...script.matchAll(/--command "(UPDATE [^"\n]+)"/g)].map(
      ([, sql]) => sql,
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatch(
      /^UPDATE agent_bootstrap_tokens SET revoked_at = coalesce\(/,
    );
    expect(mutations[0]).toContain(
      "WHERE host_id = '${host_id}' AND revoked_at IS NULL RETURNING id",
    );
    expect(mutations[1]).toMatch(/^UPDATE agent_hosts SET disabled = 1,/);
    expect(mutations[1]).toContain(
      "WHERE id = '${host_id}' AND name = '${host_name}'",
    );
    expect(mutations[1]).toContain(
      "role = 'builder' AND organization_id IS NULL AND connected = 0",
    );
    expect(mutations[1]).toContain(
      "connected_at IS NULL AND last_heartbeat_at IS NULL AND last_inventory_at IS NULL",
    );

    for (const table of [
      "host_actual_state",
      "host_desired_state",
      "scenario_runs",
      "runtime_executions",
      "runtime_vm_actual_state",
      "image_builds",
      "host_resource_reservations",
      "host_cpu_reservations",
      "workshop_publications",
    ]) {
      expect(mutations[1]).toContain(
        `NOT EXISTS (SELECT 1 FROM ${table} WHERE`,
      );
    }
  });

  test("records the preserved history and disabled-host postconditions", () => {
    expect(script).toContain("workshop_publication_history");
    expect(script).toContain(".after.disabled_hosts == 1");
    expect(script).toContain(".after.active_bootstrap_tokens == 0");
    expect(script).toContain("host_deleted: false");
    expect(script).toContain(
      "$before[0][0].results[0].workshop_publication_history ==",
    );
    expect(script).toContain(
      "$after[0][0].results[0].workshop_publication_history",
    );
    expect(script).toContain(".publication_history_preserved == true");
  });

  test("keeps the mutation behind the protected cutover operation", () => {
    expect(workflow).toContain("- retire-legacy-host");
    expect(workflow).toContain('test "${CONFIRMATION}" = "RETIRE LEGACY HOST"');
    expect(workflow).toContain(
      "if: ${{ inputs.operation == 'retire-legacy-host' }}",
    );
    expect(workflow).toContain(
      "bash tools/cutover/retire-unused-legacy-host.sh",
    );
    expect(workflow).toContain(
      "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_ADMIN_API_TOKEN }}",
    );
  });
});
