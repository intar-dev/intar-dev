import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, UserPlus, X } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AccessRequestRecord {
  id: string;
  githubUsername: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

interface AccessRequestsResponse {
  requests: AccessRequestRecord[];
}

export function AdminPeople() {
  const queryClient = useQueryClient();

  const requests = useQuery({
    queryKey: ["admin", "access-requests"],
    queryFn: async () => {
      const response = await fetch("/api/admin/access-requests", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load access requests (${response.status})`,
        );
      }
      return (await response.json()) as AccessRequestsResponse;
    },
    staleTime: 5_000,
  });

  const decide = useMutation({
    mutationFn: async (params: {
      requestId: string;
      decision: "approved" | "rejected";
    }) => {
      const response = await fetch(
        `/api/admin/access-requests/${encodeURIComponent(params.requestId)}/decision`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: params.decision }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to update request (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "access-requests"],
      });
    },
  });

  const entries = requests.data?.requests ?? [];
  const pending = entries.filter((entry) => entry.status === "pending");
  const decided = entries.filter((entry) => entry.status !== "pending");

  return (
    <PageShell
      admin
      title="People"
      description="Approve access requests; approved GitHub usernames can sign in."
    >
      {requests.error ? (
        <ErrorState
          title="Could not load access requests"
          description={
            requests.error instanceof Error
              ? requests.error.message
              : "Failed to load access requests"
          }
        />
      ) : requests.isLoading ? (
        <LoadingState title="Loading access requests" />
      ) : (
        <div className="space-y-8">
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Pending{pending.length ? ` (${pending.length})` : ""}
            </h2>
            {pending.length ? (
              <RequestsTable
                entries={pending}
                pendingActions
                decide={(requestId, decision) =>
                  decide.mutate({ requestId, decision })
                }
                actionPending={decide.isPending}
              />
            ) : (
              <EmptyState
                icon={<UserPlus className="size-6" />}
                title="No pending requests"
                description="New requests from the public request-access form land here."
              />
            )}
          </section>

          {decided.length ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Decided
              </h2>
              <RequestsTable
                entries={decided}
                decide={(requestId, decision) =>
                  decide.mutate({ requestId, decision })
                }
                actionPending={decide.isPending}
              />
            </section>
          ) : null}

          {decide.error ? (
            <p className="text-sm text-destructive">
              {decide.error instanceof Error
                ? decide.error.message
                : "Failed to update request"}
            </p>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}

function RequestsTable({
  entries,
  decide,
  actionPending,
  pendingActions = false,
}: {
  entries: AccessRequestRecord[];
  decide: (requestId: string, decision: "approved" | "rejected") => void;
  actionPending: boolean;
  pendingActions?: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>GitHub username</TableHead>
            <TableHead>Note</TableHead>
            <TableHead>Requested</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell className="font-mono text-xs">
                {entry.githubUsername}
              </TableCell>
              <TableCell className="max-w-md">
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {entry.note ?? "—"}
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatRelativeTime(entry.createdAt)}
              </TableCell>
              <TableCell>
                <StatusBadge status={entry.status} />
              </TableCell>
              <TableCell className="text-right">
                {pendingActions || entry.status !== "pending" ? (
                  <div className="flex justify-end gap-1.5">
                    {entry.status !== "approved" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionPending}
                        onClick={() => decide(entry.id, "approved")}
                      >
                        <Check className="size-3.5" />
                        Approve
                      </Button>
                    ) : null}
                    {entry.status !== "rejected" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={actionPending}
                        onClick={() => decide(entry.id, "rejected")}
                      >
                        <X className="size-3.5" />
                        {entry.status === "approved" ? "Revoke" : "Reject"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: AccessRequestRecord["status"] }) {
  switch (status) {
    case "approved":
      return <Badge variant="secondary">Approved</Badge>;
    case "rejected":
      return <Badge variant="outline">Rejected</Badge>;
    default:
      return <Badge>Pending</Badge>;
  }
}
