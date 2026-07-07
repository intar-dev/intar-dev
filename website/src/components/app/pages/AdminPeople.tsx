import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { FilterBar } from "@/components/app/patterns/FilterBar";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { authClient, type AppAuthUser } from "@/lib/auth-client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
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
import { cn } from "@/lib/utils";

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
      <AccessRequestsPanel />
      <UsersPanel />
      <TeamsPanel />
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

  if (requests.error) {
    return (
      <ErrorState
        title="Could not load access requests"
        description={
          requests.error instanceof Error
            ? requests.error.message
            : "Failed to load access requests"
        }
        onRetry={() => void requests.refetch()}
      />
    );
  }
  if (requests.isLoading) {
    return <LoadingState title="Loading access requests" />;
  }

  const entries = requests.data?.requests ?? [];
  const pending = entries.filter((entry) => entry.status === "pending");
  const decided = entries.filter((entry) => entry.status !== "pending");

  return (
    <>
      <Section
        title={
          pending.length ? `Access requests (${pending.length})` : "Access requests"
        }
        description="New requests from the public request-access form land here."
        className={cn(pending.length && "border-primary/40 bg-primary/[0.02]")}
      >
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
          <p className="text-sm text-muted-foreground">
            No pending requests right now.
          </p>
        )}
        {decide.error ? (
          <p className="mt-3 text-sm text-destructive">
            {decide.error instanceof Error
              ? decide.error.message
              : "Failed to update request"}
          </p>
        ) : null}
      </Section>

      {decided.length ? (
        <Section
          title="Decided requests"
          description="Approvals can be revoked and rejections reversed at any time."
        >
          <RequestsTable
            entries={decided}
            decide={(requestId, decision) =>
              decide.mutate({ requestId, decision })
            }
            actionPending={decide.isPending}
          />
        </Section>
      ) : null}
    </>
  );
}

interface AdminListedUser extends AppAuthUser {
  username?: string | null;
}

function UsersPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

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
        onRetry={() => void users.refetch()}
      />
    );
  }
  if (users.isLoading) {
    return <LoadingState title="Loading users" />;
  }

  const entries = (users.data?.users ?? []) as AdminListedUser[];
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) =>
        [entry.name ?? "", entry.email ?? "", entry.username ?? ""].some(
          (value) => value.toLowerCase().includes(needle),
        ),
      )
    : entries;
  const actionError = setBanned.error ?? setRole.error;

  return (
    <Section
      title="Roster"
      description="Banning revokes all sessions and blocks sign-in. To fully revoke someone, also reject their access request so the allowlist entry is removed."
      bodyClassName="space-y-4"
    >
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name, email, or GitHub handle…"
        filtersActive={needle.length > 0}
        onClear={() => setSearch("")}
      />

      {filtered.length ? (
        <div className="divide-y">
          {filtered.map((entry) => {
            const isAdmin = entry.role === "admin";
            return (
              <div
                key={entry.id}
                className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar>
                    {entry.image ? (
                      <AvatarImage src={entry.image} alt="" />
                    ) : null}
                    <AvatarFallback>
                      {(entry.name || entry.username || "?")
                        .slice(0, 1)
                        .toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {entry.name}
                      </p>
                      {entry.username ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          @{entry.username}
                        </p>
                      ) : null}
                      {isAdmin ? (
                        <Badge>Admin</Badge>
                      ) : (
                        <Badge variant="outline">User</Badge>
                      )}
                      {entry.banned ? (
                        <Badge variant="destructive">Banned</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </div>
                    <p className="truncate text-caption">
                      {entry.email} · added{" "}
                      {formatRelativeTime(new Date(entry.createdAt).getTime())}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
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
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Users />}
          title={needle ? "No matching people" : "No users yet"}
          description={
            needle
              ? "Try a different name, email, or GitHub handle."
              : "Approved accounts show up here after their first sign-in."
          }
        />
      )}

      {actionError ? (
        <p className="text-sm text-destructive">
          {actionError instanceof Error
            ? actionError.message
            : "Failed to update user"}
        </p>
      ) : null}
    </Section>
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
    <div className="overflow-x-auto">
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
      return <Badge variant="success">Approved</Badge>;
    case "rejected":
      return <Badge variant="outline">Rejected</Badge>;
    default:
      return <Badge variant="warning">Pending</Badge>;
  }
}

interface AdminTeamRow {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  memberCount: number;
  assignmentCount: number;
  owner: { name: string; username: string | null } | null;
}

function TeamsPanel() {
  const teams = useQuery({
    queryKey: ["admin", "teams"],
    queryFn: async () => {
      const response = await fetch("/api/admin/teams", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load teams (${response.status})`,
        );
      }
      return (await response.json()) as { teams: AdminTeamRow[] };
    },
    staleTime: 10_000,
  });

  if (teams.error) {
    return (
      <ErrorState
        title="Could not load teams"
        description={
          teams.error instanceof Error
            ? teams.error.message
            : "Failed to load teams"
        }
        onRetry={() => void teams.refetch()}
      />
    );
  }
  if (teams.isLoading) {
    return <LoadingState title="Loading teams" />;
  }

  const entries = teams.data?.teams ?? [];

  return (
    <Section
      title="Teams"
      description="Teams created by instructors, with their roster and assignment counts."
    >
      {entries.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Assignments</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((team) => (
                <TableRow key={team.id}>
                  <TableCell>
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{team.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {team.slug}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {team.owner ? (
                      <>
                        {team.owner.name}
                        {team.owner.username ? (
                          <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                            @{team.owner.username}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{team.memberCount}</TableCell>
                  <TableCell className="text-sm">
                    {team.assignmentCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(team.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          icon={<UserPlus />}
          title="No teams yet"
          description="Teams created by instructors show up here with their roster and assignment counts."
        />
      )}
    </Section>
  );
}
