import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  applyCacheRule,
  assertMutationContext,
  buildPlan,
  deleteCacheRule,
  inspectCacheRuleset,
  inspectDns,
  inspectTunnel,
  validateDesiredState,
} from "./workshop-app-routing.mjs";

const config = JSON.parse(
  await readFile(new URL("./workshop-app-routing.json", import.meta.url), "utf8"),
);

function desiredDnsRecord(overrides = {}) {
  return { id: "dns-id", ...config.zone.wildcardRecord, ...overrides };
}

function desiredCacheRule(overrides = {}) {
  return {
    id: "cache-rule-id",
    ref: config.cacheRule.ref,
    description: config.cacheRule.description,
    expression: config.cacheRule.expression,
    action: config.cacheRule.action,
    action_parameters: config.cacheRule.action_parameters,
    enabled: config.cacheRule.enabled,
    ...overrides,
  };
}

function ruleset(rules) {
  return {
    id: "cache-ruleset-id",
    kind: "zone",
    phase: config.cacheRule.phase,
    rules,
  };
}

test("the checked-in desired state is internally constrained", () => {
  assert.doesNotThrow(() => validateDesiredState(config));
  assert.throws(
    () => validateDesiredState({ ...config, zone: { ...config.zone, name: "example.com" } }),
    /wildcardRecord/,
  );
});

test("DNS accepts only the exact owned wildcard record", () => {
  assert.equal(inspectDns([], config).state, "absent");
  assert.equal(inspectDns([desiredDnsRecord()], config).state, "desired");
  assert.equal(inspectDns([desiredDnsRecord({ proxied: false })], config).state, "conflict");
  assert.equal(
    inspectDns([desiredDnsRecord(), desiredDnsRecord({ id: "second" })], config).state,
    "conflict",
  );
});

test("Tunnel accepts only the protected baseline or exact desired ingress", () => {
  assert.equal(inspectTunnel({ ingress: config.tunnel.baselineIngress }, config).state, "baseline");
  assert.equal(inspectTunnel({ ingress: config.tunnel.desiredIngress }, config).state, "desired");
  assert.equal(
    inspectTunnel(
      {
        ingress: [
          config.tunnel.baselineIngress[0],
          { hostname: "unexpected.intar.app", service: "http://127.0.0.1:9000" },
          config.tunnel.baselineIngress[1],
        ],
      },
      config,
    ).state,
    "conflict",
  );
});

test("cache inspection is additive and detects duplicate or changed ownership", () => {
  assert.equal(inspectCacheRuleset(null, config).state, "absent");
  assert.equal(inspectCacheRuleset(ruleset([{ id: "other", ref: "other" }]), config).state, "absent");
  assert.equal(
    inspectCacheRuleset(ruleset([{ id: "other" }, desiredCacheRule()]), config).state,
    "desired",
  );
  assert.equal(
    inspectCacheRuleset(ruleset([desiredCacheRule(), { id: "later" }]), config).state,
    "reorder",
  );
  assert.equal(
    inspectCacheRuleset(
      ruleset([desiredCacheRule(), desiredCacheRule({ id: "duplicate" })]),
      config,
    ).state,
    "conflict",
  );
  assert.equal(
    inspectCacheRuleset(ruleset([desiredCacheRule({ action_parameters: { cache: true } })]), config)
      .state,
    "conflict",
  );
});

test("cache apply uses only rule-level additive APIs when an entry point exists", async () => {
  const calls = [];
  const existing = ruleset([{ id: "other", ref: "unrelated" }]);
  const api = {
    async request(path, options = {}) {
      calls.push({ path, options });
      return path.endsWith("/entrypoint") ? { success: true, result: existing } : { success: true };
    },
  };

  await applyCacheRule(api, "zone-id", config);
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /\/entrypoint$/);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].path, "/zones/zone-id/rulesets/cache-ruleset-id/rules");
  assert.deepEqual(calls[1].options.body.position, { after: "" });
  assert.equal(calls[1].options.body.ref, config.cacheRule.ref);
});

