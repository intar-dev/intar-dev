import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  Check,
  Clipboard,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  TicketPlus,
  Trash2,
  Undo2,
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

type InviteState = "pending" | "leased" | "redeemed" | "revoked";
type InviteKind = "standard" | "bootstrap_admin";

interface AdminInvite {
  id: string;
  codePrefix: string;
  kind: InviteKind;
  state: InviteState;
  label: string | null;
  createdAt: number;
  expiresAt: number;
  leaseExpiresAt: number | null;
  redeemedAt: number | null;
  revokedAt: number | null;
  redeemerGithubUsername: string | null;
  version: number;
}

interface BetaUser {
  userId: string;
  state: "active" | "blocked";
  githubUsername: string;
  grantedAt: number;
  revokedAt: number | null;
  revocationReason: string | null;
  role: string | null;
  revocationId: string | null;
}

interface AdminAccessResponse {
  invites: AdminInvite[];
  betaUsers: BetaUser[];
}

interface OneTimeInvite {
  invite: AdminInvite;
  inviteUrl: string;
}

type InviteAction =
  | { kind: "replace"; invite: AdminInvite }
  | { kind: "revoke"; invite: AdminInvite }
  | { kind: "remove"; invite: AdminInvite };

type BetaUserAction =
  | { kind: "revoke"; user: BetaUser }
  | { kind: "allow-reinvite"; user: BetaUser };

