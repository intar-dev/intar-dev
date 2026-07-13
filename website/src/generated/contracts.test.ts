import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";

const ajv = new Ajv2020({ strict: false });

describe("generated contract schemas", () => {
  it("validates the stargate terminal session request fixture", () => {
    expect(validateFixture(
      "schemas/stargate-issue-terminal-session-request.schema.json",
      "fixtures/stargate/issue-terminal-session-request.json",
    )).toBe(true);
  });

  it("validates the stargate terminal session response fixture", () => {
    expect(validateFixture(
      "schemas/stargate-issue-terminal-session-response.schema.json",
      "fixtures/stargate/issue-terminal-session-response.json",
    )).toBe(true);
  });

  it("validates the scenario manifest fixture", () => {
    expect(validateFixture(
      "schemas/catalog-scenario-manifest-v3.schema.json",
      "fixtures/catalog/scenario-manifest-v3.json",
    )).toBe(true);
  });

  it("rejects a v2 scenario manifest version", () => {
    const fixture = readJson(
      "fixtures/catalog/scenario-manifest-v3.json",
    ) as Record<string, unknown>;
    expect(validateValue(
      "schemas/catalog-scenario-manifest-v3.schema.json",
      { ...fixture, schema_version: 2 },
    )).toBe(false);
  });

  it("validates the bridge desired state fixture", () => {
    expect(validateFixture(
      "schemas/bridge-host-desired-state-v2.schema.json",
      "fixtures/bridge/host-desired-state-v2.json",
    )).toBe(true);
  });

  it("validates the bridge host state report fixture", () => {
    expect(validateFixture(
      "schemas/bridge-host-state-report-v2.schema.json",
      "fixtures/bridge/host-state-report-v2.json",
    )).toBe(true);
  });

  it("validates the bridge vm report fixture", () => {
    expect(validateFixture(
      "schemas/bridge-vm-report-v2.schema.json",
      "fixtures/bridge/vm-report-v2.json",
    )).toBe(true);
  });

  it("validates the bridge desired build fixture", () => {
    expect(validateFixture(
      "schemas/bridge-desired-build-v1.schema.json",
      "fixtures/bridge/desired-build-v1.json",
    )).toBe(true);
  });

  it("validates the bridge build report fixture", () => {
    expect(validateFixture(
      "schemas/bridge-build-report-v1.schema.json",
      "fixtures/bridge/build-report-v1.json",
    )).toBe(true);
  });

  it("validates the bridge message fixture", () => {
    expect(validateFixture(
      "schemas/bridge-message-v6.schema.json",
      "fixtures/bridge/sync-request-v6.json",
    )).toBe(true);
  });

  it("rejects a v5 bridge protocol version", () => {
    const fixture = readJson(
      "fixtures/bridge/sync-request-v6.json",
    ) as Record<string, unknown>;
    expect(validateValue(
      "schemas/bridge-message-v6.schema.json",
      { ...fixture, protocol_version: 5 },
    )).toBe(false);
  });
});

function validateFixture(schemaPath: string, fixturePath: string): boolean {
  const value = readJson(fixturePath);
  const valid = validateValue(schemaPath, value);
  return valid;
}

function validateValue(schemaPath: string, value: unknown): boolean {
  const validate = ajv.compile(readJson(schemaPath) as AnySchema);
  const valid = validate(value);
  if (!valid) {
    return false;
  }
  return true;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}
