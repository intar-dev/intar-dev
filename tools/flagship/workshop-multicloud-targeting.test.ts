import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FLAGSHIP_APP_ID,
  WORKSHOP_MULTICLOUD_FLAG_KEY,
  canonicalSha256,
  planWorkshopMulticloudTargeting,
  verifyCurrentEvaluations,
  verifyFinalEvaluations,
} from "./workshop-multicloud-targeting";

const organizationId = "utvigi3pzkihhg7dtj50ue82";

describe("Workshop multicloud Flagship targeting", () => {
  test("plans an exact organization-only rule without changing the false default", () => {
    expect(
      planWorkshopMulticloudTargeting("plan", organizationId, flag()),
    ).toMatchObject({
      schemaVersion: 1,
      provider: "cloudflare_flagship",
      appId: FLAGSHIP_APP_ID,
      flagKey: WORKSHOP_MULTICLOUD_FLAG_KEY,
      organizationId,
      operation: "plan",
      action: "enable_and_add_rule",
      trueVariation: "on",
      falseVariation: "off",
      defaultVariation: "off",
      enabled: false,
      ruleCount: 0,
      targetRulePriority: null,
      desiredRule: exactRule(),
    });
  });

  test("computes every idempotent apply and remove transition", () => {
    expect(
      planWorkshopMulticloudTargeting("apply", organizationId, flag({ enabled: true })),
    ).toMatchObject({ action: "add_rule" });
    expect(
      planWorkshopMulticloudTargeting(
        "apply",
        organizationId,
        flag({ rules: [exactRule()] }),
      ),
    ).toMatchObject({ action: "enable", targetRulePriority: 1 });
    expect(
      planWorkshopMulticloudTargeting(
        "apply",
        organizationId,
        flag({ enabled: true, rules: [exactRule()] }),
      ),
    ).toMatchObject({ action: "none", targetRulePriority: 1 });
    expect(
      planWorkshopMulticloudTargeting(
        "remove",
        organizationId,
        flag({ enabled: true, rules: [exactRule(7)] }),
      ),
    ).toMatchObject({ action: "remove_rule", targetRulePriority: 7 });
    expect(
      planWorkshopMulticloudTargeting(
        "remove",
        organizationId,
        flag({ enabled: true }),
      ),
    ).toMatchObject({ action: "none", targetRulePriority: null });
  });

  test("rejects global exposure, another organization, rollouts, and broad rules", () => {
    const driftedRules = [
      {
        ...exactRule(),
        conditions: [],
      },
      {
        ...exactRule(),
        conditions: [
          {
            attribute: "organizationId",
            operator: "equals",
            value: "aaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      },
      {
        ...exactRule(),
        rollout: { percentage: 100, attribute: "targetingKey" },
      },
      {
        ...exactRule(),
        conditions: [
          {
            attribute: "targetingKey",
            operator: "equals",
            value: organizationId,
          },
        ],
      },
    ];
    for (const rule of driftedRules) {
      expect(() =>
        planWorkshopMulticloudTargeting(
          "apply",
          organizationId,
          flag({ rules: [rule] }),
        ),
      ).toThrow(/Flagship drift/);
    }
    expect(() =>
      planWorkshopMulticloudTargeting(
        "apply",
        organizationId,
        flag({ rules: [exactRule(), exactRule(2)] }),
      ),
    ).toThrow(/only the exact pilot rule/);
  });

  test("rejects malformed identifiers and incompatible flag definitions", () => {
    for (const id of [
      "",
      "org-a",
      "UTVIGI3PZKIHHG7DTJ50UE82",
      "utvigi3pzkihhg7dtj50ue8_",
      "a".repeat(23),
      "a".repeat(25),
    ]) {
      expect(() =>
        planWorkshopMulticloudTargeting("apply", id, flag()),
      ).toThrow(/organization ID/);
    }
    expect(() =>
      planWorkshopMulticloudTargeting("apply", organizationId, {
        ...flag(),
        key: "workshops_enabled",
      }),
    ).toThrow(/unexpected flag key/);
    expect(() =>
      planWorkshopMulticloudTargeting(
        "apply",
        organizationId,
        flag({ default_variation: "on" }),
      ),
    ).toThrow(/default variation must be boolean false/);
    expect(() =>
      planWorkshopMulticloudTargeting("apply", organizationId, {
        ...flag(),
        variations: { on: true, yes: true, off: false },
      }),
    ).toThrow(/exactly one true and one false/);
    expect(() =>
      planWorkshopMulticloudTargeting("apply", organizationId, {
        ...flag(),
        type: "string",
      }),
    ).toThrow(/flag type must be boolean/);
    const { type: _missingType, ...missingType } = flag();
    expect(() =>
      planWorkshopMulticloudTargeting("apply", organizationId, missingType),
    ).toThrow(/unexpected top-level flag response fields/);
    expect(() =>
      planWorkshopMulticloudTargeting("apply", organizationId, {
        ...flag(),
        future_global_targeting: { enabled: true },
      }),
    ).toThrow(/unexpected top-level flag response fields/);
  });

  test("verifies current target and non-target evaluations against the plan", () => {
    const disabledPlan = planWorkshopMulticloudTargeting(
      "plan",
      organizationId,
      flag(),
    );
    expect(
      verifyCurrentEvaluations(
        disabledPlan,
        evaluation(false, "off", "DISABLED"),
        evaluation(false, "off", "DISABLED"),
      ),
    ).toMatchObject({ phase: "before", target: { value: false }, verified: true });

    const enabledPlan = planWorkshopMulticloudTargeting(
      "apply",
      organizationId,
      flag({ enabled: true, rules: [exactRule()] }),
    );
    expect(
      verifyCurrentEvaluations(
        enabledPlan,
        evaluation(true, "on", "TARGETING_MATCH"),
        evaluation(false, "off", "DEFAULT"),
      ),
    ).toMatchObject({
      phase: "before",
      target: { value: true, variant: "on" },
      control: { value: false, variant: "off" },
      verified: true,
    });

    expect(() =>
      verifyCurrentEvaluations(
        enabledPlan,
        evaluation(true, "on", "TARGETING_MATCH"),
        evaluation(true, "on", "TARGETING_MATCH"),
      ),
    ).toThrow(/control evaluation did not fail closed/);
  });

  test("verifies exact final apply and remove state", () => {
    expect(
      verifyFinalEvaluations(
        "apply",
        organizationId,
        flag({ enabled: true, rules: [exactRule()] }),
        evaluation(true, "on", "TARGETING_MATCH"),
        evaluation(false, "off", "DEFAULT"),
      ),
    ).toMatchObject({ phase: "after", operation: "apply", verified: true });
    expect(
      verifyFinalEvaluations(
        "remove",
        organizationId,
        flag({ enabled: true }),
        evaluation(false, "off", "DEFAULT"),
        evaluation(false, "off", "DEFAULT"),
      ),
    ).toMatchObject({ phase: "after", operation: "remove", verified: true });
    expect(() =>
      verifyFinalEvaluations(
        "apply",
        organizationId,
        flag({ enabled: true }),
        evaluation(false, "off", "DEFAULT"),
        evaluation(false, "off", "DEFAULT"),
      ),
    ).toThrow(/exact organization targeting is not active/);
    expect(() =>
      verifyFinalEvaluations(
        "remove",
        organizationId,
        flag({ enabled: true, rules: [exactRule()] }),
        evaluation(true, "on", "TARGETING_MATCH"),
        evaluation(false, "off", "DEFAULT"),
      ),
    ).toThrow(/organization targeting remains/);
  });

  test("hashes canonical JSON and detects any observed-state change", () => {
    const first = flag({ updated_at: "2026-08-03T12:00:00Z" });
    const reordered = {
      updated_by: "operator@example.com",
      updated_at: "2026-08-03T12:00:00Z",
      type: "boolean",
      rules: [],
      variations: { off: false, on: true },
      key: WORKSHOP_MULTICLOUD_FLAG_KEY,
      enabled: false,
      description: "Provider-backed Workshop issuance",
      default_variation: "off",
    };
    expect(canonicalSha256(first)).toBe(canonicalSha256(reordered));
    expect(
      canonicalSha256({ ...first, updated_at: "2026-08-03T12:00:01Z" }),
    ).not.toBe(canonicalSha256(first));
  });

  test("keeps production mutation inside the dedicated protected workflow", () => {
    const workflow = readFileSync(
      resolve(
        import.meta.dir,
        "../../.github/workflows/workshop-multicloud-flag.yml",
      ),
      "utf8",
    );
    for (const required of [
      "workflow_dispatch:",
      "group: intar-control-plane-production",
      "environment: production",
      "CLOUDFLARE_FLAGSHIP_API_TOKEN",
      "Flagship Read, Flagship Evaluate, and Flagship Write only",
      "EXPECTED_CURRENT_SHA256",
      "SINGLE_OPERATOR_ADMIN_ATTESTED_AT",
      "Reauthorize immediately before Flagship mutation",
      "test \"${GITHUB_REF}\" = refs/heads/main",
      "test \"${GITHUB_RUN_ATTEMPT}\" = 1",
      "--rule-json",
      "--clear-rules",
      "--default-variation",
      "FLAGSHIP_RECONCILIATION_REQUIRED",
      "recovered_fail_closed",
      "Enforce exact final Flagship outcome",
      "before-target-evaluation.json",
      "after-control-evaluation.json",
      "sha256sum --check --strict SHA256SUMS",
    ]) {
      expect(workflow).toContain(required);
    }
    expect(workflow).not.toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("--add-rule-json");
    expect(workflow).not.toContain("flags rules delete");
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).not.toContain("--config apps/web/wrangler.jsonc");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("push:");
    expect(
      workflow.indexOf("FLAGSHIP_RECONCILIATION_REQUIRED=true"),
    ).toBeLessThan(
      workflow.indexOf("run_flagship_mutation flagship flags update"),
    );
  });
});

function flag(overrides: Record<string, unknown> = {}) {
  return {
    key: WORKSHOP_MULTICLOUD_FLAG_KEY,
    type: "boolean",
    description: "Provider-backed Workshop issuance",
    enabled: false,
    default_variation: "off",
    variations: { on: true, off: false },
    rules: [],
    updated_at: "2026-08-03T12:00:00Z",
    updated_by: "operator@example.com",
    ...overrides,
  };
}

function exactRule(priority = 1) {
  return {
    priority,
    conditions: [
      {
        attribute: "organizationId",
        operator: "equals",
        value: organizationId,
      },
    ],
    serve_variation: "on",
  };
}

function evaluation(value: boolean, variant: string, reason: string) {
  return {
    flagKey: WORKSHOP_MULTICLOUD_FLAG_KEY,
    value,
    variant,
    reason,
  };
}
