import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertProviderCapabilities, assertRouteLessWorkerConfig } from "@intar/provider-testkit";
import { GCP_PROVIDER_CAPABILITIES } from "../../apps/web/workers/providers/gcp/src/capabilities";
import { HETZNER_PROVIDER_CAPABILITIES } from "../../apps/web/workers/providers/hetzner/src/capabilities";

type JsonObject = Record<string, unknown>;

const root = resolve(import.meta.dir, "../..");

function stripJsonComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    output += current;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

async function readJsonc(path: string): Promise<JsonObject> {
  return JSON.parse(stripJsonComments(await readFile(resolve(root, path), "utf8"))) as JsonObject;
}

function expectObject(value: unknown, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function countOccurrences(source: string, expected: string): number {
  return source.split(expected).length - 1;
}

function expectProviderConfig(
  config: JsonObject,
  expected: {
    name: string;
    durableObjectClass: string;
    requiredSecrets: readonly string[];
  },
): void {
  assertRouteLessWorkerConfig(config);
  if (config.name !== expected.name) {
    throw new Error(`Expected provider Worker ${expected.name}`);
  }
  if (config.main !== "src/index.ts") {
    throw new Error(`${expected.name} must use src/index.ts`);
  }
  const exports = expectObject(config.exports, `${expected.name} exports`);
  const durableObject = expectObject(
    exports[expected.durableObjectClass],
    `${expected.name} ${expected.durableObjectClass}`,
  );
  if (durableObject.type !== "durable-object" || durableObject.storage !== "sqlite") {
    throw new Error(`${expected.name} must export its SQLite Durable Object`);
  }
  const secrets = expectObject(config.secrets, `${expected.name} secrets`).required;
  if (!Array.isArray(secrets)) {
    throw new Error(`${expected.name} must declare required secrets`);
  }
  for (const secret of expected.requiredSecrets) {
    if (!secrets.includes(secret)) {
      throw new Error(`${expected.name} is missing required secret ${secret}`);
    }
  }
}

assertProviderCapabilities(HETZNER_PROVIDER_CAPABILITIES, "hetzner_cloud");
assertProviderCapabilities(GCP_PROVIDER_CAPABILITIES, "gcp_compute");

const hetznerConfig = await readJsonc(
  "apps/web/workers/providers/hetzner/wrangler.jsonc",
);
const gcpConfig = await readJsonc("apps/web/workers/providers/gcp/wrangler.jsonc");
expectProviderConfig(hetznerConfig, {
  name: "intar-provider-hetzner",
  durableObjectClass: "HetznerConnectionDO",
  requiredSecrets: ["HETZNER_PROVIDER_CREDENTIAL_KEK_V1"],
});
expectProviderConfig(gcpConfig, {
  name: "intar-provider-gcp",
  durableObjectClass: "GcpConnectionDO",
  requiredSecrets: ["GCP_PROVIDER_CREDENTIAL_KEK_V1"],
});
const gcpRequiredSecrets = expectObject(gcpConfig.secrets, "GCP provider secrets").required;
if (!Array.isArray(gcpRequiredSecrets) || gcpRequiredSecrets.includes("GCP_CATALOG_API_KEY")) {
  throw new Error("GCP catalog key must remain an optional production secret");
}
const gcpVars = expectObject(gcpConfig.vars, "GCP provider vars");
if (gcpVars.GCP_PROVIDER_MODE !== "dormant") {
  throw new Error("GCP provider checked-in configuration must default dormant");
}

const providerWorkflow = await readFile(
  resolve(root, ".github/workflows/provider-workers.yml"),
  "utf8",
);
if (
  countOccurrences(providerWorkflow, "uses: actions/setup-node@v6") !== 5 ||
  countOccurrences(
    providerWorkflow,
    "node-version-file: apps/web/.node-version",
  ) !== 5
) {
  throw new Error(
    "Every provider job that executes Wrangler must use the pinned Node runtime",
  );
}
for (const required of [
  "parent_holds_control_plane_lock:",
  "single_operator_confirmation:",
  "format('provider-workers-pr-{0}', github.event.pull_request.number)",
  "format('provider-workers-reusable-{0}', github.run_id)",
  "'intar-control-plane-production'",
  '--var "GCP_PROVIDER_MODE:${provider_mode}"',
  "Recheck protected Hetzner mutation window",
  "Recheck protected GCP mutation window",
]) {
  if (!providerWorkflow.includes(required)) {
    throw new Error(`Provider workflow is missing fail-closed deployment contract: ${required}`);
  }
}
if (countOccurrences(providerWorkflow, "single_operator_confirmation:") !== 2) {
  throw new Error(
    "Provider workflow must expose the sole-operator input for call and dispatch",
  );
}
if (
  countOccurrences(
    providerWorkflow,
    "SINGLE_OPERATOR_CONFIRMATION: ${{ inputs.single_operator_confirmation }}",
  ) !== 3
) {
  throw new Error(
    "Every provider mutation gate must receive the sole-operator confirmation",
  );
}
for (const requiredGateClause of [
  ".can_admins_bypass == false",
  ".prevent_self_review == true",
  "((.reviewers // []) | length) > 0",
  '([.protection_rules[]? | select(.type == "required_reviewers")] | length) == 0',
  '[[ "${SINGLE_OPERATOR_LOGIN}" =~ ^[A-Za-z0-9-]{1,39}$ ]]',
  '[[ "${SINGLE_OPERATOR_ID}" =~ ^[0-9]+$ ]]',
  'test "${GITHUB_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"',
  'test "${GITHUB_TRIGGERING_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"',
  'test "${ACTOR_ID}" = "${SINGLE_OPERATOR_ID}"',
  'test "${RUN_ATTEMPT}" = "1"',
  'test "${remaining_seconds}" -gt 0',
  'test "${remaining_seconds}" -le 604800',
  'test "${attestation_age}" -ge 0',
  'test "${attestation_age}" -le 900',
  'test "${GITHUB_REF}" = "refs/heads/main"',
  '$policies[0].name == "main"',
]) {
  if (countOccurrences(providerWorkflow, requiredGateClause) !== 3) {
    throw new Error(
      `Every provider mutation gate must enforce: ${requiredGateClause}`,
    );
  }
}
const providerStepNames = [
  ...providerWorkflow.matchAll(/^\s{6}- name: (.+)$/gm),
].map((match) => match[1]);
for (const [guard, mutation] of [
  [
    "Recheck protected Hetzner mutation window",
    "Deploy route-less Hetzner provider Worker",
  ],
  [
    "Recheck protected GCP mutation window",
    "Deploy route-less GCP provider Worker",
  ],
] as const) {
  const guardIndex = providerStepNames.indexOf(guard);
  if (guardIndex < 0 || providerStepNames[guardIndex + 1] !== mutation) {
    throw new Error(`${guard} must run immediately before ${mutation}`);
  }
}
const controlPlaneWorkflow = await readFile(
  resolve(root, ".github/workflows/control-plane-rollout.yml"),
  "utf8",
);
if (!controlPlaneWorkflow.includes("parent_holds_control_plane_lock: true")) {
  throw new Error("Control-plane wrapper must identify itself as the provider lock owner");
}
if (
  countOccurrences(
    controlPlaneWorkflow,
    "single_operator_confirmation: ${{ inputs.single_operator_confirmation }}",
  ) !== 2
) {
  throw new Error(
    "Control-plane wrapper must forward the sole-operator gate to providers and web",
  );
}

const cleanD1Workflow = await readFile(
  resolve(root, ".github/workflows/clean-d1-cutover.yml"),
  "utf8",
);
if (
  countOccurrences(cleanD1Workflow, "uses: actions/setup-node@v6") !== 1 ||
  countOccurrences(
    cleanD1Workflow,
    "node-version-file: apps/web/.node-version",
  ) !== 1
) {
  throw new Error("Clean-D1 Wrangler commands must use the pinned Node runtime");
}

const webConfig = await readJsonc("apps/web/wrangler.jsonc");
const serviceContract = [
  ["HETZNER_PROVIDER_SERVICE", "intar-provider-hetzner", "HetznerProviderService"],
  ["GCP_PROVIDER_SERVICE", "intar-provider-gcp", "GcpProviderService"],
] as const;
const probeConfig = await readJsonc(
  "tools/providers/live-capability-probe/wrangler.jsonc",
);
assertRouteLessWorkerConfig(probeConfig);
if (probeConfig.name !== "intar-provider-capability-probe") {
  throw new Error("Live capability probe Worker identity is not canonical");
}
for (const [label, config] of [["web", webConfig], ["probe", probeConfig]] as const) {
  const services = config.services;
  if (!Array.isArray(services)) throw new Error(`${label} services must be an array`);
  for (const [binding, service, entrypoint] of serviceContract) {
    const match = services.find((candidate) => {
      const value = expectObject(candidate, `${label} service binding ${binding}`);
      return value.binding === binding;
    });
    const value = expectObject(match, `${label} service binding ${binding}`);
    if (value.service !== service || value.entrypoint !== entrypoint) {
      throw new Error(
        `${label} service binding ${binding} does not match ${service}.${entrypoint}`,
      );
    }
  }
}

const astroConfig = await readFile(resolve(root, "apps/web/astro.config.ts"), "utf8");
for (const path of [
  "./workers/providers/hetzner/wrangler.jsonc",
  "./workers/providers/gcp/wrangler.jsonc",
]) {
  if (!astroConfig.includes(`configPath: \"${path}\"`)) {
    throw new Error(`Astro auxiliary Worker config is missing ${path}`);
  }
}
if (!astroConfig.includes("remoteBindings: false")) {
  throw new Error("Astro development must keep provider bindings local");
}
if (!astroConfig.includes('process.argv.includes("preview")')) {
  throw new Error("Astro preview must use the local Worker graph");
}

console.log("Provider capability, route, secret, auxiliary Worker, and service-binding contracts are consistent.");
