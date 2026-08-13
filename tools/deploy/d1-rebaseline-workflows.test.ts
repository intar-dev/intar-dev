import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const prepareWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/d1-rebaseline-prepare.yml"),
  "utf8",
);
const deployWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/website-deploy.yml"),
  "utf8",
);
const rolloutWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/control-plane-rollout.yml"),
  "utf8",
);

describe("fresh production D1 workflows", () => {
  it("prepares one new EU D1 from exact main without deploying or deleting", () => {
    expect(prepareWorkflow).toContain('test "${GITHUB_REF}" = refs/heads/main');
    expect(prepareWorkflow).toContain(
      'test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"',
    );
    expect(prepareWorkflow).toContain(
      'test "${CONFIRMATION}" = "PREPARE FRESH DRIZZLE D1"',
    );
    expect(prepareWorkflow).toContain('test "${RUN_ATTEMPT}" = 1');
    expect(prepareWorkflow).toContain("STARGATE_SINGLE_OPERATOR_ADMIN_ATTESTED_AT");
    expect(prepareWorkflow).toContain(
      'bunx wrangler d1 create "${TARGET_DATABASE_NAME}"',
    );
    expect(prepareWorkflow).toContain("--jurisdiction eu");
    expect(prepareWorkflow).toContain("--no-update-config");
    expect(prepareWorkflow).toContain("git diff --exit-code -- wrangler.jsonc");
    expect(prepareWorkflow).toContain("bunx drizzle-kit migrate --config drizzle.config.ts");
    expect(prepareWorkflow).not.toContain("wrangler d1 migrations");
    expect(prepareWorkflow).not.toMatch(/wrangler d1 delete|wrangler delete/);
    expect(prepareWorkflow).not.toMatch(/wrangler (?:versions )?deploy/);
    expect(prepareWorkflow).toContain("worker_binding_mutated: false");
    expect(prepareWorkflow).toContain("source_database_deleted: false");
    expect(prepareWorkflow).toContain("target_database_deleted: false");
  });

  it("verifies exact Drizzle state and empirical REST batch rollback", () => {
    expect(prepareWorkflow).toContain("migrations/meta/_journal.json");
    expect(prepareWorkflow).toContain("sha256sum \"migrations/${tag}.sql\"");
    expect(prepareWorkflow).toContain("__drizzle_migrations");
    expect(prepareWorkflow).toContain("final_snapshot_path");
    expect(prepareWorkflow).toContain("sqlite_schema");
    expect(prepareWorkflow).toContain(
      '.type == "trigger" or .type == "view"',
    );
    expect(prepareWorkflow).toContain("PRAGMA foreign_key_check");
    expect(prepareWorkflow).toContain(
      "bun tools/deploy/probe-d1-batch-rollback.ts",
    );
    expect(prepareWorkflow).toContain(
      "tools/database/verify-generated-d1-schema.ts",
    );
    expect(prepareWorkflow).toContain("exact_generated_schema_verified");
    expect(prepareWorkflow).toContain("batchRequestRejected == true");
    expect(prepareWorkflow).toContain("applicationRowsBefore == 0");
    expect(prepareWorkflow).toContain("applicationRowsAfter == 0");
    expect(prepareWorkflow).toContain("retention-days: 90");
  });

  it("exports generated Worker configs as absolute workspace paths", () => {
    expect(deployWorkflow).toContain(
      'source_maintenance_config="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler-source-maintenance.json"',
    );
    expect(deployWorkflow).toContain(
      'target_maintenance_config="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler-target-maintenance.json"',
    );
    expect(deployWorkflow).toContain(
      'target_open_config="${GITHUB_WORKSPACE}/apps/web/dist/server/wrangler-target-open.json"',
    );
    expect(deployWorkflow).not.toMatch(
      /(?:source_maintenance|target_maintenance|target_open)_config="dist\/server\//u,
    );
  });

  it("orders one protected cutover source fence, copy, target fence, then open", () => {
    const sourceFence = deployWorkflow.indexOf(
      "Phase A - fence the source D1 behind maintenance",
    );
    const capabilityPreflight = deployWorkflow.indexOf(
      "Preflight source capability quiescence",
    );
    const capabilityRetirement = deployWorkflow.indexOf(
      "Retire source capabilities under maintenance",
    );
    const postQuiescenceBookmark = deployWorkflow.indexOf(
      "Capture the post-quiescence source bookmark",
    );
    const copyDryRun = deployWorkflow.indexOf(
      "Dry-run the allowlisted production D1 copy",
    );
    const copy = deployWorkflow.indexOf(
      "Copy the allowlisted durable production data",
    );
    const targetFence = deployWorkflow.indexOf(
      "Phase B - switch to the target D1 under maintenance",
    );
    const verify = deployWorkflow.indexOf(
      "Verify the copied target while traffic remains fenced",
    );
    const open = deployWorkflow.indexOf(
      "Phase C - open the verified target D1",
    );
    const sourceUnchanged = deployWorkflow.indexOf(
      "Prove the source stayed unchanged after Phase B",
    );
    const stableBookmark = deployWorkflow.indexOf(
      "Reconfirm the source Time Travel bookmark before Phase C",
    );
    expect(capabilityPreflight).toBeGreaterThan(-1);
    expect(capabilityPreflight).toBeLessThan(sourceFence);
    expect(sourceFence).toBeGreaterThan(-1);
    expect(capabilityRetirement).toBeGreaterThan(sourceFence);
    expect(postQuiescenceBookmark).toBeGreaterThan(capabilityRetirement);
    expect(copyDryRun).toBeGreaterThan(postQuiescenceBookmark);
    expect(copy).toBeGreaterThan(copyDryRun);
    expect(copy).toBeGreaterThan(sourceFence);
    expect(targetFence).toBeGreaterThan(copy);
    expect(verify).toBeGreaterThan(targetFence);
    expect(open).toBeGreaterThan(verify);
    expect(sourceUnchanged).toBeGreaterThan(verify);
    expect(stableBookmark).toBeGreaterThan(sourceUnchanged);
    expect(open).toBeGreaterThan(stableBookmark);

    expect(deployWorkflow).toContain(
      '--source-database-id "${SOURCE_DATABASE_ID}"',
    );
    expect(deployWorkflow).toContain(
      '--target-database-id "${TARGET_DATABASE_ID}"',
    );
    expect(deployWorkflow).toContain("--dry-run");
    expect(deployWorkflow).toContain("--apply");
    expect(deployWorkflow).toContain(
      "bun tools/database/quiesce-production-d1-source.ts",
    );
    expect(deployWorkflow).toContain("QUIESCE SOURCE CAPABILITIES");
    expect(deployWorkflow).toContain(
      "production-d1-source-quiescence.json",
    );
    expect(deployWorkflow).toContain("source_database_retained: true");
    expect(deployWorkflow).toContain("source_database_deleted: false");
    expect(deployWorkflow).not.toMatch(/wrangler d1 delete|wrangler delete/);
    const bookmark = deployWorkflow.indexOf(
      "Capture the source D1 Time Travel bookmark",
    );
    expect(bookmark).toBeGreaterThan(-1);
    expect(bookmark).toBeLessThan(sourceFence);
    const bookmarkStep = deployWorkflow.slice(bookmark, sourceFence);
    expect(bookmarkStep).toContain("wrangler d1 time-travel info");
    expect(bookmarkStep).toContain('--config "${SOURCE_MAINTENANCE_CONFIG}"');
    expect(bookmarkStep).toContain("restore_attempted: false");
    expect(bookmarkStep).not.toContain("time-travel restore");
    expect(deployWorkflow).toContain(
      '--slurpfile source_time_travel',
    );
    expect(deployWorkflow).toContain(
      "source_time_travel: $source_time_travel[0]",
    );
    const sourceVerificationStep = deployWorkflow.slice(
      sourceUnchanged,
      stableBookmark,
    );
    expect(sourceVerificationStep).toContain("--verify-source-unchanged");
    expect(sourceVerificationStep).toContain(
      '--copy-evidence "${RUNNER_TEMP}/production-d1-copy.json"',
    );
    expect(sourceVerificationStep).toContain(
      ".sourceAllObserved == .sourceAllExpected",
    );
    const stableBookmarkStep = deployWorkflow.slice(stableBookmark, open);
    expect(stableBookmarkStep).toContain("wrangler d1 time-travel info");
    expect(stableBookmarkStep).toContain(
      "source-d1-time-travel-post-quiescence-raw.json",
    );
    expect(stableBookmarkStep).toContain(
      ".before_bookmark == .after_bookmark",
    );
    expect(deployWorkflow).toContain(
      "${{ runner.temp }}/production-d1-source-after-phase-b.json",
    );

    const phaseA = deployWorkflow.slice(sourceFence, capabilityRetirement);
    expect(phaseA.match(/"\$\{SOURCE_DATABASE_ID\}"/g)).toHaveLength(2);
    expect(phaseA).not.toContain('"${TARGET_DATABASE_ID}"');
    expect(phaseA).toMatch(
      /exact-web-version-activation-source-maintenance\.json" \\\n+\s+open/u,
    );

    const sourceQuiescence = deployWorkflow.slice(
      capabilityRetirement,
      postQuiescenceBookmark,
    );
    expect(sourceQuiescence).toContain(
      '--source-database-id "${SOURCE_DATABASE_ID}"',
    );
    expect(sourceQuiescence).toContain(
      '--confirm-source-database-id "${SOURCE_DATABASE_ID}"',
    );
    expect(sourceQuiescence).not.toContain('"${TARGET_DATABASE_ID}"');

    const phaseB = deployWorkflow.slice(targetFence, verify);
    expect(phaseB).toContain('"${SOURCE_DATABASE_ID}"');
    expect(phaseB).toContain('"${TARGET_DATABASE_ID}"');
    expect(phaseB).toMatch(
      /exact-web-version-activation-target-maintenance\.json" \\\n+\s+maintenance/u,
    );

    const phaseC = deployWorkflow.slice(open);
    expect(
      phaseC.match(/"\$\{TARGET_DATABASE_ID\}"/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(phaseC).toMatch(
      /exact-web-version-activation-target-open\.json" \\\n+\s+maintenance/u,
    );
  });

  it("uses Drizzle for schema mutation and forwards the protected contract", () => {
    const managedGate = deployWorkflow.indexOf(
      "Prove the standard target is already Drizzle-managed",
    );
    const migrate = deployWorkflow.indexOf(
      "Apply the generated Drizzle migration stream to the target D1",
    );
    expect(managedGate).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(managedGate);
    const gate = deployWorkflow.slice(managedGate, migrate);
    expect(gate).toContain("__drizzle_migrations");
    expect(gate).toContain("d1_migrations");
    expect(gate).toContain("(.[0].results | length) > 0");
    expect(gate).toContain(
      ".[0].results == $expected[0][0:(.[0].results | length)]",
    );
    expect(gate).toContain("pre_migration_snapshot_index");
    expect(gate).toContain("production-d1-pre-migration-expected-manifest.json");
    expect(gate).toContain("PRAGMA foreign_key_check");
    expect(gate).toContain(
      "(.[0].results | sort_by(.type, .name, .table_name)) == $expected[0]",
    );
    expect(deployWorkflow).toMatch(
      /name: Verify the exact Drizzle schema and migration ledger\n\s+if: \$\{\{ !inputs\.fresh_d1_cutover \}\}/u,
    );
    expect(gate).toContain("tools/database/verify-generated-d1-schema.ts");
    expect(gate).toContain("observed-ledger-prefix");
    expect(deployWorkflow).toContain("exact_generated_schema_verified");
    expect(deployWorkflow).toContain(
      "bunx drizzle-kit migrate --config drizzle.config.ts",
    );
    expect(deployWorkflow).not.toContain("wrangler d1 migrations");
    expect(deployWorkflow).toContain("__drizzle_migrations");
    expect(deployWorkflow).toContain("PRAGMA foreign_key_check");
    expect(deployWorkflow).toContain("CUT OVER FRESH DRIZZLE D1");
    expect(deployWorkflow).toContain(
      "ARCHIVE SOURCE SNAPSHOT AND RESET CONTROL PLANE",
    );
    expect(rolloutWorkflow).toContain(
      "fresh_d1_cutover: ${{ inputs.fresh_d1_cutover }}",
    );
    expect(rolloutWorkflow).toContain(
      "source_snapshot_reset_confirmation: ${{ inputs.source_snapshot_reset_confirmation }}",
    );
    expect(rolloutWorkflow).toContain(
      "BETA_MAINTENANCE_BYPASS_SECRET: ${{ secrets.BETA_MAINTENANCE_BYPASS_SECRET }}",
    );
  });
});
