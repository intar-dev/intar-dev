import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import {
  createWorkshopRegistryToken,
  listWorkshopRegistryTokens,
  revokeWorkshopRegistryToken,
} from "@/components/app/workshops/api";
import type {
  CreatedWorkshopRegistryToken,
  WorkshopRegistryTokenSummary,
} from "@/components/app/workshops/types";
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
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

const TOKEN_LIFETIMES = [
  { value: "30", label: "30 minutes" },
  { value: "120", label: "2 hours (recommended)" },
  { value: "1440", label: "24 hours" },
  { value: "10080", label: "7 days" },
  { value: "43200", label: "30 days" },
] as const;

export function WorkshopPublisherTokens({
  organizationId,
}: {
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState("Workshop publisher");
  const [lifetimeMinutes, setLifetimeMinutes] = useState("120");
  const [createdToken, setCreatedToken] =
    useState<CreatedWorkshopRegistryToken | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] =
    useState<WorkshopRegistryTokenSummary | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const queryKey = [
    "organizations",
    organizationId,
    "workshop-registry-tokens",
  ] as const;
  const tokens = useQuery({
    queryKey,
    queryFn: () => listWorkshopRegistryTokens(organizationId),
    retry: 1,
    staleTime: 5_000,
  });
  const nextExpiry = useMemo(
    () =>
      tokens.data?.tokens.reduce<number | null>((nearest, token) => {
        if (
          token.revokedAt ||
          !token.expiresAt ||
          token.expiresAt <= now ||
          (nearest !== null && nearest <= token.expiresAt)
        ) {
          return nearest;
        }
        return token.expiresAt;
      }, null) ?? null,
    [now, tokens.data?.tokens],
  );
  useEffect(() => {
    if (nextExpiry === null) return;
    const delay = Math.min(
      Math.max(0, nextExpiry - Date.now() + 25),
      2_147_483_647,
    );
    const timeout = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [nextExpiry, now]);

  const closeCreateDialog = () => {
    setCreateOpen(false);
    setCreatedToken(null);
    setCreateError(null);
    setCopied(false);
  };

  return (
    <section aria-labelledby="workshop-publisher-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="workshop-publisher-heading" className="text-section-title">
            Publisher access
          </h2>
          <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
            Create short-lived credentials for the workshop CLI. Intar shows
            each secret once and stores only its hash.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setCreateOpen(true);
            setCreatedToken(null);
            setCreateError(null);
            setCopied(false);
          }}
        >
          <Plus />
          Create publisher token
        </Button>
      </div>

      {tokens.isPending ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : tokens.error ? (
        <div className="rounded-xl border bg-card p-4">
          <InlineFeedback tone="error">
            {errorMessage(tokens.error, "Could not load publisher tokens")}
          </InlineFeedback>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={() => void tokens.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : tokens.data.tokens.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {tokens.data.tokens.map((token) => {
            const status = tokenStatus(token, now);
            return (
              <article
                key={token.id}
                className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {token.name}
                    </p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {token.tokenPrefix}…
                    </p>
                  </div>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>
                <dl className="grid gap-1 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-4">
                    <dt>Created</dt>
                    <dd className="text-right">
                      {formatTimestamp(token.createdAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt>Expires</dt>
                    <dd className="text-right">
                      {token.expiresAt
                        ? formatTimestamp(token.expiresAt)
                        : "No expiry"}
                    </dd>
                  </div>
                  {token.lastUsedAt ? (
                    <div className="flex justify-between gap-4">
                      <dt>Last used</dt>
                      <dd className="text-right">
                        {formatTimestamp(token.lastUsedAt)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {status.label === "Active" ? (
                  <Button
                    className="mt-auto self-start"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRevokeTarget(token);
                      setRevokeError(null);
                    }}
                  >
                    <Trash2 />
                    Revoke
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-dashed bg-card p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </div>
          <div>
            <p className="text-sm font-medium">No publisher tokens</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create one only when you are ready to publish, then revoke it
              after the CLI accepts the bundle.
            </p>
          </div>
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && !createBusy) closeCreateDialog();
        }}
      >
        <DialogContent>
          {createdToken ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy this token now</DialogTitle>
                <DialogDescription>
                  This secret cannot be shown again. Refreshing or dismissing
                  this dialog permanently hides it.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-lg border bg-muted/50 p-3">
                <code className="block break-all font-mono text-xs leading-5">
                  {createdToken.token}
                </code>
              </div>
              {createError ? (
                <InlineFeedback tone="error">{createError}</InlineFeedback>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (!navigator.clipboard) {
                      setCreateError("Clipboard access is unavailable.");
                      return;
                    }
                    void navigator.clipboard
                      .writeText(createdToken.token)
                      .then(() => {
                        setCopied(true);
                        setCreateError(null);
                      })
                      .catch(() =>
                        setCreateError(
                          "Could not copy the token. Select and copy it manually.",
                        ),
                      );
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy token"}
                </Button>
                <Button onClick={closeCreateDialog}>I have stored it</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setCreateBusy(true);
                setCreateError(null);
                try {
                  const created = await createWorkshopRegistryToken(
                    organizationId,
                    {
                      name: tokenName,
                      expiresAfterMinutes: Number.parseInt(
                        lifetimeMinutes,
                        10,
                      ),
                    },
                  );
                  setCreatedToken(created);
                  void queryClient.invalidateQueries({ queryKey });
                } catch (error) {
                  setCreateError(
                    errorMessage(error, "Could not create publisher token"),
                  );
                } finally {
                  setCreateBusy(false);
                }
              }}
            >
              <DialogHeader>
                <DialogTitle>Create publisher token</DialogTitle>
                <DialogDescription>
                  Use this credential with the workshop CLI. Choose the shortest
                  lifetime that covers the publication.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 grid gap-3">
                <label className="space-y-1.5 text-sm font-medium">
                  Token name
                  <Input
                    required
                    maxLength={80}
                    value={tokenName}
                    onChange={(event) => setTokenName(event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="space-y-1.5 text-sm font-medium">
                  Expires after
                  <NativeSelect
                    value={lifetimeMinutes}
                    onChange={(event) =>
                      setLifetimeMinutes(event.target.value)
                    }
                    className="w-full"
                  >
                    {TOKEN_LIFETIMES.map((lifetime) => (
                      <option key={lifetime.value} value={lifetime.value}>
                        {lifetime.label}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                {createError ? (
                  <InlineFeedback tone="error">{createError}</InlineFeedback>
                ) : null}
              </div>
              <DialogFooter className="mt-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={createBusy}
                  onClick={closeCreateDialog}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createBusy}>
                  {createBusy ? (
                    <LoaderCircle className="motion-safe:animate-spin" />
                  ) : (
                    <KeyRound />
                  )}
                  Create publisher token
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open && !revokeBusy) {
            setRevokeTarget(null);
            setRevokeError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke publisher token</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? `Revoke “${revokeTarget.name}”? Any CLI using it will lose access immediately.`
                : "This token will stop working immediately."}
            </DialogDescription>
          </DialogHeader>
          {revokeError ? (
            <InlineFeedback tone="error">{revokeError}</InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revokeBusy}
              onClick={() => setRevokeTarget(null)}
            >
              Keep token
            </Button>
            <Button
              variant="destructive"
              disabled={revokeBusy || !revokeTarget}
              onClick={async () => {
                if (!revokeTarget) return;
                setRevokeBusy(true);
                setRevokeError(null);
                try {
                  await revokeWorkshopRegistryToken(
                    organizationId,
                    revokeTarget.id,
                  );
                  setRevokeTarget(null);
                  void queryClient.invalidateQueries({ queryKey });
                } catch (error) {
                  setRevokeError(
                    errorMessage(error, "Could not revoke publisher token"),
                  );
                } finally {
                  setRevokeBusy(false);
                }
              }}
            >
              {revokeBusy ? (
                <LoaderCircle className="motion-safe:animate-spin" />
              ) : (
                <Trash2 />
              )}
              Revoke token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function tokenStatus(
  token: WorkshopRegistryTokenSummary,
  now: number,
): {
  label: "Active" | "Expired" | "Revoked";
  variant: "success" | "warning" | "secondary";
} {
  if (token.revokedAt) return { label: "Revoked", variant: "secondary" };
  if (token.expiresAt && token.expiresAt <= now) {
    return { label: "Expired", variant: "warning" };
  }
  return { label: "Active", variant: "success" };
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
