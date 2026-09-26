import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Ban, RefreshCw, RotateCcw, TriangleAlert, UserX } from "lucide-react";
import {
  HttpResponseError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";
import { formatTimestamp } from "@/components/app/lib/format";
import { ConfirmDialog } from "@/components/app/patterns/ConfirmDialog";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { RelativeTime } from "@/components/app/patterns/RelativeTime";
import { Section } from "@/components/app/patterns/Section";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  restorePreview,
  type PlatformUserAccessEvent,
  type PlatformUserDetails,
  type PlatformUserSignInMethod,
  type RestorePreview,
  type SignInMethodBlocker,
} from "@/lib/platform-user-details";
import {
  ADMIN_SIGNUPS_KEY,
  ADMIN_USERS_KEY,
  adminUserKey,
  fetchPlatformUserDetails,
  finishRevocationCleanup,
  restoreErrorMessage,
  restoreUserAccess,
  revokeAccessDescription,
  revokeUserAccess,
} from "./user-access";

export function AdminUserDetails() {
  const { userId } = useParams({ from: "/app/admin/people/$userId" });
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"restore" | "revoke" | null>(null);

  const details = useQuery({
    queryKey: adminUserKey(userId),
    queryFn: () => fetchPlatformUserDetails(userId),
    staleTime: 5_000,
    retry: retryHttpResponseError,
  });

  // Access changes free or take a sign-up spot. Refresh after failures too:
  // a revocation may be committed even when its cleanup didn't finish.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_SIGNUPS_KEY }),
    ]);

  const revoke = useMutation({
    mutationFn: () => revokeUserAccess(userId),
    onSuccess: () => setDialog(null),
    onSettled: refresh,
  });
  const finishCleanup = useMutation({
    mutationFn: (revocationId: string) =>
      finishRevocationCleanup(userId, revocationId),
    onSettled: refresh,
  });
  const restore = useMutation({
    mutationFn: (revocationId: string) =>
      restoreUserAccess(userId, revocationId),
    onSuccess: () => setDialog(null),
    onSettled: refresh,
  });

  const person = details.data ?? null;
  const preview = useMemo(
    () => (person ? restorePreview(person) : null),
    [person],
  );
  const busy = revoke.isPending || finishCleanup.isPending || restore.isPending;

  const { reset: resetRevoke } = revoke;
  const { reset: resetFinish, mutate: finish } = finishCleanup;
  const { reset: resetRestore } = restore;
  const { refetch } = details;

  const revocation = person?.revocation ?? null;
  usePageChrome({
    title: person?.name,
    status: useMemo(
      () =>
        person ? (
          <Badge
            variant={person.access === "active" ? "success" : "destructive"}
            className="hidden sm:inline-flex"
          >
            {person.access === "active" ? "Active" : "Access revoked"}
          </Badge>
        ) : undefined,
      [person],
    ),
    action: useMemo(() => {
      if (!person) return undefined;
      const resetFeedback = () => {
        resetRevoke();
        resetFinish();
        resetRestore();
      };
      if (person.access === "active") {
        return (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              resetFeedback();
              setDialog("revoke");
            }}
          >
            <Ban className="size-3.5" />
            Revoke access
          </Button>
        );
      }
      if (!revocation) return undefined;
      if (revocation.cleanup !== "completed") {
        return (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              resetFeedback();
              finish(revocation.revocationId);
            }}
          >
            <RefreshCw className="size-3.5" />
            {finishCleanup.isPending ? "Finishing…" : "Finish cleanup"}
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            resetFeedback();
            setDialog("restore");
            // Confirm against what is true now, not what the page loaded with.
            void refetch();
          }}
        >
          <RotateCcw className="size-3.5" />
          Restore access
        </Button>
      );
    }, [
      person,
      revocation,
      busy,
      finishCleanup.isPending,
      finish,
      refetch,
      resetFinish,
      resetRestore,
      resetRevoke,
    ]),
  });

  if (details.error) {
    if (details.error instanceof HttpResponseError && details.error.status === 404) {
      return (
        <PageShell variant="workspace" density="compact">
          <EmptyState
            icon={<UserX />}
            title="User not found"
            description="They may have been deleted, or the link is wrong."
            action={
              <Link
                to="/admin/people"
                className={buttonVariants({
                  variant: "outline",
                  className: "min-h-11 sm:min-h-9",
                })}
              >
                Back to people
              </Link>
            }
          />
        </PageShell>
      );
    }
    return (
      <PageShell variant="workspace" density="compact">
        <ErrorState
          title="Could not load this user"
          description={
            details.error instanceof Error
              ? details.error.message
              : "The user could not be loaded"
          }
          onRetry={() => void details.refetch()}
        />
      </PageShell>
    );
  }

  if (!person || !preview) {
    return (
      <PageShell variant="workspace" density="compact">
        <div role="status" className="space-y-4">
          <span className="sr-only">Loading…</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-64 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </PageShell>
    );
  }

  const mutationError = revoke.error ?? finishCleanup.error ?? null;
  const restoredServersPending = restore.data?.serversPendingCleanup ?? 0;

  return (
    <PageShell variant="workspace" density="compact">
      <ContentHeader
        title={
          <span className="inline-flex items-center gap-3">
            <Avatar>
              {person.image ? <AvatarImage src={person.image} alt="" /> : null}
              <AvatarFallback>
                {(person.name || person.username || "?").slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {person.name}
          </span>
        }
        meta={
          <MetaLine
            items={[
              person.email,
              person.role === "admin" ? "Admin" : "User",
              person.username ? `@${person.username}` : null,
            ]}
          />
        }
      />

      {mutationError ? (
        <InlineFeedback tone="error">
          {mutationError instanceof Error
            ? mutationError.message
            : "The user could not be updated"}
        </InlineFeedback>
      ) : restore.isSuccess ? (
        <InlineFeedback tone="success">
          {restoredServersPending > 0
            ? `Access restored. Removing ${restoredServersPending === 1 ? "one of their servers" : `${restoredServersPending} of their servers`} didn't finish; they can remove it again from My servers.`
            : "Access restored."}
        </InlineFeedback>
      ) : finishCleanup.isSuccess ? (
        <InlineFeedback tone="success">Cleanup finished.</InlineFeedback>
      ) : revoke.isSuccess ? (
        <InlineFeedback tone="success">Access revoked.</InlineFeedback>
      ) : null}

      <Section density="compact" title="Account">
        <dl className="grid gap-4 sm:grid-cols-2">
          <MetaRow label="Signed up with" value={signedUpWith(person)} />
          <MetaRow label="Joined" value={formatTimestamp(person.createdAt)} />
          <MetaRow
            label="GitHub handle"
            value={person.username ? `@${person.username}` : "Not connected"}
          />
          <MetaRow label="Flag targeting key" value={person.id} mono />
        </dl>
      </Section>

      <Section density="compact" title="Access">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-label">Access</dt>
            <dd className="mt-1">
              <StatusToken
                tone={person.access === "active" ? "success" : "danger"}
                word={person.access === "active" ? "Active" : "Access revoked"}
              />
            </dd>
          </div>
          <div>
            <dt className="text-label">Sign-in</dt>
            <dd className="mt-1 text-sm font-medium">{signInSummary(person)}</dd>
          </div>
          {revocation ? (
            <>
              <div>
                <dt className="text-label">Revoked</dt>
                <dd className="mt-1 text-sm font-medium">
                  <RelativeTime at={revocation.revokedAt} />
                  {revocation.revokedBy ? ` by ${revocation.revokedBy.name}` : null}
                  {revocation.reason === "admin_deleted"
                    ? " · to delete the account"
                    : null}
                </dd>
              </div>
              <div>
                <dt className="text-label">Cleanup</dt>
                <dd className="mt-1 text-sm font-medium">
                  {revocation.cleanup === "completed" &&
                  revocation.cleanupCompletedAt !== null ? (
                    <>
                      Finished <RelativeTime at={revocation.cleanupCompletedAt} />
                    </>
                  ) : revocation.cleanup === "running" &&
                    revocation.cleanupStartedAt !== null ? (
                    <>
                      Started <RelativeTime at={revocation.cleanupStartedAt} /> and
                      hasn't finished. Finish it before restoring access.
                    </>
                  ) : (
                    "Unfinished. Finish it before restoring access."
                  )}
                </dd>
              </div>
            </>
          ) : person.access === "revoked" ? (
            <div className="sm:col-span-2">
              <dt className="text-label">Revocation</dt>
              <dd className="mt-1 text-sm">
                There's no revocation record, so access can't be restored here.
              </dd>
            </div>
          ) : null}
        </dl>
      </Section>

      <Section
        density="compact"
        title="Sign-in methods"
        description={`Each way ${person.name} can sign in, and whether it works.`}
      >
        <SignInMethodList person={person} preview={preview} />
      </Section>

      <Section
        density="compact"
        title="Organizations"
        description="Organization admins manage memberships. Platform admins restore removed people from the Organizations tab."
      >
        <OrganizationLists person={person} />
      </Section>

      <Section density="compact" title="Access history">
        <AccessHistoryList history={person.history} />
      </Section>

      <ConfirmDialog
        open={dialog === "revoke"}
        onClose={() => setDialog(null)}
        title="Revoke access?"
        description={revokeAccessDescription(person)}
        error={
          revoke.error
            ? revoke.error instanceof Error
              ? revoke.error.message
              : "Access could not be revoked"
            : null
        }
        pending={revoke.isPending}
        confirmLabel="Revoke access"
        pendingLabel="Revoking…"
        cancelLabel="Keep access"
        onConfirm={() => revoke.mutate()}
      />

      <ConfirmDialog
        open={dialog === "restore"}
        onClose={() => setDialog(null)}
        title="Restore access?"
        description={
          preview.working.length
            ? `${person.name} can sign in again with the methods below and starts fresh.`
            : `${person.name} gets access back and starts fresh, but none of their sign-in methods works, so they still can't sign in.`
        }
        error={restore.error ? restoreErrorMessage(restore.error) : null}
        pending={restore.isPending}
        confirmLabel="Restore access"
        pendingLabel="Restoring…"
        confirmVariant="default"
        confirmDisabled={
          details.isFetching || preview.unavailable !== null || !revocation
        }
        contentClassName="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onConfirm={() => {
          if (revocation) restore.mutate(revocation.revocationId);
        }}
      >
        <RestoreAccessSummary person={person} preview={preview} />
      </ConfirmDialog>
    </PageShell>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function signedUpWith(person: PlatformUserDetails): string {
  if (person.origin.kind === "github") return "GitHub";
  return person.origin.organization
    ? `${person.origin.organization.name}'s identity provider`
    : "A deleted organization's identity provider";
}

