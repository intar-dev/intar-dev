import { describe, expect, it } from "vitest";
import { parseOptions } from "../../scripts/live-e2e";

const requiredEnv = {
  INTAR_LIVE_BASE_URL: "https://intar.dev",
  INTAR_LIVE_COOKIE: "session=test",
};

describe("live E2E options", () => {
  it("rejects the removed same-user cross-run option", () => {
    expect(() =>
      parseOptions(["--cross-run-scenario", "broken-nginx"], requiredEnv),
    ).toThrow("unknown option: --cross-run-scenario");
  });

  it("rejects the removed cross-run environment variable", () => {
    expect(() =>
      parseOptions([], {
        ...requiredEnv,
        INTAR_LIVE_CROSS_RUN_SCENARIO_ID: "broken-nginx",
      }),
    ).toThrow("concurrent runs on the same agent host");
  });

  it("accepts registered value options", () => {
    const options = parseOptions(
      ["--scenario", "broken-nginx", "--wait-ready-ms", "12345"],
      requiredEnv,
    );
    expect(options.scenarioId).toBe("broken-nginx");
    expect(options.waitReadyMs).toBe(12_345);
  });

  it("rejects inline values for boolean flags", () => {
    expect(() =>
      parseOptions(["--skip-publish=false"], requiredEnv),
    ).toThrow("--skip-publish does not accept a value");
  });
});