export function BetaAccessPanel() {
  const queryClient = useQueryClient();
  const createInviteButton = useRef<HTMLButtonElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [oneTimeInvite, setOneTimeInvite] =
    useState<OneTimeInvite | null>(null);
  const [inviteAction, setInviteAction] = useState<InviteAction | null>(null);
  const [betaUserAction, setBetaUserAction] =
    useState<BetaUserAction | null>(null);
  const [reason, setReason] = useState("");
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});
  const [copyFeedback, setCopyFeedback] = useState<{
    inviteId: string;
    message: string;
    tone: "success" | "error";
  } | null>(null);

  const access = useQuery({
    queryKey: ["admin", "beta-access"],
    queryFn: () =>
      apiJson<AdminAccessResponse>("/api/admin/access-invites", {
        method: "GET",
      }),
    staleTime: 5_000,
  });

  const refreshAccess = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "beta-access"] });
  };

  const createInvite = useMutation({
    mutationFn: () =>
      apiJson<OneTimeInvite>("/api/admin/access-invites", {
        method: "POST",
        body: JSON.stringify({
          label: label.trim() || null,
        }),
      }),
    onSuccess: async (result) => {
      setCreateOpen(false);
      setLabel("");
      setInviteLinks((current) => ({
        ...current,
        [result.invite.id]: result.inviteUrl,
      }));
      setCopyFeedback(null);
      setOneTimeInvite(result);
      await refreshAccess();
    },
  });

  const replaceInvite = useMutation({
    mutationFn: (invite: AdminInvite) =>
      apiJson<OneTimeInvite>(
        `/api/admin/access-invites/${encodeURIComponent(invite.id)}/replace`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: invite.version }),
        },
      ),
    onSuccess: async (result, replacedInvite) => {
      setInviteAction(null);
      setReason("");
      setInviteLinks((current) => {
        const next = { ...current };
        delete next[replacedInvite.id];
        next[result.invite.id] = result.inviteUrl;
        return next;
      });
      setCopyFeedback(null);
      setOneTimeInvite(result);
      await refreshAccess();
    },
  });

  const revokeInvite = useMutation({
    mutationFn: ({ invite, reason }: { invite: AdminInvite; reason: string }) =>
      apiJson<void>(
        `/api/admin/access-invites/${encodeURIComponent(invite.id)}/revoke`,
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            expectedVersion: invite.version,
          }),
        },
      ),
    onSuccess: async (_result, { invite }) => {
      setInviteAction(null);
      setReason("");
      setInviteLinks((current) => {
        const next = { ...current };
        delete next[invite.id];
        return next;
      });
      setCopyFeedback(null);
      await refreshAccess();
    },
  });

  const removeInvite = useMutation({
    mutationFn: (invite: AdminInvite) =>
      apiJson<void>(
        `/api/admin/access-invites/${encodeURIComponent(invite.id)}/remove`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: invite.version }),
        },
      ),
    onMutate: () => setRemovalNotice(null),
    onSuccess: async (_result, invite) => {
      setInviteAction(null);
      setReason("");
      setInviteLinks((current) => {
        const next = { ...current };
        delete next[invite.id];
        return next;
      });
      setCopyFeedback(null);
      setRemovalNotice(
        `${invite.codePrefix}… was removed from this list. Its audit history was retained.`,
      );
      await refreshAccess();
      requestAnimationFrame(() => createInviteButton.current?.focus());
    },
  });

  const updateBetaUser = useMutation({
    mutationFn: ({ action, reason }: { action: BetaUserAction; reason: string }) =>
      apiJson<void>(
        action.kind === "revoke"
          ? `/api/admin/beta-users/${encodeURIComponent(action.user.userId)}/revoke`
          : `/api/admin/beta-users/${encodeURIComponent(action.user.userId)}/allow-reinvite`,
        {
          method: "POST",
          body: JSON.stringify(
            action.kind === "revoke"
              ? { reason }
              : { revocationId: action.user.revocationId },
          ),
        },
      ),
    onSuccess: async () => {
      setBetaUserAction(null);
      setReason("");
      await refreshAccess();
    },
  });

  if (access.error) {
    return (
      <ErrorState
        title="Could not load beta access"
        description={errorMessage(access.error, "Failed to load beta access")}
        onRetry={() => void access.refetch()}
      />
    );
  }

  if (access.isPending) {
    return <TableSkeleton />;
  }

  const invites = access.data.invites;
  const betaUsers = access.data.betaUsers;
  const actionError =
    createInvite.error ??
    replaceInvite.error ??
    revokeInvite.error ??
    removeInvite.error ??
    updateBetaUser.error;
  const actionPending =
    replaceInvite.isPending ||
    revokeInvite.isPending ||
    removeInvite.isPending ||
    updateBetaUser.isPending;

  const copyInviteLink = async (invite: AdminInvite) => {
    const inviteUrl = inviteLinks[invite.id];
    if (!inviteUrl) return;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyFeedback({
        inviteId: invite.id,
        message: `${invite.codePrefix}… link copied.`,
        tone: "success",
      });
    } catch {
      setCopyFeedback({
        inviteId: invite.id,
        message: `${invite.codePrefix}… link could not be copied.`,
        tone: "error",
      });
    }
  };

  return (
    <div className="space-y-4">
      <Section
        density="compact"
        title="Beta invite codes"
        description="New single-use bearer links expire after 14 days. Links created on this page remain copyable until you leave or refresh; the server stores only a safe code prefix."
        actions={
          <Button
            ref={createInviteButton}
            size="sm"
            onClick={() => {
              createInvite.reset();
              setRemovalNotice(null);
              setCreateOpen(true);
            }}
          >
            <TicketPlus />
            Create invite
          </Button>
        }
      >
        {invites.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Lifetime</TableHead>
                <TableHead>Redeemer</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>
                    <div className="space-y-1">
                      <p className="font-mono text-xs">
                        {invite.codePrefix}…
                      </p>
                      <p className="text-caption">
                        {invite.kind === "bootstrap_admin"
                          ? "Bootstrap admin"
                          : "Standard"}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <InviteStateBadge state={invite.state} />
                    {invite.state === "leased" && invite.leaseExpiresAt ? (
                      <p className="mt-1 text-caption">
                        Lease ends {formatRelativeTime(invite.leaseExpiresAt)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-56 whitespace-normal">
                    <p className="text-sm">{invite.label ?? "—"}</p>
                  </TableCell>
                  <TableCell>
                    <p className="text-xs">
                      Expires {formatRelativeTime(invite.expiresAt)}
                    </p>
                    <p className="text-caption">
                      Created {formatRelativeTime(invite.createdAt)}
                    </p>
                  </TableCell>
                  <TableCell>
                    {invite.redeemerGithubUsername ? (
                      <span className="font-mono text-xs">
                        @{invite.redeemerGithubUsername}
                      </span>
                    ) : (
                      <span className="text-caption">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {invite.state === "pending" ||
                      invite.state === "leased" ? (
                        <>
                          {inviteLinks[invite.id] ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={actionPending}
                              onClick={() => void copyInviteLink(invite)}
                            >
                              {copyFeedback?.inviteId === invite.id &&
                              copyFeedback.tone === "success" ? (
                                <Check />
                              ) : (
                                <Clipboard />
                              )}
                              Copy link
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionPending}
                            onClick={() => {
                              setReason("");
                              setInviteAction({ kind: "replace", invite });
                            }}
                          >
                            <RefreshCw />
                            Replace
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={actionPending}
                            onClick={() => {
                              setReason("");
                              setInviteAction({ kind: "revoke", invite });
                            }}
                          >
                            <Ban />
                            Revoke
                          </Button>
                        </>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={actionPending}
                        onClick={() => {
                          setReason("");
                          setRemovalNotice(null);
                          setInviteAction({ kind: "remove", invite });
                        }}
                      >
                        <Trash2 />
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={<KeyRound />}
            title="No invite codes"
            description="Create a code when you are ready to admit one beta user."
          />
        )}
        {copyFeedback ? (
          <InlineFeedback tone={copyFeedback.tone} className="mt-3">
            {copyFeedback.message}
          </InlineFeedback>
        ) : null}
      </Section>

      <Section
        density="compact"
        title="Beta users"
        description="Access is keyed to the Better Auth user and immutable GitHub account ID. A cleared block does not grant access; the person still needs a fresh invite."
      >
        {betaUsers.length ? (
          <div className="divide-y">
            {betaUsers.map((user) => (
              <div
                key={user.userId}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-semibold">
                      @{user.githubUsername}
                    </p>
                    <Badge
                      variant={user.state === "active" ? "success" : "destructive"}
                    >
                      {user.state === "active" ? "Active" : "Blocked"}
                    </Badge>
                    {user.role === "admin" ? <Badge>Admin</Badge> : null}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {user.userId}
                  </p>
                  <p className="text-caption">
                    {user.state === "active"
                      ? `Granted ${formatRelativeTime(user.grantedAt)}`
                      : `${user.revocationReason ?? "Access revoked"}${
                          user.revokedAt
                            ? ` · ${formatRelativeTime(user.revokedAt)}`
                            : ""
                        }`}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={user.state === "active" ? "destructive" : "outline"}
                  disabled={actionPending}
                  onClick={() => {
                    setReason("");
                    setBetaUserAction({
                      kind: user.state === "active" ? "revoke" : "allow-reinvite",
                      user,
                    });
                  }}
                >
                  {user.state === "active" ? <Ban /> : <Undo2 />}
                  {user.state === "active" ? "Revoke access" : "Allow re-invite"}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ShieldCheck />}
            title="No beta users"
            description="A user appears here only after confirming an invite with GitHub."
          />
        )}
      </Section>

      {actionError ? (
        <InlineFeedback tone="error">
          {errorMessage(actionError, "The access change could not be completed")}
        </InlineFeedback>
      ) : null}

      {removalNotice ? (
        <InlineFeedback tone="success">{removalNotice}</InlineFeedback>
      ) : null}

      <CreateInviteDialog
        open={createOpen}
        label={label}
        pending={createInvite.isPending}
        error={createInvite.error}
        onLabelChange={setLabel}
        onOpenChange={(open) => {
          if (!createInvite.isPending) setCreateOpen(open);
        }}
        onCreate={() => createInvite.mutate()}
      />

      <OneTimeInviteDialog
        result={oneTimeInvite}
        onClose={() => {
          setOneTimeInvite(null);
          createInvite.reset();
          replaceInvite.reset();
        }}
      />

      <InviteActionDialog
        action={inviteAction}
        reason={reason}
        pending={
          replaceInvite.isPending ||
          revokeInvite.isPending ||
          removeInvite.isPending
        }
        error={
          replaceInvite.error ?? revokeInvite.error ?? removeInvite.error
        }
        onReasonChange={setReason}
        onClose={() => {
          if (
            !replaceInvite.isPending &&
            !revokeInvite.isPending &&
            !removeInvite.isPending
          ) {
            setInviteAction(null);
            setReason("");
          }
        }}
        onConfirm={() => {
          if (!inviteAction) return;
          if (inviteAction.kind === "replace") {
            replaceInvite.mutate(inviteAction.invite);
          } else if (inviteAction.kind === "remove") {
            removeInvite.mutate(inviteAction.invite);
          } else if (isValidReasonCode(reason)) {
            revokeInvite.mutate({
              invite: inviteAction.invite,
              reason: reason.trim(),
            });
          }
        }}
      />

      <BetaUserActionDialog
        action={betaUserAction}
        reason={reason}
        pending={updateBetaUser.isPending}
        error={updateBetaUser.error}
        onReasonChange={setReason}
        onClose={() => {
          if (!updateBetaUser.isPending) {
            setBetaUserAction(null);
            setReason("");
          }
        }}
        onConfirm={() => {
          if (!betaUserAction) return;
          if (
            betaUserAction.kind === "revoke" &&
            !isValidReasonCode(reason)
          ) {
            return;
          }
          updateBetaUser.mutate({
            action: betaUserAction,
            reason: reason.trim(),
          });
        }}
      />
    </div>
  );
}

function CreateInviteDialog({
  open,
  label,
  pending,
  error,
  onOpenChange,
  onLabelChange,
  onCreate,
}: {
  open: boolean;
  label: string;
  pending: boolean;
  error: unknown;
  onOpenChange: (open: boolean) => void;
  onLabelChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create beta invite</DialogTitle>
          <DialogDescription>
            This creates one unbound, single-use link that expires after 14
            days. Anyone holding it can begin the claim.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate();
          }}
        >
          <div className="space-y-2">
            <label htmlFor="invite-label" className="text-sm font-semibold">
              Label{" "}
              <span className="font-normal text-muted-foreground">
                Optional
              </span>
            </label>
            <Input
              id="invite-label"
              value={label}
              maxLength={80}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder="Workshop facilitator"
            />
          </div>
          <p className="text-caption">
            The label is administrative metadata only. It never authorizes
            access.
          </p>
          {error ? (
            <InlineFeedback tone="error">
              {errorMessage(error, "The invite could not be created")}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create single-use link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OneTimeInviteDialog({
  result,
  onClose,
}: {
  result: OneTimeInvite | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const close = () => {
    setCopied(false);
    setCopyError(false);
    onClose();
  };

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy this link</DialogTitle>
          <DialogDescription>
            The raw code is not stored on the server. After you close this
            window, you can copy the link from its list row until you leave or
            refresh this page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label htmlFor="one-time-invite" className="text-sm font-semibold">
            Beta invite link
          </label>
          <Input
            id="one-time-invite"
            readOnly
            value={result?.inviteUrl ?? ""}
            className="font-mono text-sm"
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          <p className="text-caption">
            Send it through a trusted channel. Do not paste it into tickets,
            logs, or analytics tools.
          </p>
          {copied ? (
            <InlineFeedback tone="success">Link copied.</InlineFeedback>
          ) : copyError ? (
            <InlineFeedback tone="error">
              Clipboard access was blocked. Select the whole link and copy it
              manually.
            </InlineFeedback>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button
            onClick={async () => {
              if (!result) return;
              try {
                await navigator.clipboard.writeText(result.inviteUrl);
                setCopyError(false);
                setCopied(true);
              } catch {
                setCopied(false);
                setCopyError(true);
              }
            }}
          >
            {copied ? <Check /> : <Clipboard />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteActionDialog({
  action,
  reason,
  pending,
  error,
  onReasonChange,
  onClose,
  onConfirm,
}: {
  action: InviteAction | null;
  reason: string;
  pending: boolean;
  error: unknown;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const replacing = action?.kind === "replace";
  const removing = action?.kind === "remove";
  const active =
    action?.invite.state === "pending" || action?.invite.state === "leased";
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {replacing
              ? "Replace this invite?"
              : removing
                ? "Remove this invite code?"
                : "Revoke this invite?"}
          </DialogTitle>
          <DialogDescription>
            {replacing
              ? "The current link and any active OAuth lease stop working immediately. A new raw link will be shown once."
              : removing
                ? active
                  ? "The link and any active sign-in attempt stop working immediately, then the code disappears from this list. Its audit history remains."
                  : action?.invite.state === "redeemed"
                    ? "The code disappears from this list, but its audit history remains and the redeemed user keeps beta access."
                    : "The code disappears from this list, but its audit history remains."
                : "The link and any active OAuth lease stop working immediately. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="font-mono text-xs">{action?.invite.codePrefix}…</p>
          <p className="mt-1 text-caption">
            {action?.invite.label ?? "Unlabelled invite"}
          </p>
        </div>
        {!replacing && !removing ? (
          <div className="space-y-2">
            <label htmlFor="invite-reason" className="text-sm font-semibold">
              Revocation reason code
            </label>
            <Input
              id="invite-reason"
              value={reason}
              maxLength={120}
              pattern="[a-z0-9][a-z0-9._:-]{0,119}"
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="link_shared_publicly"
            />
            <p className="text-caption">
              Lowercase letters, numbers, dots, underscores, colons, and
              hyphens only. Do not enter personal data.
            </p>
          </div>
        ) : null}
        {error ? (
          <InlineFeedback tone="error">
            {errorMessage(error, "The invite could not be updated")}
          </InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={replacing ? "default" : "destructive"}
            disabled={
              pending ||
              (!replacing && !removing && !isValidReasonCode(reason))
            }
            onClick={onConfirm}
          >
            {pending
              ? "Updating…"
              : replacing
                ? "Replace and show new link"
                : removing
                  ? "Remove from list"
                  : "Revoke invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BetaUserActionDialog({
  action,
  reason,
  pending,
  error,
  onReasonChange,
  onClose,
  onConfirm,
}: {
  action: BetaUserAction | null;
  reason: string;
  pending: boolean;
  error: unknown;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const revoking = action?.kind === "revoke";
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {revoking ? "Revoke beta access?" : "Allow a new invite?"}
          </DialogTitle>
          <DialogDescription>
            {revoking
              ? "Access is blocked first. Sessions, OAuth grants, personal routes, credentials, agents, and active personal runs are then cleaned up."
              : "This only clears the block. The user remains without beta access until they claim a fresh invite."}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/40 p-3">
          <p className="font-mono text-sm font-semibold">
            @{action?.user.githubUsername}
          </p>
          {action?.user.role === "admin" ? (
            <p className="mt-1 text-caption">
              Platform administrator — last-admin protection is enforced by the
              server.
            </p>
          ) : null}
        </div>
        {revoking ? (
          <div className="space-y-2">
            <label htmlFor="beta-reason" className="text-sm font-semibold">
              Revocation reason code
            </label>
            <Input
              id="beta-reason"
              value={reason}
              maxLength={120}
              pattern="[a-z0-9][a-z0-9._:-]{0,119}"
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="policy_violation"
            />
            <p className="text-caption">
              Use a normalized audit code and do not enter personal data.
            </p>
          </div>
        ) : null}
        {error ? (
          <InlineFeedback tone="error">
            {errorMessage(error, "The beta access change was rejected")}
          </InlineFeedback>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={revoking ? "destructive" : "default"}
            disabled={pending || (revoking && !isValidReasonCode(reason))}
            onClick={onConfirm}
          >
            {pending
              ? "Updating…"
              : revoking
                ? "Revoke beta access"
                : "Clear block only"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteStateBadge({ state }: { state: InviteState }) {
  switch (state) {
    case "pending":
      return <Badge variant="success">Pending</Badge>;
    case "leased":
      return <Badge variant="warning">Leased</Badge>;
    case "redeemed":
      return <Badge variant="outline">Redeemed</Badge>;
    case "revoked":
      return <Badge variant="destructive">Revoked</Badge>;
  }
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isValidReasonCode(value: string) {
  return REASON_CODE_PATTERN.test(value.trim());
}
