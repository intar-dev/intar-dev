import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";
import { isWorkshopManifestV2 } from "@intar/workshop-contracts";

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

  it("validates the Rust hydrated Workshop v2 fixture in TypeScript", () => {
    const fixture = readJson("fixtures/workshop/workshop-manifest-v2.json");
    expect(validateValue("schemas/workshop-manifest-v2.schema.json", fixture)).toBe(true);
    expect(isWorkshopManifestV2(fixture)).toBe(true);
  });

  it.each([
    ["attribution", (fixture: Record<string, any>) => delete fixture.workshop.attribution],
    ["application.releaseModuleId", (fixture: Record<string, any>) => delete fixture.workspace.applications[0].releaseModuleId],
    ["runtimeProfile.requestedSystemImage", (fixture: Record<string, any>) => delete fixture.workspace.runtimeProfiles[0].requestedSystemImage],
    ["runtimeProfile.immutableSystemImage", (fixture: Record<string, any>) => delete fixture.workspace.runtimeProfiles[0].immutableSystemImage],
    ["runtimeProfile.hardware", (fixture: Record<string, any>) => delete fixture.workspace.runtimeProfiles[0].hardware],
    ["module.catchUpCheckpointId", (fixture: Record<string, any>) => delete fixture.modules[0].catchUpCheckpointId],
    ["hint.title", (fixture: Record<string, any>) => delete fixture.modules[0].hints[0].title],
    ["slide.title", (fixture: Record<string, any>) => delete fixture.presentation.slides[0].title],
  ])("rejects a hydrated Workshop v2 fixture without %s", (_field, mutate) => {
    const fixture = readJson(
      "fixtures/workshop/workshop-manifest-v2.json",
    ) as Record<string, any>;
    mutate(fixture);

    expect(isWorkshopManifestV2(fixture)).toBe(false);
    expect(validateValue("schemas/workshop-manifest-v2.schema.json", fixture)).toBe(false);
  });

  it.each([
    ["ARM hardware", (fixture: Record<string, any>) => fixture.workspace.runtimeProfiles[0].hardware.architecture = "arm64"],
    ["a missing GCP machine type", (fixture: Record<string, any>) => delete fixture.workspace.runtimeProfiles[0].machineType],
    ["an unsupported GCP root disk", (fixture: Record<string, any>) => fixture.workspace.runtimeProfiles[0].rootDiskType = "pd-ssd"],
    ["agent KVM with cloud metadata", (fixture: Record<string, any>) => fixture.workspace.runtimeProfiles[0].provider = "agent_kvm"],
  ])("rejects a hydrated Workshop v2 fixture with %s", (_case, mutate) => {
    const fixture = readJson(
      "fixtures/workshop/workshop-manifest-v2.json",
    ) as Record<string, any>;
    mutate(fixture);

    expect(isWorkshopManifestV2(fixture)).toBe(false);
    expect(validateValue("schemas/workshop-manifest-v2.schema.json", fixture)).toBe(false);
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

  it("validates the run CLI request fixture", () => {
    expect(validateFixture(
      "schemas/run-cli-request-v1.schema.json",
      "fixtures/run-cli/request-v1.json",
    )).toBe(true);
  });

  it("rejects a zero expected hint ordinal", () => {
    const fixture = readJson(
      "fixtures/run-cli/request-v1.json",
    ) as Record<string, unknown>;
    (fixture.action as Record<string, unknown>).expected_ordinal = 0;
    expect(validateValue("schemas/run-cli-request-v1.schema.json", fixture)).toBe(false);
  });

  it("validates the run CLI response fixture", () => {
    expect(validateFixture(
      "schemas/run-cli-response-v1.schema.json",
      "fixtures/run-cli/response-v1.json",
    )).toBe(true);
  });

  it("rejects an unsafe run CLI retry scope", () => {
    const fixture = readJson(
      "fixtures/run-cli/response-v1.json",
    ) as Record<string, any>;
    fixture.result.view.retry_scope = "scope with whitespace";
    expect(validateValue("schemas/run-cli-response-v1.schema.json", fixture)).toBe(false);
  });

  it("validates the local Kino probe-check request fixture", () => {
    expect(validateFixture(
      "schemas/run-cli-probe-check-request-v1.schema.json",
      "fixtures/run-cli/probe-check-request-v1.json",
    )).toBe(true);
  });

  it("validates the local Kino probe-check response fixture", () => {
    expect(validateFixture(
      "schemas/run-cli-probe-check-response-v1.schema.json",
      "fixtures/run-cli/probe-check-response-v1.json",
    )).toBe(true);
  });

  it("validates local Kino probe-check event fixtures", () => {
    expect(validateFixture(
      "schemas/run-cli-probe-check-event-v1.schema.json",
      "fixtures/run-cli/probe-check-event-v1.json",
    )).toBe(true);
    expect(validateFixture(
      "schemas/run-cli-probe-check-event-v1.schema.json",
      "fixtures/run-cli/probe-check-complete-v1.json",
    )).toBe(true);
  });

  it("rejects a zero local Kino completion count", () => {
    const fixture = readJson(
      "fixtures/run-cli/probe-check-complete-v1.json",
    ) as Record<string, any>;
    fixture.event.completed_count = 0;
    expect(validateValue("schemas/run-cli-probe-check-event-v1.schema.json", fixture)).toBe(false);
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
