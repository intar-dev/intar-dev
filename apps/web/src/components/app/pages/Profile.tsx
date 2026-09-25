import { useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import { ConfirmDialog } from "@/components/app/patterns/ConfirmDialog";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import { useCallbackErrorCode } from "@/components/app/hooks/useCallbackErrorCode";
import { useSession } from "@/components/app/hooks/useSession";
import { formatTimestamp } from "@/components/app/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { LinkedIdentity } from "@/lib/account-links";
import { appBootstrapQueryKey } from "@/lib/app-bootstrap";
import { AuthFlowError, connectGithub } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";
import { SSO_ERROR_MESSAGES } from "@/lib/organization-sso-errors";
import { MyServers } from "./MyServers";
import { fetchJson, mutationResponse } from "./organization-detail/types";
import { githubCallbackMessage } from "./sign-in-helpers";

// Link results return to Profile with an error code only; the message comes
// from here.
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  account_already_linked_to_different_user:
    "This GitHub account is already connected to another Intar account.",
  github_already_connected: "This account already has GitHub connected.",
  unable_to_link_account:
    "GitHub couldn't be connected. Make sure your GitHub email is verified.",
  impersonation_link_forbidden: SSO_ERROR_MESSAGES.impersonation_link_forbidden,
  session_not_fresh:
    "Connecting GitHub needs a recent sign-in. Sign out, sign in again, and connect it then.",
};

const DISCONNECT_ERROR_MESSAGES: Record<string, string> = {
  session_not_fresh:
    "Disconnecting needs a sign-in from the last day. Sign out, sign in again, and disconnect it then.",
  last_sign_in_method:
    "This is your last way to sign in. Connect another one before disconnecting it.",
  identity_removed:
    "An organization admin removed you, so this sign-in stays connected until they restore you.",
  identity_not_found: "This sign-in method is already disconnected.",
  impersonation_unlink_forbidden:
    "Stop impersonating before disconnecting sign-in methods.",
};

function disconnectErrorMessage(error: unknown): string {
  if (error instanceof HttpResponseError) {
    if (error.code && Object.hasOwn(DISCONNECT_ERROR_MESSAGES, error.code)) {
      return DISCONNECT_ERROR_MESSAGES[error.code]!;
    }
    // Signed out elsewhere, or the account lost access: trying again won't
    // help.
    if (error.status === 401) {
      return "You were signed out. Sign in again to change sign-in methods.";
    }
    if (error.status === 403) return "This account no longer has access.";
  }
  return "The sign-in method couldn't be disconnected. Try again.";
}

function connectErrorMessage(code: string | null): string {
  if (code && Object.hasOwn(CONNECT_ERROR_MESSAGES, code)) {
    return CONNECT_ERROR_MESSAGES[code]!;
  }
  return (
    githubCallbackMessage(code) ?? "GitHub couldn't be connected. Try again."
  );
}

interface UserSshKeyRecord {
  id: string;
  label: string | null;
  keyType: string;
  comment: string | null;
  publicKeyOpenssh: string;
  fingerprintSha256: string;
  createdAt: number;
}

interface ProfileSshKeysResponse {
  keys: UserSshKeyRecord[];
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

export function Profile() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [label, setLabel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const sshKeys = useQuery({
    queryKey: ["profile", "ssh-keys"],
    queryFn: async (): Promise<ProfileSshKeysResponse> => {
      const response = await fetch("/api/profile/ssh-keys", {
        method: "GET",
        credentials: "include",
      });

      const body = (await response.json().catch(() => null)) as
        | ProfileSshKeysResponse
        | { error?: string }
        | null;

      if (!response.ok || !body || !("keys" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : `Failed to load SSH keys (${response.status})`,
        );
      }

      return body;
    },
    staleTime: 10_000,
  });

  const addKey = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/profile/ssh-keys", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          label,
          publicKey,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        key?: UserSshKeyRecord;
        error?: string;
      } | null;

      if (!response.ok || !body?.key) {
        throw new Error(
          body?.error ?? `Failed to add SSH key (${response.status})`,
        );
      }

