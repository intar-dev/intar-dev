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
  it("keeps the production Drizzle proof, migration, verification, and activation ordered", () => {
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
    const activation = deployWorkflow.indexOf(
      "Activate the exact immutable web version",
    );
    const oidcCleanup = deployWorkflow.indexOf(
      "Remove plaintext after encrypted OIDC activation",
    );

    expect(prefixProof).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(prefixProof);
    expect(fullProof).toBeGreaterThan(migrate);
    expect(oidcBackfill).toBeGreaterThan(fullProof);
    expect(activation).toBeGreaterThan(oidcBackfill);
    expect(oidcCleanup).toBeGreaterThan(activation);

    const prefixStep = deployWorkflow.slice(prefixProof, migrate);
    expect(prefixStep).toContain("tools/database/verify-generated-d1-schema.ts");
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

    const fullProofStep = deployWorkflow.slice(fullProof, activation);
    expect(fullProofStep).toContain("--expect full");
    expect(fullProofStep).toContain("exact_generated_schema_verified");
    expect(fullProofStep).toContain("PRAGMA foreign_key_check");
    expect(fullProofStep).toContain(
      "(.[0].results | sort_by(.type, .name, .table_name)) == $expected[0]",
    );

    const backfillStep = deployWorkflow.slice(oidcBackfill, activation);
    expect(backfillStep).toContain("oidc-secret-migration.ts");
    expect(backfillStep).toContain("--operation backfill");
    expect(backfillStep).toContain("BACKFILL OIDC SECRET MIGRATION");
    expect(backfillStep).toContain(
      "(.counts.dualWritten + .counts.ciphertextOnly) == .counts.scanned",
    );

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
    expect(activationStep).toMatch(/\n\s+open\n/u);

    const cleanupStep = deployWorkflow.slice(
      oidcCleanup,
      deployWorkflow.indexOf("Retain exact web-version activation attempt"),
    );
    expect(cleanupStep).toContain("oidc-secret-migration.ts");
    expect(cleanupStep).toContain("--operation cleanup");
    expect(cleanupStep).toContain("CLEANUP OIDC SECRET MIGRATION");
    expect(cleanupStep).toContain(".counts.plaintextPresent == 0");
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
      "${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-standard/",
    );
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
