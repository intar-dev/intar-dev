// Display helpers for the fleet map. Every value has a word, so a reader never
// depends on a color or an icon alone.

import type { HostHealth } from "@/lib/host-health";

/**
 * The state words name the report, not the workload. A host holds the healthy
 * state because its report arrived on time, which is not proof that every
 * workload inside that host is running.
 */
export const HOST_STATE_LABELS: Record<HostHealth, string> = {
  healthy: "Report on time",
  degraded: "Report overdue",
  unknown: "No report yet",
};

/** Why a host holds its state. The map legend prints these after the words. */
export const HOST_STATE_DETAILS: Record<HostHealth, string> = {
  healthy: "A report arrived in the last minute.",
  degraded: "The newest report is older than one minute.",
  unknown: "This host has not reported yet.",
};

/** The states in reading order: newest report first, no report last. */
export const HOST_STATES: readonly HostHealth[] = [
  "healthy",
  "degraded",
  "unknown",
];

export function formatHostState(state: HostHealth): string {
  return HOST_STATE_LABELS[state];
}

export function formatLocation(
  city: string | null,
  country: string | null,
): string {
  const parts = [city, country].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  return parts.length ? parts.join(", ") : "Unknown location";
}

/** The short place name for a map label: the city when the host reports one. */
export function formatPlaceLabel(
  city: string | null,
  country: string | null,
): string {
  const cityText = city?.trim();
  if (cityText) return cityText;
  const countryText = country?.trim();
  return countryText || "Unknown location";
}

export function formatCpuMillis(cpuMillis: number | null): string {
  if (cpuMillis === null) return "Not reported";
  return `${formatNumber(cpuMillis / 1000)} vCPU`;
}

export function formatMemoryMib(memoryMib: number | null): string {
  if (memoryMib === null) return "Not reported";
  return `${formatNumber(memoryMib / 1024)} GiB`;
}

/** Mapped hosts are the placed hosts, which may be fewer than all hosts. */
export function formatMappedHostCount(count: number): string {
  return count === 1 ? "1 mapped host" : `${count} mapped hosts`;
}

export function formatLocationCount(count: number): string {
  return count === 1 ? "1 location" : `${count} locations`;
}

/** The summary words for one host and for several, so no count reads "times". */
const STATE_COUNT_WORDS: Record<HostHealth, readonly [string, string]> = {
  healthy: ["report on time", "reports on time"],
  degraded: ["report overdue", "reports overdue"],
  unknown: ["host with no report", "hosts with no report"],
};

export function formatStateCount(state: HostHealth, count: number): string {
  const [one, many] = STATE_COUNT_WORDS[state];
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** The clock time of the snapshot, so the reader judges its age. */
export function formatCheckedAt(generatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(generatedAt));
}

export function formatUnlocatedNote(count: number): string {
  return count === 1
    ? "1 agent host has no location yet."
    : `${count} agent hosts have no location yet.`;
}

export function formatPendingNote(count: number): string {
  return count === 1
    ? "1 agent host is still being placed."
    : `${count} agent hosts are still being placed.`;
}

export function formatTruncatedNote(count: number): string {
  return count === 1
    ? "1 agent host is beyond the map read limit and is not shown."
    : `${count} agent hosts are beyond the map read limit and are not shown.`;
}

export function formatStalledNote(count: number): string {
  const hosts = count === 1 ? "1 agent host is" : `${count} agent hosts are`;
  return `${hosts} still being placed. Reload the page for the rest.`;
}

/** One decimal, and no trailing zero: 64 vCPU reads better than 64.0 vCPU. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
