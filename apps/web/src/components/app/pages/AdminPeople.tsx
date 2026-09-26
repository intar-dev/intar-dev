import { useState } from "react";
import type { OrganizationRemovedMemberRecord } from "@/lib/organizations";
import {
  signupPolicyText,
  useSignupPolicy,
} from "../hooks/useSignupPolicy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Ban,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
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
import type {
  PlatformUserAccess,
  PlatformUserOrigin,
} from "@/lib/platform-user-details";
import { SignupsPanel } from "./admin/SignupsPanel";
import {
  ADMIN_SIGNUPS_KEY,
  ADMIN_USERS_KEY,
  adminJson,
  finishRevocationCleanup,
  isUnfinishedCleanup,
  revokeAccessDescription,
  revokeUserAccess,
  signupOriginText,
} from "./admin/user-access";
import { RemovedMemberList } from "./organization-detail/RemovedMemberList";

export function AdminPeople() {
  const routeSearch = useSearch({ from: "/app/admin/people" });
  const navigate = useNavigate();
  const activeTab = routeSearch.tab ?? "users";

  const setTab = (tab: AdminPeopleTab) => {
    void navigate({
      to: ".",
      replace: true,
      search: tab === "users" ? {} : { tab },
    });
  };

  return (
    <PageShell variant="workspace" density="compact">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as AdminPeopleTab)}
        className="gap-4"
      >
        <div className="overflow-x-auto border-b">
          <TabsList variant="line" className="min-w-max pb-1">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="signups">Sign-ups</TabsTrigger>
            <TabsTrigger value="organizations">Organizations</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="users">
          <UsersPanel />
        </TabsContent>
        <TabsContent value="signups">
          <SignupsPanel />
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
  access: PlatformUserAccess;
  origin: PlatformUserOrigin;
  revocationId: string | null;
  revokedAt: number | null;
  cleanupCompletedAt: number | null;
  createdAt: string;
}

type UserConfirmation = {
  entry: AdminListedUser;
  kind: "role" | "revoke" | "delete";
  nextRole?: "user" | "admin";
};

function UsersPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [confirmation, setConfirmation] = useState<UserConfirmation | null>(
    null,
  );

  const users = useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn: () =>
      adminJson<{ users: AdminListedUser[] }>("/api/admin/users", {
        method: "GET",
      }),
    staleTime: 5_000,
  });

  // Revoking and deleting both free a sign-up spot. Refresh after failures
  // too: access may be revoked even when its cleanup did not finish.
  const refreshAccess = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_SIGNUPS_KEY }),
    ]);

  const deleteUser = useMutation({
    mutationFn: (userId: string) =>
      adminJson<void>(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => setConfirmation(null),
    onSettled: refreshAccess,
  });

  const revokeAccess = useMutation({
    mutationFn: (userId: string) => revokeUserAccess(userId),
    onSuccess: () => setConfirmation(null),
    // Committed, but its cleanup didn't finish: the row's Finish cleanup
    // takes over, since repeating the revoke would be refused.
    onError: (error) => {
      if (isUnfinishedCleanup(error)) setConfirmation(null);
    },
    onSettled: refreshAccess,
  });

  // Finishes the cleanup of the revocation this list shows, never another.
  const finishCleanup = useMutation({
    mutationFn: (entry: { userId: string; revocationId: string }) =>
      finishRevocationCleanup(entry.userId, entry.revocationId),
    onSettled: refreshAccess,
  });

  const setRole = useMutation({
    mutationFn: (params: { userId: string; role: "user" | "admin" }) =>
      adminJson<void>(
        `/api/admin/users/${encodeURIComponent(params.userId)}/role`,
        { method: "POST", body: JSON.stringify({ role: params.role }) },
      ),
    onSuccess: async () => {
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY });
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
  const busy =
    setRole.isPending ||
    deleteUser.isPending ||
    revokeAccess.isPending ||
    finishCleanup.isPending;
  const dialogPending =
    setRole.isPending || deleteUser.isPending || revokeAccess.isPending;
  const dialogError =
    confirmation?.kind === "delete"
      ? deleteUser.error
      : confirmation?.kind === "revoke"
        ? revokeAccess.error
        : confirmation?.kind === "role"
          ? setRole.error
          : null;
  const actionError =
    finishCleanup.error ??
    (confirmation === null ? revokeAccess.error : null);
  const openConfirmation = (next: UserConfirmation) => {
    setRole.reset();
    deleteUser.reset();
    revokeAccess.reset();
    finishCleanup.reset();
    setConfirmation(next);
  };
  const closeConfirmation = () => {
    setConfirmation(null);
    setRole.reset();
    deleteUser.reset();
    revokeAccess.reset();
  };

  return (
    <>
      <Section
        density="compact"
        title="Users"
        description="Manage roles and access, or permanently delete accounts. Open a person to see how they sign in and to restore their access. The last active administrator is protected."
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
                  const revoked = entry.access === "revoked";
                  const unrecorded = revoked && entry.revocationId === null;
                  const cleanupUnfinished =
                    revoked && !unrecorded && entry.cleanupCompletedAt === null;
                  const finishing =
                    finishCleanup.isPending &&
                    finishCleanup.variables?.userId === entry.id;
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
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
                            <Link
                              to="/admin/people/$userId"
                              params={{ userId: entry.id }}
                              className="inline-flex min-w-0 items-center text-sm font-medium hover:underline pointer-coarse:min-h-11"
                            >
                              <span className="truncate">{entry.name}</span>
                            </Link>
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
                            {revoked ? (
                              <Badge variant="destructive">Access revoked</Badge>
                            ) : (
                              <Badge variant="success">Active</Badge>
                            )}
                          </div>
                          <p className="text-caption tabular-nums [overflow-wrap:anywhere]">
                            {entry.email} · {signupOriginText(entry.origin)}{" "}
                            {formatRelativeTime(
                              new Date(entry.createdAt).getTime(),
                            )}
                            {revoked && entry.revokedAt !== null
                              ? ` · revoked ${formatRelativeTime(entry.revokedAt)}`
                              : null}
                            {cleanupUnfinished ? " · cleanup unfinished" : null}
                            {unrecorded ? " · no revocation record" : null}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            Flag targeting key: {entry.id}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {revoked ? (
                          cleanupUnfinished && entry.revocationId !== null ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11 sm:min-h-9"
                              disabled={busy}
                              onClick={() => {
                                if (entry.revocationId === null) return;
                                setRole.reset();
                                revokeAccess.reset();
                                finishCleanup.mutate({
                                  userId: entry.id,
                                  revocationId: entry.revocationId,
                                });
                              }}
                            >
                              <RefreshCw className="size-3.5" />
                              {finishing ? "Finishing…" : "Finish cleanup"}
                            </Button>
                          ) : null
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11 sm:min-h-9"
                              disabled={busy}
                              onClick={() =>
                                openConfirmation({
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
                              disabled={busy}
                              onClick={() =>
                                openConfirmation({ entry, kind: "revoke" })
                              }
                            >
                              <Ban className="size-3.5" />
                              Revoke access
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="min-h-11 text-muted-foreground hover:text-destructive sm:min-h-9"
                          disabled={busy}
                          onClick={() =>
                            openConfirmation({ entry, kind: "delete" })
                          }
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
        ) : finishCleanup.isSuccess ? (
          <InlineFeedback tone="success">Cleanup finished.</InlineFeedback>
        ) : null}
      </Section>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !dialogPending) closeConfirmation();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === "delete"
                ? "Delete this user?"
                : confirmation?.kind === "revoke"
                  ? "Revoke access?"
                  : confirmation?.nextRole === "admin"
                    ? "Grant admin access?"
                    : "Remove admin access?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation ? confirmationDescription(confirmation) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-sm font-medium">{confirmation?.entry.name}</p>
            <p className="text-metadata">{confirmation?.entry.email}</p>
          </div>
          {dialogError ? (
            <InlineFeedback tone="error">
              {dialogError instanceof Error
                ? dialogError.message
                : confirmation?.kind === "revoke"
                  ? "Access could not be revoked"
                  : confirmation?.kind === "role"
                    ? "The role could not be changed"
                    : "The user could not be deleted"}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeConfirmation}
              disabled={dialogPending}
            >
              {confirmation?.kind === "revoke" ? "Keep access" : "Cancel"}
            </Button>
            <Button
              variant={
                confirmation?.kind === "role" ? "default" : "danger"
              }
              disabled={dialogPending}
              onClick={() => {
                if (!confirmation) return;
                if (confirmation.kind === "delete") {
                  deleteUser.mutate(confirmation.entry.id);
                } else if (confirmation.kind === "revoke") {
                  revokeAccess.mutate(confirmation.entry.id);
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
                : revokeAccess.isPending
                  ? "Revoking…"
                  : setRole.isPending
                    ? "Updating…"
                    : confirmation?.kind === "delete"
                      ? "Delete user"
                      : confirmation?.kind === "revoke"
                        ? "Revoke access"
                        : "Confirm change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function confirmationDescription({
  entry,
  kind,
  nextRole,
}: UserConfirmation): string {
  if (kind === "revoke") return revokeAccessDescription(entry);
  if (kind === "delete") {
    return [
      "This permanently removes sign-in, sessions, memberships, OAuth grants, and personal SSH keys. Retained operational and security history remains linked to an anonymous user record.",
      entry.access === "active" ? "Access is revoked first." : null,
      "They can sign up again while spots are open.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return nextRole === "admin"
    ? "Admins sign in with GitHub, so they need it connected. They're signed out now and sign in again as an admin."
    : "Role changes take effect immediately. The server keeps at least one active administrator.";
}

interface AdminOrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  memberCount: number;
  assignmentCount: number;
  owner: { name: string; username: string | null } | null;
  oidc: {
    domain: string;
    domainVerified: boolean;
    allowExternalEmailSignups: boolean;
  } | null;
  removedMemberCount: number;
}

function OrganizationsPanel() {
  const [managedId, setManagedId] = useState<string | null>(null);
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
  const managed = entries.find((entry) => entry.id === managedId) ?? null;

  return (
    <Section
      density="compact"
      title="Organizations"
      description="Organization ownership, roster size, and assignment counts. Owners manage lifecycle from their workspace because deletion is blocked while owned resources exist. Sign-in approvals and removed people are managed here without membership."
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
                  <TableHead>Sign-in</TableHead>
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
                    <TableCell className="text-sm">
                      {organization.oidc || organization.removedMemberCount ? (
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 space-y-0.5">
                            <p className="font-mono text-xs">
                              {organization.oidc?.domain ?? "No provider"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {organizationSignInSummary(organization)}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setManagedId(organization.id)}
                          >
                            Manage
                          </Button>
                        </div>
                      ) : (
                        "—"
                      )}
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
      {managed ? (
        <OrganizationAccessDialog
          organization={managed}
          onClose={() => setManagedId(null)}
        />
      ) : null}
    </Section>
  );
}

function organizationSignInSummary(organization: AdminOrganizationRow): string {
  const parts: string[] = [];
  if (organization.oidc) {
    parts.push(
      !organization.oidc.domainVerified
        ? "Domain unverified"
        : organization.oidc.allowExternalEmailSignups
          ? "Any verified email"
          : "Domain emails only",
    );
  }
  if (organization.removedMemberCount) {
    parts.push(`${organization.removedMemberCount} removed`);
  }
  return parts.join(" · ");
}

/**
 * A platform admin's controls for an organization's sign-in: approving
 * sign-ups with emails off its verified domain, and restoring people its
 * admins removed. Neither needs membership in the organization.
 */
function OrganizationAccessDialog({
  organization,
  onClose,
}: {
  organization: AdminOrganizationRow;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const removedPath = `/api/admin/organizations/${encodeURIComponent(organization.id)}/removed-members`;
  const removed = useQuery({
    queryKey: ["admin", "organizations", organization.id, "removed-members"],
    queryFn: () =>
      adminJson<{ removedMembers: OrganizationRemovedMemberRecord[] }>(removedPath, {
        method: "GET",
      }),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "organizations"] });
  const setPolicy = useSignupPolicy(organization.id);
  const restore = useMutation({
    mutationFn: (userId: string) =>
      adminJson(`${removedPath}/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      }),
    // Only the latest action's failure shows; one still running keeps its own.
    onMutate: () => {
      if (!setPolicy.isPending) setPolicy.reset();
    },
    onSettled: refresh,
  });
  const actionError = setPolicy.error ?? restore.error;
  const oidc = organization.oidc;
  const removedMembers = removed.data?.removedMembers ?? [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{organization.name} sign-in</DialogTitle>
          <DialogDescription>
            Changes apply to the organization's next sign-ins.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {oidc ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">New accounts</h3>
              <p className="text-caption">
                {
                  signupPolicyText(oidc.domain, oidc.allowExternalEmailSignups)
                    .status
                }
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={setPolicy.isPending}
                onClick={() => {
                  if (!restore.isPending) restore.reset();
                  setPolicy.mutate(!oidc.allowExternalEmailSignups);
                }}
              >
                {
                  signupPolicyText(oidc.domain, oidc.allowExternalEmailSignups)
                    .action
                }
              </Button>
            </div>
          ) : null}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Removed people</h3>
            {removed.error ? (
              <InlineFeedback tone="error">
                {removed.error instanceof Error
                  ? removed.error.message
                  : "Failed to load removed people"}
              </InlineFeedback>
            ) : removed.isPending ? (
              <p className="text-caption">Loading…</p>
            ) : removedMembers.length ? (
              <RemovedMemberList
                entries={removedMembers}
                restoring={restore.isPending}
                onRestore={(userId) => restore.mutate(userId)}
              />
            ) : (
              <p className="text-caption">Nobody is removed.</p>
            )}
          </div>
          {actionError ? (
            <InlineFeedback tone="error">
              {actionError instanceof Error
                ? actionError.message
                : "Action failed"}
            </InlineFeedback>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
