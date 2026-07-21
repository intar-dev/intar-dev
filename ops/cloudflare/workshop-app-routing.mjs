#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const DEFAULT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "workshop-app-routing.json",
);

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function expectedCacheRule(config) {
  const cacheRule = config.cacheRule;
  return {
    ref: cacheRule.ref,
    description: cacheRule.description,
    expression: cacheRule.expression,
    action: cacheRule.action,
    action_parameters: cacheRule.action_parameters,
    enabled: cacheRule.enabled,
  };
}

export function validateDesiredState(config) {
  if (config?.version !== 1) {
    throw new Error("desired-state version must be 1");
  }

  requireString(config.zone?.name, "zone.name");
  requireString(config.tunnel?.id, "tunnel.id");
  if (!Array.isArray(config.zone.preserveExactNames)) {
    throw new Error("zone.preserveExactNames must be an array");
  }

  const zoneName = config.zone.name.toLowerCase();
  const wildcard = config.zone.wildcardRecord;
  const expectedTarget = `${config.tunnel.id}.cfargotunnel.com`;
  if (
    wildcard?.type !== "CNAME" ||
    wildcard.name !== `*.${zoneName}` ||
    wildcard.content !== expectedTarget ||
    wildcard.proxied !== true ||
    wildcard.ttl !== 1
  ) {
    throw new Error("zone.wildcardRecord is not the expected proxied Tunnel CNAME");
  }
  requireString(wildcard.comment, "zone.wildcardRecord.comment");

  const expectedBaseline = [
    { hostname: `ws.${zoneName}`, service: "http://127.0.0.1:8080" },
    { service: "http_status:404" },
  ];
  const expectedIngress = [
    expectedBaseline[0],
    { hostname: `*.${zoneName}`, service: "http://127.0.0.1:8080" },
    expectedBaseline[1],
  ];
  if (!equal(config.tunnel.baselineIngress, expectedBaseline)) {
    throw new Error("tunnel.baselineIngress is not the protected ws/404 baseline");
  }
  if (!equal(config.tunnel.desiredIngress, expectedIngress)) {
    throw new Error("tunnel.desiredIngress is not the protected ws/wildcard/404 order");
  }

  for (const name of config.zone.preserveExactNames) {
    requireString(name, "zone.preserveExactNames entry");
    const normalized = name.toLowerCase();
    if (normalized !== name || !normalized.endsWith(`.${zoneName}`) || normalized.includes("*")) {
      throw new Error(`invalid exact DNS name to preserve: ${name}`);
    }
  }

  const cacheRule = config.cacheRule;
  if (cacheRule?.phase !== "http_request_cache_settings") {
    throw new Error("cacheRule.phase must be http_request_cache_settings");
  }
  requireString(cacheRule.rulesetName, "cacheRule.rulesetName");
  requireString(cacheRule.rulesetDescription, "cacheRule.rulesetDescription");
  requireString(cacheRule.ref, "cacheRule.ref");
  requireString(cacheRule.description, "cacheRule.description");
  if (
    cacheRule.expression !== `(http.host wildcard \"wa-*.${zoneName}\")` ||
    cacheRule.action !== "set_cache_settings" ||
    !equal(cacheRule.action_parameters, { cache: false }) ||
    cacheRule.enabled !== true
  ) {
    throw new Error("cacheRule must be the enabled wa-* hostname cache bypass");
  }
}

function normalizeDnsName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/\.$/, "") : value;
}

function isDesiredDnsRecord(record, desired) {
  return (
    record.type === desired.type &&
    normalizeDnsName(record.name) === normalizeDnsName(desired.name) &&
    normalizeDnsName(record.content) === normalizeDnsName(desired.content) &&
    record.proxied === desired.proxied &&
    record.ttl === desired.ttl &&
    record.comment === desired.comment
  );
}