/** Whether they can sign in now, and the main reason when they can't. */
export function signInSummary(person: PlatformUserDetails): string {
  if (person.access === "revoked") return "Can't sign in · access is revoked";
  if (person.canSignIn) return "Can sign in";
  if (!person.signInMethods.length) {
    return "Can't sign in · no sign-in method is connected";
  }
  if (
    person.role === "admin" &&
    person.signInMethods.every(
      (method) => method.blocker === "admin_requires_github",
    )
  ) {
    return "Can't sign in · platform admins sign in with GitHub only, and none is connected";
  }
  return "Can't sign in · none of their sign-in methods works";
}

const BLOCKER_TEXT: Record<SignInMethodBlocker, string> = {
  provider_removed: "Its identity provider was removed.",
  removed_from_organization:
    "The organization removed them. It stays until an admin restores them.",
  admin_requires_github: "Platform admins sign in with GitHub only.",
};

function methodTitle(
  method: PlatformUserSignInMethod,
  username: string | null,
): ReactNode {
  if (method.kind === "github") {
    return (
      <>
        GitHub
        {username ? (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            @{username}
          </span>
        ) : null}
      </>
    );
  }
  return method.organization?.name ?? "Removed identity provider";
}

function methodStatus(
  person: PlatformUserDetails,
  method: PlatformUserSignInMethod,
): { tone: "success" | "danger" | "muted"; word: string; reason: string | null } {
  if (person.access === "revoked") {
    // A restore makes them a user, so admins' GitHub-only rule lifts.
    return method.blocker === null || method.blocker === "admin_requires_github"
      ? { tone: "muted", word: "Works after restore", reason: null }
      : { tone: "danger", word: "Doesn't work", reason: BLOCKER_TEXT[method.blocker] };
  }
  return method.blocker === null
    ? { tone: "success", word: "Works", reason: null }
    : { tone: "danger", word: "Doesn't work", reason: BLOCKER_TEXT[method.blocker] };
}

