#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const FLAGSHIP_APP_ID = "12f35c20-55f4-47ee-8b31-b3ad202d1f04";
export const WORKSHOP_MULTICLOUD_FLAG_KEY =
  "workshop_multicloud_runtime_enabled";

const ORGANIZATION_ID_PATTERN = /^[a-z0-9]{24}$/u;
const VARIATION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type TargetingOperation = "plan" | "apply" | "remove";
export type TargetingAction =
  | "none"
  | "enable"
  | "add_rule"
  | "enable_and_add_rule"
  | "remove_rule";

type JsonRecord = Record<string, unknown>;

export interface FlagshipCondition {
  attribute: "organizationId";
  operator: "equals";
  value: string;
}

export interface FlagshipTargetRule {
  priority: number;
  conditions: [FlagshipCondition];
  serve_variation: string;
}

export interface FlagshipDefinition {
  key: string;
  description: string | null;
  enabled: boolean;
  default_variation: string;
  variations: Record<string, boolean>;
  rules: unknown[];
  type: "boolean";
  updated_at: string;
  updated_by: string;
}

export interface TargetingPlan {
  schemaVersion: 1;
  provider: "cloudflare_flagship";
  appId: typeof FLAGSHIP_APP_ID;
  flagKey: typeof WORKSHOP_MULTICLOUD_FLAG_KEY;
  organizationId: string;
  operation: TargetingOperation;
  observedSha256: string;
  action: TargetingAction;
  trueVariation: string;
  falseVariation: string;
  defaultVariation: string;
  enabled: boolean;
  ruleCount: number;
  targetRulePriority: number | null;
  desiredRule: FlagshipTargetRule;
}

export interface EvaluationEvidence {
  schemaVersion: 1;
  provider: "cloudflare_flagship";
  appId: typeof FLAGSHIP_APP_ID;
  flagKey: typeof WORKSHOP_MULTICLOUD_FLAG_KEY;
  organizationId: string;
  phase: "before" | "after";
  operation: TargetingOperation;
  flagSha256: string;
  target: {
    value: boolean;
    variant: string;
    reason: string | null;
  };
  control: {
    value: false;
    variant: string;
    reason: string | null;
  };
  verified: true;
}

export function planWorkshopMulticloudTargeting(
  operation: TargetingOperation,
  organizationId: string,
  input: unknown,
): TargetingPlan {
  const normalizedOrganizationId = validateOrganizationId(organizationId);
  const flag = validateFlagDefinition(input);
  const [trueVariation, falseVariation] = booleanVariations(flag.variations);
  if (flag.default_variation !== falseVariation) {
    throw new TypeError(
      "Flagship drift: the multicloud flag default variation must be boolean false",
    );
  }

  const targetRules = flag.rules.map((rule) =>
    parseExactTargetRule(rule, normalizedOrganizationId, trueVariation),
  );
  if (targetRules.length > 1) {
    throw new TypeError(
      "Flagship drift: the multicloud flag may contain only the exact pilot rule",
    );
  }
  const targetRule = targetRules[0] ?? null;
  const desiredRule: FlagshipTargetRule = {
    priority: targetRule?.priority ?? 1,
    conditions: [
      {
        attribute: "organizationId",
        operator: "equals",
        value: normalizedOrganizationId,
      },
    ],
    serve_variation: trueVariation,
  };

  return {
    schemaVersion: 1,
    provider: "cloudflare_flagship",
    appId: FLAGSHIP_APP_ID,
    flagKey: WORKSHOP_MULTICLOUD_FLAG_KEY,
    organizationId: normalizedOrganizationId,
    operation,
    observedSha256: canonicalSha256(flag),
    action: targetingAction(operation, flag.enabled, targetRule !== null),
    trueVariation,
    falseVariation,
    defaultVariation: flag.default_variation,
    enabled: flag.enabled,
    ruleCount: flag.rules.length,
    targetRulePriority: targetRule?.priority ?? null,
    desiredRule,
  };
}

