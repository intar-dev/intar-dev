import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Power, Server, Trash2 } from "lucide-react";
import { HostOnboardingPanel } from "../../HostOnboardingPanel";
import { formatRelativeTime } from "../../lib/format";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../../patterns/CollectionPagination";
import { Section } from "../../patterns/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type OrganizationDetailResponse,
  fetchJson,
  mutationResponse,
} from "./types";

type Detail = OrganizationDetailResponse["organization"];

interface RunnerRecord {
  id: string;
  name: string;
  role: "agent";
  disabled: boolean;
  scenarioEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: {
    connected: boolean;
    lastHeartbeatAt: string | null;
    agentVersion: string | null;
    inventoryVmCount: number;
  };
  recentRuns: Array<{
    runId: string;
    scenarioId: string;
    state: string;
    createdAt: number;
  }>;
}

export function OrganizationRunnersSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const admin = detail.role !== "member";
  const endpoint = `/api/organizations/${encodeURIComponent(detail.id)}/runners`;
  const runners = useQuery({
    queryKey: ["organizations", detail.id, "runners"],
    queryFn: () => fetchJson<{ runners: RunnerRecord[] }>(endpoint),
    refetchInterval: 15_000,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["organizations", detail.id, "runners"],
    });
  const toggle = useMutation({
    mutationFn: async (input: { id: string; disabled: boolean }) => {
      const response = await fetch(
        `${endpoint}/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: input.disabled }),
        },
      );
      await mutationResponse(response, "Failed to update runner");
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      await mutationResponse(response, "Failed to delete runner");
    },
    onSuccess: invalidate,
  });
  const actionError = toggle.error ?? remove.error;

  return (
    <div className="space-y-8">
      <Section
        title="Execution runners"
        description="Organization runs are scheduled only on this pool. Platform runners are never used as fallback, and organization runners cannot build images."
      >
        {runners.error ? (
          <InlineFeedback tone="error">
            {runners.error instanceof Error
              ? runners.error.message
              : "Failed to load runners"}
          </InlineFeedback>
        ) : (runners.data?.runners ?? []).length ? (
          <PaginatedCollection
            items={runners.data?.runners ?? []}
            pageSize={COLLECTION_PAGE_SIZE.list}
            itemLabel="runners"
          >
            {(visibleRunners) => (
              <div className="divide-y overflow-hidden rounded-xl border">
                {visibleRunners.map((runner) => (
                  <div
                    key={runner.id}
                    className="flex flex-wrap items-center gap-4 p-4 sm:p-6"
                  >
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brand-subtle text-brand-text">
                      <Server className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{runner.name}</p>
                        <Badge
                          variant={
                            runner.status.connected && !runner.disabled
                              ? "success"
                              : "outline"
                          }
                        >
                          {runner.disabled
                            ? "Disabled"
                            : runner.status.connected
                              ? "Connected"
                              : "Offline"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-caption">
                        <code>{runner.id}</code> ·{" "}
                        {runner.status.inventoryVmCount} VM
                        {runner.status.inventoryVmCount === 1 ? "" : "s"} ·
                        added {formatRelativeTime(runner.createdAt)}
                      </p>
                    </div>
                    {runner.status.lastHeartbeatAt ? (
                      <span className="flex items-center gap-1.5 text-metadata">
                        <Activity className="size-3.5" />
                        heartbeat{" "}
                        {formatRelativeTime(
                          Date.parse(runner.status.lastHeartbeatAt),
                        )}
                      </span>
                    ) : null}
                    {admin ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={toggle.isPending}
                          onClick={() =>
                            toggle.mutate({
                              id: runner.id,
                              disabled: !runner.disabled,
                            })
                          }
                        >
                          <Power className="size-3.5" />
                          {runner.disabled ? "Enable" : "Disable"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(runner.id)}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </PaginatedCollection>
        ) : (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Server className="size-5" />
            <p className="text-sm">No organization runner is registered.</p>
          </div>
        )}
        {actionError ? (
          <InlineFeedback tone="error" className="mt-3">
            {actionError instanceof Error
              ? actionError.message
              : "Runner action failed"}
          </InlineFeedback>
        ) : null}
      </Section>

      {admin ? (
        <HostOnboardingPanel
          endpoint={endpoint}
          allowedRoles={["agent"]}
          defaultHostName={`${detail.slug}-runner`}
          eyebrow="Organization runner"
          title="Generate a long-lived runner config"
          onGenerated={() => void invalidate()}
        />
      ) : null}
    </div>
  );
}
