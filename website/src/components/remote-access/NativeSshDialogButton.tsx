import { type ComponentProps, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface NativeSshDialogButtonProps {
  vmName: string;
  sessionRequest: {
    url: string;
    body: Record<string, unknown>;
  };
  disabled?: boolean;
  label?: string;
  size?: ComponentProps<typeof Button>["size"];
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
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

export function NativeSshDialogButton({
  vmName,
  sessionRequest,
  disabled = false,
  label = "Native SSH",
  size = "sm",
  variant = "outline",
  className,
}: NativeSshDialogButtonProps) {
  const [open, setOpen] = useState(false);
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

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setCopied(null);
    if (!nextOpen) {
      return;
    }
    sessionMutation.reset();
    sessionMutation.mutate();
  };

  const copyText = async (value: string, target: Exclude<CopyTarget, null>) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      throw new Error("clipboard is not available");
    }
    await navigator.clipboard.writeText(value);
    setCopied(target);
  };

  const session = sessionMutation.data;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size={size}
          variant={variant}
          className={className}
          disabled={disabled}
        >
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Native SSH for {vmName}</DialogTitle>
          <DialogDescription>
            This route accepts one of the Ed25519 keys saved on your profile.
            Use your own local SSH identity and connect through Stargate.
          </DialogDescription>
        </DialogHeader>

        {sessionMutation.isPending ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <LoaderCircle className="size-5 motion-safe:animate-spin" />
            <p>Issuing SSH credentials…</p>
          </div>
        ) : sessionMutation.error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {sessionMutation.error.message}
          </div>
        ) : session ? (
          <div className="space-y-4">
            <div
              className="grid gap-3 rounded-lg border bg-primary/5 px-4 py-3 text-sm sm:grid-cols-4"
            >
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Access mode
                </p>
                <p className="mt-1 font-medium">
                  Profile key route
                </p>
              </div>
              {session.routeUsername ? (
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    Route
                  </p>
                  <p className="mt-1 font-mono text-xs">{session.routeUsername}</p>
                </div>
              ) : null}
              {typeof session.expiresAt === "number" ? (
                <div>
                  <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    Expires
                  </p>
                  <p className="mt-1">
                    {new Date(session.expiresAt).toLocaleString()}
                  </p>
                </div>
              ) : null}
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Target
                </p>
                <p className="mt-1 font-mono text-xs">
                  {session.native.username}@{session.native.host}:{session.native.port}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Authorized keys
                </p>
                <p className="mt-1">
                  {session.native.authorizedKeyCount} loaded
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                  Host key
                </p>
                <p className="mt-1 font-mono text-xs">
                  {session.native.publicHostKeyFingerprintSha256}
                </p>
              </div>
            </div>

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
              onCopy={() =>
                copyText(session.native.knownHostsLine ?? "", "knownHosts")
              }
            />

          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{props.label}</p>
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
        value={props.value}
        readOnly
        rows={props.rows ?? 3}
        className="font-mono text-xs"
      />
      {copyError ? (
        <p className="text-xs text-destructive">{copyError}</p>
      ) : null}
    </div>
  );
}
