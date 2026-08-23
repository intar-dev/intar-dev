import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  ChevronDown,
  Clipboard,
  History,
  KeyRound,
  ShieldCheck,
  TicketPlus,
} from "lucide-react";
import { formatRelativeTime } from "../../lib/format";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { TableSkeleton } from "../../patterns/Skeletons";
import { EmptyState, ErrorState } from "../../patterns/StateCard";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type InviteState = "active" | "expired" | "redeemed" | "revoked";

interface AdminInvite {
  id: string;
  codePrefix: string;
  state: InviteState;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  redeemerGithubUsername: string | null;
  version: number;
}

interface BetaUser {
  userId: string;
  name: string | null;
  role: string | null;
  state: "active" | "revoked";
  githubUsername: string;
  grantedAt: number;
  revokedAt: number | null;
  revocationCleanupCompletedAt: number | null;
}

interface BetaAccessResponse {
  invites: AdminInvite[];
  betaUsers: BetaUser[];
}

interface CopyResponse {
  inviteUrl: string;
}

type Feedback = {
  tone: "success" | "error";
  message: string;
} | null;

export function BetaAccessPanel() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [revokeInvite, setRevokeInvite] = useState<AdminInvite | null>(null);
  const [revokeUser, setRevokeUser] = useState<BetaUser | null>(null);

  const access = useQuery({
    queryKey: ["admin", "beta-access"],
    queryFn: () =>
      apiJson<BetaAccessResponse>("/api/admin/access-invites", {
        method: "GET",
      }),
    staleTime: 5_000,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "beta-access"] });

  const createInvite = useMutation({
    mutationFn: () =>
      apiJson<void>("/api/admin/access-invites", {
        method: "POST",
        body: "{}",
      }),
    onMutate: () => setFeedback(null),
    onSuccess: async () => {
      await refresh();
      setFeedback({
        tone: "success",
        message: "Invite created. It expires in 7 days.",
      });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (invite: AdminInvite) =>
      apiJson<void>(
        `/api/admin/access-invites/${encodeURIComponent(invite.id)}/revoke`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: invite.version }),
        },
      ),
    onSuccess: async () => {
      setRevokeInvite(null);
      await refresh();
      setFeedback({ tone: "success", message: "Invite revoked." });
    },
  });

  const revokeUserMutation = useMutation({
    mutationFn: (user: BetaUser) =>
      apiJson<void>(
        `/api/admin/beta-users/${encodeURIComponent(user.userId)}/revoke`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "admin_revoked" }),
        },
      ),
    onSuccess: async () => {
      setRevokeUser(null);
      await refresh();
      setFeedback({
        tone: "success",
        message: "Beta access revoked. A fresh invite can restore access.",
      });
    },
  });

  const copyInvite = async (invite: AdminInvite) => {
    setCopyingId(invite.id);
    setFeedback(null);
    try {
      const result = await apiJson<CopyResponse>(
        `/api/admin/access-invites/${encodeURIComponent(invite.id)}/copy`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: invite.version }),
        },
      );
      await copyText(result.inviteUrl);
      setFeedback({
        tone: "success",
        message: `${invite.codePrefix}… copied.`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message: errorMessage(error, "The invite link could not be copied."),
      });
    } finally {
      setCopyingId(null);
    }
  };

  if (access.error) {
    return (
      <ErrorState
        title="Could not load beta access"
        description={errorMessage(access.error, "Failed to load beta access")}
        onRetry={() => void access.refetch()}
      />
    );
  }
  if (access.isPending) return <TableSkeleton />;

  const activeInvites = access.data.invites.filter(
    (invite) => invite.state === "active",
  );
  const inviteHistory = access.data.invites.filter(
    (invite) => invite.state !== "active",
  );
  const activeUsers = access.data.betaUsers.filter(
    (user) => user.state === "active",
  );
  const revokedUsers = access.data.betaUsers.filter(
    (user) => user.state === "revoked",
  );
  const actionPending =
    copyingId !== null ||
    createInvite.isPending ||
    revokeInviteMutation.isPending ||
    revokeUserMutation.isPending;

  return (
    <div className="space-y-6">
      <Section
        density="compact"
        title="Invite links"
        description="Each link admits one GitHub account and expires after 7 days."
        actions={
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            disabled={actionPending}
            onClick={() => createInvite.mutate()}
          >
            <TicketPlus />
            {createInvite.isPending ? "Creating…" : "Create invite"}
          </Button>
        }
      >
        {activeInvites.length ? (
          <>
            <div className="divide-y lg:hidden">
              {activeInvites.map((invite) => (
                <div
                  key={invite.id}
                  className="space-y-4 py-4 first:pt-0 last:pb-0"
                >
                  <p className="font-mono text-sm font-semibold">
                    {invite.codePrefix}…
                  </p>
                  <dl className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <dt className="text-caption">Created</dt>
                      <dd className="mt-1">
                        {formatRelativeTime(invite.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-caption">Expires</dt>
                      <dd className="mt-1">
                        {formatRelativeTime(invite.expiresAt)}
                      </dd>
                    </div>
                  </dl>
                  <InviteActions
                    invite={invite}
                    copying={copyingId === invite.id}
                    disabled={actionPending}
                    mobile
                    onCopy={() => void copyInvite(invite)}
                    onRevoke={() => setRevokeInvite(invite)}
                  />
                </div>
              ))}
            </div>
            <div className="hidden lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Link</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeInvites.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell className="font-mono text-xs">
                        {invite.codePrefix}…
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatRelativeTime(invite.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatRelativeTime(invite.expiresAt)}
                      </TableCell>
                      <TableCell>
                        <InviteActions
                          invite={invite}
                          copying={copyingId === invite.id}
                          disabled={actionPending}
                          onCopy={() => void copyInvite(invite)}
                          onRevoke={() => setRevokeInvite(invite)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<KeyRound />}
            title="No active invites"
            description="Create a link when you are ready to admit someone."
          />
        )}

        {createInvite.error ? (
          <InlineFeedback tone="error" className="mt-3">
            {errorMessage(createInvite.error, "The invite could not be created.")}
          </InlineFeedback>
        ) : feedback ? (
          <InlineFeedback tone={feedback.tone} className="mt-3">
            {feedback.message}
          </InlineFeedback>
        ) : null}
      </Section>

      <Section
        density="compact"
        title="People with access"
        description="Access stays bound to the same Better Auth user and GitHub account."
      >
        {activeUsers.length ? (
          <div className="divide-y">
            {activeUsers.map((user) => (
              <div
                key={user.userId}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold">
                      @{user.githubUsername}
                    </p>
                    {user.role === "admin" ? <Badge>Admin</Badge> : null}
                  </div>
                  <p className="text-caption">
                    Access granted {formatRelativeTime(user.grantedAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-11 self-start text-muted-foreground hover:text-destructive sm:min-h-9 sm:self-auto"
                  disabled={actionPending}
                  onClick={() => setRevokeUser(user)}
                >
                  <Ban />
                  Revoke access
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ShieldCheck />}
            title="No active beta users"
            description="A person appears here after confirming an invite with GitHub."
          />
        )}
      </Section>

      <details className="group border-t pt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold marker:hidden">
          <History className="size-4 text-muted-foreground" />
          History
          <span className="font-normal text-muted-foreground">
            {inviteHistory.length + revokedUsers.length}
          </span>
          <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <div className="space-y-6 pt-4">
          <InviteHistory invites={inviteHistory} />
          <RevokedPeople users={revokedUsers} />
        </div>
      </details>

      <RevokeInviteDialog
        invite={revokeInvite}
        pending={revokeInviteMutation.isPending}
        error={revokeInviteMutation.error}
        onClose={() => !revokeInviteMutation.isPending && setRevokeInvite(null)}
        onConfirm={() => revokeInvite && revokeInviteMutation.mutate(revokeInvite)}
      />
      <RevokeUserDialog
        user={revokeUser}
        pending={revokeUserMutation.isPending}
        error={revokeUserMutation.error}
        onClose={() => !revokeUserMutation.isPending && setRevokeUser(null)}
        onConfirm={() => revokeUser && revokeUserMutation.mutate(revokeUser)}
      />
    </div>
  );
}

function InviteActions({
  invite,
  copying,
  disabled,
  mobile = false,
  onCopy,
  onRevoke,
}: {
  invite: AdminInvite;
  copying: boolean;
  disabled: boolean;
  mobile?: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  return (
    <div
      className={
        mobile
          ? "grid grid-cols-2 gap-2"
          : "flex flex-wrap justify-end gap-1.5"
      }
    >
      <Button
        size="sm"
        variant="outline"
        className={mobile ? "min-h-11 w-full" : undefined}
        disabled={disabled}
        onClick={onCopy}
        aria-label={`Copy ${invite.codePrefix} invite`}
      >
        {copying ? <Check /> : <Clipboard />}
        {copying ? "Copying…" : "Copy"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={
          mobile
            ? "min-h-11 w-full text-muted-foreground hover:text-destructive"
            : "text-muted-foreground hover:text-destructive"
        }
        disabled={disabled}
        onClick={onRevoke}
        aria-label={`Revoke ${invite.codePrefix} invite`}
      >
        <Ban />
        Revoke
      </Button>
    </div>
  );
}

function InviteHistory({ invites }: { invites: AdminInvite[] }) {
  if (!invites.length) {
    return <p className="text-caption">No completed invites.</p>;
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Invites</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Link</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Completed</TableHead>
            <TableHead>GitHub account</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invites.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell className="font-mono text-xs">
                {invite.codePrefix}…
              </TableCell>
              <TableCell>
                <InviteStateBadge state={invite.state} />
              </TableCell>
              <TableCell className="text-sm">
                {invite.completedAt
                  ? formatRelativeTime(invite.completedAt)
                  : "—"}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {invite.redeemerGithubUsername
                  ? `@${invite.redeemerGithubUsername}`
                  : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RevokedPeople({ users }: { users: BetaUser[] }) {
  if (!users.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Revoked access</h3>
      <div className="divide-y">
        {users.map((user) => (
          <div
            key={user.userId}
            className="flex flex-wrap items-center justify-between gap-2 py-3"
          >
            <span className="font-mono text-sm">@{user.githubUsername}</span>
            <span className="text-caption">
              {user.revokedAt
                ? formatRelativeTime(user.revokedAt)
                : "Access revoked"}
              {user.revocationCleanupCompletedAt ? " · Cleanup complete" : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RevokeInviteDialog({
  invite,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  invite: AdminInvite | null;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={invite !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this invite?</DialogTitle>
          <DialogDescription>
            The link stops working immediately and moves to History.
          </DialogDescription>
        </DialogHeader>
        <p className="font-mono text-sm">{invite?.codePrefix}…</p>
        {error ? (
          <InlineFeedback tone="error">
            {errorMessage(error, "The invite could not be revoked.")}
          </InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Keep invite
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Revoking…" : "Revoke invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeUserDialog({
  user,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  user: BetaUser | null;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke beta access?</DialogTitle>
          <DialogDescription>
            Sessions and personal runtime access are cleaned up. A fresh invite
            can restore access after cleanup finishes.
          </DialogDescription>
        </DialogHeader>
        <p className="font-mono text-sm">@{user?.githubUsername}</p>
        {user?.role === "admin" ? (
          <p className="text-caption">
            Last-admin protection is enforced by the server.
          </p>
        ) : null}
        {error ? (
          <InlineFeedback tone="error">
            {errorMessage(error, "Beta access could not be revoked.")}
          </InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Keep access
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Revoking…" : "Revoke access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteStateBadge({ state }: { state: InviteState }) {
  switch (state) {
    case "active":
      return null;
    case "expired":
      return <Badge variant="outline">Expired</Badge>;
    case "redeemed":
      return <Badge variant="success">Used</Badge>;
    case "revoked":
      return <Badge variant="destructive">Revoked</Badge>;
  }
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(value);
}

async function apiJson<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method !== "GET") headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | T
    | null;
  if (!response.ok) {
    const details = body as { error?: string; message?: string } | null;
    throw new Error(
      details?.error ??
        details?.message ??
        `Access operation failed (${response.status})`,
    );
  }
  return body as T;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