export function verifyCurrentEvaluations(
  planInput: unknown,
  targetEvaluationInput: unknown,
  controlEvaluationInput: unknown,
): EvaluationEvidence {
  const plan = validatePlan(planInput);
  const expectedTarget =
    plan.enabled && plan.ruleCount === 1 && plan.targetRulePriority !== null;
  const target = parseEvaluation(
    targetEvaluationInput,
    expectedTarget,
    expectedTarget ? plan.trueVariation : plan.falseVariation,
    "target",
  );
  const control = parseEvaluation(
    controlEvaluationInput,
    false,
    plan.falseVariation,
    "control",
  );
  return evaluationEvidence(plan, "before", target, control);
}

export function verifyFinalEvaluations(
  operation: "apply" | "remove",
  organizationId: string,
  flagInput: unknown,
  targetEvaluationInput: unknown,
  controlEvaluationInput: unknown,
): EvaluationEvidence {
  const plan = planWorkshopMulticloudTargeting(
    operation,
    organizationId,
    flagInput,
  );
  if (operation === "apply") {
    if (!plan.enabled || plan.ruleCount !== 1) {
      throw new TypeError(
        "Flagship apply verification failed: exact organization targeting is not active",
      );
    }
  } else if (plan.ruleCount !== 0) {
    throw new TypeError(
      "Flagship remove verification failed: organization targeting remains",
    );
  }

  const targetExpected = operation === "apply";
  const target = parseEvaluation(
    targetEvaluationInput,
    targetExpected,
    targetExpected ? plan.trueVariation : plan.falseVariation,
    "target",
  );
  const control = parseEvaluation(
    controlEvaluationInput,
    false,
    plan.falseVariation,
    "control",
  );
  return evaluationEvidence(plan, "after", target, control);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function validateOrganizationId(value: string): string {
  const normalized = value.trim();
  if (!ORGANIZATION_ID_PATTERN.test(normalized)) {
    throw new TypeError(
      "organization ID must be exactly 24 lowercase ASCII letters or digits",
    );
  }
  return normalized;
}

function validateFlagDefinition(input: unknown): FlagshipDefinition {
  if (!isRecord(input)) {
    throw new TypeError("Flagship flag response must be a JSON object");
  }
  const keys = Object.keys(input).sort();
  const expectedKeys = [
    "default_variation",
    "description",
    "enabled",
    "key",
    "rules",
    "type",
    "updated_at",
    "updated_by",
    "variations",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      "Flagship drift: unexpected top-level flag response fields",
    );
  }
  if (input.key !== WORKSHOP_MULTICLOUD_FLAG_KEY) {
    throw new TypeError("Flagship drift: unexpected flag key");
  }
  if (input.enabled !== true && input.enabled !== false) {
    throw new TypeError("Flagship drift: enabled must be boolean");
  }
  if (
    typeof input.default_variation !== "string" ||
    !VARIATION_NAME_PATTERN.test(input.default_variation)
  ) {
    throw new TypeError("Flagship drift: default variation is invalid");
  }
  if (input.type !== "boolean") {
    throw new TypeError("Flagship drift: flag type must be boolean");
  }
  if (input.description !== null && typeof input.description !== "string") {
    throw new TypeError("Flagship drift: flag description is invalid");
  }
  if (
    typeof input.updated_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(input.updated_at) ||
    typeof input.updated_by !== "string" ||
    input.updated_by.length < 1
  ) {
    throw new TypeError("Flagship drift: flag update metadata is invalid");
  }
  if (!isRecord(input.variations)) {
    throw new TypeError("Flagship drift: variations must be an object");
  }
  if (!Array.isArray(input.rules)) {
    throw new TypeError("Flagship drift: rules must be an array");
  }

  const variations: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(input.variations)) {
    if (!VARIATION_NAME_PATTERN.test(name) || typeof value !== "boolean") {
      throw new TypeError(
        "Flagship drift: every variation must have a canonical name and boolean value",
      );
    }
    variations[name] = value;
  }
  booleanVariations(variations);

  return {
    key: input.key,
    description: input.description,
    enabled: input.enabled,
    default_variation: input.default_variation,
    variations,
    rules: input.rules,
    type: input.type,
    updated_at: input.updated_at,
    updated_by: input.updated_by,
  };
}

