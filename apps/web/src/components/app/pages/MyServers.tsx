import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatTimestamp } from "@/components/app/lib/format";
import {
  HttpResponseError,
  pollingIntervalUnlessAccessError,
} from "@/components/app/lib/http-response-error";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { CodeBlock } from "@/components/app/patterns/CodeBlock";
import { Field } from "@/components/app/patterns/Field";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { Section } from "@/components/app/patterns/Section";
import { ListSkeleton } from "@/components/app/patterns/Skeletons";
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
  placement: "platform" | "personal" | "organization";
  installerCommand: string;
  servers: Array<{
    id: string;
    name: string;
    status:
      | "setting_up"
      | "ready"
      | "paused"
      | "offline"
      | "needs_attention"
      | "removing"
      | "revoked";
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

type Server = MyServersResponse["servers"][number];

function serversPending(data: MyServersResponse | undefined): boolean {
  return Boolean(
    data &&
      (data.enrollments.length > 0 ||
        data.servers.some(
          (server) => server.status !== "ready" && server.status !== "revoked",
        )),
  );
}
type Enrollment = {
  hostId: string;
  enrollmentToken: string;
  expiresAt: number;
};
// A notice carries its own tone: only a fully successful action is a success.
type Notice = { tone: "success" | "error"; text: string };
type Removal = {
  removed: true;
  placement: "platform" | "personal" | "organization";
  physicalCleanup: "confirmed" | "unconfirmed";
};
const statuses: Record<Server["status"], { word: string; tone: StatusTone }> = {
  setting_up: { word: "Setting up", tone: "pending" },
  ready: { word: "Ready", tone: "success" },
  paused: { word: "Paused", tone: "muted" },
  offline: { word: "Offline", tone: "muted" },
  needs_attention: { word: "Needs attention", tone: "danger" },
  removing: { word: "Removal pending", tone: "pending" },
  revoked: { word: "Access revoked", tone: "danger" },
};

async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...init,
  });
  const body = (await response.json().catch(() => null)) as
    (T & { error?: unknown; code?: unknown }) | null;
  if (!response.ok || !body) {
    throw HttpResponseError.fromBody(
      response.status,
      body,
      "The server request failed. Try again.",
    );
  }
  return body as T;
}

