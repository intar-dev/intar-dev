import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatTimestamp } from "@/components/app/lib/format";
import {
  HttpResponseError,
  pollingIntervalUnlessAccessError,
} from "@/components/app/lib/http-response-error";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Section } from "@/components/app/patterns/Section";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface MyServersResponse {
  placement: "platform" | "personal";
  registrationOpen: boolean;
  installerCommand: string;
  servers: Array<{
    id: string;
    name: string;
    status: "setting_up" | "ready" | "paused" | "offline" | "needs_attention" | "removing" | "revoked";
    message: string;
    repairAction: string | null;
    connected: boolean;
    createdAt: number;
    lastSeenAt: number | null;
    capacity: { total: number; available: number } | null;
    activeRuns: number;
  }>;
  enrollments: Array<{ id: string; name: string; expiresAt: number }>;
}

type PersonalServer = MyServersResponse["servers"][number];
type Enrollment = {
  hostId: string;
  enrollmentToken: string;
  expiresAt: number;
};
type Removal = {
  removed: true;
  placement: "platform" | "personal";
  physicalCleanup: "confirmed" | "unconfirmed";
};
const statuses: Record<
  PersonalServer["status"],
  { word: string; tone: StatusTone }
> = {
  setting_up: { word: "Setting up", tone: "pending" },
  ready: { word: "Ready", tone: "success" },
  paused: { word: "Paused", tone: "muted" },
  offline: { word: "Offline", tone: "muted" },
  needs_attention: { word: "Needs attention", tone: "danger" },
  removing: { word: "Removal pending", tone: "pending" },
  revoked: { word: "Access revoked", tone: "danger" },
};

