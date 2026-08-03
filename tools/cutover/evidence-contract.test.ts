import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cleanD1Workflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/clean-d1-cutover.yml", import.meta.url),
  ),
  "utf8",
);
const websiteDeployWorkflow = readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/website-deploy.yml", import.meta.url),
  ),
  "utf8",
);
const maintenanceFenceScript = readFileSync(
  fileURLToPath(new URL("./deploy-maintenance-fence.sh", import.meta.url)),
  "utf8",
);

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThan(-1);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return contents.slice(startIndex, endIndex);
}

const applyProducer = between(
  cleanD1Workflow,
  "- name: Apply or resume the exact baseline and owner commissioning",
  "- name: Upload apply evidence",
);
const bootstrapConsumer = between(
  cleanD1Workflow,
  "- name: Verify the successful apply run and immutable evidence",
  "- name: Promote the sole signed-in clean-database owner",
);
const websiteConsumer = between(
  websiteDeployWorkflow,
  "- name: Reprove the fenced legacy drain immediately before the first binding switch",
  "- name: Deploy",
);

describe("clean-D1 evidence contract", () => {
  it("pins apply schema v4 at its producer and both consumers", () => {
    expect(applyProducer).toContain(
      '{schema_version: 4, operation: "apply"',
    );
    expect(bootstrapConsumer).toContain(".schema_version == 4");
    expect(websiteConsumer).toContain(".schema_version == 4");
    expect(applyProducer).not.toContain(
      '{schema_version: 3, operation: "apply"',
    );
    expect(bootstrapConsumer).not.toContain(".schema_version == 3");
    expect(websiteConsumer).not.toContain(".schema_version == 3");
  });

  it("pins maintenance-fence schema v2 at its producer and both consumers", () => {
    expect(maintenanceFenceScript).toContain("schema_version: 2");
    expect(maintenanceFenceScript).toContain(".schema_version == 2");
    expect(bootstrapConsumer).toContain(
      ".maintenance_fence.schema_version == 2",
    );
    expect(websiteConsumer).toContain(
      ".maintenance_fence.schema_version == 2",
    );
  });

  it("requires recovery provenance in both immutable-evidence consumers", () => {
    expect(applyProducer).toContain(
      '--slurpfile pre_drain_recovery "${RUNNER_TEMP}/clean-d1-pre-drain-recovery.json"',
    );
    expect(applyProducer).toContain(
      "pre_drain_recovery: $pre_drain_recovery[0]",
    );

    for (const consumer of [bootstrapConsumer, websiteConsumer]) {
      for (const requiredCheck of [
        '.pre_drain_recovery.operation == "resume-maintenance-fence"',
        ".pre_drain_recovery.source_sha == .source_sha",
        ".pre_drain_recovery.run_id == .apply_run_id",
        ".pre_drain_recovery.run_attempt == 1",
        ".pre_drain_recovery.database_name == .previous_database_name",
        ".pre_drain_recovery.database_id == .previous_database_id",
        ".pre_drain_recovery.expected_previous_version_id == .previous_web_version_id",
        ".pre_drain_recovery.restore_deployment_id",
        ".pre_drain_recovery.active_fence_tag_proven == true",
        ".pre_drain_recovery.wrangler_version_deploy_ndjson",
      ]) {
        expect(consumer).toContain(requiredCheck);
      }
    }
  });

  it("requires exact maintenance upload and deployment evidence in both consumers", () => {
    for (const consumer of [bootstrapConsumer, websiteConsumer]) {
      for (const requiredCheck of [
        ".maintenance_fence.maintenance_deployment_id",
        ".maintenance_fence.upload_did_not_activate",
        ".maintenance_fence.exact_version_deployed",
        ".maintenance_fence.wrangler_version_upload_ndjson",
        ".maintenance_fence.wrangler_version_deploy_ndjson",
      ]) {
        expect(consumer).toContain(requiredCheck);
      }
      expect(consumer).toContain(".maintenance_fence.reused == true");
      expect(consumer).toContain(".maintenance_fence.reused == false");
    }
  });
});