export function MyServers(
  props:
    | { userId: string; organizationId?: never; canManage?: never }
    | { organizationId: string; canManage: boolean; userId?: never },
) {
  const { organizationId } = props;
  const organization = organizationId !== undefined;
  const canManage = !organization || props.canManage === true;
  const apiBase = organization
    ? `/api/organizations/${encodeURIComponent(organizationId)}/servers`
    : "/api/servers";
  const title = organization ? "Organization servers" : "My servers";
  const queryClient = useQueryClient();
  const queryKey = organization
    ? ["organizations", props.organizationId, "servers"]
    : ["profile", props.userId, "servers"];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [canceledHostId, setCanceledHostId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const servers = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      serverRequest<MyServersResponse>(apiBase, { signal }),
    enabled: !removing,
    // Setup, removal, and servers waiting on a fix outside this page (offline,
    // needs attention, paused) change on their own; ready servers do not.
    refetchInterval: (query) =>
      pollingIntervalUnlessAccessError(
        query.state.error,
        adding || serversPending(query.state.data) ? 15_000 : false,
      ),
    refetchIntervalInBackground: false,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const cancelSetup = useMutation({
    mutationFn: (id: string) =>
      serverRequest<{ canceled: true }>(
        `${apiBase}/enrollments/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: async (_, id) => {
      setCanceledHostId(id);
      setNotice({ tone: "success", text: "Setup canceled." });
      await refresh();
    },
  });
  const data = servers.data;
  const enabledServerCount =
    data?.servers.filter(
      (server) => server.status !== "removing" && server.status !== "revoked",
    ).length ?? 0;

  return (
    <Section
      title={title}
      description={
        organization
          ? "Shared servers are used only for this organization's runs. Users with personal servers always use their own servers."
          : "Use your own servers for all your runs, including organization courses."
      }
      actions={
        canManage && data && !adding ? (
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
          <ListSkeleton rows={2} action={false} label="Loading servers…" />
        ) : null}
        {servers.error ? (
          <div className="space-y-3">
            <InlineFeedback tone="error">
              Could not refresh servers. {servers.error.message}
            </InlineFeedback>
            <Button
              variant="outline"
              aria-busy={servers.isFetching || undefined}
              focusableWhenDisabled
              disabled={servers.isFetching}
              onClick={() => void servers.refetch()}
            >
              <AsyncLabel
                state={servers.isFetching ? "pending" : "idle"}
                idle="Try again"
                pending="Trying again…"
              />
            </Button>
          </div>
        ) : null}
        {data ? (
          <>
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                {organization
                  ? data.placement === "organization"
                    ? "Organization runs use shared servers unless the user has personal servers."
                    : "Organization runs use the cloud unless the user has personal servers."
                  : data.placement === "personal"
                    ? "Your runs use your personal servers."
                    : "Your runs use the cloud or organization servers."}
              </p>
              <p className="text-muted-foreground">
                {organization
                  ? data.placement === "organization"
                    ? "If shared servers are offline, paused, or full, new runs assigned to them cannot start. They do not move to the cloud."
                    : "When the first shared server is Ready, new organization runs use shared servers unless the user has personal servers. Existing runs stay where they started."
                  : data.placement === "personal"
                    ? "If your servers are offline, paused, or full, new runs cannot start. Runs stay on your personal servers. They do not move to the cloud or organization servers."
                    : "When your first server is Ready, all new runs use your servers. Existing runs stay where they started."}
              </p>
            </div>
            {notice ? (
              <InlineFeedback tone={notice.tone}>{notice.text}</InlineFeedback>
            ) : null}
            {data.servers.length ? (
              <ul
                aria-label={title}
                className="divide-y overflow-hidden rounded-lg border"
              >
                {data.servers.map((server) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    apiBase={apiBase}
                    organization={organization}
                    canManage={canManage}
                    lastServer={
                      server.status !== "removing" &&
                      enabledServerCount <=
                        (server.status === "revoked" ? 0 : 1)
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
                {organization
                  ? "No organization servers connected yet."
                  : "No personal servers connected yet."}
              </p>
            )}
            {data.enrollments.length ? (
              <div className="space-y-3">
                <h3 className="text-card-title">Waiting for installation</h3>
                <ul className="space-y-2 text-sm">
                  {data.enrollments.map((enrollment) => (
                    <li
                      key={enrollment.id}
                      className="flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium break-words">
                          {enrollment.name}
                        </p>
                        <MetaLine
                          items={[
                            `Token expires ${formatTimestamp(enrollment.expiresAt)}`,
                          ]}
                        />
                      </div>
                      {canManage ? (
                        <Button
                          variant="outline"
                          aria-busy={
                            (cancelSetup.isPending &&
                              cancelSetup.variables === enrollment.id) ||
                            undefined
                          }
                          focusableWhenDisabled
                          disabled={cancelSetup.isPending}
                          onClick={() => cancelSetup.mutate(enrollment.id)}
                        >
                          <AsyncLabel
                            state={
                              cancelSetup.isPending &&
                              cancelSetup.variables === enrollment.id
                                ? "pending"
                                : "idle"
                            }
                            idle="Cancel setup"
                            pending="Canceling…"
                          />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-muted-foreground">
                  {canManage
                    ? "Tokens are shown only when you create them. If you lost an unused token, cancel its pending setup, then add the server again."
                    : "Only owners and admins can add and manage organization servers."}
                </p>
              </div>
            ) : null}
            {cancelSetup.error ? (
              <InlineFeedback tone="error">
                Could not cancel setup. {cancelSetup.error.message}
              </InlineFeedback>
            ) : null}
            {canManage && adding ? (
              <AddServer
                apiBase={apiBase}
                organization={organization}
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
  apiBase,
  organization,
  installerCommand,
  servers,
  canceledHostId,
  onCreated,
  onClose,
}: {
  apiBase: string;
  organization: boolean;
  installerCommand: string;
  servers: Server[];
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
  const [notice, setNotice] = useState<Notice | null>(null);
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
    const clearToken = (text: string, tone: Notice["tone"] = "success") => {
      setEnrollment(null);
      setRevealed(false);
      setNotice({ tone, text });
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
        clearToken("Token expired. Create a new token to continue.", "error");
      },
      Math.max(0, enrollment.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [enrollment, connected, canceledHostId]);

  const copy = async (value: string, label: string) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ tone: "success", text: `${label} copied.` });
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
        <h3 className="text-card-title">
          {organization
            ? "Add an organization server"
            : "Add a personal server"}
        </h3>
        <Button variant="ghost" onClick={onClose}>
          {enrollment ? "Clear token and close" : "Close setup"}
        </Button>
      </div>
      <div className="space-y-1 text-sm">
        <h4 className="font-medium">Server requirements</h4>
        <p className="text-muted-foreground">
          Ubuntu 24.04 or later (x86_64) with KVM. At least 2 logical CPUs and 4
          GiB RAM.
        </p>
        <p className="text-muted-foreground">
          The installer uses compatible storage when available. Otherwise, it
          needs 110 GiB free to create its own 100 GiB storage file.
        </p>
        <p className="text-muted-foreground">
          No inbound ports or public IP address are required. Browser terminals
          and SSH connect through Intar.
        </p>
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
            <CodeBlock
              language="bash"
              copyName="Copy installer command"
              onCopied={() => {
                setError(null);
                setNotice({ tone: "success", text: "Installer command copied." });
              }}
              onCopyError={() => {
                setNotice(null);
                setError(
                  "Could not copy installer command. Select and copy it manually.",
                );
              }}
            >
              <code>{installerCommand}</code>
            </CodeBlock>
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
                    setNotice({
                      tone: "error",
                      text: "Token expired. Create a new token to continue.",
                    });
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
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            setPending(true);
            setError(null);
            setNotice(null);
            try {
              const result = await serverRequest<Enrollment>(
                `${apiBase}/enrollments`,
                {
                  method: "POST",
                  signal: abort.current?.signal ?? null,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: name.trim() }),
                },
              );
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
          <Field
            label="Server name"
            hint="Create a token, then run the installer on your server. The installer command contains no secret."
          >
            {(control) => (
              <Input
                {...control}
                className="max-w-field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
                // readOnly keeps focus and the touch height while it saves.
                readOnly={pending}
                placeholder={organization ? "Team server" : "Home server"}
              />
            )}
          </Field>
          <Button
            type="submit"
            aria-busy={pending || undefined}
            focusableWhenDisabled
            disabled={pending || !name.trim()}
          >
            <AsyncLabel
              state={pending ? "pending" : "idle"}
              idle="Create token"
              pending="Creating token…"
            />
          </Button>
        </form>
      )}
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
      {notice ? (
        <InlineFeedback tone={notice.tone}>{notice.text}</InlineFeedback>
      ) : null}
    </div>
  );
}

function ServerRow({
  apiBase,
  organization,
  canManage,
  server,
  lastServer,
  onChanged,
  onRemoved,
  onRemovalOpen,
}: {
  apiBase: string;
  organization: boolean;
  canManage: boolean;
  server: Server;
  lastServer: boolean;
  onChanged: () => Promise<void>;
  onRemoved: (notice: Notice) => void;
  onRemovalOpen: (open: boolean) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [name, setName] = useState(server.name);
  const [action, setAction] = useState<"pause" | "resume" | "remove" | null>(
    null,
  );
  const [cloudConsent, setCloudConsent] = useState(false);
  const [lastServerConflict, setLastServerConflict] = useState(false);
  const needsCloudConsent = lastServer || lastServerConflict;
  const [notice, setNotice] = useState<Notice | null>(null);
  const closeRename = () => {
    returnFocus.current = true;
    setRenaming(false);
  };
  const change = useMutation({
    mutationFn: (body: { name: string } | { paused: boolean }) =>
      serverRequest(`${apiBase}/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: async (_, body) => {
      if ("name" in body) closeRename();
      setAction(null);
      setNotice({
        tone: "success",
        text:
          "name" in body
            ? "Server renamed."
            : body.paused
              ? "Server paused."
              : "Server resumed.",
      });
      await onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      serverRequest<Removal>(`${apiBase}/${encodeURIComponent(server.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirmReturnToCloud: needsCloudConsent && cloudConsent,
        }),
      }),
    onSuccess: async (result) => {
      setAction(null);
      onRemovalOpen(false);
      onRemoved({
        // Unconfirmed cleanup needs follow-up work, so it is not a success.
        tone: result.physicalCleanup === "unconfirmed" ? "error" : "success",
        text: `Server removed. ${
          organization
            ? result.placement === "platform"
              ? "New organization runs use the cloud. Users with personal servers keep using their own servers."
              : "Organization runs still use shared servers unless the user has personal servers."
            : result.placement === "platform"
              ? "New runs use the cloud or organization servers."
              : "Your runs still use your personal servers."
        } ${result.physicalCleanup === "unconfirmed" ? "Cleanup on the server could not be confirmed. Stop the agent and remove remaining virtual machines on that server." : "Cleanup on the server is confirmed."}`,
      });
      await onChanged();
    },
    onError: (error) => {
      if (
        error instanceof HttpResponseError &&
        error.code === "last_server_confirmation_required"
      ) {
        setLastServerConflict(true);
        setCloudConsent(false);
      }
    },
  });
  const busy = change.isPending || remove.isPending;
  // The Rename button disables itself while the field is open; focus returns
  // to it once it is enabled again.
  useEffect(() => {
    if (!renaming && !busy && returnFocus.current) {
      returnFocus.current = false;
      renameButton.current?.focus();
    }
  }, [renaming, busy]);
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
    <li className="space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-card-title break-words">{server.name}</h3>
          <StatusToken {...statuses[server.status]} />
          <p className="text-sm text-muted-foreground break-words">
            {server.message}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={renameButton}
              variant="outline"
              disabled={
                busy ||
                renaming ||
                server.status === "removing" ||
                server.status === "revoked"
              }
              onClick={() => {
                change.reset();
                setNotice(null);
                setName(server.name);
                returnFocus.current = false;
                setRenaming(true);
              }}
            >
              Rename
            </Button>
            <Button
              variant="outline"
              disabled={
                busy ||
                server.status === "removing" ||
                server.status === "revoked"
              }
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
        ) : null}
      </div>
      <MetaLine
        items={[
          server.connected ? "Connected" : "Disconnected",
          `${server.activeRuns} active ${server.activeRuns === 1 ? "run" : "runs"}`,
          server.capacity
            ? `${server.capacity.available} of ${server.capacity.total} vCPUs available`
            : "Capacity not reported",
          server.capacity?.available === 0 ? "Full" : null,
        ]}
      />
      <MetaLine
        dense
        items={[
          `Added ${formatTimestamp(server.createdAt)}`,
          `Last seen ${server.lastSeenAt ? formatTimestamp(server.lastSeenAt) : "Never"}`,
        ]}
      />
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
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <span className="block">New server name</span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                if (!busy) {
                  closeRename();
                  change.reset();
                }
              }}
              required
              maxLength={80}
              readOnly={busy}
              className="max-w-field"
            />
          </label>
          <Button
            type="submit"
            aria-busy={change.isPending || undefined}
            focusableWhenDisabled
            disabled={busy || !name.trim() || name.trim() === server.name}
          >
            <AsyncLabel
              state={change.isPending ? "pending" : "idle"}
              idle="Save name"
              pending="Saving…"
            />
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              closeRename();
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
      {notice ? (
        <InlineFeedback tone={notice.tone}>{notice.text}</InlineFeedback>
      ) : null}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAction(null);
            onRemovalOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === "remove"
                ? "Remove"
                : action === "pause"
                  ? "Pause"
                  : "Resume"}{" "}
              {server.name}?
            </DialogTitle>
            <DialogDescription>
              {action === "remove"
                ? server.status === "removing"
                  ? "Access is already revoked. Retry removal to close remaining sessions."
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
                    {organization
                      ? "No other available shared server remains. I agree to use the cloud for new organization runs. Users with personal servers keep using their own servers."
                      : "No other available personal server remains. I agree to use the cloud or organization servers for new runs."}
                  </span>
                </label>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {server.status === "removing"
                    ? "This retry does not change where new runs start."
                    : organization
                      ? "New organization runs will still use the other shared servers. Users with personal servers keep using their own servers."
                      : "New runs will still use your other personal servers."}
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
              {action === "remove" ? "Keep server" : "Cancel"}
            </Button>
            <Button
              variant={action === "remove" ? "destructive" : "default"}
              aria-busy={busy || undefined}
              focusableWhenDisabled
              disabled={
                busy ||
                (action === "remove" && needsCloudConsent && !cloudConsent)
              }
              onClick={() => {
                if (action === "remove") remove.mutate();
                else change.mutate({ paused: action === "pause" });
              }}
            >
              <AsyncLabel
                state={busy ? "pending" : "idle"}
                idle={
                  action === "remove"
                    ? "Remove server"
                    : action === "pause"
                      ? "Pause server"
                      : "Resume server"
                }
                pending="Saving…"
              />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
