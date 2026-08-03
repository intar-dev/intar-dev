import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("./reactivate-maintenance-fence.sh", import.meta.url)),
  "utf8",
);

describe("exact maintenance-fence reactivation", () => {
  it("deploys only the original immutable maintenance version at 100 percent", () => {
    expect(script).toContain(
      'bunx wrangler versions deploy "${maintenance_version_id}@100%"',
    );
    expect(script.match(/bunx wrangler versions deploy/g)).toHaveLength(1);
    expect(script).not.toMatch(/bunx wrangler versions upload\b/);
    expect(script).not.toMatch(/bunx wrangler deploy\b/);
    expect(script).not.toMatch(/bunx wrangler rollback\b/);
    expect(script).not.toMatch(/bunx wrangler d1\b/);
    expect(script).not.toMatch(/(?:routes?|crons?) (?:delete|deploy|put)/i);
  });

  it("accepts only the exact previous or exact maintenance version", () => {
    expect(script).toContain('case "${before_version_id}" in');
    expect(script).toContain(
      '"${previous_version_id}"|"${maintenance_version_id}"',
    );
    expect(script).toContain(
      '"${previous_version}" "${database_id}" "${previous_version_id}"',
    );
    expect(script).toContain(
      '"${maintenance_version}" "${database_id}" "${maintenance_version_id}"',
    );
    expect(script).toContain('clean-d1-fence-${apply_run_id}');
  });

  it("always emits a newer maintenance deployment during recovery", () => {
    expect(script).toContain(
      'if [ "${before_version_id}" = "${previous_version_id}" ] || [ "${phase}" = recovery ]; then',
    );
    expect(script).toContain('must_deploy=true');
    expect(script).toContain(
      '.phase == "recovery" and .before_active_version_id == $maintenance_version_id',
    );
  });

  it("writes a mutation receipt before parsing or post-deploy proof", () => {
    const deploy = script.indexOf(
      'bunx wrangler versions deploy "${maintenance_version_id}@100%"',
    );
    const receipt = script.indexOf('> "${mutation_receipt}"', deploy);
    const parse = script.indexOf('wrangler-output.ts" version-deploy', deploy);
    const after = script.indexOf(
      'bunx wrangler deployments status --name intar-dev --json > "${after_deployment}"',
    );
    expect(deploy).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(deploy);
    expect(parse).toBeGreaterThan(receipt);
    expect(after).toBeGreaterThan(parse);
  });

  it("proves the exact marker, fence response, and bounded propagation", () => {
    expect(script).toContain(
      '[ "$(sha256sum "${attempt_marker}" | cut -d \' \' -f 1)" = "${expected_marker_sha256}" ]',
    );
    expect(script).toContain(".runId == $apply_run_id");
    expect(script).toContain(".databaseId == $database_id");
    expect(script).toContain('[ "${final_root_status}" = 503 ]');
    expect(script).toContain("--connect-timeout 2");
    expect(script).toContain(
      '--max-time "${propagation_request_timeout_seconds}"',
    );
    expect(script).toContain('test "${propagation_proven}" = true');
  });

  it("records that no database, routing, cron, or DO lifecycle was mutated", () => {
    expect(script).toContain("database_mutated: false");
    expect(script).toContain("routes_mutated: false");
    expect(script).toContain("crons_mutated: false");
    expect(script).toContain("durable_object_lifecycle_mutated: false");
  });
});
