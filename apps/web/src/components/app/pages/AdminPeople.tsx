import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Ban, Check, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import { FilterBar } from "@/components/app/patterns/FilterBar";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { TableSkeleton } from "../patterns/Skeletons";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { authClient, type AppAuthUser } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AdminPeopleTab } from "./tab-search";

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
  const routeSearch = useSearch({ from: "/app/admin/people" });
  const navigate = useNavigate();
  const activeTab = routeSearch.tab ?? "requests";

  const setTab = (tab: AdminPeopleTab) => {
    void navigate({
      to: ".",
      replace: true,
      search: tab === "requests" ? {} : { tab },
    });
  };

  return (
    <PageShell width="workspace" density="compact">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as AdminPeopleTab)}
        className="gap-6"
      >
        <div className="overflow-x-auto border-b">
          <TabsList variant="line" className="min-w-max pb-1">
            <TabsTrigger value="requests">Access requests</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="organizations">Organizations</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="requests">
          <AccessRequestsPanel />
        </TabsContent>
        <TabsContent value="users">
          <UsersPanel />
        </TabsContent>
        <TabsContent value="organizations">
          <OrganizationsPanel />
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
  if (requests.isPending) {
    return <TableSkeleton />;
  }

  const entries = requests.data?.requests ?? [];
  const pending = entries.filter((entry) => entry.status === "pending");
  const decided = entries.filter((entry) => entry.status !== "pending");

  return (
    <>
      <Section
        density="compact"
        variant={pending.length ? "default" : "flat"}
        title={
          pending.length
            ? `Access requests (${pending.length})`
            : "Access requests"
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
          <InlineFeedback tone="error" className="mt-3">
            {decide.error instanceof Error
              ? decide.error.message
              : "Failed to update request"}
          </InlineFeedback>
        ) : null}
      </Section>

      {decided.length ? (
        <Section
          density="compact"
          variant="flat"
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
  const [confirmation, setConfirmation] = useState<{
    entry: AdminListedUser;
    kind: "role" | "ban";
    nextRole?: "user" | "admin";
    nextBanned?: boolean;
  } | null>(null);

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
      setConfirmation(null);
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
      setConfirmation(null);
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
  if (users.isPending) {
    return <TableSkeleton />;
  }

  const entries = (users.data?.users ?? []) as AdminListedUser[];
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) =>
        [
          entry.id,
          entry.name ?? "",
          entry.email ?? "",
          entry.username ?? "",
        ].some((value) => value.toLowerCase().includes(needle)),
      )
    : entries;
  const actionError = setBanned.error ?? setRole.error;

  return (
    <>
      <Section
        density="compact"
        title="Users"
        description="Use the displayed targeting key for Flagship selection. Banning revokes all sessions; rejecting the access request also removes GitHub allowlist access."
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
          <PaginatedCollection
            items={filtered}
            pageSize={COLLECTION_PAGE_SIZE.dense}
            itemLabel="users"
            resetKey={needle}
          >
            {(visibleUsers) => (
              <div className="divide-y">
                {visibleUsers.map((entry) => {
                  const isAdmin = entry.role === "admin";
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between"
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
                            {formatRelativeTime(
                              new Date(entry.createdAt).getTime(),
                            )}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            Flag targeting key: {entry.id}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={setRole.isPending}
                          onClick={() =>
                            setConfirmation({
                              entry,
                              kind: "role",
                              nextRole: isAdmin ? "user" : "admin",
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
                            setConfirmation({
                              entry,
                              kind: "ban",
                              nextBanned: !entry.banned,
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
            )}
          </PaginatedCollection>
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
          <InlineFeedback tone="error">
            {actionError instanceof Error
              ? actionError.message
              : "Failed to update user"}
          </InlineFeedback>
        ) : null}
      </Section>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !setBanned.isPending && !setRole.isPending) {
            setConfirmation(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === "ban"
                ? confirmation.nextBanned
                  ? "Ban this user?"
                  : "Restore this user?"
                : confirmation?.nextRole === "admin"
                  ? "Grant admin access?"
                  : "Remove admin access?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.kind === "ban" && confirmation.nextBanned
                ? "This revokes active sessions and blocks sign-in. Their allowlist request remains unchanged."
                : confirmation?.kind === "role"
                  ? "Role changes take effect immediately for protected admin routes."
                  : "This restores sign-in access; the allowlist still applies."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-sm font-medium">{confirmation?.entry.name}</p>
            <p className="text-metadata">{confirmation?.entry.email}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmation(null)}
              disabled={setBanned.isPending || setRole.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                confirmation?.kind === "ban" && confirmation.nextBanned
                  ? "destructive"
                  : "default"
              }
              disabled={setBanned.isPending || setRole.isPending}
              onClick={() => {
                if (!confirmation) return;
                if (confirmation.kind === "ban") {
                  setBanned.mutate({
                    userId: confirmation.entry.id,
                    banned: Boolean(confirmation.nextBanned),
                  });
                } else if (confirmation.nextRole) {
                  setRole.mutate({
                    userId: confirmation.entry.id,
                    role: confirmation.nextRole,
                  });
                }
              }}
            >
              {setBanned.isPending || setRole.isPending
                ? "Updating…"
                : "Confirm change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
    <PaginatedCollection
      items={entries}
      pageSize={COLLECTION_PAGE_SIZE.dense}
      itemLabel="access requests"
    >
      {(visibleEntries) => (
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
            {visibleEntries.map((entry) => (
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
      )}
    </PaginatedCollection>
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

interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  memberCount: number;
  assignmentCount: number;
  owner: { name: string; username: string | null } | null;
}

function OrganizationsPanel() {
  const organizations = useQuery({
    queryKey: ["admin", "organizations"],
    queryFn: async () => {
      const response = await fetch("/api/admin/organizations", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load organizations (${response.status})`,
        );
      }
      return (await response.json()) as {
        organizations: AdminOrganizationRow[];
      };
    },
    staleTime: 10_000,
  });

  if (organizations.error) {
    return (
      <ErrorState
        title="Could not load organizations"
        description={
          organizations.error instanceof Error
            ? organizations.error.message
            : "Failed to load organizations"
        }
        onRetry={() => void organizations.refetch()}
      />
    );
  }
  if (organizations.isPending) {
    return <TableSkeleton />;
  }

  const entries = organizations.data?.organizations ?? [];

  return (
    <Section
      density="compact"
      title="Organizations"
      description="Organization ownership, roster size, and assignment counts. Owners manage lifecycle from their workspace because deletion is blocked while owned resources exist."
    >
      {entries.length ? (
        <PaginatedCollection
          items={entries}
          pageSize={COLLECTION_PAGE_SIZE.dense}
          itemLabel="organizations"
        >
          {(visibleOrganizations) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Assignments</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleOrganizations.map((organization) => (
                  <TableRow key={organization.id}>
                    <TableCell>
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {organization.name}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {organization.slug}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {organization.owner ? (
                        <>
                          {organization.owner.name}
                          {organization.owner.username ? (
                            <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                              @{organization.owner.username}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {organization.memberCount}
                    </TableCell>
                    <TableCell className="text-sm">
                      {organization.assignmentCount}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeTime(organization.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </PaginatedCollection>
      ) : (
        <EmptyState
          icon={<UserPlus />}
          title="No organizations yet"
          description="Selected users can create the first organization from the Organizations workspace."
        />
      )}
    </Section>
  );
}