export function inspectDns(records, config) {
  const desired = config.zone.wildcardRecord;
  const wildcardRecords = records.filter(
    (record) => normalizeDnsName(record.name) === normalizeDnsName(desired.name),
  );

  if (wildcardRecords.length === 0) {
    return { state: "absent", record: null };
  }
  if (wildcardRecords.length !== 1) {
    return {
      state: "conflict",
      reason: `found ${wildcardRecords.length} records at ${desired.name}`,
      record: null,
    };
  }

  const record = wildcardRecords[0];
  if (!isDesiredDnsRecord(record, desired)) {
    return {
      state: "conflict",
      reason: `the existing ${desired.name} record is not owned desired state`,
      record,
    };
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return { state: "conflict", reason: "the owned wildcard record has no ID", record };
  }
  return { state: "desired", record };
}

export function inspectTunnel(tunnelConfig, config) {
  if (tunnelConfig === null || typeof tunnelConfig !== "object" || Array.isArray(tunnelConfig)) {
    return { state: "conflict", reason: "Tunnel configuration is missing" };
  }
  if (equal(tunnelConfig.ingress, config.tunnel.baselineIngress)) {
    return { state: "baseline" };
  }
  if (equal(tunnelConfig.ingress, config.tunnel.desiredIngress)) {
    return { state: "desired" };
  }
  return {
    state: "conflict",
    reason: "Tunnel ingress is neither the protected baseline nor desired state",
  };
}

function relevantCacheRule(rule) {
  return {
    ref: rule.ref,
    description: rule.description,
    expression: rule.expression,
    action: rule.action,
    action_parameters: rule.action_parameters,
    enabled: rule.enabled,
  };
}

export function inspectCacheRuleset(ruleset, config) {
  if (ruleset === null) {
    return { state: "absent", ruleset: null, rule: null, ruleCount: 0 };
  }
  if (
    typeof ruleset !== "object" ||
    ruleset.phase !== config.cacheRule.phase ||
    !Array.isArray(ruleset.rules)
  ) {
    return {
      state: "conflict",
      reason: "cache entry point has an unexpected shape or phase",
      ruleset,
      rule: null,
      ruleCount: 0,
    };
  }

  const matches = ruleset.rules.filter(
    (rule) =>
      rule.ref === config.cacheRule.ref || rule.description === config.cacheRule.description,
  );
  if (matches.length === 0) {
    return {
      state: "absent",
      ruleset,
      rule: null,
      ruleCount: ruleset.rules.length,
    };
  }
  if (matches.length !== 1) {
    return {
      state: "conflict",
      reason: `found ${matches.length} cache rules with the managed identity`,
      ruleset,
      rule: null,
      ruleCount: ruleset.rules.length,
    };
  }

  const rule = matches[0];
  if (!equal(relevantCacheRule(rule), expectedCacheRule(config))) {
    return {
      state: "conflict",
      reason: "the managed cache rule payload has drifted",
      ruleset,
      rule,
      ruleCount: ruleset.rules.length,
    };
  }
  if (typeof ruleset.id !== "string" || typeof rule.id !== "string") {
    return {
      state: "conflict",
      reason: "the managed cache ruleset or rule has no ID",
      ruleset,
      rule,
      ruleCount: ruleset.rules.length,
    };
  }

  const lastRule = ruleset.rules.at(-1);
  return {
    state: lastRule?.id === rule.id ? "desired" : "reorder",
    ruleset,
    rule,
    ruleCount: ruleset.rules.length,
  };
}

function conflicts(inventory) {
  const found = [];
  for (const [resource, inspection] of [
    ["DNS", inventory.dns],
    ["Tunnel", inventory.tunnel],
    ["cache rule", inventory.cache],
  ]) {
    if (inspection.state === "conflict") {
      found.push(`${resource}: ${inspection.reason}`);
    }
  }
  return found;
}