async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/servers${path}`, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  const body = (await response.json().catch(() => null)) as
    (T & { error?: unknown; code?: unknown }) | null;
  if (!response.ok || !body) {
    throw Object.assign(new HttpResponseError(
      response.status,
      typeof body?.error === "string"
        ? body.error
        : "The server request failed. Try again.",
    ), { code: body?.code });
  }
  return body as T;
}

export function MyServers({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["profile", userId, "servers"];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [canceledHostId, setCanceledHostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const servers = useQuery({
    queryKey,
    queryFn: ({ signal }) => serverRequest<MyServersResponse>("", { signal }),
    enabled: !removing,
    refetchInterval: (query) =>
      pollingIntervalUnlessAccessError(query.state.error, 15_000),
    refetchIntervalInBackground: false,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const cancelSetup = useMutation({
    mutationFn: (id: string) =>
      serverRequest<{ canceled: true }>(
        `/enrollments/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: async (_, id) => {
      setCanceledHostId(id);
      setNotice("Setup canceled.");
      await refresh();
    },
  });
  const data = servers.data;
  const enabledServerCount = data?.servers.filter(
    (server) => server.status !== "removing" && server.status !== "revoked",
  ).length ?? 0;

  return (
    <Section
      title="My servers"
      description="Use your own servers for all your runs, including organization courses."
      actions={
        data?.registrationOpen && !adding ? (
          <Button
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            Add server
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {servers.isPending ? (
          <InlineFeedback tone="pending">Loading servers…</InlineFeedback>
        ) : null}
        {servers.error ? (
          <div className="space-y-3">
            <InlineFeedback tone="error">
              Could not refresh servers. {servers.error.message}
            </InlineFeedback>
            <Button
              variant="outline"
              disabled={servers.isFetching}
              onClick={() => void servers.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {data ? (
          <>
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                {data.placement === "personal"
                  ? "Your runs use your personal servers."
                  : "Your runs use the cloud."}
              </p>
              <p className="text-muted-foreground">
                {data.placement === "personal"
                  ? "If your servers are offline, paused, or full, new runs cannot start. Runs stay on your personal servers. They do not move to the cloud."
                  : "When your first server is Ready, all new runs use your servers. Existing runs stay where they started."}
              </p>
            </div>
            {notice ? (
              <InlineFeedback tone="success">{notice}</InlineFeedback>
            ) : null}
            {data.servers.length ? (
              <ul aria-label="My servers" className="divide-y border-y">
                {data.servers.map((server) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    lastServer={
                      server.status !== "removing" &&
                      enabledServerCount <= (server.status === "revoked" ? 0 : 1)
                    }
                    onChanged={refresh}
                    onRemoved={setNotice}
                    onRemovalOpen={(open) => {
                      setRemoving(open);
                      if (open) void queryClient.cancelQueries({ queryKey });
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No personal servers connected yet.
              </p>
            )}
            {data.enrollments.length ? (
              <div className="space-y-2">
                <h3 className="text-card-title">Waiting for installation</h3>
                <ul className="space-y-2 text-sm">
                  {data.enrollments.map((enrollment) => (
                    <li
                      key={enrollment.id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <p className="min-w-0 break-words">
                        <span className="font-medium">{enrollment.name}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          · Token expires{" "}
                          {formatTimestamp(enrollment.expiresAt)}
                        </span>
                      </p>
                      <Button
                        variant="outline"
                        disabled={cancelSetup.isPending}
                        onClick={() => cancelSetup.mutate(enrollment.id)}
                      >
                        {cancelSetup.isPending &&
                        cancelSetup.variables === enrollment.id
                          ? "Canceling…"
                          : "Cancel setup"}
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-muted-foreground">
                  Tokens are shown only when you create them. If you lost an
                  unused token, cancel its pending setup, then add the server
                  again.
                </p>
              </div>
            ) : null}
            {cancelSetup.error ? (
              <InlineFeedback tone="error">
                Could not cancel setup. {cancelSetup.error.message}
              </InlineFeedback>
            ) : null}
            {!data.registrationOpen ? (
              <p className="text-sm text-muted-foreground">
                New server registration is not available yet. You can still
                manage your servers.
              </p>
            ) : null}
            {adding && data.registrationOpen ? (
              <AddServer
                installerCommand={data.installerCommand}
                servers={data.servers}
                canceledHostId={canceledHostId}
                onCreated={refresh}
                onClose={() => setAdding(false)}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}

function AddServer({
  installerCommand,
  servers,
  canceledHostId,
  onCreated,
  onClose,
}: {
  installerCommand: string;
  servers: PersonalServer[];
  canceledHostId: string | null;
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  // Keep the token in this mounted form only, never in the query or mutation cache.
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);
  const connected =
    enrollment &&
    servers.some(
      (server) => server.id === enrollment.hostId && server.connected,
    );
  useEffect(() => {
    if (!enrollment) return;
    const clearToken = (message: string) => {
      setEnrollment(null);
      setRevealed(false);
      setNotice(message);
    };
    if (connected) {
      clearToken(
        "Server connected. The token has been cleared from this page.",
      );
      return;
    }
    if (canceledHostId === enrollment.hostId) {
      clearToken("Setup canceled. The token has been cleared from this page.");
      return;
    }
    const timeout = window.setTimeout(
      () => {
        clearToken("Token expired. Create a new token to continue.");
      },
      Math.max(0, enrollment.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [enrollment, connected, canceledHostId]);

  const copy = async (value: string, label: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(null);
      setError(
        `Could not copy ${label.toLowerCase()}. Select and copy it manually.`,
      );
    }
  };

  return (
    <div className="space-y-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-card-title">Add a personal server</h3>
        <Button variant="ghost" onClick={onClose}>
          {enrollment ? "Clear token and close" : "Close setup"}
        </Button>
      </div>
      <div className="space-y-1 text-sm">
        <h4 className="font-medium">Server requirements</h4>
        <p className="text-muted-foreground">
          Ubuntu 24.04 or later (x86_64) with KVM. At least 2 logical CPUs and 4 GiB RAM.
        </p>
        <p className="text-muted-foreground">
          The installer uses compatible storage when available. Otherwise, it
          needs 110 GiB free to create its own 100 GiB storage file.
        </p>
        <p className="text-muted-foreground">
          No inbound ports or public IP address are required. Browser terminals
          and SSH connect through Intar.
        </p>
        <a className="underline underline-offset-4" href="https://docs.intar.dev/operations/personal-host/">
          Installation and repair guide
        </a>
      </div>
      {enrollment ? (
        <>
          <p className="text-sm">
            Run this command on{" "}
            <strong className="break-words">{name.trim()}</strong>. Paste the
            token only when the installer asks for it.
          </p>
          <div className="space-y-2">
            <p className="text-sm font-medium">Installer command</p>
            <pre className="rounded-lg bg-muted/50 p-3 font-mono text-xs break-all whitespace-pre-wrap">
              <code>{installerCommand}</code>
            </pre>
            <Button
              variant="outline"
              onClick={() => void copy(installerCommand, "Installer command")}
            >
              Copy installer command
            </Button>
          </div>
          <div className="space-y-2" data-private>
            <p className="text-sm font-medium">Enrollment token</p>
            <p className="text-sm text-muted-foreground">
              Single use. Expires {formatTimestamp(enrollment.expiresAt)}. This
              page does not save the token. Keep it private.
            </p>
            <p
              className="rounded-lg bg-muted/50 p-3 font-mono text-xs break-all"
              aria-label={
                revealed ? "Enrollment token" : "Enrollment token hidden"
              }
            >
              {revealed ? enrollment.enrollmentToken : "••••••••••••••••"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                aria-pressed={revealed}
                onClick={() => setRevealed(!revealed)}
              >
                {revealed ? "Hide token" : "Reveal token"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (enrollment.expiresAt <= Date.now()) {
                    setEnrollment(null);
                    setNotice("Token expired. Create a new token to continue.");
                    return;
                  }
                  void copy(enrollment.enrollmentToken, "Token");
                }}
              >
                Copy token
              </Button>
            </div>
          </div>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            setPending(true);
            setError(null);
            setNotice(null);
            try {
              const result = await serverRequest<Enrollment>("/enrollments", {
                method: "POST",
                signal: abort.current?.signal ?? null,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: name.trim() }),
              });
              if (abort.current?.signal.aborted) return;
              setEnrollment(result);
              setRevealed(false);
              void onCreated();
            } catch (cause) {
              if (!abort.current?.signal.aborted)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not create a token. Try again.",
                );
            } finally {
              if (!abort.current?.signal.aborted) setPending(false);
            }
          }}
        >
          <label
            htmlFor="personal-server-name"
            className="block text-sm font-medium"
          >
            Server name
          </label>
          <Input
            id="personal-server-name"
            className="max-w-sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={80}
            disabled={pending}
            placeholder="Home server"
          />
          <p className="text-sm text-muted-foreground">
            Create a token, then run the installer on your server. The installer
            command contains no secret.
          </p>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Creating token…" : "Create token"}
          </Button>
        </form>
      )}
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
      {notice ? <InlineFeedback tone="success">{notice}</InlineFeedback> : null}
    </div>
  );
}

function ServerRow({
  server,
  lastServer,
  onChanged,
  onRemoved,
  onRemovalOpen,
}: {
  server: PersonalServer;
  lastServer: boolean;
  onChanged: () => Promise<void>;
  onRemoved: (notice: string) => void;
  onRemovalOpen: (open: boolean) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(server.name);
  const [action, setAction] = useState<"pause" | "resume" | "remove" | null>(
    null,
  );
  const [cloudConsent, setCloudConsent] = useState(false);
  const [lastServerConflict, setLastServerConflict] = useState(false);
  const needsCloudConsent = lastServer || lastServerConflict;
  const [notice, setNotice] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: { name: string } | { paused: boolean }) =>
      serverRequest(`/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: async (_, body) => {
      setRenaming(false);
      setAction(null);
      setNotice(
        "name" in body
          ? "Server renamed."
          : body.paused
            ? "Server paused."
            : "Server resumed.",
      );
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      serverRequest<Removal>(`/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmReturnToCloud: needsCloudConsent && cloudConsent,
        }),
      }),
    onSuccess: async (result) => {
      setAction(null);
      onRemovalOpen(false);
      onRemoved(
        `Server removed. ${result.placement === "platform" ? "All new runs use the cloud." : "Your runs still use your personal servers."} ${result.physicalCleanup === "unconfirmed" ? "Cleanup on the server could not be confirmed. Stop the agent and remove remaining virtual machines on that server." : "Cleanup on the server is confirmed."}`,
      );
      await onChanged();
    },
    onError: (error) => {
      if (error instanceof HttpResponseError && "code" in error && error.code === "last_server_confirmation_required") {
        setLastServerConflict(true);
        setCloudConsent(false);
      }
    },
  });
  const busy = change.isPending || remove.isPending;
  const mutationError = change.error ?? remove.error;
  const openAction = (next: typeof action) => {
    change.reset();
    remove.reset();
    setNotice(null);
    setCloudConsent(false);
    setLastServerConflict(false);
    setAction(next);
    onRemovalOpen(next === "remove");
  };

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-card-title break-words">{server.name}</h3>
          <StatusToken {...statuses[server.status]} />
          <p className="text-sm text-muted-foreground break-words">
            {server.message}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || renaming || server.status === "removing" || server.status === "revoked"}
            onClick={() => {
              change.reset();
              setNotice(null);
              setName(server.name);
              setRenaming(true);
            }}
          >
            Rename
          </Button>
          <Button
            variant="outline"
            disabled={busy || server.status === "removing" || server.status === "revoked"}
            onClick={() =>
              openAction(server.status === "paused" ? "resume" : "pause")
            }
          >
            {server.status === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => openAction("remove")}
          >
            {server.status === "removing" ? "Retry removal" : "Remove"}
          </Button>
        </div>
      </div>
      <p className="font-mono text-xs text-muted-foreground break-words">
        {server.connected ? "Connected" : "Disconnected"} · {server.activeRuns}{" "}
        active {server.activeRuns === 1 ? "run" : "runs"} ·{" "}
        {server.capacity
          ? `${server.capacity.available} of ${server.capacity.total} vCPUs available`
          : "Capacity not reported"}
        {server.capacity?.available === 0 ? " · Full" : ""}
      </p>
      <p className="text-caption">
        Added {formatTimestamp(server.createdAt)} · Last seen{" "}
        {server.lastSeenAt ? formatTimestamp(server.lastSeenAt) : "Never"}
      </p>
      {server.repairAction ? (
        <p className="text-sm break-words">
          <strong>Next step: </strong>
          {server.repairAction}
        </p>
      ) : null}
      {renaming ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && !busy) change.mutate({ name: name.trim() });
          }}
        >
          <label className="space-y-2 text-sm font-medium">
            <span className="block">New server name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={80}
              disabled={busy}
            />
          </label>
          <Button
            type="submit"
            disabled={busy || !name.trim() || name.trim() === server.name}
          >
            {change.isPending ? "Saving…" : "Save name"}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setRenaming(false);
              change.reset();
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {!action && mutationError ? (
        <InlineFeedback tone="error">{mutationError.message}</InlineFeedback>
      ) : null}
      {notice ? <InlineFeedback tone="success">{notice}</InlineFeedback> : null}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAction(null);
            onRemovalOpen(false);
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle className="break-words">
              {action === "remove"
                ? "Remove"
                : action === "pause"
                  ? "Pause"
                  : "Resume"}{" "}
              {server.name}?
            </DialogTitle>
            <DialogDescription>
              {action === "remove"
                ? server.status === "removing" ? "Access is already revoked. Retry removal to close remaining sessions."
                  : "This revokes the server's access and ends access to its runs. You must register it again to use it later."
                : action === "pause"
                  ? "New runs will not start on this server. Current runs stay on this server."
                  : "This server can accept new runs when it is ready and has enough capacity."}
            </DialogDescription>
          </DialogHeader>
          {action === "remove" ? (
            <>
              <p className="text-sm">
                {server.activeRuns} active{" "}
                {server.activeRuns === 1 ? "run" : "runs"} on this server.
              </p>
              {needsCloudConsent ? (
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 shrink-0 accent-primary"
                    checked={cloudConsent}
                    onChange={(event) => setCloudConsent(event.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    No other available server remains. I agree to use the cloud for all new
                    runs, including organization courses.
                  </span>
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {server.status === "removing" ? "This retry does not change where new runs start." : "New runs will still use your other personal servers."}
                </p>
              )}
            </>
          ) : null}
          {mutationError ? (
            <InlineFeedback tone="error">
              {mutationError.message}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAction(null);
                onRemovalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant={action === "remove" ? "destructive" : "default"}
              disabled={
                busy || (action === "remove" && needsCloudConsent && !cloudConsent)
              }
              onClick={() => {
                if (action === "remove") remove.mutate();
                else change.mutate({ paused: action === "pause" });
              }}
            >
              {busy
                ? "Saving…"
                : action === "remove"
                  ? "Remove server"
                  : action === "pause"
                    ? "Pause server"
                    : "Resume server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
