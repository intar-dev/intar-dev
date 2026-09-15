import { Globe } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { FleetHostList } from "../fleet/FleetHostList";
import { FleetMap } from "../fleet/FleetMap";
import {
  formatHostNameCount,
  formatPendingNote,
  formatPlaceCount,
  formatUnlocatedNote,
} from "../fleet/format";
import { useFleetMap } from "../fleet/useFleetMap";
import { PageShell } from "../patterns/PageShell";
import { EmptyState, ErrorState } from "../patterns/StateCard";

/**
 * Where the platform runs. The map holds one pin for each agent host, placed
 * from the address that host reported, and it carries no host name, no host
 * id, and no address.
 */
export function Fleet() {
  const { query: fleet, stalled } = useFleetMap();
  const snapshot = fleet.data ?? null;
  const hosts = snapshot?.hosts ?? [];
  const places = new Set(
    hosts.map((host) => `${host.city ?? ""}\u0000${host.country ?? ""}`),
  ).size;

  return (
    <PageShell density="comfortable">
      {fleet.error ? (
        <ErrorState
          title="Could not load the fleet map"
          description={
            fleet.error instanceof Error
              ? fleet.error.message
              : "The fleet map did not load"
          }
          onRetry={() => void fleet.refetch()}
        />
      ) : fleet.isPending || !snapshot ? (
        <FleetMapSkeleton />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-support">
              <span className="font-semibold">
                {formatHostNameCount(hosts.length)}
              </span>{" "}in{" "}
              <span className="text-muted-foreground">
                {formatPlaceCount(places)}
              </span>
            </p>
            <p className="text-caption">
              Checked at {formatCheckedAt(snapshot.generatedAt)}
            </p>
          </div>
          {/* The map always renders, so the notes under it never hide behind
              an empty state. */}
          <FleetMap
            hosts={hosts}
            unlocatedHostCount={snapshot.unlocatedHostCount}
            pendingHostCount={snapshot.pendingHostCount}
            pendingStalled={stalled}
            truncatedHostCount={snapshot.truncatedHostCount}
          />
          {hosts.length ? (
            <FleetHostList hosts={hosts} />
          ) : (
            <EmptyState
              icon={<Globe />}
              title="No placed hosts yet"
              description={
                snapshot.unlocatedHostCount > 0
                  ? formatUnlocatedNote(snapshot.unlocatedHostCount)
                  : snapshot.pendingHostCount > 0
                    ? formatPendingNote(snapshot.pendingHostCount)
                    : "An agent host appears here as soon as it reports an address."
              }
            />
          )}
        </>
      )}
    </PageShell>
  );
}

function FleetMapSkeleton() {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">Loading the fleet map…</span>
      <Skeleton
        className="w-full rounded-xl"
        style={{ aspectRatio: "360 / 150" }}
      />
      <Skeleton className="h-4 w-64" />
    </div>
  );
}

/** The map loads once, so the reader sees the exact age of the data. */
function formatCheckedAt(generatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(generatedAt));
}
