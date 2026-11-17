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

  it("validates the stargate terminal target stage fixture", () => {
    expect(validateFixture(
      "schemas/stargate-stage-terminal-target-request.schema.json",
      "fixtures/stargate/stage-terminal-target-request.json",
    )).toBe(true);
  });

  it("validates the stargate terminal target stage response fixture", () => {
    expect(validateFixture(
      "schemas/stargate-stage-terminal-target-response.schema.json",
      "fixtures/stargate/stage-terminal-target-response.json",
    )).toBe(true);
  });

  it("validates the stargate terminal target activate fixture", () => {
    expect(validateFixture(
      "schemas/stargate-activate-terminal-target-request.schema.json",
      "fixtures/stargate/activate-terminal-target-request.json",
    )).toBe(true);
  });

  it("rejects a pending target on the stage call", () => {
    const fixture = readJson(
      "fixtures/stargate/stage-terminal-target-request.json",
    ) as Record<string, unknown>;
    expect(validateValue(
      "schemas/stargate-stage-terminal-target-request.schema.json",
      { ...fixture, target: { state: "pending" } },
    )).toBe(false);
  });

  it("rejects an activate call with no attachment id", () => {
    const fixture = readJson(
      "fixtures/stargate/activate-terminal-target-request.json",
    ) as Record<string, unknown>;
    const { attachment_id: _omitted, ...withoutAttachment } = fixture;
    expect(validateValue(
      "schemas/stargate-activate-terminal-target-request.schema.json",
      withoutAttachment,
    )).toBe(false);
  });

  it("validates the source refusal fixture", () => {
    expect(validateFixture(
      "schemas/source-refusal-v1.schema.json",
      "fixtures/source/source-refusal-v1.json",
    )).toBe(true);
  });

  it("rejects a source refusal without a known code", () => {
    const fixture = readJson(
      "fixtures/source/source-refusal-v1.json",
    ) as Record<string, unknown>;
    expect(validateValue(
      "schemas/source-refusal-v1.schema.json",
      { ...fixture, code: "internal_error" },
    )).toBe(false);
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
