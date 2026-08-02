import { describe, expect, it } from "vitest";

import { assertDrainedStargatePlan } from "./stargate-plan";

const healthy = [
  "protocol=1",
  "service=active",
  `binary_sha256=${"a".repeat(64)}`,
  "terminal_routes=0",
  "workspace_app_routes=0",
  "browser_sessions=0",
  "workspace_app_base_domain=intar.app",
  "workspace_app_bootstrap_ttl_seconds=60",
  "workspace_app_session_ttl_seconds=900",
  "workspace_app_migrations=ready",
  "",
].join("\n");

describe("restricted Stargate plan drain proof", () => {
  it("accepts only the healthy, fully drained production contract", () => {
    expect(assertDrainedStargatePlan(healthy)).toEqual({
      schema_version: 1,
      operation: "stargate-drain",
      protocol: 1,
      service: "active",
      binary_sha256: "a".repeat(64),
      counts: {
        terminal_routes: 0,
        workspace_app_routes: 0,
        browser_sessions: 0,
      },
      configuration: {
        workspace_app_base_domain: "intar.app",
        workspace_app_bootstrap_ttl_seconds: 60,
        workspace_app_session_ttl_seconds: 900,
        workspace_app_migrations: "ready",
      },
      healthy: true,
      drained: true,
    });
  });

  it("rejects every live route or browser session", () => {
    for (const [current, replacement] of [
      ["terminal_routes=0", "terminal_routes=1"],
      ["workspace_app_routes=0", "workspace_app_routes=2"],
      ["browser_sessions=0", "browser_sessions=3"],
    ]) {
      expect(() =>
        assertDrainedStargatePlan(healthy.replace(current!, replacement!)),
      ).toThrow(/live routes or browser sessions/);
    }
  });

  it("rejects unhealthy service configuration and migrations", () => {
    expect(() =>
      assertDrainedStargatePlan(healthy.replace("service=active", "service=inactive")),
    ).toThrow(/must be active/);
    expect(() =>
      assertDrainedStargatePlan(
        healthy.replace("workspace_app_base_domain=intar.app", "workspace_app_base_domain=absent"),
      ),
    ).toThrow(/base domain/);
    expect(() =>
      assertDrainedStargatePlan(
        healthy.replace("workspace_app_migrations=ready", "workspace_app_migrations=missing"),
      ),
    ).toThrow(/not ready/);
  });

  it("rejects reordered, duplicate, extra, or noncanonical fields", () => {
    expect(() =>
      assertDrainedStargatePlan(
        healthy.replace("protocol=1\nservice=active", "service=active\nprotocol=1"),
      ),
    ).toThrow(/not canonical/);
    expect(() => assertDrainedStargatePlan(`${healthy}unexpected=0\n`)).toThrow(
      /exactly the canonical ten lines/,
    );
    expect(() =>
      assertDrainedStargatePlan(healthy.replace("terminal_routes=0", "terminal_routes=00")),
    ).toThrow(/canonical non-negative integer/);
    expect(() => assertDrainedStargatePlan(healthy.replaceAll("\n", "\r\n"))).toThrow(
      /canonical LF/,
    );
  });
});
