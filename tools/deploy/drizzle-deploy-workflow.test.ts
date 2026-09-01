import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const deployWorkflow = read(".github/workflows/website-deploy.yml");
const validationWorkflow = read(".github/workflows/website.yml");
const providerRollout = read(".github/workflows/control-plane-rollout.yml");
const deployScript = read("tools/deploy/deploy-web.sh");

describe("automatic web deployment workflow", () => {
  it("runs one fixed lane automatically for web changes on main", () => {
    expect(validationWorkflow).toContain("push:");
    expect(validationWorkflow).toContain("branches:\n      - main");
    expect(validationWorkflow).toContain('      - "apps/web/**"');
    expect(validationWorkflow).toContain(
      '      - "!apps/web/workers/providers/**"',
    );
    expect(validationWorkflow).not.toContain("workflow_dispatch:");
    expect(validationWorkflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    expect(validationWorkflow).toContain("needs:\n      - validate\n      - ui");
    expect(validationWorkflow).toContain(
      "uses: ./.github/workflows/website-deploy.yml",
    );
    expect(validationWorkflow).toContain("secrets: inherit");
  });

  it("keeps only web checks and one Chromium smoke test", () => {
    expect(validationWorkflow).toContain("bun run check:imports");
    expect(validationWorkflow).toContain("bun run check:deploy");
    expect(validationWorkflow).toContain("bun run check:database-migrations");
    expect(validationWorkflow).toContain("bun run test");
    expect(validationWorkflow).toContain("bun run build");
    expect(validationWorkflow).toContain(
      "playwright test tests/ui/smoke.spec.ts --project=chromium-smoke",
    );
    expect(validationWorkflow).not.toContain("bun run test:ui\n");
    expect(validationWorkflow).not.toContain("check:providers");
    expect(validationWorkflow).not.toContain("workspace-agent:");
    expect(validationWorkflow).not.toContain("Build learner guest tools");
    expect(validationWorkflow).toContain("website-dist-${{ github.sha }}");
    expect(deployWorkflow).toContain("website-dist-${{ github.sha }}");
  });

  it("uses maintenance only when a generated D1 migration is pending", () => {
    const plan = deployWorkflow.indexOf("Plan production D1 migrations");
    const preMigrationEvidence = deployWorkflow.indexOf(
      "Capture pre-migration D1 evidence",
    );
    const maintenance = deployWorkflow.indexOf(
      "Enable maintenance for pending migrations",
    );
    const drain = deployWorkflow.indexOf("Drain and recheck maintenance");
    const migrate = deployWorkflow.indexOf("Apply pending D1 migrations");
    const verify = deployWorkflow.indexOf("Verify production D1 schema");
    const deploy = deployWorkflow.indexOf("Deploy production at 100 percent");

    expect(plan).toBeGreaterThan(-1);
    expect(preMigrationEvidence).toBeGreaterThan(plan);
    expect(maintenance).toBeGreaterThan(plan);
    expect(maintenance).toBeGreaterThan(preMigrationEvidence);
    expect(drain).toBeGreaterThan(maintenance);
    expect(migrate).toBeGreaterThan(drain);
    expect(verify).toBeGreaterThan(migrate);
    expect(deploy).toBeGreaterThan(verify);
    expect(deployWorkflow).toContain("--expect observed-ledger-prefix");
    expect(deployWorkflow).toContain(
      "if: steps.migrations.outputs.pending == 'true'",
    );
    expect(deployWorkflow).toContain("sleep 30");
    expect(deployWorkflow).toContain("bun run db:migrate:production");
    expect(deployWorkflow).toContain("--expect full");
    expect(deployWorkflow).not.toContain("wrangler d1 migrations");
  });

  it("retains and gates only the pre-migration D1 evidence", () => {
    for (const required of [
      "bunx --bun wrangler d1 info",
      '.result.version == "production"',
      "bunx --bun wrangler d1 time-travel info",
      "jq -cn --arg sql",
      "{sql: $sql, params: []}",
      "--request POST",
      'Content-Type: application/json',
      '--data-binary "@${query_request}"',
      '/d1/database/${DATABASE_ID}/query',
      ".result[0].success == true",
      '.result[0].results | type == "array"',
      "scenario_course_catalogs",
      "rev GLOB 'draft-*'",
      "host_desired_state",
      "hidden_at IS NULL AND",
      "active_key IS NOT NULL OR state NOT IN ('completed', 'failed')",
      "upload_status <> 'uploaded'",
      "GROUP BY organization_id, scenario_id",
      "pre-migration-enabled-scenarios.json",
    ]) {
      expect(deployWorkflow).toContain(required);
    }
    expect(deployWorkflow).not.toContain("wrangler d1 execute");
    const artifact = deployWorkflow.slice(
      deployWorkflow.indexOf("Retain deployment evidence"),
    );
    for (const evidence of [
      "production-d1-info.json",
      "production-d1-backend.json",
      "production-d1-bookmark.json",
      "pre-migration-scenario-course-catalogs.json",
      "pre-migration-draft-build-audit.json",
      "pre-migration-run-drain-audit.json",
      "pre-migration-assignment-counts.json",
      "pre-migration-enabled-scenarios.json",
    ]) {
      expect(artifact).toContain(evidence);
    }
    expect(deployWorkflow).not.toContain("scenario_sources");
  });

  it("deploys the complete configuration at 100 percent with no rollback", () => {
    expect(deployScript).toContain("bunx wrangler deploy");
    expect(deployScript).toContain("--strict");
    expect(deployScript).toContain("--experimental-provision=false");
    expect(deployScript).toContain("--autoconfig=false");
    expect(deployScript).not.toContain("wrangler versions upload");
    expect(deployScript).not.toContain("wrangler versions deploy");
    expect(deployScript).not.toMatch(/rollback|restore_previous/iu);
    expect(deployScript).toContain("exact_version_active: true");
    expect(deployScript).toContain("full_configuration_deployed: true");
  });

  it("proves the exact Worker, homepage, static asset, and health API", () => {
    expect(deployScript).toContain("tools/deploy/worker-version.ts");
    expect(deployScript).toContain("https://intar.dev/");
    expect(deployScript).toContain("https://intar.dev/favicon.svg");
    expect(deployScript).toContain("https://intar.dev/api/health");
    expect(deployScript).toContain("propagation_required_consecutive_healthy=5");
    expect(deployScript).toContain("live_health_proven: true");
  });

  it("has no manual web confirmation or unrelated production work", () => {
    for (const retired of [
      "DEPLOY WORKSHOP CONTROL PLANE",
      "OIDC CANARY PASSED",
      "oidc-secret-migration.ts",
      "Validate provider capability contract",
      "CLOUDFLARE_PROVIDER_PROBE_API_TOKEN",
      "Build pinned learner guest tools",
      "INTAR_IMAGE_PUBLISH_TOKEN",
      "bundle-images",
      "Queue the exact scenario source bundle",
    ]) {
      expect(deployWorkflow).not.toContain(retired);
    }
    expect(deployWorkflow).not.toContain("workflow_dispatch:");
    expect(deployWorkflow).toContain("environment:\n      name: production");
  });

  it("leaves provider deployment in its provider-only workflow", () => {
    expect(providerRollout).toContain("Multicloud provider rollout");
    expect(providerRollout).toContain("uses: ./.github/workflows/provider-workers.yml");
    expect(providerRollout).not.toContain("website-deploy.yml");
    expect(providerRollout).not.toContain("web_confirmation");
    expect(providerRollout).not.toContain("oidc_canary");
  });

  it("passes only web runtime secrets into the deployed Worker", () => {
    for (const required of [
      "ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET",
      "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1",
      "STARGATE_EGRESS_IPV4_CIDRS",
    ]) {
      expect(deployWorkflow).toContain(required);
    }
    expect(deployWorkflow).not.toContain("HETZNER_PROVIDER_CREDENTIAL_KEK_V1");
    expect(deployWorkflow).not.toContain("GCP_PROVIDER_CREDENTIAL_KEK_V1");
    expect(deployWorkflow).not.toContain("GCP_CATALOG_API_KEY");
    expect(deployWorkflow).toContain(
      '[[ "${ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1}" =~ ^[A-Za-z0-9_-]{43}$ ]]',
    );
    expect(deployWorkflow).toContain(
      'decoded.toString("base64url") !== value',
    );
  });
});

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}