function booleanVariations(
  variations: Record<string, boolean>,
): [trueVariation: string, falseVariation: string] {
  const entries = Object.entries(variations);
  const trueVariations = entries.filter(([, value]) => value);
  const falseVariations = entries.filter(([, value]) => !value);
  if (
    entries.length !== 2 ||
    trueVariations.length !== 1 ||
    falseVariations.length !== 1
  ) {
    throw new TypeError(
      "Flagship drift: the multicloud flag must have exactly one true and one false variation",
    );
  }
  return [trueVariations[0]![0], falseVariations[0]![0]];
}

function parseExactTargetRule(
  input: unknown,
  organizationId: string,
  trueVariation: string,
): FlagshipTargetRule {
  if (!isRecord(input)) {
    throw new TypeError("Flagship drift: targeting rule must be an object");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "conditions" ||
    keys[1] !== "priority" ||
    keys[2] !== "serve_variation"
  ) {
    throw new TypeError(
      "Flagship drift: only priority, conditions, and serve_variation are allowed on the pilot rule",
    );
  }
  if (!Number.isSafeInteger(input.priority) || Number(input.priority) < 1) {
    throw new TypeError("Flagship drift: target rule priority is invalid");
  }
  if (input.serve_variation !== trueVariation) {
    throw new TypeError(
      "Flagship drift: target rule must serve the boolean true variation",
    );
  }
  if (!Array.isArray(input.conditions) || input.conditions.length !== 1) {
    throw new TypeError(
      "Flagship drift: target rule must contain exactly one condition",
    );
  }
  const condition = input.conditions[0];
  if (!isRecord(condition)) {
    throw new TypeError("Flagship drift: target condition must be an object");
  }
  const conditionKeys = Object.keys(condition).sort();
  if (
    conditionKeys.length !== 3 ||
    conditionKeys[0] !== "attribute" ||
    conditionKeys[1] !== "operator" ||
    conditionKeys[2] !== "value" ||
    condition.attribute !== "organizationId" ||
    condition.operator !== "equals" ||
    condition.value !== organizationId
  ) {
    throw new TypeError(
      "Flagship drift: target condition must equal the exact organizationId",
    );
  }
  return {
    priority: Number(input.priority),
    conditions: [
      {
        attribute: "organizationId",
        operator: "equals",
        value: organizationId,
      },
    ],
    serve_variation: trueVariation,
  };
}

function targetingAction(
  operation: TargetingOperation,
  enabled: boolean,
  hasTargetRule: boolean,
): TargetingAction {
  if (operation === "remove") return hasTargetRule ? "remove_rule" : "none";
  if (enabled && hasTargetRule) return "none";
  if (!enabled && hasTargetRule) return "enable";
  if (enabled) return "add_rule";
  return "enable_and_add_rule";
}

function validatePlan(input: unknown): TargetingPlan {
  if (!isRecord(input)) throw new TypeError("targeting plan must be an object");
  const operation = input.operation;
  if (operation !== "plan" && operation !== "apply" && operation !== "remove") {
    throw new TypeError("targeting plan operation is invalid");
  }
  const organizationId = validateOrganizationId(String(input.organizationId ?? ""));
  if (
    input.schemaVersion !== 1 ||
    input.provider !== "cloudflare_flagship" ||
    input.appId !== FLAGSHIP_APP_ID ||
    input.flagKey !== WORKSHOP_MULTICLOUD_FLAG_KEY ||
    typeof input.observedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.observedSha256)
  ) {
    throw new TypeError("targeting plan provenance is invalid");
  }
  if (
    typeof input.enabled !== "boolean" ||
    !Number.isSafeInteger(input.ruleCount) ||
    Number(input.ruleCount) < 0 ||
    typeof input.trueVariation !== "string" ||
    typeof input.falseVariation !== "string" ||
    typeof input.defaultVariation !== "string"
  ) {
    throw new TypeError("targeting plan state is invalid");
  }
  const targetRulePriority = input.targetRulePriority;
  if (
    targetRulePriority !== null &&
    (!Number.isSafeInteger(targetRulePriority) || Number(targetRulePriority) < 1)
  ) {
    throw new TypeError("targeting plan rule priority is invalid");
  }
  return input as unknown as TargetingPlan & { organizationId: string };
}

