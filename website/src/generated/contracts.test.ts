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
      "schemas/catalog-scenario-manifest-v2.schema.json",
      "fixtures/catalog/scenario-manifest-v2.json",
    )).toBe(true);
  });

  it("validates the bridge desired state fixture", () => {
    expect(validateFixture(
      "schemas/bridge-host-desired-state-v1.schema.json",
      "fixtures/bridge/host-desired-state-v1.json",
    )).toBe(true);
  });

  it("validates the bridge host state report fixture", () => {
    expect(validateFixture(
      "schemas/bridge-host-state-report-v1.schema.json",
      "fixtures/bridge/host-state-report-v1.json",
    )).toBe(true);
  });

  it("validates the bridge vm report fixture", () => {
    expect(validateFixture(
      "schemas/bridge-vm-report-v1.schema.json",
      "fixtures/bridge/vm-report-v1.json",
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
      "schemas/bridge-message-v5.schema.json",
      "fixtures/bridge/sync-request-v5.json",
    )).toBe(true);
  });
});

function validateFixture(schemaPath: string, fixturePath: string): boolean {
  const validate = ajv.compile(readJson(schemaPath) as AnySchema);
  const valid = validate(readJson(fixturePath));
  if (!valid) {
    throw new Error(JSON.stringify(validate.errors, null, 2));
  }
  return true;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}
