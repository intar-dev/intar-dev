import { useCallback, useMemo, useRef, useState } from "react";
import { Globe, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { HOST_PROVIDER_LABELS } from "@/lib/host-provider";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FleetHostDetails } from "../fleet/FleetHostDetails";
import { FleetHostList } from "../fleet/FleetHostList";
import { FleetMap } from "../fleet/FleetMap";
import {
  HOST_STATES,
  formatCheckedAt,
  formatHostState,
  formatLocationCount,
  formatMappedHostCount,
  formatPendingNote,
  formatStateCount,
  formatUnlocatedNote,
} from "../fleet/format";
import { useFleetMap } from "../fleet/useFleetMap";
import {
  EMPTY_FLEET_HOST_FILTER,
  countFleetHostStates,
  countFleetLocations,
  filterFleetHostIndices,
  fleetProvidersPresent,
  isFleetHostFilterActive,
  type FleetHostFilter,
} from "../fleet/view";
import type { FleetMapSnapshot } from "../fleet/types";
import { FilterBar, FilterChip } from "../patterns/FilterBar";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";

/**
 * Where the platform runs. The map holds one pin for each agent host, placed
 * from the address that host reported, and it carries no host name, no host
 * id, and no address.
 *
 * The page holds the selection, so a pin and its list row always describe the
 * same host. The selection belongs to one snapshot: the payload has no host
 * identity, so a new snapshot clears it rather than show another host's facts.
 */
export function Fleet() {
  const { query: fleet, stalled, refresh } = useFleetMap();
  const snapshot = fleet.data ?? null;
  const hosts = snapshot?.hosts ?? [];
  const [selection, setSelection] = useState<{
    snapshot: FleetMapSnapshot;
    index: number;
  } | null>(null);
  const [filter, setFilter] = useState<FleetHostFilter>(
    EMPTY_FLEET_HOST_FILTER,
  );

  const selectedIndex =
    selection && selection.snapshot === snapshot ? selection.index : null;
  const selectedHost =
    selectedIndex === null ? null : (hosts[selectedIndex] ?? null);
  // The control that made the selection, so a clear can return focus to it.
  const selectionOrigin = useRef<HTMLElement | null>(null);
  const selectHost = useCallback(
    (index: number | null, origin?: HTMLElement | null) => {
      selectionOrigin.current = origin ?? null;
      setSelection(
        index === null || snapshot === null ? null : { snapshot, index },
      );
    },
    [snapshot],
  );
  const clearSelection = useCallback(() => {
    // The clear button leaves the page with the panel action, so focus
    // returns to the pin or row that opened the selection.
    const origin = selectionOrigin.current;
    const index = selectedIndex;
    selectionOrigin.current = null;
    setSelection(null);
    window.requestAnimationFrame(() => {
      if (origin?.isConnected) {
        origin.focus();
        return;
      }
      // A filter can remove the selected row from the page; the pin that
      // shows the same host is still on the map and takes the focus.
      document
        .querySelector<HTMLElement>(`[data-fleet-pin-index="${index}"]`)
        ?.focus();
    });
  }, [selectedIndex]);

  const refreshAction = useMemo(
    () => (
      <Button size="sm" variant="outline" onClick={refresh} disabled={fleet.isFetching}>
        <RefreshCw
          aria-hidden="true"
          className={cn(fleet.isFetching && "motion-safe:animate-spin")}
        />
        Refresh
      </Button>
    ),
    [refresh, fleet.isFetching],
  );
  usePageChrome({ action: refreshAction });

  const visibleIndices = useMemo(
    () => filterFleetHostIndices(hosts, filter),
    [hosts, filter],
  );
  const filtersActive = isFleetHostFilterActive(filter);
  const providers = fleetProvidersPresent(hosts);
  const stateCounts = countFleetHostStates(hosts);
  const summaryFacts = [
    formatMappedHostCount(hosts.length),
    formatLocationCount(countFleetLocations(hosts)),
    ...HOST_STATES.filter((state) => stateCounts[state] > 0).map((state) =>
      formatStateCount(state, stateCounts[state]),
    ),
    ...(snapshot
      ? [
          `checked ${formatCheckedAt(snapshot.generatedAt)}`,
          ...(fleet.isFetching ? ["checking again…"] : []),
        ]
      : []),
  ];

  return (
    <PageShell density="comfortable">
      {fleet.error && !snapshot ? (
        <ErrorState
          title="Could not load the fleet map"
          description={
            fleet.error instanceof Error
              ? fleet.error.message
              : "The fleet map did not load"
          }
          onRetry={refresh}
        />
      ) : !snapshot ? (
        <FleetMapSkeleton />
      ) : (
        <>
          {fleet.error && !fleet.isFetching ? (
            // A failed refresh keeps the loaded snapshot: old facts beat no
            // facts, and the summary line still names the checked time.
            <InlineFeedback tone="error">
              Could not check again. The map still shows the last loaded
              snapshot.
            </InlineFeedback>
          ) : null}
          <MetaLine items={summaryFacts} />
          {/* The map always renders, so the notes under it never hide behind
              an empty state, and the selected host keeps its own panel. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
            <FleetMap
              hosts={hosts}
              selectedIndex={selectedIndex}
              onSelect={selectHost}
              unlocatedHostCount={snapshot.unlocatedHostCount}
              pendingHostCount={snapshot.pendingHostCount}
              pendingStalled={stalled}
              truncatedHostCount={snapshot.truncatedHostCount}
            />
            <FleetHostDetails
              host={selectedHost}
              onClear={clearSelection}
            />
          </div>
          {hosts.length ? (
            <section className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="text-label">Every placed agent host</h2>
                {filtersActive ? (
                  <p className="text-caption">
                    Showing {visibleIndices.length} of {hosts.length}
                  </p>
                ) : null}
              </div>
              <FilterBar
                search={filter.search}
                onSearchChange={(search) =>
                  setFilter((current) => ({ ...current, search }))
                }
                searchPlaceholder="Search location…"
                searchLabel="Search hosts by location"
                stackSearchOnMobile
                filtersActive={filtersActive}
                onClear={() => setFilter(EMPTY_FLEET_HOST_FILTER)}
              >
                <div
                  role="group"
                  aria-label="Filter hosts by report status"
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {HOST_STATES.map((state) => (
                    <FilterChip
                      key={state}
                      className="normal-case"
                      active={filter.status === state}
                      onClick={() =>
                        setFilter((current) => ({
                          ...current,
                          status: current.status === state ? null : state,
                        }))
                      }
                    >
                      {formatHostState(state)}
                    </FilterChip>
                  ))}
                </div>
                {providers.length ? (
                  <div
                    role="group"
                    aria-label="Filter hosts by sponsor"
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    {providers.map((provider) => (
                      <FilterChip
                        key={provider}
                        className="normal-case"
                        active={filter.provider === provider}
                        onClick={() =>
                          setFilter((current) => ({
                            ...current,
                            provider:
                              current.provider === provider ? null : provider,
                          }))
                        }
                      >
                        {HOST_PROVIDER_LABELS[provider]}
                      </FilterChip>
                    ))}
                  </div>
                ) : null}
              </FilterBar>
              <FleetHostList
                hosts={hosts}
                indices={visibleIndices}
                selectedIndex={selectedIndex}
                onSelect={selectHost}
                emptyMessage="No host matches these filters."
              />
            </section>
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