export function buildPlan(action, inventory) {
  if (action !== "apply" && action !== "rollback") {
    throw new Error(`unsupported plan action: ${action}`);
  }
  const drift = conflicts(inventory);
  if (drift.length > 0) {
    throw new Error(`refusing to continue because managed edge state conflicts:\n- ${drift.join("\n- ")}`);
  }

  if (action === "apply") {
    return [
      inventory.cache.state === "absent"
        ? inventory.cache.ruleset === null
          ? "create cache entry point with managed bypass rule"
          : "append managed cache bypass rule"
        : inventory.cache.state === "reorder"
          ? "move managed cache bypass rule to final position"
          : "leave managed cache bypass rule unchanged",
      inventory.tunnel.state === "baseline"
        ? "replace protected Tunnel baseline ingress with desired ingress"
        : "leave desired Tunnel ingress unchanged",
      inventory.dns.state === "absent"
        ? "create owned proxied wildcard CNAME"
        : "leave owned proxied wildcard CNAME unchanged",
    ];
  }

  return [
    inventory.dns.state === "desired"
      ? "delete only the owned wildcard CNAME"
      : "leave absent wildcard CNAME unchanged",
    inventory.tunnel.state === "desired"
      ? "restore protected Tunnel baseline ingress"
      : "leave protected Tunnel baseline ingress unchanged",
    inventory.cache.state === "absent"
      ? "leave absent managed cache rule unchanged"
      : "delete only the managed cache rule",
  ];
}

function parseExactUtcTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  ) {
    throw new Error(`${name} must use YYYY-MM-DDTHH:MM:SSZ`);
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new Error(`${name} must be a valid UTC timestamp`);
  }
  return timestamp;
}

export function assertMutationContext(environment, now = Date.now()) {
  if (!Number.isFinite(now)) {
    throw new Error("edge mutation authorization time must be finite");
  }
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.INTAR_EDGE_MUTATION_APPROVED !== "true"
  ) {
    throw new Error(
      "edge mutation is permitted only by an approved workflow_dispatch run on refs/heads/main",
    );
  }

  if (environment.APPROVAL_MODE === "reviewed") {
    return;
  }
  if (environment.APPROVAL_MODE !== "single-operator") {
    throw new Error("edge mutation requires a supported production approval mode");
  }

  const expiresAt = parseExactUtcTimestamp(
    environment.SINGLE_OPERATOR_EXPIRES_AT,
    "SINGLE_OPERATOR_EXPIRES_AT",
  );
  const attestedAt = parseExactUtcTimestamp(
    environment.SINGLE_OPERATOR_ADMIN_ATTESTED_AT,
    "SINGLE_OPERATOR_ADMIN_ATTESTED_AT",
  );
  const remainingMilliseconds = expiresAt - now;
  const attestationAgeMilliseconds = now - attestedAt;
  if (remainingMilliseconds <= 0 || remainingMilliseconds > 604_800_000) {
    throw new Error("single-operator expiry is outside the mutation window");
  }
  if (attestationAgeMilliseconds < 0 || attestationAgeMilliseconds > 900_000) {
    throw new Error("single-operator admin attestation is outside the mutation window");
  }
}

class CloudflareApi {
  constructor(token, fetchImplementation = globalThis.fetch) {
    requireString(token, "CLOUDFLARE_WORKSHOP_EDGE_API_TOKEN");
    this.token = token;
    this.fetch = fetchImplementation;
  }

  async request(path, { method = "GET", body, allowNotFound = false } = {}) {
    const response = await this.fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });

    if (allowNotFound && response.status === 404) {
      return null;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Cloudflare API ${method} ${path} returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok || payload?.success !== true) {
      const details = Array.isArray(payload?.errors)
        ? payload.errors.map((error) => `${error.code ?? "unknown"}: ${error.message ?? "unknown"}`)
        : [];
      throw new Error(
        `Cloudflare API ${method} ${path} failed with HTTP ${response.status}${
          details.length === 0 ? "" : ` (${details.join("; ")})`
        }`,
      );
    }
    return payload;
  }
}

async function listDnsRecords(api, zoneId) {
  const records = [];
  let page = 1;
  for (;;) {
    const query = new URLSearchParams({ page: String(page), per_page: "5000" });
    const payload = await api.request(`/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`);
    if (!Array.isArray(payload.result)) {
      throw new Error("Cloudflare DNS list response did not contain a result array");
    }
    records.push(...payload.result);
    const totalPages = Number(payload.result_info?.total_pages ?? 1);
    if (!Number.isInteger(totalPages) || totalPages < 1) {
      throw new Error("Cloudflare DNS list response had invalid pagination");
    }
    if (page >= totalPages) {
      return records;
    }
    page += 1;
  }
}