test("cache rollback deletes only the exact managed rule", async () => {
  const calls = [];
  const existing = ruleset([{ id: "other", ref: "unrelated" }, desiredCacheRule()]);
  const api = {
    async request(path, options = {}) {
      calls.push({ path, options });
      return path.endsWith("/entrypoint") ? { success: true, result: existing } : { success: true };
    },
  };

  await deleteCacheRule(api, "zone-id", config);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(
    calls[1].path,
    "/zones/zone-id/rulesets/cache-ruleset-id/rules/cache-rule-id",
  );
});

test("plans preserve unrelated cache rules and reject drift", () => {
  const base = {
    dns: { state: "absent" },
    tunnel: { state: "baseline" },
    cache: { state: "absent", ruleset: ruleset([{ id: "other" }]) },
  };
  assert.deepEqual(buildPlan("apply", base), [
    "append managed cache bypass rule",
    "replace protected Tunnel baseline ingress with desired ingress",
    "create owned proxied wildcard CNAME",
  ]);
  assert.throws(
    () => buildPlan("apply", { ...base, tunnel: { state: "conflict", reason: "unknown" } }),
    /refusing to continue/,
  );
});

test("rollback deletes only owned resources", () => {
  assert.deepEqual(
    buildPlan("rollback", {
      dns: { state: "desired" },
      tunnel: { state: "desired" },
      cache: { state: "reorder", ruleset: ruleset([]) },
    }),
    [
      "delete only the owned wildcard CNAME",
      "restore protected Tunnel baseline ingress",
      "delete only the managed cache rule",
    ],
  );
});

test("mutation is guarded by manual GitHub Actions main context", () => {
  const approved = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    INTAR_EDGE_MUTATION_APPROVED: "true",
    APPROVAL_MODE: "reviewed",
  };
  assert.doesNotThrow(() => assertMutationContext(approved));
  assert.throws(() => assertMutationContext({ ...approved, GITHUB_REF: "refs/heads/topic" }));
  assert.throws(() => assertMutationContext({ ...approved, GITHUB_EVENT_NAME: "push" }));
  assert.throws(() => assertMutationContext({ ...approved, INTAR_EDGE_MUTATION_APPROVED: "false" }));
  assert.throws(() => assertMutationContext({ ...approved, APPROVAL_MODE: "unknown" }));
  assert.throws(() => assertMutationContext(approved, Number.NaN), /must be finite/);
});

test("single-operator edge mutation requires current expiry and admin attestation", () => {
  const now = Date.parse("2026-07-21T21:00:00Z");
  const approved = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    INTAR_EDGE_MUTATION_APPROVED: "true",
    APPROVAL_MODE: "single-operator",
    SINGLE_OPERATOR_EXPIRES_AT: "2026-07-22T21:00:00Z",
    SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "2026-07-21T20:55:00Z",
  };
  assert.doesNotThrow(() => assertMutationContext(approved, now));
  assert.doesNotThrow(() =>
    assertMutationContext(
      {
        ...approved,
        SINGLE_OPERATOR_EXPIRES_AT: "2026-07-28T21:00:00Z",
        SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "2026-07-21T20:45:00Z",
      },
      now,
    ),
  );
  assert.throws(
    () =>
      assertMutationContext(
        { ...approved, SINGLE_OPERATOR_EXPIRES_AT: "2026-07-21T21:00:00Z" },
        now,
      ),
    /expiry/,
  );
  assert.throws(
    () =>
      assertMutationContext(
        { ...approved, SINGLE_OPERATOR_EXPIRES_AT: "2026-07-28T21:00:01Z" },
        now,
      ),
    /expiry/,
  );
  assert.throws(
    () =>
      assertMutationContext(
        { ...approved, SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "2026-07-21T20:44:59Z" },
        now,
      ),
    /attestation/,
  );
  assert.throws(
    () =>
      assertMutationContext(
        { ...approved, SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "2026-07-21T21:00:01Z" },
        now,
      ),
    /attestation/,
  );
  assert.throws(
    () =>
      assertMutationContext(
        { ...approved, SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "2026-02-30T00:00:00Z" },
        now,
      ),
    /valid UTC/,
  );
});
