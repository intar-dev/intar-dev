export type ScenarioHostRole = "agent" | "builder";

export function resolveRequestedHostRole(
  input: unknown,
  fallback: ScenarioHostRole = "agent",
): ScenarioHostRole {
  if (input === "builder") {
    return "builder";
  }
  if (input === "agent") {
    return "agent";
  }
  return fallback;
}

export function isReportedHostRoleAllowed(
  reportedRole: ScenarioHostRole,
  persistedRole: ScenarioHostRole,
): boolean {
  return reportedRole === persistedRole;
}

export interface ScenarioLaunchHostCandidate {
  role: ScenarioHostRole;
  disabled: boolean;
  scenarioEnabled: boolean;
}

export interface AvailableScenarioLaunchHostCandidate
  extends ScenarioLaunchHostCandidate {
  connected: boolean;
  lastHeartbeatAt: number | null;
}

export function isScenarioLaunchHost(
  host: ScenarioLaunchHostCandidate,
): boolean {
  return host.role === "agent" && !host.disabled && host.scenarioEnabled;
}

export function isAvailableScenarioLaunchHost(
  host: AvailableScenarioLaunchHostCandidate,
  nowUnixMs: number,
  heartbeatTtlMs: number,
): boolean {
  return (
    isScenarioLaunchHost(host) &&
    host.connected &&
    isFreshHostHeartbeat(host.lastHeartbeatAt, nowUnixMs, heartbeatTtlMs)
  );
}

export function isFreshHostHeartbeat(
  value: number | null,
  nowUnixMs: number,
  heartbeatTtlMs: number,
): boolean {
  return typeof value === "number" && nowUnixMs - value <= heartbeatTtlMs;
}

/**
 * A host disconnect shorter than this is a blip the run page does not show.
 * It matches the agent's reconnect backoff ceiling (`RETRY_MAX_MS`).
 */
export const HOST_UNREACHABLE_GRACE_MS = 30_000;

/** The host is gone past the grace, or its socket stopped reporting. */
export function isHostUnreachable(
  host: { connected: boolean; disconnectedAt: number | null; lastHeartbeatAt: number | null },
  nowUnixMs: number,
  heartbeatTtlMs: number,
): boolean {
  if (!host.connected) {
    return host.disconnectedAt === null || nowUnixMs - host.disconnectedAt >= HOST_UNREACHABLE_GRACE_MS;
  }
  return !isFreshHostHeartbeat(host.lastHeartbeatAt, nowUnixMs, heartbeatTtlMs);
}
