import { type ReactNode, useState } from "react";
import { KeyRound, LoaderCircle, MonitorUp, ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageShell } from "@/components/app/patterns/PageShell";
import { useSession } from "@/components/app/hooks/useSession";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
      setFormNotice(null);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ["profile", "ssh-keys"] });
    },
  });

  const user = session?.user ?? null;
  const keyCount = sshKeys.data?.keys.length ?? 0;

  return (
    <PageShell
      title="Profile"
      description="Control how Intar lets you into mission VMs. Public SSH keys are copied into new runs so native access can go straight to the mapped VM port from your own machine."
      eyebrow="Identity"
      compactHeader
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-background to-muted/20">
          <CardHeader className="gap-4 border-b border-border/70 bg-muted/30">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">Mission access</Badge>
              <Badge variant="outline">{keyCount} keys loaded</Badge>
            </div>
            <div className="space-y-2">
              <CardTitle className="text-2xl">Native SSH without copied secrets</CardTitle>
              <CardDescription className="max-w-3xl leading-6">
                Add your public keys once. Intar injects them into new scenario VMs at
                launch time, so the run page can hand you a direct `ssh` command that
                uses your local SSH agent or configured identities.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 py-6 sm:grid-cols-3">
            <ProfileStep
              icon={<KeyRound className="size-4" />}
              title="1. Save a public key"
              description="Paste an OpenSSH public key from your laptop or hardware-backed SSH agent."
            />
            <ProfileStep
              icon={<MonitorUp className="size-4" />}
              title="2. Start a fresh run"
              description="Browser access stays unchanged, and native SSH routes can immediately accept your saved keys when you open them."
            />
            <ProfileStep
              icon={<ShieldCheck className="size-4" />}
              title="3. Connect through Stargate"
              description="Use an explicit route like ssh <route>@intar.app. If you have no saved keys, Intar falls back to a temporary issued key."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
            <CardDescription>
              This is the identity currently attached to scenario runs and SSH access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Username
              </p>
              <p className="mt-1 font-medium">{user?.username ?? "Anonymous"}</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
              <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                Email
              </p>
              <p className="mt-1 font-medium">{user?.email ?? "Unknown"}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(24rem,0.88fr)]">
        <Card className="min-h-[20rem]">
          <CardHeader>
            <CardTitle className="text-lg">Saved public keys</CardTitle>
            <CardDescription>
              These keys authorize explicit native SSH routes through Stargate, so
              your machine&apos;s existing Ed25519 identities can connect without
              copying a temporary private key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sshKeys.isLoading ? (
              <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-muted-foreground">
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
              <div className="space-y-3">
                {sshKeys.data.keys.map((key) => {
                  const deleting =
                    deleteKey.isPending && deleteKey.variables === key.id;

                  return (
                    <article
                      key={key.id}
                      className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 px-4 py-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">
                              {key.label || key.comment || "Unnamed key"}
                            </p>
                            <Badge variant="outline">{key.keyType}</Badge>
                          </div>
                          <p className="font-mono text-xs text-muted-foreground">
                            {key.fingerprintSha256}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={deleting}
                          onClick={() => deleteKey.mutate(key.id)}
                        >
                          {deleting ? "Removing..." : "Remove"}
                        </Button>
                      </div>
                      <Textarea
                        readOnly
                        value={key.publicKeyOpenssh}
                        rows={3}
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-muted-foreground">
                        Added {new Date(key.createdAt).toLocaleString()}
                      </p>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 text-center">
                <KeyRound className="size-8 text-muted-foreground" />
                <h2 className="mt-4 text-lg font-semibold">No public keys yet</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  Add the public half of a key from your machine and Intar will inject it
                  into new VMs so native SSH can use your existing local identity.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/90">
          <CardHeader>
            <CardTitle className="text-base">Add public SSH key</CardTitle>
            <CardDescription>
              Paste an OpenSSH public key from `~/.ssh/*.pub`. One key per save.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Label</p>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="MacBook Pro, YubiKey, Workstation"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Public key</p>
              <Textarea
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
                rows={8}
                placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI..."
                className="font-mono text-xs"
              />
            </div>

            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not save key</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            {formNotice ? (
              <Alert>
                <AlertTitle>Key saved</AlertTitle>
                <AlertDescription>{formNotice}</AlertDescription>
              </Alert>
            ) : null}

            <div className="rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              Changes apply to new scenario runs. Already-running VMs keep the authorized
              key set they were launched with.
            </div>

            <Button
              type="button"
              className="w-full"
              disabled={addKey.isPending}
              onClick={() => {
                setFormError(null);
                setFormNotice(null);
                addKey.mutate();
              }}
            >
              {addKey.isPending ? "Saving key..." : "Save public key"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function ProfileStep(props: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-border/70 bg-muted/15 px-4 py-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        {props.icon}
        {props.title}
      </div>
      <p className="text-sm leading-6 text-muted-foreground">
        {props.description}
      </p>
    </div>
  );
}