      return body.key;
    },
    onSuccess: async () => {
      setLabel("");
      setPublicKey("");
      setFormError(null);
      setFormNotice("Key saved. New native SSH routes can use it.");
      await queryClient.invalidateQueries({
        queryKey: ["profile", "ssh-keys"],
      });
    },
    onError: (error) => {
      setFormNotice(null);
      setFormError(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteKey = useMutation({
    mutationFn: async (keyId: string) => {
      const response = await fetch(
        `/api/profile/ssh-keys/${encodeURIComponent(keyId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      const body = (await response.json().catch(() => null)) as {
        deleted?: true;
        error?: string;
      } | null;

      if (!response.ok || body?.deleted !== true) {
        throw new Error(
          body?.error ?? `Failed to delete SSH key (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      setFormNotice("SSH key removed. It cannot be used for new routes.");
      setFormError(null);
      await queryClient.invalidateQueries({
        queryKey: ["profile", "ssh-keys"],
      });
    },
  });

  const user = session?.user ?? null;
  // Organization providers never sign in a platform admin.
  const platformAdmin = isAdminUser(user);
  const identities = useQuery({
    queryKey: ["profile", "identities"],
    queryFn: async () =>
      (await fetchJson<{ identities: LinkedIdentity[] }>("/api/account-links"))
        .identities,
    enabled: Boolean(user),
    // Sign-in methods change only through redirects, the dialog below, and
    // removing an organization's provider, which invalidates this query.
    staleTime: 60_000,
  });
  const github = identities.data?.find((entry) => entry.kind === "github");
  const organizationIdentities =
    identities.data?.filter((entry) => entry.kind === "organization") ?? [];
  const usableCount =
    identities.data?.filter((entry) => entry.usable).length ?? 0;
  const [callbackCode, clearCallbackCode] = useCallbackErrorCode();
  const connect = useMutation({
    mutationFn: connectGithub,
    onMutate: clearCallbackCode,
  });
  const connectError = connect.error
    ? connectErrorMessage(
        connect.error instanceof AuthFlowError ? connect.error.code : null,
      )
    : callbackCode
      ? connectErrorMessage(callbackCode)
      : null;
  // The target outlives the dialog's close animation, so its text holds.
  const [disconnectTarget, setDisconnectTarget] =
    useState<LinkedIdentity | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const disconnect = useMutation({
    mutationFn: async (identity: LinkedIdentity) => {
      const response = await fetch(
        `/api/account-links/${encodeURIComponent(identity.providerId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to disconnect");
    },
    onSuccess: () => setDisconnectOpen(false),
    // Disconnecting GitHub also clears the username the session shows.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profile", "identities"] }),
        queryClient.invalidateQueries({ queryKey: appBootstrapQueryKey }),
      ]),
  });
  const closeDisconnectDialog = () => {
    setDisconnectOpen(false);
    disconnect.reset();
  };
  const openDisconnectDialog = (identity: LinkedIdentity) => {
    disconnect.reset();
    setDisconnectTarget(identity);
    setDisconnectOpen(true);
  };

  return (
    <PageShell>
      <Section
        title="Account"
        description="This identity is recorded on every scenario run you start."
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <Avatar size="lg">
            {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback>{initials(user?.name)}</AvatarFallback>
          </Avatar>
          <dl className="grid flex-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="text-label">Username</dt>
              <dd className="mt-1 text-sm font-medium">
                {user?.username ?? user?.name ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-label">Email</dt>
              <dd className="mt-1 text-sm font-medium">
                {user?.email ?? "Unknown"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-label">Sign-in methods</dt>
              <dd className="mt-1 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {github ? (
                    <>
                      <Badge variant="secondary">
                        GitHub
                        {user?.username ? (
                          <span className="font-mono">@{user.username}</span>
                        ) : null}
                      </Badge>
                      {/* Keep at least one way to sign in. */}
                      {usableCount > 1 ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={disconnect.isPending}
                          onClick={() => openDisconnectDialog(github)}
                        >
                          Disconnect GitHub
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {identities.data && !github ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={connect.isPending}
                      onClick={() => connect.mutate()}
                    >
                      {connect.isPending ? "Opening GitHub…" : "Connect GitHub"}
                    </Button>
                  ) : null}
                </div>
                {organizationIdentities.length ? (
                  <ul className="divide-y overflow-hidden rounded-lg border">
                    {organizationIdentities.map((entry) => {
                      // Keep at least one way to sign in.
                      const lastSignIn =
                        usableCount - (entry.usable ? 1 : 0) < 1;
                      // An organization's removal holds through its identity
                      // until an admin restores the person.
                      const removed = entry.removed;
                      return (
                        <li
                          key={entry.providerId}
                          className="flex flex-wrap items-center gap-3 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-medium">
                              {entry.organization?.name ??
                                "Removed identity provider"}
                            </p>
                            <p className="text-caption">
                              {entry.usable
                                ? "Organization sign-in"
                                : platformAdmin
                                  ? "Organization sign-in · platform admins sign in with GitHub only"
                                  : "Organization sign-in · can't sign you in"}
                              {removed
                                ? " · an admin removed you; it stays until they restore you"
                                : lastSignIn
                                  ? " · connect GitHub before disconnecting"
                                  : ""}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={
                              lastSignIn || removed || disconnect.isPending
                            }
                            onClick={() => openDisconnectDialog(entry)}
                          >
                            Disconnect
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {identities.error ? (
                  <InlineFeedback tone="error">
                    Your sign-in methods couldn't be loaded. Reload the page to
                    try again.
                  </InlineFeedback>
                ) : null}
              </dd>
              {connectError ? (
                <InlineFeedback tone="error" className="mt-2">
                  {connectError}
                </InlineFeedback>
              ) : null}
            </div>
          </dl>
        </div>
        <dl className="mt-5 grid gap-4 border-t pt-5 sm:grid-cols-3">
          <div>
            <dt className="text-label">1. Identity</dt>
            <dd className="mt-1 text-sm">
              Sign in with GitHub or your organization.
            </dd>
          </div>
          <div>
            <dt className="text-label">2. Public key</dt>
            <dd className="mt-1 text-sm">
              Add only the public half of your SSH key.
            </dd>
          </div>
          <div>
            <dt className="text-label">3. Route access</dt>
            <dd className="mt-1 text-sm">
              Reuse your local identity for native SSH.
            </dd>
          </div>
        </dl>
        <ConfirmDialog
          open={disconnectOpen}
          onClose={closeDisconnectDialog}
          title={`Disconnect ${
            disconnectTarget?.kind === "github"
              ? "GitHub"
              : (disconnectTarget?.organization?.name ?? "this organization")
          }?`}
          description={`${
            disconnectTarget?.kind === "github"
              ? "Your GitHub account"
              : "Its identity provider"
          } can no longer sign in as you. Your other sessions and connected apps are signed out.`}
          error={
            disconnect.error ? disconnectErrorMessage(disconnect.error) : null
          }
          pending={disconnect.isPending}
          confirmLabel="Disconnect"
          pendingLabel="Disconnecting…"
          confirmDisabled={!disconnectTarget}
          onConfirm={() => {
            if (disconnectTarget) disconnect.mutate(disconnectTarget);
          }}
        />
      </Section>

      {user ? <MyServers key={user.id} userId={user.id} /> : null}

      <Section
        title="SSH keys"
        description="Saved public keys are optional credentials for native SSH routes. They are never added to scenario VMs."
      >
        <div className="space-y-5">
          {sshKeys.isLoading ? (
            <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 motion-safe:animate-spin" />
              Loading SSH keys…
            </div>
          ) : sshKeys.error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load SSH keys</AlertTitle>
              <AlertDescription>
                {sshKeys.error instanceof Error
                  ? sshKeys.error.message
                  : "Failed to load SSH keys"}
              </AlertDescription>
            </Alert>
          ) : sshKeys.data?.keys.length ? (
            <PaginatedCollection
              items={sshKeys.data.keys}
              pageSize={COLLECTION_PAGE_SIZE.list}
              itemLabel="SSH keys"
            >
              {(visibleKeys) => (
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {visibleKeys.map((key) => {
                    const deleting =
                      deleteKey.isPending && deleteKey.variables === key.id;

                    return (
                      <li
                        key={key.id}
                        className="flex flex-wrap items-start gap-4 p-4"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">
                              {key.label || key.comment || "Unnamed key"}
                            </p>
                            <Badge variant="outline">{key.keyType}</Badge>
                          </div>
                          <p className="font-mono text-xs break-all text-muted-foreground">
                            {key.fingerprintSha256}
                          </p>
                          <p className="text-caption">
                            Added {formatTimestamp(key.createdAt)}
                          </p>
                          <details>
                            <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
                              Show public key
                            </summary>
                            <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                              {key.publicKeyOpenssh}
                            </pre>
                          </details>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={deleting}
                          onClick={() => deleteKey.mutate(key.id)}
                        >
                          {deleting ? "Removing…" : "Remove"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </PaginatedCollection>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-5 py-6 text-center">
              <KeyRound className="size-6 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No public keys yet</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Intar can issue a temporary key for each run. Save a public
                  key if you want native SSH to reuse your local identity.
                </p>
              </div>
            </div>
          )}

          {deleteKey.error ? (
            <InlineFeedback tone="error">
              {deleteKey.error instanceof Error
                ? deleteKey.error.message
                : "Could not remove SSH key"}
            </InlineFeedback>
          ) : null}

          <form
            className="space-y-4 border-t pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (addKey.isPending) return;
              setFormError(null);
              setFormNotice(null);
              addKey.mutate();
            }}
          >
            <div>
              <h3 className="text-card-title">Add a public key</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Paste an OpenSSH public key from ~/.ssh/*.pub — one key per
                save. Saved keys are optional credentials for future native SSH
                routes; they are never injected into scenario VMs.
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="ssh-key-label" className="block text-sm font-medium">
                Label
              </label>
              <Input
                id="ssh-key-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="MacBook Pro, YubiKey, Workstation"
                maxLength={80}
                className="max-w-sm"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="ssh-key-public" className="block text-sm font-medium">
                Public key
              </label>
              <Textarea
                id="ssh-key-public"
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
                rows={5}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
                className="font-mono text-xs"
              />
            </div>

            {formError ? (
              <InlineFeedback tone="error">{formError}</InlineFeedback>
            ) : null}

            {formNotice ? (
              <InlineFeedback tone="success">{formNotice}</InlineFeedback>
            ) : null}

            <Button
              type="submit"
              disabled={addKey.isPending || !publicKey.trim()}
            >
              {addKey.isPending ? "Saving key…" : "Save public key"}
            </Button>
          </form>
        </div>
      </Section>
    </PageShell>
  );
}
