import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/oidc-secret-migration.yml"),
  "utf8",
);

describe("protected OIDC secret migration workflow", () => {
  it("allows only non-destructive standalone operations on protected main", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("- plan");
    expect(workflow).toContain("- backfill");
    expect(workflow).not.toContain("- cleanup");
    expect(workflow).not.toContain("- restore");
    expect(workflow).toContain('test "${GITHUB_REF}" = "refs/heads/main"');
    expect(workflow).toContain('test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"');
    expect(workflow).toContain('test "${RUN_ATTEMPT}" = "1"');
    expect(workflow).toContain("environment: production");
  });

  it("uses exact confirmations and retains only count evidence", () => {
    for (const confirmation of [
      "PLAN OIDC SECRET MIGRATION",
      "BACKFILL OIDC SECRET MIGRATION",
    ]) {
      expect(workflow).toContain(confirmation);
    }
    expect(workflow).not.toContain("CLEANUP OIDC SECRET MIGRATION");
    expect(workflow).toContain("--counts-output");
    expect(workflow).toContain("counts-only migration evidence");
    expect(workflow).toContain("OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1");
    expect(workflow).not.toContain("OIDC_SSO_SECRET_PHASE");
  });

  it("mirrors the reviewed and single-operator production approval policy", () => {
    for (const required of [
      "APPROVAL_MODE: ${{ vars.STARGATE_DEPLOY_APPROVAL_MODE }}",
      "SINGLE_OPERATOR_CONFIRMATION: ${{ inputs.single_operator_confirmation }}",
      ".can_admins_bypass == false",
      ".prevent_self_review == true",
      "SINGLE OPERATOR WORKSHOP CONTROL PLANE",
      'test "${GITHUB_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"',
      'test "${GITHUB_TRIGGERING_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"',
      'test "${remaining_seconds}" -le 604800',
      'test "${attestation_age}" -le 900',
      '$policies[0].name == "main"',
    ]) {
      expect(workflow).toContain(required);
    }
  });

  it("leaves plaintext cleanup coupled to exact Worker activation", () => {
    expect(workflow).not.toContain("inputs.operation == 'cleanup'");
    expect(workflow).not.toContain(
      "Require encrypted Worker activation before cleanup",
    );
    expect(workflow).not.toContain("--operation cleanup");
  });
});
