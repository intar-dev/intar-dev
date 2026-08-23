import { describe, expect, it } from "vitest";
import { scenarioStartRequest } from "../../scripts/live-e2e-start";

describe("live E2E scenario start request", () => {
  it("uses the scenario-centric launch endpoint without a host override", () => {
    expect(scenarioStartRequest("pair-ping", null)).toEqual({
      path: "/api/scenarios/pair-ping/start",
      init: { method: "POST", json: {} },
    });
  });

  it("sends an explicit host override through the scenario launch endpoint", () => {
    const request = scenarioStartRequest("pair/ping", "agent-01");

    expect(request).toEqual({
      path: "/api/scenarios/pair%2Fping/start",
      init: {
        method: "POST",
        json: { hostId: "agent-01" },
      },
    });
    expect(request.path).not.toContain("/api/agent/hosts/");
  });
});
