import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface NativeSshSessionRequest {
  url: string;
  body: Record<string, unknown>;
}

interface NativeTerminalSessionResponse {
  native: {
    authMode: "profile_keys";
    authorizedKeyCount: number;
    host: string;
    port: number;
    username: string;
    command: string;
    publicHostKeyOpenssh?: string;
    publicHostKeyFingerprintSha256?: string;
    knownHostsLine?: string;
  };
  routeUsername?: string;
  expiresAt?: number;
}

type CopyTarget = "command" | "knownHosts" | null;

// Issues a native-SSH route on mount and shows the credentials. Rendered
// inline on the run page and inside NativeSshDialogButton's dialog.
export function NativeSshConnectPanel({
  sessionRequest,
}: {
  sessionRequest: NativeSshSessionRequest;
}) {
  const [copied, setCopied] = useState<CopyTarget>(null);

  const sessionMutation = useMutation({
    mutationFn: async (): Promise<NativeTerminalSessionResponse> => {
      const response = await fetch(sessionRequest.url, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...sessionRequest.body,
          mode: "native",
        }),
      });

      const body = (await response.json().catch(() => null)) as
        | {
            error?: string;
            routeUsername?: string;
            expiresAt?: number;
            native?: NativeTerminalSessionResponse["native"];
          }
        | null;

      if (
        !response.ok ||
        !body ||
        !body.native ||
        body.native.authMode !== "profile_keys" ||
        typeof body.native.authorizedKeyCount !== "number" ||
        typeof body.native.host !== "string" ||
        typeof body.native.port !== "number" ||
        typeof body.native.username !== "string" ||
        typeof body.native.command !== "string"
      ) {
        throw new Error(
          body?.error ??
            `Failed to create native SSH session (${response.status})`,
        );
      }

      const session: NativeTerminalSessionResponse = {
        native: body.native,
      };
      if (typeof body.routeUsername === "string") {
        session.routeUsername = body.routeUsername;
      }
      if (typeof body.expiresAt === "number") {
        session.expiresAt = body.expiresAt;
      }

      return session;
    },
  });

  const { mutate, reset } = sessionMutation;
  useEffect(() => {
    setCopied(null);
    reset();
    mutate();
  }, [mutate, reset]);

  const copyText = async (value: string, target: Exclude<CopyTarget, null>) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      throw new Error("clipboard is not available");
    }
    await navigator.clipboard.writeText(value);
    setCopied(target);
  };

  const session = sessionMutation.data;

  if (sessionMutation.isPending) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 motion-safe:animate-spin" />
        <p>Issuing SSH credentials…</p>
      </div>
    );
  }

  if (sessionMutation.error) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {sessionMutation.error.message}
        </div>
        <NoKeysHint />
      </div>
    );
  }

  if (!session) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border bg-primary/5 px-4 py-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-eyebrow">
            Access mode
          </p>
          <p className="mt-1 font-medium">Profile key route</p>
        </div>
        {session.routeUsername ? (
          <div>
            <p className="text-eyebrow">
              Route
            </p>
            <p className="mt-1 font-mono text-xs">{session.routeUsername}</p>
          </div>
        ) : null}
        {typeof session.expiresAt === "number" ? (
          <div>
            <p className="text-eyebrow">
              Expires
            </p>
            <p className="mt-1">{new Date(session.expiresAt).toLocaleString()}</p>
          </div>
        ) : null}
        <div>
          <p className="text-eyebrow">
            Target
          </p>
          <p className="mt-1 font-mono text-xs">
            {session.native.username}@{session.native.host}:{session.native.port}
          </p>
        </div>
        <div>
          <p className="text-eyebrow">
            Authorized keys
          </p>
          <p className="mt-1">{session.native.authorizedKeyCount} loaded</p>
        </div>
        <div>
          <p className="text-eyebrow">
            Host key
          </p>
          <p className="mt-1 font-mono text-xs">
            {session.native.publicHostKeyFingerprintSha256}
          </p>
        </div>
      </div>

      {session.native.authorizedKeyCount === 0 ? <NoKeysHint /> : null}

      <CopyableTextBlock
        label="SSH command"
        value={session.native.command}
        copied={copied === "command"}
        onCopy={() => copyText(session.native.command, "command")}
      />

      <CopyableTextBlock
        label="known_hosts entry"
        value={session.native.knownHostsLine ?? ""}
        copied={copied === "knownHosts"}
        onCopy={() => copyText(session.native.knownHostsLine ?? "", "knownHosts")}
      />
    </div>
  );
}

function NoKeysHint() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
      <p className="text-sm text-muted-foreground">
        Native SSH authenticates with the Ed25519 keys saved on your profile.
      </p>
      <Button size="sm" variant="outline" render={<Link to="/profile" />}>
        <KeyRound className="size-3.5" />
        Manage SSH keys
      </Button>
    </div>
  );
}

function CopyableTextBlock(props: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => Promise<void>;
  rows?: number;
}) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const fieldId = useId();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {props.label}
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setCopyError(null);
            void props.onCopy().catch((error) => {
              setCopyError(error instanceof Error ? error.message : String(error));
            });
          }}
        >
          {props.copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <Textarea
        id={fieldId}
        value={props.value}
        readOnly
        rows={props.rows ?? 3}
        className="font-mono text-xs"
      />
      <span role="status" aria-live="polite" className="sr-only">
        {props.copied ? `${props.label} copied.` : ""}
      </span>
      {copyError ? (
        <p role="alert" className="text-xs text-destructive">
          {copyError}
        </p>
      ) : null}
    </div>
  );
}
