import { useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { useSession } from "@/components/app/hooks/useSession";
import { formatTimestamp } from "@/components/app/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

      const body = (await response.json().catch(() => null)) as
        | { key?: UserSshKeyRecord; error?: string }
        | null;

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
      setFormNotice("Key saved. New scenario runs will trust it automatically.");
      await queryClient.invalidateQueries({ queryKey: ["profile", "ssh-keys"] });
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

      const body = (await response.json().catch(() => null)) as
        | { deleted?: true; error?: string }
        | null;

      if (!response.ok || body?.deleted !== true) {
        throw new Error(
          body?.error ?? `Failed to delete SSH key (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      setFormNotice("SSH key removed. Existing VMs are unchanged.");
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["profile", "ssh-keys"] });
    },
  });

  const user = session?.user ?? null;

  return (
    <PageShell width="content">
      <Section
        title="Account"
        description="This identity is recorded on every scenario run you start."
      >
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <Avatar size="lg">
            {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
            <AvatarFallback>{initials(user?.name)}</AvatarFallback>
          </Avatar>
          <dl className="grid flex-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="text-eyebrow">Username</dt>
              <dd className="mt-1 text-sm font-medium">
                {user?.username ?? "Anonymous"}
              </dd>
            </div>
            <div>
              <dt className="text-eyebrow">Email</dt>
              <dd className="mt-1 text-sm font-medium">
                {user?.email ?? "Unknown"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-eyebrow">GitHub</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium">
                {user?.username ? (
                  <span className="font-mono text-xs">@{user.username}</span>
                ) : (
                  "—"
                )}
                <Badge variant="secondary">Signed in with GitHub</Badge>
              </dd>
            </div>
          </dl>
        </div>
        <dl className="mt-6 grid gap-4 border-t pt-6 sm:grid-cols-3">
          <div>
            <dt className="text-eyebrow">1. Identity</dt>
            <dd className="mt-1 text-sm">Sign in with GitHub.</dd>
          </div>
          <div>
            <dt className="text-eyebrow">2. Public key</dt>
            <dd className="mt-1 text-sm">Add only the public half of your SSH key.</dd>
          </div>
          <div>
            <dt className="text-eyebrow">3. Future runs</dt>
            <dd className="mt-1 text-sm">New VMs trust that key at launch.</dd>
          </div>
        </dl>
      </Section>

      <Section
        title="SSH keys"
        description="Public keys added here are injected into new scenario VMs at launch. Existing runs keep the keys they started with."
      >
        <div className="space-y-6">
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
            <ul className="divide-y">
              {sshKeys.data.keys.map((key) => {
                const deleting =
                  deleteKey.isPending && deleteKey.variables === key.id;

                return (
                  <li
                    key={key.id}
                    className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0"
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
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center">
              <KeyRound className="size-6 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No public keys yet</p>
                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                  Add the public half of a key from your machine and intar will
                  inject it into new VMs so native SSH can use your existing
                  local identity.
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
            className="space-y-4 border-t pt-6"
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
                save. Changes apply to new scenario runs; already-running VMs
                keep the authorized keys they launched with.
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="ssh-key-label" className="text-sm font-medium">
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
              <label htmlFor="ssh-key-public" className="text-sm font-medium">
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
