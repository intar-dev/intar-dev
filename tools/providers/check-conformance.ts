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
  requiredSecrets: ["GCP_PROVIDER_CREDENTIAL_KEK_V1", "GCP_CATALOG_API_KEY"],
});

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
