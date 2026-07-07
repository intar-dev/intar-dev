import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, ShieldCheck, UserPlus, X } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { authClient, type AppAuthUser } from "@/lib/auth-client";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  return (
    <PageShell
      admin
      title="People"
      description="Approve access requests and manage existing accounts."
    >
      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Access requests</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>
        <TabsContent value="requests" className="pt-4">
          <AccessRequestsPanel />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

function AccessRequestsPanel() {
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
    <>
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
    </>
  );
}

interface AdminListedUser extends AppAuthUser {
  username?: string | null;
}

function UsersPanel() {
  const queryClient = useQueryClient();

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const result = await authClient.admin.listUsers({
        query: {
          limit: 200,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to load users");
      }
      return result.data;
    },
    staleTime: 5_000,
  });

  const setBanned = useMutation({
    mutationFn: async (params: { userId: string; banned: boolean }) => {
      const result = params.banned
        ? await authClient.admin.banUser({
            userId: params.userId,
            banReason: "Access revoked by admin",
          })
        : await authClient.admin.unbanUser({ userId: params.userId });
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to update user");
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  const setRole = useMutation({
    mutationFn: async (params: { userId: string; role: "user" | "admin" }) => {
      const result = await authClient.admin.setRole({
        userId: params.userId,
        role: params.role,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Failed to update role");
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  if (users.error) {
    return (
      <ErrorState
        title="Could not load users"
        description={
          users.error instanceof Error
            ? users.error.message
            : "Failed to load users"
        }
      />
    );
  }
  if (users.isLoading) {
    return <LoadingState title="Loading users" />;
  }

  const entries = (users.data?.users ?? []) as AdminListedUser[];
  const actionError = setBanned.error ?? setRole.error;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>GitHub</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              const isAdmin = entry.role === "admin";
              return (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{entry.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.email}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.username ?? "—"}
                  </TableCell>
                  <TableCell>
                    {isAdmin ? (
                      <Badge>Admin</Badge>
                    ) : (
                      <Badge variant="outline">User</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {entry.banned ? (
                      <Badge variant="destructive">Banned</Badge>
                    ) : (
                      <Badge variant="secondary">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={setRole.isPending}
                        onClick={() =>
                          setRole.mutate({
                            userId: entry.id,
                            role: isAdmin ? "user" : "admin",
                          })
                        }
                      >
                        <ShieldCheck className="size-3.5" />
                        {isAdmin ? "Make user" : "Make admin"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={setBanned.isPending}
                        onClick={() =>
                          setBanned.mutate({
                            userId: entry.id,
                            banned: !entry.banned,
                          })
                        }
                      >
                        <Ban className="size-3.5" />
                        {entry.banned ? "Unban" : "Ban"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Banning revokes all sessions and blocks sign-in. To fully revoke
        someone, also reject their access request so the allowlist entry is
        removed.
      </p>
      {actionError ? (
        <p className="text-sm text-destructive">
          {actionError instanceof Error
            ? actionError.message
            : "Failed to update user"}
        </p>
      ) : null}
    </div>
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
