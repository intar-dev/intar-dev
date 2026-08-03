import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("./resume-maintenance-fence.sh", import.meta.url)),
  "utf8",
);
const workflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/clean-d1-cutover.yml", import.meta.url),
  ),
  "utf8",
);

describe("same-revision maintenance-fence recovery", () => {
  test("permits only an exact 100 percent Worker-version deployment", () => {
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
  });

  test("binds the live marker, tag, and failed origin run to this cutover", () => {
    for (const check of [
      ".sourceSha == $source_sha",
      ".databaseId == $database_id",
      ".previousVersionId == $previous_version_id",
      ".runId != $current_run_id",
      ".runAttempt == 1",
      '.annotations["workers/tag"] == $tag',
      ".workflow_id == $workflow_id",
      '.head_branch == "main"',
      ".head_sha == $source_sha",
      '.status == "completed"',
      '(.conclusion | IN("failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"))',
    ]) {
      expect(script).toContain(check);
    }
  });

  test("proves the old D1 binding and structured deployment result", () => {
    expect(script).toMatch(
      /active-binding \\\n+\s+"\$\{before_deployment\}" "\$\{before_version\}" "\$\{database_id\}"/,
    );
    expect(script).toMatch(
      /version-binding \\\n+\s+"\$\{previous_version\}" "\$\{database_id\}" "\$\{previous_version_id\}"/,
    );
    expect(script).toMatch(
      /active-binding \\\n+\s+"\$\{after_deployment\}" "\$\{after_version\}" "\$\{database_id\}"/,
    );
    expect(script).toContain(
      'test "${observed_after_deployment_id}" = "${restore_deployment_id}"',
    );
    expect(script).toContain('WRANGLER_OUTPUT_FILE_PATH="${deploy_output}"');
    expect(script).toContain('wrangler-output.ts" version-deploy');
    expect(script).toContain("wrangler_version_deploy_ndjson:");
    expect(script).toContain('test "${before_version_id}" = "${previous_version_id}"');
  });

  test("retries the unchanged strict drain only after restoration", () => {
    const recovery = workflow.indexOf(
      "Recover an exact same-revision maintenance fence before draining",
    );
    const initialDrain = workflow.indexOf(
      "Prove the old control plane is initially drained",
    );
    expect(recovery).toBeGreaterThan(-1);
    expect(initialDrain).toBeGreaterThan(recovery);
    expect(workflow).toContain(
      'if [ "${{ steps.pre_drain_recovery.outputs.restored }}" = true ]; then',
    );
    expect(workflow).toContain(
      ".counts.untrustworthy_enabled_host_reports > 0",
    );
    expect(workflow).toContain(
      'if .key == "untrustworthy_enabled_host_reports"',
    );
    expect(workflow).toContain("else .value == 0");
    expect(workflow).toContain(
      "${{ runner.temp }}/intar-clean-d1-resume-${{ github.run_id }}/",
    );
    expect(workflow).toContain(
      'pre_drain_recovery: $pre_drain_recovery[0]',
    );
  });
});
