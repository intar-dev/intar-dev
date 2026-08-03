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
const localBaselineValidation = between(
  cleanD1Workflow,
  "- name: Validate the single clean baseline locally",
  "- name: Rehearse the clean bootstrap twice",
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
  it("imports the oversized baseline through the atomic file endpoint", () => {
    expect(localBaselineValidation).toContain("build-clean-d1-import.ts");
    for (const producer of [localBaselineValidation, applyProducer]) {
      expect(producer).toContain("d1 execute DB \\");
      expect(producer).toContain('--file "${baseline_import}"');
      expect(producer).not.toContain("d1 migrations apply");
    }
    expect(localBaselineValidation).toContain(
      'sha256sum "${baseline_import}"',
    );
    expect(applyProducer).toContain(
      'sha256sum --check "${RUNNER_TEMP}/clean-d1-baseline-import.sha256"',
    );
  });

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

  it("pins bounded restore propagation evidence in both consumers", () => {
    for (const consumer of [bootstrapConsumer, websiteConsumer]) {
      for (const requiredCheck of [
        ".pre_drain_recovery.restore_propagation.max_attempts == 12",
        ".pre_drain_recovery.restore_propagation.interval_seconds == 5",
        ".pre_drain_recovery.restore_propagation.request_timeout_seconds == 5",
        ".pre_drain_recovery.restore_propagation.required == false",
        ".pre_drain_recovery.restore_propagation.attempts == 0",
        ".pre_drain_recovery.restore_propagation.marker_clear_attempt == null",
        ".pre_drain_recovery.restore_propagation.root_healthy_attempt == null",
        ".pre_drain_recovery.restore_propagation.final_marker_http_status == null",
        ".pre_drain_recovery.restore_propagation.final_root_http_status == null",
        ".pre_drain_recovery.restore_propagation.proven == false",
        '.pre_drain_recovery.restore_propagation.attempts_ndjson == ""',
        ".pre_drain_recovery.restore_propagation.required == true",
        ".pre_drain_recovery.restore_propagation.attempts >= 1",
        ".pre_drain_recovery.restore_propagation.attempts <= .pre_drain_recovery.restore_propagation.max_attempts",
        ".pre_drain_recovery.restore_propagation.marker_clear_attempt >= 1",
        ".pre_drain_recovery.restore_propagation.marker_clear_attempt <= .pre_drain_recovery.restore_propagation.attempts",
        ".pre_drain_recovery.restore_propagation.root_healthy_attempt >= 1",
        ".pre_drain_recovery.restore_propagation.root_healthy_attempt <= .pre_drain_recovery.restore_propagation.attempts",
        '.pre_drain_recovery.restore_propagation.final_marker_http_status | test("^[234][0-9]{2}$")',
        '.pre_drain_recovery.restore_propagation.final_root_http_status == "200"',
        ".pre_drain_recovery.restore_propagation.proven == true",
        '.pre_drain_recovery.restore_propagation.attempts_ndjson | contains("\\"root_healthy\\":true")',
        '.pre_drain_recovery.restore_propagation.attempts_ndjson | contains("\\"marker_clear\\":true")',
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

  it("pins bounded maintenance activation propagation in both consumers", () => {
    for (const consumer of [bootstrapConsumer, websiteConsumer]) {
      for (const requiredCheck of [
        ".maintenance_fence.marker_probe_attempts >= 1",
        ".maintenance_fence.marker_probe_attempts <= .maintenance_fence.propagation_max_attempts",
        ".maintenance_fence.workshop_503_probe_attempts >= 1",
        ".maintenance_fence.workshop_503_probe_attempts <= .maintenance_fence.marker_probe_attempts",
        ".maintenance_fence.propagation_max_attempts == 12",
        ".maintenance_fence.propagation_retry_seconds == 2",
      ]) {
        expect(consumer).toContain(requiredCheck);
      }
    }
  });
});