async function getTunnelConfig(api, accountId, tunnelId) {
  const payload = await api.request(
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
  );
  return payload.result?.config;
}

async function getCacheRuleset(api, zoneId, phase) {
  const payload = await api.request(
    `/zones/${encodeURIComponent(zoneId)}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`,
    { allowNotFound: true },
  );
  return payload?.result ?? null;
}

async function inventory(api, identifiers, config) {
  const [records, tunnelConfig, ruleset] = await Promise.all([
    listDnsRecords(api, identifiers.zoneId),
    getTunnelConfig(api, identifiers.accountId, config.tunnel.id),
    getCacheRuleset(api, identifiers.zoneId, config.cacheRule.phase),
  ]);
  return {
    records,
    tunnelConfig,
    ruleset,
    dns: inspectDns(records, config),
    tunnel: inspectTunnel(tunnelConfig, config),
    cache: inspectCacheRuleset(ruleset, config),
  };
}

function publicInventory(state, config) {
  const preserved = Object.fromEntries(
    config.zone.preserveExactNames.map((name) => [
      name,
      state.records
        .filter((record) => normalizeDnsName(record.name) === name)
        .map((record) => ({ type: record.type, name: record.name, proxied: record.proxied })),
    ]),
  );
  return {
    zone: config.zone.name,
    dns: {
      state: state.dns.state,
      reason: state.dns.reason,
      totalRecords: state.records.length,
      preservedExactNames: preserved,
    },
    tunnel: { id: config.tunnel.id, state: state.tunnel.state, reason: state.tunnel.reason },
    cache: {
      state: state.cache.state,
      reason: state.cache.reason,
      rulesetId: state.cache.ruleset?.id ?? null,
      ruleId: state.cache.rule?.id ?? null,
      ruleCount: state.cache.ruleCount,
    },
  };
}

export async function applyCacheRule(api, zoneId, config) {
  const ruleset = await getCacheRuleset(api, zoneId, config.cacheRule.phase);
  const inspection = inspectCacheRuleset(ruleset, config);
  if (inspection.state === "conflict") {
    throw new Error(`cache rule changed after planning: ${inspection.reason}`);
  }
  if (inspection.state === "desired") {
    return;
  }

  const rule = expectedCacheRule(config);
  if (inspection.state === "reorder") {
    await api.request(
      `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(
        inspection.ruleset.id,
      )}/rules/${encodeURIComponent(inspection.rule.id)}`,
      { method: "PATCH", body: { ...rule, position: { after: "" } } },
    );
    return;
  }
  if (inspection.ruleset === null) {
    await api.request(`/zones/${encodeURIComponent(zoneId)}/rulesets`, {
      method: "POST",
      body: {
        name: config.cacheRule.rulesetName,
        description: config.cacheRule.rulesetDescription,
        kind: "zone",
        phase: config.cacheRule.phase,
        rules: [rule],
      },
    });
    return;
  }

  await api.request(
    `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(
      inspection.ruleset.id,
    )}/rules`,
    { method: "POST", body: { ...rule, position: { after: "" } } },
  );
}

export async function deleteCacheRule(api, zoneId, config) {
  const ruleset = await getCacheRuleset(api, zoneId, config.cacheRule.phase);
  const inspection = inspectCacheRuleset(ruleset, config);
  if (inspection.state === "conflict") {
    throw new Error(`cache rule changed after planning: ${inspection.reason}`);
  }
  if (inspection.state === "absent") {
    return;
  }
  await api.request(
    `/zones/${encodeURIComponent(zoneId)}/rulesets/${encodeURIComponent(
      inspection.ruleset.id,
    )}/rules/${encodeURIComponent(inspection.rule.id)}`,
    { method: "DELETE" },
  );
}

