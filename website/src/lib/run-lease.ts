// Lease/time-remaining logic for a scenario run. The sandbox VMs are leased for
// a bounded time (vm.provisioning.leaseDurationSeconds from run.createdAt);
// overdue leases are torn down server-side. This computes the client-side
// countdown so learners can see how long their box lives.

export type LeaseState = "ok" | "warning" | "critical" | "expired";

const WARNING_MS = 10 * 60 * 1000;
const CRITICAL_MS = 2 * 60 * 1000;

export interface LeaseInfo {
  deadlineMs: number | null;
  remainingMs: number;
  state: LeaseState;
}

// The run-level deadline is the earliest lease deadline across VMs that carry a
// lease. Returns null deadline when no lease info is available.
export function computeLeaseDeadline(
  createdAtMs: number,
  leaseDurationsSeconds: Array<number | null | undefined>,
): number | null {
  let earliest: number | null = null;
  for (const seconds of leaseDurationsSeconds) {
    if (typeof seconds === "number" && seconds > 0) {
      const deadline = createdAtMs + seconds * 1000;
      if (earliest === null || deadline < earliest) {
        earliest = deadline;
      }
    }
  }
  return earliest;
}

export function leaseInfo(deadlineMs: number | null, nowMs: number): LeaseInfo {
  if (deadlineMs === null) {
    return { deadlineMs: null, remainingMs: 0, state: "ok" };
  }
  const remainingMs = deadlineMs - nowMs;
  let state: LeaseState;
  if (remainingMs <= 0) state = "expired";
  else if (remainingMs <= CRITICAL_MS) state = "critical";
  else if (remainingMs <= WARNING_MS) state = "warning";
  else state = "ok";
  return { deadlineMs, remainingMs: Math.max(0, remainingMs), state };
}

export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
