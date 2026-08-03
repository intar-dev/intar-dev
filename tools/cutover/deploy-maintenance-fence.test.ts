import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./deploy-maintenance-fence.sh", import.meta.url), "utf8");
const workflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/clean-d1-cutover.yml", import.meta.url),
  ),
  "utf8",
);

describe("maintenance fence deployment contract", () => {
  it("uploads without activation and deploys only the captured version", () => {
    expect(script).toMatch(/^\s*bunx wrangler versions upload \\/m);
    expect(script).toContain('WRANGLER_OUTPUT_FILE_PATH="${upload_output}"');
    expect(script).toContain('"${maintenance_version_id}@100%"');
    expect(script).toMatch(/^\s*bunx wrangler versions deploy \\/m);
    expect(script).toContain('WRANGLER_OUTPUT_FILE_PATH="${deploy_output}"');
    expect(script).not.toMatch(/^\s*bunx wrangler deploy(?:\s|\\)/m);
  });

  it("does not ask the version flow to mutate routes, triggers, or DO state", () => {
    expect(script).not.toContain('routes: [{pattern: "intar.dev"');
    expect(script).not.toContain("triggers: {crons:");
    expect(script).not.toContain("durable_objects:");
    expect(script).not.toContain("migrations:");
  });

  it("proves upload non-activation and the exact final deployment", () => {
    expect(script).toContain('test "${observed_after_upload_deployment_id}" = "${previous_deployment_id}"');
    expect(script).toContain('test "${observed_deployment_id}" = "${maintenance_deployment_id}"');
    expect(script).toContain('"${after_upload_deployment}" "${before_version}"');
    expect(script).toContain('"${after_deployment}" "${after_version}"');
  });

  it("emits schema-v2 evidence for fresh and reused fences", () => {
    expect(script).toContain("schema_version: 2");
    expect(script).toContain(".schema_version == 2");
    expect(script).toContain("maintenance_deployment_id:");
    expect(script).toContain("if .reused then");
    expect(script).toContain(".upload_did_not_activate == false");
    expect(script).toContain(".exact_version_deployed == false");
    expect(script).toContain(".upload_did_not_activate == true");
    expect(script).toContain(".exact_version_deployed == true");
    expect(script).toContain("wrangler_version_upload_ndjson:");
    expect(script).toContain("wrangler_version_deploy_ndjson:");
  });

  it("retains partial maintenance command evidence even when the apply fails", () => {
    const artifactStart = workflow.indexOf(
      "- name: Upload old-control-plane drain evidence",
    );
    const artifactEnd = workflow.indexOf(
      "- name: Create the clean D1 when absent",
      artifactStart,
    );
    expect(artifactStart).toBeGreaterThan(-1);
    expect(artifactEnd).toBeGreaterThan(artifactStart);
    const artifact = workflow.slice(artifactStart, artifactEnd);
    expect(artifact).toContain(
      "if: ${{ always() && inputs.operation == 'apply' }}",
    );
    expect(artifact).toContain(
      "${{ runner.temp }}/intar-clean-d1-maintenance-${{ github.run_id }}/",
    );
    expect(artifact).toContain(
      "${{ runner.temp }}/clean-d1-maintenance-fence.json",
    );
  });
});
