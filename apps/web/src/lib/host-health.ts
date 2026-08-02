export const HOST_DEGRADED_AFTER_MS = 60_000;

export type HostHealth = "healthy" | "degraded" | "unknown";

export function hostHealth(
  observedAtUnixMs: number | null,
  nowUnixMs: number,
): HostHealth {
  if (observedAtUnixMs === null) {
    return "unknown";
  }
  return nowUnixMs - observedAtUnixMs > HOST_DEGRADED_AFTER_MS
    ? "degraded"
    : "healthy";
}
