import type { HostProvider } from "@/db/schema/shared";

/**
 * The sponsors an operator can record for a host. The list is the single
 * runtime source for the admin control, the request validation, and the map
 * logo map.
 */
export const HOST_PROVIDERS = [
  "hetzner",
  "namespace",
  "other",
] as const satisfies readonly HostProvider[];

export const HOST_PROVIDER_LABELS: Record<HostProvider, string> = {
  hetzner: "Hetzner",
  namespace: "namespace",
  other: "Other",
};

export function isHostProvider(value: unknown): value is HostProvider {
  return (
    typeof value === "string" &&
    (HOST_PROVIDERS as readonly string[]).includes(value)
  );
}

