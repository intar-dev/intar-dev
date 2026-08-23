import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
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
import type { AdminPeopleTab } from "./tab-search";
import { BetaAccessPanel } from "./admin/BetaAccess";

export function AdminPeople() {
  const routeSearch = useSearch({ from: "/app/admin/people" });
  const navigate = useNavigate();
  const activeTab = routeSearch.tab ?? "beta";

  const setTab = (tab: AdminPeopleTab) => {
    void navigate({
      to: ".",
      replace: true,
      search: tab === "beta" ? {} : { tab },
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
            <TabsTrigger value="beta">Beta access</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="organizations">Organizations</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="beta">
          <BetaAccessPanel />
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

interface AdminListedUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
  role: string | null;
  banned: boolean | null;
  createdAt: string;
}

function UsersPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [confirmation, setConfirmation] = useState<{
    entry: AdminListedUser;
    kind: "role" | "delete";
    nextRole?: "user" | "admin";
  } | null>(null);

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () =>
      adminJson<{ users: AdminListedUser[] }>("/api/admin/users", {
        method: "GET",
      }),
    staleTime: 5_000,
  });

  const deleteUser = useMutation({
    mutationFn: (userId: string) =>
      adminJson<void>(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: async () => {
      setConfirmation(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "beta-access"] }),
      ]);
    },
  });

  const setRole = useMutation({
    mutationFn: (params: { userId: string; role: "user" | "admin" }) =>
      adminJson<void>(
        `/api/admin/users/${encodeURIComponent(params.userId)}/role`,
        { method: "POST", body: JSON.stringify({ role: params.role }) },
      ),
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

  const entries = users.data.users;
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
  const actionError = setRole.error;

  return (
    <>
      <Section
        density="compact"
        title="Users"
        description="Manage roles or permanently delete sign-in identities. Beta access is controlled separately. The last active administrator is protected."
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
                          className="min-h-11 sm:min-h-9"
                          disabled={setRole.isPending || deleteUser.isPending}
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
                          className="min-h-11 text-muted-foreground hover:text-destructive sm:min-h-9"
                          disabled={setRole.isPending || deleteUser.isPending}
                          onClick={() => {
                            deleteUser.reset();
                            setConfirmation({
                              entry,
                              kind: "delete",
                            });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
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
                : "Better Auth accounts show up here after their first sign-in."
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
          if (!open && !deleteUser.isPending && !setRole.isPending) {
            setConfirmation(null);
            deleteUser.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === "delete"
                ? "Delete this user?"
                : confirmation?.nextRole === "admin"
                  ? "Grant admin access?"
                  : "Remove admin access?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.kind === "delete"
                ? "This permanently removes sign-in, sessions, memberships, beta access, OAuth grants, and personal SSH keys. Retained operational and security history remains linked to an anonymous user record."
                : confirmation?.kind === "role"
                  ? "Role changes take effect immediately. The server will reject removal of the last active beta administrator."
                  : "Choose a user action."}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-sm font-medium">{confirmation?.entry.name}</p>
            <p className="text-metadata">{confirmation?.entry.email}</p>
          </div>
          {confirmation?.kind === "delete" && deleteUser.error ? (
            <InlineFeedback tone="error">
              {deleteUser.error instanceof Error
                ? deleteUser.error.message
                : "The user could not be deleted"}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmation(null);
                deleteUser.reset();
              }}
              disabled={deleteUser.isPending || setRole.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                confirmation?.kind === "delete"
                  ? "destructive"
                  : "default"
              }
              disabled={deleteUser.isPending || setRole.isPending}
              onClick={() => {
                if (!confirmation) return;
                if (confirmation.kind === "delete") {
                  deleteUser.mutate(confirmation.entry.id);
                } else if (confirmation.nextRole) {
                  setRole.mutate({
                    userId: confirmation.entry.id,
                    role: confirmation.nextRole,
                  });
                }
              }}
            >
              {deleteUser.isPending
                ? "Deleting…"
                : setRole.isPending
                  ? "Updating…"
                  : confirmation?.kind === "delete"
                    ? "Delete user"
                    : "Confirm change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function adminJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const result = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "User action failed",
    );
  }
  return result as T;
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
