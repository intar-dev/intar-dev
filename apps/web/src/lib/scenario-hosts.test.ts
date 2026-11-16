import { describe, expect, it } from "vitest";
import {
  isAvailableScenarioLaunchHost,
  HOST_UNREACHABLE_GRACE_MS,
  isFreshHostHeartbeat,
  isHostUnreachable,
  isReportedHostRoleAllowed,
  isScenarioLaunchHost,
  resolveRequestedHostRole,
} from "@/lib/scenario-hosts";

describe("scenario host launch eligibility", () => {
  it("defaults new hosts to agent but preserves existing host roles when role is omitted", () => {
    expect(resolveRequestedHostRole(undefined)).toBe("agent");
    expect(resolveRequestedHostRole(null)).toBe("agent");
    expect(resolveRequestedHostRole(undefined, "builder")).toBe("builder");
  });

  it("accepts only explicit supported host roles", () => {
    expect(resolveRequestedHostRole("builder", "agent")).toBe("builder");
    expect(resolveRequestedHostRole("agent", "builder")).toBe("agent");
    expect(resolveRequestedHostRole("worker", "builder")).toBe("builder");
  });

  it("requires bridge clients to report the persisted host role", () => {
    expect(isReportedHostRoleAllowed("builder", "builder")).toBe(true);
    expect(isReportedHostRoleAllowed("agent", "agent")).toBe(true);
    expect(isReportedHostRoleAllowed("builder", "agent")).toBe(false);
    expect(isReportedHostRoleAllowed("agent", "builder")).toBe(false);
  });

  it("allows enabled agent hosts to launch scenarios", () => {
    expect(isScenarioLaunchHost({
      role: "agent",
      disabled: false,
      scenarioEnabled: true,
    })).toBe(true);
  });

  it("rejects builder hosts even when they are otherwise enabled", () => {
    expect(isScenarioLaunchHost({
      role: "builder",
      disabled: false,
      scenarioEnabled: true,
    })).toBe(false);
  });

  it("rejects disabled or scenario-disabled agent hosts", () => {
    expect(isScenarioLaunchHost({
      role: "agent",
      disabled: true,
      scenarioEnabled: true,
    })).toBe(false);
    expect(isScenarioLaunchHost({
      role: "agent",
      disabled: false,
      scenarioEnabled: false,
    })).toBe(false);
  });

  it("requires connected hosts with fresh heartbeats for launch availability", () => {
    const now = 1_762_041_660_000;
    const ttl = 90_000;

    expect(isAvailableScenarioLaunchHost({
      role: "agent",
      disabled: false,
      scenarioEnabled: true,
      connected: true,
      lastHeartbeatAt: now - 30_000,
    }, now, ttl)).toBe(true);

    expect(isAvailableScenarioLaunchHost({
      role: "agent",
      disabled: false,
      scenarioEnabled: true,
      connected: false,
      lastHeartbeatAt: now - 30_000,
    }, now, ttl)).toBe(false);

    expect(isAvailableScenarioLaunchHost({
      role: "agent",
      disabled: false,
      scenarioEnabled: true,
      connected: true,
      lastHeartbeatAt: now - ttl - 1,
    }, now, ttl)).toBe(false);
  });

  it("treats missing heartbeats as stale", () => {
    expect(isFreshHostHeartbeat(null, 1_762_041_660_000, 90_000)).toBe(false);
  });
});

describe("host reachability for a live run", () => {
  const now = 1_000_000;
  const ttl = 90_000;

  it("lets a disconnect inside the grace pass and shows one beyond it", () => {
    const connected = { connected: true, disconnectedAt: null, lastHeartbeatAt: now - 20_000 };
    expect(isHostUnreachable(connected, now, ttl)).toBe(false);
    const blip = { connected: false, disconnectedAt: now - 5_000, lastHeartbeatAt: now - 20_000 };
    expect(isHostUnreachable(blip, now, ttl)).toBe(false);
    const gone = { ...blip, disconnectedAt: now - HOST_UNREACHABLE_GRACE_MS };
    expect(isHostUnreachable(gone, now, ttl)).toBe(true);
    expect(isHostUnreachable({ ...blip, disconnectedAt: null }, now, ttl)).toBe(true);
    // Reconnected: the hello clears disconnectedAt and a report refreshes the heartbeat.
    expect(isHostUnreachable({ connected: true, disconnectedAt: null, lastHeartbeatAt: now }, now, ttl)).toBe(false);
  });

  it("treats a connected host that stopped reporting as unreachable", () => {
    expect(
      isHostUnreachable({ connected: true, disconnectedAt: null, lastHeartbeatAt: now - ttl - 1 }, now, ttl),
    ).toBe(true);
  });
});