function parseEvaluation<const Expected extends boolean>(
  input: unknown,
  expectedValue: Expected,
  expectedVariant: string,
  label: "target" | "control",
): { value: Expected; variant: string; reason: string | null } {
  if (!isRecord(input)) {
    throw new TypeError(`Flagship ${label} evaluation must be an object`);
  }
  if (
    input.flagKey !== WORKSHOP_MULTICLOUD_FLAG_KEY ||
    input.value !== expectedValue ||
    input.variant !== expectedVariant
  ) {
    throw new TypeError(`Flagship ${label} evaluation did not fail closed`);
  }
  if (input.reason !== undefined && typeof input.reason !== "string") {
    throw new TypeError(`Flagship ${label} evaluation reason is invalid`);
  }
  return {
    value: expectedValue,
    variant: expectedVariant,
    reason: (input.reason as string | undefined) ?? null,
  };
}

function evaluationEvidence(
  plan: TargetingPlan,
  phase: "before" | "after",
  target: { value: boolean; variant: string; reason: string | null },
  control: { value: false; variant: string; reason: string | null },
): EvaluationEvidence {
  return {
    schemaVersion: 1,
    provider: "cloudflare_flagship",
    appId: FLAGSHIP_APP_ID,
    flagKey: WORKSHOP_MULTICLOUD_FLAG_KEY,
    organizationId: plan.organizationId,
    phase,
    operation: plan.operation,
    flagSha256: plan.observedSha256,
    target,
    control,
    verified: true,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    const [operation, organizationId, flagPath, outputPath] = args;
    if (
      (operation !== "plan" && operation !== "apply" && operation !== "remove") ||
      !organizationId ||
      !flagPath ||
      !outputPath ||
      args.length !== 4
    ) {
      throw new Error(
        "usage: workshop-multicloud-targeting.ts plan <plan|apply|remove> <organization-id> <flag.json> <plan.json>",
      );
    }
    await writeJson(
      outputPath,
      planWorkshopMulticloudTargeting(
        operation,
        organizationId,
        await readJson(flagPath),
      ),
    );
    return;
  }

  if (command === "verify-current") {
    const [planPath, targetPath, controlPath, outputPath] = args;
    if (!planPath || !targetPath || !controlPath || !outputPath || args.length !== 4) {
      throw new Error(
        "usage: workshop-multicloud-targeting.ts verify-current <plan.json> <target-eval.json> <control-eval.json> <evidence.json>",
      );
    }
    await writeJson(
      outputPath,
      verifyCurrentEvaluations(
        await readJson(planPath),
        await readJson(targetPath),
        await readJson(controlPath),
      ),
    );
    return;
  }

  if (command === "verify-final") {
    const [operation, organizationId, flagPath, targetPath, controlPath, outputPath] =
      args;
    if (
      (operation !== "apply" && operation !== "remove") ||
      !organizationId ||
      !flagPath ||
      !targetPath ||
      !controlPath ||
      !outputPath ||
      args.length !== 6
    ) {
      throw new Error(
        "usage: workshop-multicloud-targeting.ts verify-final <apply|remove> <organization-id> <flag.json> <target-eval.json> <control-eval.json> <evidence.json>",
      );
    }
    await writeJson(
      outputPath,
      verifyFinalEvaluations(
        operation,
        organizationId,
        await readJson(flagPath),
        await readJson(targetPath),
        await readJson(controlPath),
      ),
    );
    return;
  }

  throw new Error(
    "usage: workshop-multicloud-targeting.ts <plan|verify-current|verify-final> ...",
  );
}

if (import.meta.main) await main();
