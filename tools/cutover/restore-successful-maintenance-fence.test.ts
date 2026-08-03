import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  fileURLToPath(
    new URL("./restore-successful-maintenance-fence.sh", import.meta.url),
  ),
  "utf8",
);

describe("successful maintenance-fence pre-switch restore", () => {
  it("changes traffic only through one exact 100 percent version deployment", () => {
    expect(script).toContain(
      'bunx wrangler versions deploy "${previous_version_id}@100%"',
    );
    expect(script.match(/bunx wrangler versions deploy/g)).toHaveLength(1);
    expect(script).not.toMatch(/bunx wrangler deploy\b/);
    expect(script).not.toMatch(/bunx wrangler rollback\b/);
    expect(script).not.toMatch(/bunx wrangler d1\b/);
    expect(script).not.toMatch(/(?:routes?|crons?) (?:delete|deploy|put)/i);
    expect(script).toContain("database_mutated: false");
    expect(script).toContain("routes_mutated: false");
    expect(script).toContain("crons_mutated: false");
    expect(script).toContain("durable_object_lifecycle_mutated: false");
  });

  it("binds the exact successful cutover run and immutable versions", () => {
    for (const required of [
      '.path == ".github/workflows/clean-d1-cutover.yml"',
      '.conclusion == "success"',
      ".head_sha == $source_sha",
      'case "${before_version_id}" in',
      '"${maintenance_version_id}"|"${previous_version_id}"',
      '"${maintenance_version}" "${database_id}" "${maintenance_version_id}"',
      '"${previous_version}" "${database_id}" "${previous_version_id}"',
      'clean-d1-fence-${apply_run_id}',
      ".runId == $apply_run_id",
    ]) {
      expect(script).toContain(required);
    }
  });

  it("writes an immediate mutation receipt before post-deploy proof", () => {
    const deploy = script.indexOf(
      'bunx wrangler versions deploy "${previous_version_id}@100%"',
    );
    const receipt = script.indexOf('> "${mutation_receipt}"', deploy);
    const afterStatus = script.indexOf(
      'bunx wrangler deployments status --name intar-dev --json > "${after_deployment}"',
    );
    expect(deploy).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(deploy);
    const parse = script.indexOf(
      'wrangler-output.ts" version-deploy',
      deploy,
    );
    expect(parse).toBeGreaterThan(receipt);
    expect(afterStatus).toBeGreaterThan(parse);
    expect(script).toContain(
      'operation: "pre-switch-exact-version-mutation-receipt"',
    );
  });

  it("proves exact binding plus bounded public recovery", () => {
    expect(script).toContain(
      'test "$(jq -er \'.id\' "${after_deployment}")" = "${restore_deployment_id}"',
    );
    expect(script).toContain(
      '"${after_deployment}" "${after_version}" "${database_id}"',
    );
    expect(script).toContain(
      "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do",
    );
    expect(script).toContain('[ "${final_root_status}" = 200 ]');
    expect(script).toContain('[ "${marker_fence_headers}" = 0 ]');
    expect(script).toContain('test "${propagation_proven}" = true');
    expect(script).toContain("--connect-timeout 2");
    expect(script).toContain(
      '--max-time "${propagation_request_timeout_seconds}"',
    );
  });
});
