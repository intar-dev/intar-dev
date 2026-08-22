import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deployWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/website-deploy.yml"),
  "utf8",
);
const rolloutWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/control-plane-rollout.yml"),
  "utf8",
);
const validationWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/website.yml"),
  "utf8",
);

describe("Drizzle production deployment workflow", () => {
  it("fences OIDC writes before migration and opens only after a fresh ciphertext proof", () => {
    const maintenanceConfig = deployWorkflow.indexOf(
      "Prepare immutable maintenance-fence Worker configuration",
    );
    const currentWebMode = deployWorkflow.indexOf(
      "Derive active web mode for a safe maintenance rerun",
    );
    const maintenanceFreshness = deployWorkflow.indexOf(
      "Recheck sole-operator freshness before maintenance fence activation",
    );
    const maintenanceActivation = deployWorkflow.indexOf(
      "Activate exact immutable maintenance fence",
    );
    const maintenanceDrain = deployWorkflow.indexOf(
      "Drain old pre-fence requests before D1 and OIDC writes",
    );
    const maintenanceReproof = deployWorkflow.indexOf(
      "Reprove exact maintenance fence after old-request drain",
    );
    const prefixProof = deployWorkflow.indexOf(
      "Prove the production D1 is already Drizzle-managed",
    );
    const migrate = deployWorkflow.indexOf(
      "Apply the generated Drizzle migration stream to production D1",
    );
    const fullProof = deployWorkflow.indexOf(
      "Verify the exact Drizzle schema and migration ledger",
    );
    const oidcBackfill = deployWorkflow.indexOf(
      "Backfill OIDC ciphertext before encrypted Worker activation",
    );
    const preOpenReverify = deployWorkflow.indexOf(
      "Reverify fenced OIDC ciphertext immediately before opening",
    );
    const activation = deployWorkflow.indexOf(
      "Activate the exact immutable web version",
    );
    const canaryGate = deployWorkflow.indexOf(
      "Require completed OIDC canary before plaintext cleanup",
    );
    const cleanupFreshness = deployWorkflow.indexOf(
      "Recheck sole-operator freshness before plaintext cleanup",
    );
    const oidcCleanup = deployWorkflow.indexOf(
      "Remove plaintext after encrypted OIDC activation",
    );
    const cleanupProof = deployWorkflow.indexOf(
      "Verify OIDC plaintext cleanup",
    );
    const recovery = deployWorkflow.indexOf(
      "Recover original open Worker after failed encrypted OIDC activation",
    );

    expect(maintenanceConfig).toBeGreaterThan(-1);
    expect(currentWebMode).toBeGreaterThan(maintenanceConfig);
    expect(maintenanceFreshness).toBeGreaterThan(currentWebMode);
    expect(maintenanceActivation).toBeGreaterThan(maintenanceFreshness);
    expect(maintenanceDrain).toBeGreaterThan(maintenanceActivation);
    expect(maintenanceReproof).toBeGreaterThan(maintenanceDrain);
    expect(prefixProof).toBeGreaterThan(-1);
    expect(prefixProof).toBeGreaterThan(maintenanceReproof);
    expect(migrate).toBeGreaterThan(prefixProof);
    expect(fullProof).toBeGreaterThan(migrate);
    expect(oidcBackfill).toBeGreaterThan(fullProof);
    expect(preOpenReverify).toBeGreaterThan(oidcBackfill);
    expect(activation).toBeGreaterThan(preOpenReverify);
    expect(canaryGate).toBeGreaterThan(activation);
    expect(cleanupFreshness).toBeGreaterThan(canaryGate);
    expect(oidcCleanup).toBeGreaterThan(cleanupFreshness);
    expect(cleanupProof).toBeGreaterThan(oidcCleanup);
    expect(recovery).toBeGreaterThan(cleanupProof);

    const maintenanceConfigStep = deployWorkflow.slice(
      maintenanceConfig,
      currentWebMode,
    );
    expect(maintenanceConfigStep).toContain(
      '.vars.CONTROL_PLANE_MAINTENANCE = "on"',
    );
    expect(maintenanceConfigStep).toContain("MAINTENANCE_DEPLOYMENT_CONFIG");
    expect(maintenanceConfigStep).toContain(
      '.vars.CONTROL_PLANE_MAINTENANCE == "on"',
    );

    const currentWebModeStep = deployWorkflow.slice(
      currentWebMode,
      maintenanceActivation,
    );
    expect(currentWebModeStep).toContain(
      "bunx wrangler deployments status --name intar-dev --json",
    );
    expect(currentWebModeStep).toContain("bunx wrangler versions view");
    expect(currentWebModeStep).toContain("on) mode=maintenance");
    expect(currentWebModeStep).toContain("off) mode=open");
    expect(currentWebModeStep).toContain('>> "${GITHUB_OUTPUT}"');

    const maintenanceFreshnessStep = deployWorkflow.slice(
      maintenanceFreshness,
      maintenanceActivation,
    );
    expect(maintenanceFreshnessStep).toContain("reviewed) ;;");
    expect(maintenanceFreshnessStep).toContain("single-operator)");
    expect(maintenanceFreshnessStep).toContain(
      'expires_epoch="$(date -u -d "${SINGLE_OPERATOR_EXPIRES_AT}" +%s)"',
    );
    expect(maintenanceFreshnessStep).toContain(
      'attested_epoch="$(date -u -d "${SINGLE_OPERATOR_ADMIN_ATTESTED_AT}" +%s)"',
    );
    expect(maintenanceFreshnessStep).toContain(
      'test "${remaining_seconds}" -gt 0',
    );
    expect(maintenanceFreshnessStep).toContain(
      'test "${remaining_seconds}" -le 604800',
    );
    expect(maintenanceFreshnessStep).toContain(
      'test "${attestation_age}" -le 900',
    );
    expect(
      maintenanceFreshnessStep.slice(
        maintenanceFreshnessStep.indexOf("reviewed)"),
        maintenanceFreshnessStep.indexOf("single-operator)"),
      ),
    ).not.toContain("date -u");

    const maintenanceActivationStep = deployWorkflow.slice(
      maintenanceActivation,
      prefixProof,
    );
    expect(maintenanceActivationStep).toContain(
      "tools/deploy/activate-web-version.sh",
    );
    expect(maintenanceActivationStep).toContain(
      '"${MAINTENANCE_DEPLOYMENT_CONFIG}"',
    );
    expect(maintenanceActivationStep).toContain(
      "WEB_ACTIVATION_LABEL: maintenance",
    );
    expect(maintenanceActivationStep).toContain(
      '"${RUNNER_TEMP}/exact-web-version-activation-maintenance.json"',
    );
    expect(maintenanceActivationStep).toContain(
      "EXPECTED_CURRENT_MODE: ${{ steps.current_web_mode.outputs.mode }}",
    );
    expect(maintenanceActivationStep).toContain('"${EXPECTED_CURRENT_MODE}"');

    const drainStep = deployWorkflow.slice(
      maintenanceDrain,
      maintenanceReproof,
    );
    expect(drainStep).toContain(
      "old_oidc_registration_discovery_timeout_seconds=10",
    );
    expect(drainStep).toContain("old_request_drain_seconds=30");
    expect(drainStep).toContain('sleep "${old_request_drain_seconds}"');
    expect(drainStep).toContain("oidc-maintenance-fence-drain.json");
    expect(drainStep).toContain('operation: "drain-old-pre-fence-requests"');
    expect(drainStep).toContain(".elapsed_seconds >= .required_drain_seconds");
    expect(
      deployWorkflow
        .slice(maintenanceActivation, maintenanceDrain)
        .match(/^\s*- name:/gmu),
    ).toHaveLength(1);

    const maintenanceReproofStep = deployWorkflow.slice(
      maintenanceReproof,
      prefixProof,
    );
    expect(maintenanceReproofStep).toContain(
      "exact-web-version-activation-maintenance.json",
    );
    expect(maintenanceReproofStep).toContain(
      "oidc-maintenance-fence-post-drain-proof.json",
    );
    expect(maintenanceReproofStep).toContain(
      "bunx wrangler deployments status --name intar-dev --json",
    );
    expect(maintenanceReproofStep).toContain(".percentage == 100");
    expect(maintenanceReproofStep).toContain('.text == "on"');
    expect(maintenanceReproofStep).toContain(
      "exact_maintenance_version_active: true",
    );

    const prefixStep = deployWorkflow.slice(prefixProof, migrate);
    expect(prefixStep).toContain(
      "tools/database/verify-generated-d1-schema.ts",
    );
    expect(prefixStep).toContain("observed-ledger-prefix");
    expect(prefixStep).toContain("__drizzle_migrations");
    expect(prefixStep).toContain("d1_migrations");
    expect(prefixStep).toContain("pre_migration_snapshot_index");
    expect(prefixStep).toContain("PRAGMA foreign_key_check");
    expect(prefixStep).toContain(
      ".[0].results == $expected[0][0:(.[0].results | length)]",
    );

    const migrateStep = deployWorkflow.slice(migrate, fullProof);
    expect(migrateStep).toContain(
      "bunx drizzle-kit migrate --config drizzle.config.ts",
    );
    expect(migrateStep).toContain(
      'export CLOUDFLARE_DATABASE_ID="${DATABASE_ID}"',
    );

    const fullProofStep = deployWorkflow.slice(fullProof, preOpenReverify);
    expect(fullProofStep).toContain("--expect full");
    expect(fullProofStep).toContain("exact_generated_schema_verified");
    expect(fullProofStep).toContain("PRAGMA foreign_key_check");
    expect(fullProofStep).toContain(
      "(.[0].results | sort_by(.type, .name, .table_name)) == $expected[0]",
    );

    const backfillStep = deployWorkflow.slice(oidcBackfill, preOpenReverify);
    expect(backfillStep).toContain("oidc-secret-migration.ts");
    expect(backfillStep).toContain("--operation backfill");
    expect(backfillStep).toContain("BACKFILL OIDC SECRET MIGRATION");
    expect(backfillStep).toContain(
      "(.counts.dualWritten + .counts.ciphertextOnly) == .counts.scanned",
    );

    const preOpenStep = deployWorkflow.slice(preOpenReverify, activation);
    expect(preOpenStep).toContain("oidc-secret-migration.ts");
    expect(preOpenStep).toContain("--operation plan");
    expect(preOpenStep).toContain("PLAN OIDC SECRET MIGRATION");
    expect(preOpenStep).toContain('.status == "ready"');
    expect(preOpenStep).toContain(".counts.plaintextOnly == 0");
    expect(preOpenStep).toContain(".counts.ciphertextValid == .counts.scanned");
    expect(preOpenStep).toContain(
      "(.counts.dualWritten + .counts.ciphertextOnly) == .counts.scanned",
    );
    expect(preOpenStep.match(/^\s*- name:/gmu)).toHaveLength(1);

    const activationStep = deployWorkflow.slice(
      activation,
      deployWorkflow.indexOf("Remove ephemeral Worker activation secrets"),
    );
    expect(activationStep).toContain("tools/deploy/activate-web-version.sh");
    expect(activationStep).toContain('"${DEPLOYMENT_CONFIG}"');
    expect(activationStep.match(/"\$\{DATABASE_ID\}"/gu)).toHaveLength(2);
    expect(activationStep).toContain(
      '"${RUNNER_TEMP}/exact-web-version-activation-standard.json"',
    );
    expect(activationStep).toMatch(/\n\s+maintenance\n/u);

    const canaryGateStep = deployWorkflow.slice(canaryGate, oidcCleanup);
    expect(canaryGateStep).toContain(
      "steps.exact_web_activation.outcome == 'success'",
    );
    expect(canaryGateStep).toContain(
      "OIDC_CANARY_CONFIRMATION: ${{ inputs.oidc_canary_confirmation }}",
    );
    expect(canaryGateStep).toContain(
      "OIDC_CANARY_SOURCE_RUN_ID: ${{ inputs.oidc_canary_source_run_id }}",
    );
    expect(canaryGateStep).toContain("jq -er '.counts.scanned'");
    expect(canaryGateStep).toContain('if [ "${scanned}" -eq 0 ]; then');
    expect(canaryGateStep).toContain(
      '"${OIDC_CANARY_CONFIRMATION}" != "OIDC CANARY PASSED"',
    );
    expect(canaryGateStep).toContain(
      '[[ "${OIDC_CANARY_SOURCE_RUN_ID}" =~ ^[1-9][0-9]*$ ]]',
    );
    expect(canaryGateStep).toContain(
      'test "${OIDC_CANARY_SOURCE_RUN_ID}" -lt "${GITHUB_RUN_ID}"',
    );
    expect(canaryGateStep).toContain(
      "repos/${GITHUB_REPOSITORY}/actions/runs/${OIDC_CANARY_SOURCE_RUN_ID}",
    );
    expect(canaryGateStep).toContain('.event == "workflow_dispatch"');
    expect(canaryGateStep).toContain('.conclusion == "failure"');
    expect(canaryGateStep).toContain(".run_attempt == 1");
    expect(canaryGateStep).toContain(
      '--arg workflow_path "${PROVENANCE_WORKFLOW_PATH}"',
    );
    expect(canaryGateStep).toContain(
      'gh run download "${OIDC_CANARY_SOURCE_RUN_ID}"',
    );
    expect(canaryGateStep).toContain(
      "exact-web-version-attempt-${GITHUB_SHA}-${OIDC_CANARY_SOURCE_RUN_ID}",
    );
    expect(canaryGateStep).toContain(
      "exact-web-version-activation-standard.json",
    );
    expect(canaryGateStep).toContain("runtime_secret_binding_proven == true");
    expect(canaryGateStep).toContain(
      "exact-web-version-activation-maintenance.json",
    );
    expect(canaryGateStep).toContain('test "${source_uploaded_version_id}" =');
    expect(
      canaryGateStep.indexOf('[[ "${OIDC_CANARY_SOURCE_RUN_ID}"'),
    ).toBeGreaterThan(
      canaryGateStep.indexOf('if [ "${scanned}" -eq 0 ]; then'),
    );

    const cleanupFreshnessStep = deployWorkflow.slice(
      cleanupFreshness,
      oidcCleanup,
    );
    expect(cleanupFreshnessStep).toContain("reviewed) ;;");
    expect(cleanupFreshnessStep).toContain("single-operator)");
    expect(cleanupFreshnessStep).toContain(
      'expires_epoch="$(date -u -d "${SINGLE_OPERATOR_EXPIRES_AT}" +%s)"',
    );
    expect(cleanupFreshnessStep).toContain(
      'attested_epoch="$(date -u -d "${SINGLE_OPERATOR_ADMIN_ATTESTED_AT}" +%s)"',
    );
    expect(cleanupFreshnessStep).toContain('test "${remaining_seconds}" -gt 0');
    expect(cleanupFreshnessStep).toContain(
      'test "${remaining_seconds}" -le 604800',
    );
    expect(cleanupFreshnessStep).toContain('test "${attestation_age}" -le 900');
    expect(
      cleanupFreshnessStep.slice(
        cleanupFreshnessStep.indexOf("reviewed)"),
        cleanupFreshnessStep.indexOf("single-operator)"),
      ),
    ).not.toContain("date -u");

    const cleanupStep = deployWorkflow.slice(
      oidcCleanup,
      deployWorkflow.indexOf("Retain exact web-version activation attempt"),
    );
    expect(cleanupStep).toContain("oidc-secret-migration.ts");
    expect(cleanupStep).toContain("--operation cleanup");
    expect(cleanupStep).toContain("CLEANUP OIDC SECRET MIGRATION");
    expect(cleanupStep).toContain(".counts.plaintextPresent == 0");

    const recoveryStep = deployWorkflow.slice(
      recovery,
      deployWorkflow.indexOf("Retain counts-only OIDC cleanup evidence"),
    );
    expect(recoveryStep).toContain(
      "steps.maintenance_fence_activation.outcome == 'success'",
    );
    expect(recoveryStep).toContain(
      "steps.current_web_mode.outputs.mode == 'open'",
    );
    expect(recoveryStep).toContain(
      "steps.exact_web_activation.outcome != 'success'",
    );
    expect(recoveryStep).toContain("steps.oidc_cleanup.outcome == 'skipped'");
    expect(recoveryStep).toContain("before_version_id");
    expect(recoveryStep).toContain(
      'bunx wrangler versions deploy "${pre_fence_version_id}@100%"',
    );
    expect(recoveryStep).toContain(".versions[0].percentage == 100");
    expect(recoveryStep).toContain("root_status");
    expect(recoveryStep).toContain("root_open_health_proven: true");
    expect(recoveryStep).toContain("cleanup_started: false");
    expect(recoveryStep).not.toContain("oidc_config");
    expect(recoveryStep).not.toContain("oidc_client_secret");
  });

  it("uses one checked-in database identity and retains steady-state evidence", () => {
    expect(deployWorkflow).toContain(
      'config="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler.json"',
    );
    expect(deployWorkflow).toContain(
      "printf 'DATABASE_ID=%s\\n' \"${database_id}\"",
    );
    expect(deployWorkflow).toContain(
      "printf 'DATABASE_NAME=%s\\n' \"${database_name}\"",
    );
    expect(deployWorkflow).toContain(
      "printf 'DEPLOYMENT_CONFIG=%s\\n' \"${config}\"",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/production-d1-pre-migration-*.json",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/production-d1-generated-schema.json",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/exact-web-version-activation-standard.json",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/exact-web-version-activation-maintenance.json",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-standard/",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-maintenance/",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/oidc-secret-pre-open-counts.json",
    );
    expect(
      deployWorkflow.match(/^\s+oidc_canary_confirmation:/gmu),
    ).toHaveLength(2);
    expect(
      deployWorkflow.match(/^\s+oidc_canary_source_run_id:/gmu),
    ).toHaveLength(2);
    expect(deployWorkflow).toContain(".assets.run_worker_first == true");
    expect(deployWorkflow).not.toContain("wrangler d1 migrations");
  });

  it("contains no completed fresh-D1 cutover contract", () => {
    const workflows = `${deployWorkflow}\n${rolloutWorkflow}\n${validationWorkflow}`;
    for (const retired of [
      "fresh_d1_cutover",
      "CUT OVER FRESH DRIZZLE D1",
      "ARCHIVE SOURCE SNAPSHOT AND RESET CONTROL PLANE",
      "d1-rebaseline-prepare.yml",
      "Phase A -",
      "Phase B -",
      "Phase C -",
      "production-d1-copy",
      "production-d1-source-quiescence",
      "source_database_id",
      "target_database_id",
    ]) {
      expect(workflows).not.toContain(retired);
    }

    expect(rolloutWorkflow).toContain(
      "confirmation: ${{ inputs.web_confirmation }}",
    );
    expect(rolloutWorkflow).toContain(
      "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: ${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}",
    );
    expect(deployWorkflow).toContain(
      "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: ${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}",
    );
    expect(deployWorkflow).toContain(
      "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1: ${{ secrets.OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1 }}",
    );
    expect(rolloutWorkflow).toContain(
      "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1: ${{ secrets.OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1 }}",
    );
  });
});