async function setTunnelIngress(api, accountId, config, target) {
  const currentConfig = await getTunnelConfig(api, accountId, config.tunnel.id);
  const inspection = inspectTunnel(currentConfig, config);
  if (inspection.state === "conflict") {
    throw new Error(`Tunnel ingress changed after planning: ${inspection.reason}`);
  }
  if (inspection.state === target) {
    return;
  }

  const ingress = target === "desired" ? config.tunnel.desiredIngress : config.tunnel.baselineIngress;
  await api.request(
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(
      config.tunnel.id,
    )}/configurations`,
    {
      method: "PUT",
      body: { config: { ...currentConfig, ingress } },
    },
  );
}

async function createDnsRecord(api, zoneId, config) {
  const records = await listDnsRecords(api, zoneId);
  const inspection = inspectDns(records, config);
  if (inspection.state === "conflict") {
    throw new Error(`DNS changed after planning: ${inspection.reason}`);
  }
  if (inspection.state === "desired") {
    return;
  }
  await api.request(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    method: "POST",
    body: config.zone.wildcardRecord,
  });
}

async function deleteDnsRecord(api, zoneId, config) {
  const records = await listDnsRecords(api, zoneId);
  const inspection = inspectDns(records, config);
  if (inspection.state === "conflict") {
    throw new Error(`DNS changed after planning: ${inspection.reason}`);
  }
  if (inspection.state === "absent") {
    return;
  }
  await api.request(
    `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(inspection.record.id)}`,
    { method: "DELETE" },
  );
}

async function reconcile(action, api, identifiers, config) {
  if (action === "apply") {
    // Make the security policy and origin route ready before exposing DNS.
    await applyCacheRule(api, identifiers.zoneId, config);
    await setTunnelIngress(api, identifiers.accountId, config, "desired");
    await createDnsRecord(api, identifiers.zoneId, config);
    return;
  }

  // Stop new traffic before removing the origin route and cache policy.
  await deleteDnsRecord(api, identifiers.zoneId, config);
  await setTunnelIngress(api, identifiers.accountId, config, "baseline");
  await deleteCacheRule(api, identifiers.zoneId, config);
}

function assertFinalState(action, state) {
  const expected =
    action === "apply"
      ? { dns: "desired", tunnel: "desired", cache: "desired" }
      : { dns: "absent", tunnel: "baseline", cache: "absent" };
  for (const resource of ["dns", "tunnel", "cache"]) {
    if (state[resource].state !== expected[resource]) {
      throw new Error(
        `${resource} verification failed: expected ${expected[resource]}, got ${state[resource].state}`,
      );
    }
  }
}

async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  validateDesiredState(config);
  return config;
}

async function main() {
  const [action = "", configArgument] = process.argv.slice(2);
  if (!new Set(["validate", "plan", "apply", "rollback"]).has(action)) {
    throw new Error(
      "usage: node ops/cloudflare/workshop-app-routing.mjs <validate|plan|apply|rollback> [config.json]",
    );
  }
  const configPath = resolve(configArgument ?? DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath);
  if (action === "validate") {
    console.log(JSON.stringify({ valid: true, config: configPath }, null, 2));
    return;
  }

  const identifiers = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
  };
  requireString(identifiers.accountId, "CLOUDFLARE_ACCOUNT_ID");
  requireString(identifiers.zoneId, "CLOUDFLARE_ZONE_ID");
  const api = new CloudflareApi(process.env.CLOUDFLARE_WORKSHOP_EDGE_API_TOKEN);
  const initial = await inventory(api, identifiers, config);
  const requestedAction = action === "plan" ? "apply" : action;
  const plan = buildPlan(requestedAction, initial);
  console.log(
    JSON.stringify(
      { operation: action, inventory: publicInventory(initial, config), changes: plan },
      null,
      2,
    ),
  );
  if (action === "plan") {
    return;
  }

  assertMutationContext(process.env);
  await reconcile(action, api, identifiers, config);
  const final = await inventory(api, identifiers, config);
  assertFinalState(action, final);
  console.log(
    JSON.stringify(
      { operation: action, verified: true, inventory: publicInventory(final, config) },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