export function SignInMethodList({
  person,
  preview,
}: {
  person: PlatformUserDetails;
  preview: RestorePreview;
}) {
  if (!person.signInMethods.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No sign-in method is connected, so they can't sign in.
      </p>
    );
  }
  const late = new Set(preview.linkedAfterRevocation);
  return (
    <ul className="divide-y overflow-hidden rounded-lg border">
      {person.signInMethods.map((method) => {
        const status = methodStatus(person, method);
        return (
          <li
            key={method.providerId}
            className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">
                {methodTitle(method, person.username)}
              </p>
              <p className="text-caption">
                {method.kind === "github" ? "GitHub sign-in" : "Organization sign-in"}
                {" · connected "}
                <RelativeTime at={method.linkedAt} />
                {status.reason ? ` · ${status.reason}` : null}
              </p>
              {late.has(method) ? (
                <p className="flex items-center gap-1.5 text-caption text-warning">
                  <TriangleAlert aria-hidden="true" className="size-3.5" />
                  Connected after access was revoked.
                </p>
              ) : null}
            </div>
            <StatusToken tone={status.tone} word={status.word} />
          </li>
        );
      })}
    </ul>
  );
}

function OrganizationLists({ person }: { person: PlatformUserDetails }) {
  if (!person.memberships.length && !person.removals.length) {
    return (
      <p className="text-sm text-muted-foreground">
        They aren't in any organization.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {person.memberships.length ? (
        <div className="space-y-2">
          <h3 className="text-label">Member of</h3>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {person.memberships.map((membership) => (
              <li key={membership.organization.id} className="px-3 py-2">
                <p className="text-sm font-medium">{membership.organization.name}</p>
                <p className="text-caption">
                  {capitalize(membership.role)}
                  {membership.soleOwner ? " · only owner" : null}
                  {" · joined "}
                  <RelativeTime at={membership.joinedAt} />
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {person.removals.length ? (
        <div className="space-y-2">
          <h3 className="text-label">Removed from</h3>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {person.removals.map((removal) => (
              <li key={removal.organization.id} className="px-3 py-2">
                <p className="text-sm font-medium">{removal.organization.name}</p>
                <p className="text-caption">
                  Removed <RelativeTime at={removal.removedAt} />
                  {removal.removedBy ? ` by ${removal.removedBy.name}` : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Readable text for an access event. */
export function accessEventLabel(event: PlatformUserAccessEvent): string {
  switch (event.type) {
    case "access.blocked":
      return event.reason === "admin_deleted"
        ? "Access revoked to delete the account"
        : "Access revoked";
    case "access.restored":
      return "Access restored";
    case "access.revocation_cleanup_completed":
      return "Revocation cleanup finished";
    case "access.revocation_cleanup_failed":
      return "Revocation cleanup failed";
    case "access.revocation_cleanup_stalled":
      return "Revocation cleanup stopped partway";
    case "run.deleted_by_admin":
      return "An admin deleted one of their runs";
    case "user.deleted":
      return "Account deleted";
    default:
      return "Access record changed";
  }
}

export function AccessHistoryList({
  history,
}: {
  history: PlatformUserDetails["history"];
}) {
  if (!history.events.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No access changes are recorded.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ol className="divide-y overflow-hidden rounded-lg border">
        {history.events.map((event) => {
          const failed =
            event.type === "access.revocation_cleanup_failed" ||
            event.type === "access.revocation_cleanup_stalled";
          return (
            <li key={event.id} className="px-3 py-2">
              <p className="text-sm font-medium">
                {accessEventLabel(event)}
                {failed && event.reason ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {event.reason}
                  </span>
                ) : null}
              </p>
              <p className="text-caption">
                {event.actor ? `by ${event.actor.name} · ` : null}
                <RelativeTime at={event.at} />
              </p>
            </li>
          );
        })}
      </ol>
      {history.truncated ? (
        <p className="text-caption">Showing the 50 most recent events.</p>
      ) : null}
    </div>
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

export function RestoreAccessSummary({
  person,
  preview,
}: {
  person: PlatformUserDetails;
  preview: RestorePreview;
}) {
  const late = new Set(preview.linkedAfterRevocation);
  const consequences = [
    person.role === "admin"
      ? "They lose the admin role and come back as a user."
      : null,
    person.sshKeyCount
      ? `${capitalize(plural(person.sshKeyCount, "their SSH key is", "SSH keys are"))} removed.`
      : null,
    person.appCount
      ? `${capitalize(plural(person.appCount, "their app is", "apps are"))} deleted, with the access other people gave ${person.appCount === 1 ? "it" : "them"}.`
      : null,
    preview.removedMemberships.length
      ? `They leave ${listNames(preview.removedMemberships.map((membership) => membership.organization.name))}. An organization whose sign-in they use may add them back when they sign in there.`
      : null,
    preview.keptMemberships.length
      ? `They stay the owner of ${listNames(preview.keptMemberships.map((membership) => membership.organization.name))}, which has no other owner.`
      : null,
    "Their personal servers are retired, and new runs use Intar's cloud.",
    "They take a sign-up spot again.",
    "Ended sessions, app access, and runs don't come back.",
  ].filter((line): line is string => line !== null);

  return (
    <div className="space-y-3 text-sm">
      {preview.working.length ? (
        <div className="space-y-1.5">
          <h3 className="text-label">Will work again</h3>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {preview.working.map((method) => (
              <li key={method.providerId} className="px-3 py-2">
                <p className="font-medium">{methodTitle(method, person.username)}</p>
                <p className="text-caption">
                  Connected {formatTimestamp(method.linkedAt)}
                </p>
                {late.has(method) ? (
                  <p className="flex items-center gap-1.5 text-caption text-warning">
                    <TriangleAlert aria-hidden="true" className="size-3.5" />
                    Connected after access was revoked. Check that it's theirs.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.notWorking.length ? (
        <div className="space-y-1.5">
          <h3 className="text-label">Still won't work</h3>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {preview.notWorking.map((method) => (
              <li key={method.providerId} className="px-3 py-2">
                <p className="font-medium">{methodTitle(method, person.username)}</p>
                <p className="text-caption">
                  {method.blocker ? BLOCKER_TEXT[method.blocker] : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <h3 className="text-label">After you restore</h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {consequences.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function MetaRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-label">{props.label}</dt>
      <dd
        className={
          props.mono
            ? "mt-1 font-mono text-xs break-all"
            : "mt-1 text-sm font-medium break-words"
        }
      >
        {props.value}
      </dd>
    </div>
  );
}
