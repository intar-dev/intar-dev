import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/clean-d1-cutover.yml", import.meta.url),
  ),
  "utf8",
);

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  expect(startIndex).toBeGreaterThan(-1);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

const rollback = between(
  workflow,
  "- name: Verify the rollback unit",
  "- name: Retain rollback activation evidence",
);

describe("exact-version clean-D1 rollback", () => {
  it("deploys only the approved version at 100 percent", () => {
    expect(rollback).toContain(
      'bunx wrangler versions deploy "${PREVIOUS_WEB_VERSION_ID}@100%"',
    );
    expect(rollback).toContain(
      'WRANGLER_OUTPUT_FILE_PATH="${deploy_output}"',
    );
    expect(rollback).toContain(
      "tools/cutover/wrangler-output.ts version-deploy",
    );
    expect(rollback).not.toMatch(/bunx wrangler rollback\b/);
    expect(rollback).not.toMatch(/bunx wrangler deploy\b/);
  });

  it("proves the captured deployment and previous D1 binding", () => {
    expect(rollback).toContain(
      'test "$(jq -er \'.id\' "${deployment}")" = "${restore_deployment_id}"',
    );
    expect(rollback).toContain(
      '"${deployment}" "${version}" "${PREVIOUS_DATABASE_ID}"',
    );
    expect(rollback).toContain('"${PREVIOUS_WEB_VERSION_ID}" > "${binding}"');
    expect(rollback).toContain("exact_binding_proven: true");
    expect(rollback).toContain("exact_version_deployed: true");
  });

  it("waits boundedly for fence clearance and root health", () => {
    expect(rollback).toContain(
      "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do",
    );
    expect(rollback.match(/--connect-timeout 2 --max-time 5/g)).toHaveLength(2);
    expect(rollback).toContain("https://intar.dev/.well-known/intar-clean-d1-cutover-fence");
    expect(rollback).toContain("https://intar.dev/");
    expect(rollback).toContain(
      'if [ "${marker_clear}" = true ] && [ "${root_healthy}" = true ]; then',
    );
    expect(rollback).toContain('test "${propagation_proven}" = true');
    expect(rollback).toContain("public_propagation: {");
    expect(rollback).toContain(".public_propagation.proven == true");
  });

  it("records that bindings, routes, crons, and DO lifecycle were untouched", () => {
    expect(rollback).toContain("database_mutated: false");
    expect(rollback).toContain("routes_mutated: false");
    expect(rollback).toContain("crons_mutated: false");
    expect(rollback).toContain("durable_object_lifecycle_mutated: false");
    expect(rollback).not.toMatch(/(?:routes?|crons?) (?:delete|deploy|put)/i);
  });

  it("retains mutation and partial proof evidence even when a later check fails", () => {
    const deploy = rollback.indexOf(
      'bunx wrangler versions deploy "${PREVIOUS_WEB_VERSION_ID}@100%"',
    );
    const partialEvidence = rollback.indexOf(
      '${RUNNER_TEMP}/clean-d1-rollback-mutation.json',
    );
    expect(deploy).toBeGreaterThan(-1);
    expect(partialEvidence).toBeGreaterThan(deploy);
    expect(rollback).toContain('operation: "rollback-version-deploy"');

    const artifact = workflow.slice(
      workflow.indexOf("- name: Retain rollback activation evidence"),
    );
    expect(artifact).toContain(
      "if: ${{ always() && inputs.operation == 'rollback' }}",
    );
    for (const retained of [
      "clean-d1-rollback.json",
      "clean-d1-rollback-mutation.json",
      "web-rollback-version-deploy.ndjson",
      "web-rollback-version-deploy.json",
      "web-rollback-deployment.json",
      "web-rollback-active-version.json",
      "web-rollback-binding.json",
      "web-rollback-propagation.ndjson",
      "web-rollback-marker-*.headers",
      "web-rollback-root-*.headers",
    ]) {
      expect(artifact).toContain(retained);
    }
  });
});
