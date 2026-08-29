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

export function resolveScenarioEnabledForHostRole(
  role: ScenarioHostRole,
  currentScenarioEnabled: boolean,
): boolean {
  return role === "agent" && currentScenarioEnabled;
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
 * New learner KVM runs need the private run-CLI broker and its completion
 * protocol. Absence is false so a pre-rollout inventory cannot be selected
 * merely because its old schema omitted either capability.
 */
export function hostSupportsRunCliV1(
  report:
    | {
        capabilities?: {
          supports_run_cli_v1?: unknown;
          supports_run_cli_completion_v1?: unknown;
        };
      }
    | null
    | undefined,
): boolean {
  return (
    report?.capabilities?.supports_run_cli_v1 === true &&
    report?.capabilities?.supports_run_cli_completion_v1 === true
  );
}
