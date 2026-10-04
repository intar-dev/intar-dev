import { useLayoutEffect, useRef, useState } from "react";
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
import { SideSheet } from "../patterns/SideSheet";
import { formatRelativeTime } from "../lib/format";
import { apiErrorMessage } from "../lib/api-errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BinIcon } from "@/components/ui/bin-icon";
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
  // The URL is the source of truth, but the route guards can take a round
  // trip; show the requested tab at once and let the URL catch up.
  const [pendingTab, setPendingTab] = useState<AdminPeopleTab | null>(null);
  const shownTab = pendingTab ?? activeTab;

  const setTab = (tab: AdminPeopleTab) => {
    setPendingTab(tab);
    void navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      search: tab === "users" ? {} : { tab },
    }).finally(() => setPendingTab((current) => (current === tab ? null : current)));
  };

  return (
    <PageShell variant="workspace" density="compact">
      <Tabs
        value={shownTab}
        onValueChange={(value) => setTab(value as AdminPeopleTab)}
        className="gap-4"
      >
        <div className="border-b">
          <TabsList variant="line" aria-label="People and organizations">
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="signups">Sign-ups</TabsTrigger>
            <TabsTrigger value="organizations">Organizations</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="users" keepMounted>
          <UsersPanel />
        </TabsContent>
        <TabsContent value="signups" keepMounted>
          <SignupsPanel />
        </TabsContent>
        <TabsContent value="organizations" keepMounted>
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

  if (users.error && !users.data) {
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
  if (!users.data) {
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
  // A row's own action reports inside that row, named after the person. A
  // failure whose row left the list falls back to the section.
  const rowError = (entry: AdminListedUser): string | null => {
    if (finishCleanup.error && finishCleanup.variables?.userId === entry.id) {
      return `Could not finish cleanup for ${entry.name}: ${errorText(finishCleanup.error, "The user could not be updated.")}`;
    }
    if (
      confirmation === null &&
      revokeAccess.error &&
      revokeAccess.variables === entry.id
    ) {
      return `Could not finish revoking ${entry.name}: ${errorText(revokeAccess.error, "The user could not be updated.")}`;
    }
    return null;
  };
  const rowSuccess = (entry: AdminListedUser) =>
    finishCleanup.isSuccess && finishCleanup.variables?.userId === entry.id;
  const orphanError =
    (finishCleanup.error &&
    !filtered.some((entry) => entry.id === finishCleanup.variables?.userId)
      ? finishCleanup.error
      : null) ??
    (confirmation === null &&
    revokeAccess.error &&
    !filtered.some((entry) => entry.id === revokeAccess.variables)
      ? revokeAccess.error
      : null);
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
        {users.error ? (
          <Alert>
            <AlertTitle>Users may be out of date</AlertTitle>
            <AlertDescription>
              The last loaded users are shown.{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void users.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {entries.length ? (
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchLabel="Search users"
            searchPlaceholder="Search by name, email, or GitHub handle…"
            filtersActive={needle.length > 0}
            onClear={() => setSearch("")}
          />
        ) : null}

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
                  const problem = rowError(entry);
                  return (
                    <div key={entry.id} className="py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
                                <code>@{entry.username}</code>
                              ) : null}
                              {isAdmin ? (
                                <Badge variant="secondary">Admin</Badge>
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
                            <p className="text-caption">
                              Flag targeting key: <code>{entry.id}</code>
                            </p>
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {revoked ? (
                            cleanupUnfinished && entry.revocationId !== null ? (
                              <Button
                                size="sm"
                                variant="outline"
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
                                <RefreshCw />
                                {finishing ? "Finishing cleanup…" : "Finish cleanup"}
                              </Button>
                            ) : null
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                  openConfirmation({
                                    entry,
                                    kind: "role",
                                    nextRole: isAdmin ? "user" : "admin",
                                  })
                                }
                              >
                                <ShieldCheck />
                                {isAdmin ? "Make user" : "Make admin"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground hover:text-destructive"
                                disabled={busy}
                                onClick={() =>
                                  openConfirmation({ entry, kind: "revoke" })
                                }
                              >
                                <Ban />
                                Revoke access
                              </Button>
                            </>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            onClick={() =>
                              openConfirmation({ entry, kind: "delete" })
                            }
                          >
                            <BinIcon />
                            Delete
                          </Button>
                        </div>
                      </div>
                    {problem ? (
                      <InlineFeedback tone="error" className="mt-2">
                        {problem}
                      </InlineFeedback>
                    ) : rowSuccess(entry) ? (
                      <InlineFeedback tone="success" className="mt-2">
                        Cleanup finished for {entry.name}.
                      </InlineFeedback>
                    ) : null}
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

        {orphanError ? (
          <InlineFeedback tone="error">
            {errorText(orphanError, "The user could not be updated.")}
          </InlineFeedback>
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
              {errorText(
                dialogError,
                confirmation?.kind === "revoke"
                  ? "Access could not be revoked."
                  : confirmation?.kind === "role"
                    ? "The role could not be changed."
                    : "The user could not be deleted.",
              )}
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
                confirmation?.kind === "role" &&
                confirmation.nextRole === "admin"
                  ? "default"
                  : "danger"
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
                ? "Deleting user…"
                : revokeAccess.isPending
                  ? "Revoking access…"
                  : setRole.isPending
                    ? confirmation?.nextRole === "admin"
                      ? "Granting admin…"
                      : "Removing admin…"
                    : confirmation?.kind === "delete"
                      ? "Delete user"
                      : confirmation?.kind === "revoke"
                        ? "Revoke access"
                        : confirmation?.nextRole === "admin"
                          ? "Grant admin"
                          : "Remove admin"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function errorText(error: unknown, fallback: string): string {
  return apiErrorMessage(error, fallback) ?? fallback;
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
  const lastManaged = useRef<AdminOrganizationRow | null>(null);
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

  if (organizations.error && !organizations.data) {
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
  if (!organizations.data) {
    return <TableSkeleton />;
  }

  const entries = organizations.data.organizations;
  const managed = entries.find((entry) => entry.id === managedId) ?? null;
  // Keep the last organization so the sheet plays its exit.
  if (managed && lastManaged.current !== managed) lastManaged.current = managed;
  const sheetOrganization = managed ?? lastManaged.current;

  return (
    <Section
      density="compact"
      title="Organizations"
      description="Organization ownership, roster size, and assignment counts. Owners manage lifecycle from their workspace because deletion is blocked while owned resources exist. Sign-in approvals and removed people are managed here without membership."
    >
      {organizations.error ? (
        <Alert>
          <AlertTitle>Organizations may be out of date</AlertTitle>
          <AlertDescription>
            The last loaded organizations are shown.{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void organizations.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
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
                        <p className="text-sm font-semibold">
                          {organization.name}
                        </p>
                        <p className="text-caption">
                          <code>{organization.slug}</code>
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {organization.owner ? (
                        <>
                          {organization.owner.name}
                          {organization.owner.username ? (
                            <code className="ml-1.5">
                              @{organization.owner.username}
                            </code>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {organization.memberCount || "—"}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {organization.assignmentCount || "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {organization.oidc || organization.removedMemberCount ? (
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-sm">
                              {organization.oidc ? (
                                <code>{organization.oidc.domain}</code>
                              ) : (
                                "No provider"
                              )}
                            </p>
                            <p className="text-caption">
                              {organizationSignInSummary(organization)}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Manage sign-in for ${organization.name}`}
                            onClick={() => setManagedId(organization.id)}
                          >
                            Manage
                          </Button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-metadata">
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
      {sheetOrganization ? (
        <OrganizationAccessSheet
          organization={sheetOrganization}
          open={managed !== null}
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
function OrganizationAccessSheet({
  organization,
  open,
  onClose,
}: {
  organization: AdminOrganizationRow;
  open: boolean;
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
  // The sheet stays mounted to play its exit, so its mutations would carry a
  // failure into the next opening, or the next organization. Each opening
  // starts clean.
  const { reset: resetPolicy } = setPolicy;
  const { reset: resetRestore } = restore;
  useLayoutEffect(() => {
    if (!open) return;
    resetPolicy();
    resetRestore();
  }, [open, organization.id, resetPolicy, resetRestore]);
  const actionError = setPolicy.error ?? restore.error;
  const oidc = organization.oidc;
  const removedMembers = removed.data?.removedMembers ?? [];

  return (
    <SideSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${organization.name} sign-in`}
      description="Changes apply to the organization's next sign-ins."
      data-organization-access-sheet
    >
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
    </SideSheet>
  );
}
