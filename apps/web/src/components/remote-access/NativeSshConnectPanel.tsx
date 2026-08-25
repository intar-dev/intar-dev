import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, KeyRound, LoaderCircle } from "lucide-react";
import { useSession } from "@/components/app/hooks/useSession";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  buildTemporaryNativeSshCommand,
  temporaryNativeSshKeyFilename,
} from "@/lib/native-ssh";
import {
  generateSshEd25519KeyPair,
  type SshEd25519KeyPair,
} from "@/lib/ssh-ed25519";
import {
  buildTemporaryNativeSshRequestScope,
  clearTemporaryNativeSshKey,
  loadTemporaryNativeSshKey,
  markTemporaryNativeSshKeyDownloaded,
  saveProvisionalTemporaryNativeSshKey,
  saveTemporaryNativeSshKey,
  temporaryNativeSshKeyWasDownloaded,
} from "@/lib/temporary-native-ssh-storage";

const NO_PROFILE_KEY_CODES = new Set([
  "scenario_native_ssh_key_required",
  "workshop_native_ssh_key_required",
]);

export interface NativeSshSessionRequest {
  url: string;
  body: Record<string, unknown>;
}

interface NativeTerminalSessionResponse {
  native: {
    authMode: "profile_keys" | "issued_key";
    authorizedKeyCount: number;
    host: string;
    port: number;
    username: string;
    command: string;
    publicHostKeyOpenssh: string;
    publicHostKeyFingerprintSha256: string;
    knownHostsLine: string;
    keyFilename?: string;
  };
  routeUsername: string;
  expiresAt: number;
}

interface NativeSshMutationInput {
  sessionRequest: NativeSshSessionRequest;
  requestScope: string;
  temporaryPublicKeyOpenssh?: string;
}

class NativeSshRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(input: { status: number; code?: string | null; message: string }) {
    super(input.message);
    this.name = "NativeSshRequestError";
    this.status = input.status;
    this.code = input.code ?? null;
  }
}

type CopyTarget = "command" | "knownHosts" | null;

// Issues a native-SSH route on mount and shows the credentials. Rendered
// inline on the run page and inside NativeSshDialogButton's dialog.
export function NativeSshConnectPanel({
  sessionRequest,
}: {
  sessionRequest: NativeSshSessionRequest;
}) {
  const { data: authenticatedSession, isLoading: sessionLoading } = useSession();
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(
    null,
  );
  const initialRequestScopeRef = useRef<string | null>(null);
  const temporaryKeyRef = useRef<SshEd25519KeyPair | null>(null);
  const sessionRequestBodyJson = useMemo(
    () => JSON.stringify(sessionRequest.body),
    [sessionRequest.body],
  );
  const authenticatedUserId = authenticatedSession?.user?.id?.trim() ?? "";
  const requestScope = useMemo(
    () =>
      authenticatedUserId
        ? buildTemporaryNativeSshRequestScope({
            userId: authenticatedUserId,
            url: sessionRequest.url,
            bodyJson: sessionRequestBodyJson,
          })
        : null,
    [authenticatedUserId, sessionRequest.url, sessionRequestBodyJson],
  );
  const request = useMemo(
    () => ({
      url: sessionRequest.url,
      body: JSON.parse(sessionRequestBodyJson) as Record<string, unknown>,
    }),
    [sessionRequest.url, sessionRequestBodyJson],
  );

  const sessionMutation = useMutation({
    gcTime: 0,
    mutationFn: issueNativeSshSession,
    onSuccess: (session, input) => {
      const keyPair = temporaryKeyRef.current;
      if (
        input.temporaryPublicKeyOpenssh &&
        session.native.authMode === "issued_key" &&
        keyPair?.publicKeyOpenssh === input.temporaryPublicKeyOpenssh
      ) {
        const persisted = saveTemporaryNativeSshKey({
          requestScope: input.requestScope,
          keyPair,
          expiresAt: session.expiresAt,
        });
        setPersistenceWarning(
          persisted
            ? null
            : "This browser cannot keep the temporary key after a refresh. Download it now.",
        );
      }
    },
    onError: (error, input) => {
      if (
        input.temporaryPublicKeyOpenssh &&
        error instanceof NativeSshRequestError &&
        error.code === "native_ssh_public_key_invalid"
      ) {
        clearTemporaryNativeSshKey(input.requestScope);
        if (
          temporaryKeyRef.current?.publicKeyOpenssh ===
          input.temporaryPublicKeyOpenssh
        ) {
          temporaryKeyRef.current = null;
        }
      }
    },
  });
  const { mutate, reset } = sessionMutation;

  const openSession = useCallback(
    (temporaryKey?: SshEd25519KeyPair) => {
      if (!requestScope) return;
      setCopied(null);
      setDownloaded(
        Boolean(
          temporaryKey &&
            temporaryNativeSshKeyWasDownloaded(requestScope),
        ),
      );
      setDownloadError(null);
      temporaryKeyRef.current = temporaryKey ?? null;
      if (temporaryKey) {
        const persisted = saveProvisionalTemporaryNativeSshKey(
          requestScope,
          temporaryKey,
        );
        setPersistenceWarning(
          persisted
            ? null
            : "This browser cannot keep the temporary key after a refresh. Download it now.",
        );
      } else {
        setPersistenceWarning(null);
      }
      reset();
      mutate({
        sessionRequest: request,
        requestScope,
        ...(temporaryKey
          ? { temporaryPublicKeyOpenssh: temporaryKey.publicKeyOpenssh }
          : {}),
      });
    },
    [mutate, request, requestScope, reset],
  );

  useEffect(() => {
    if (!requestScope) return;
    if (initialRequestScopeRef.current === requestScope) return;
    initialRequestScopeRef.current = requestScope;
    openSession(loadTemporaryNativeSshKey(requestScope));
  }, [openSession, requestScope]);

  useEffect(() => {
    const session = sessionMutation.data;
    if (!requestScope || session?.native.authMode !== "issued_key") return;

    const timeout = window.setTimeout(() => {
      clearTemporaryNativeSshKey(requestScope);
      openSession();
    }, Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [openSession, requestScope, sessionMutation.data]);

  const copyText = async (value: string, target: Exclude<CopyTarget, null>) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      throw new Error("clipboard is not available");
    }
    await navigator.clipboard.writeText(value);
    setCopied(target);
  };

  if (!requestScope) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {sessionLoading ? (
          <LoaderCircle className="size-5 motion-safe:animate-spin" />
        ) : null}
        <p>
          {sessionLoading
            ? "Checking your account…"
            : "Sign in again to open native SSH."}
        </p>
      </div>
    );
  }

  const session = sessionMutation.data;
  const temporaryPublicKeyOpenssh =
    sessionMutation.variables?.temporaryPublicKeyOpenssh ?? null;
  const temporaryKey =
    temporaryKeyRef.current?.publicKeyOpenssh === temporaryPublicKeyOpenssh
      ? temporaryKeyRef.current
      : null;
  const noProfileKey = isNoProfileKeyError(sessionMutation.error);

  if (sessionMutation.isPending) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-5 motion-safe:animate-spin" />
        <p>
          {temporaryPublicKeyOpenssh
            ? "Opening temporary SSH route…"
            : "Checking SSH access…"}
        </p>
      </div>
    );
  }

  if (noProfileKey) {
    return (
      <TemporaryKeyFallback
        onCreateTemporaryKey={() => {
          openSession(generateSshEd25519KeyPair("intar-temporary-ssh"));
        }}
      />
    );
  }

  if (sessionMutation.error) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {sessionMutation.error.message}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              openSession(
                temporaryKeyRef.current ??
                  loadTemporaryNativeSshKey(requestScope),
              )
            }
          >
            Try again
          </Button>
          <ProfileKeyLink />
        </div>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  const issuedTemporaryKey =
    session.native.authMode === "issued_key" ? temporaryKey : null;
  if (
    session.native.authMode === "issued_key" &&
    (!issuedTemporaryKey || !session.native.keyFilename)
  ) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          The temporary private key is not available in this browser session.
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() =>
            openSession(generateSshEd25519KeyPair("intar-temporary-ssh"))
          }
        >
          Create a new temporary key
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-x-5 gap-y-3 border-y py-3 text-sm sm:grid-cols-3">
        <SessionFact
          label="Access"
          value={
            session.native.authMode === "issued_key"
              ? "Temporary key"
              : "Saved profile key"
          }
        />
        <SessionFact
          label="Target"
          value={`${session.native.username}@${session.native.host}:${session.native.port}`}
          mono
        />
        <SessionFact
          label="Expires"
          value={new Date(session.expiresAt).toLocaleString()}
        />
      </div>

      {issuedTemporaryKey && session.native.keyFilename ? (
        <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              1. Download the temporary key
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              It stays in this tab through refreshes until the route expires.
              It is never added to your profile.
            </p>
          </div>
          <Button
            type="button"
            className="shrink-0"
            onClick={() => {
              setDownloadError(null);
              try {
                downloadTemporaryKey({
                  privateKeyOpenssh: issuedTemporaryKey.privateKeyOpenssh,
                  filename: session.native.keyFilename!,
                });
                markTemporaryNativeSshKeyDownloaded(requestScope);
                setDownloaded(true);
              } catch (error) {
                setDownloaded(false);
                setDownloadError(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          >
            <Download className="size-4" />
            Download temporary key
          </Button>
        </div>
      ) : null}

      {downloadError ? (
        <p role="alert" className="text-sm text-destructive">
          {downloadError}
        </p>
      ) : null}
      {persistenceWarning ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
        >
          {persistenceWarning}
        </p>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {downloaded ? "Temporary SSH key downloaded." : ""}
      </span>

      {session.native.authMode === "issued_key" ? (
        <p className="text-sm leading-6 text-muted-foreground">
          2. Run this in a macOS or Linux shell. On Windows, use WSL. The
          command expects the key in your Downloads folder; change the key_path
          value if you saved it elsewhere.
        </p>
      ) : null}
      <CopyableTextBlock
        label={
          session.native.authMode === "issued_key"
            ? "macOS/Linux SSH command"
            : "SSH command"
        }
        value={session.native.command}
        copied={copied === "command"}
        onCopy={() => copyText(session.native.command, "command")}
        rows={Math.max(3, session.native.command.split("\n").length + 1)}
        copyDisabled={
          session.native.authMode === "issued_key" && !downloaded
        }
      />

      {session.native.authMode === "issued_key" ? (
        <details className="border-t pt-3 text-sm">
          <summary className="cursor-pointer font-medium">
            Security details
          </summary>
          <div className="mt-3 space-y-3">
            <SessionFact
              label="Host fingerprint"
              value={session.native.publicHostKeyFingerprintSha256}
              mono
            />
            <CopyableTextBlock
              label="known_hosts entry"
              value={session.native.knownHostsLine}
              copied={copied === "knownHosts"}
              onCopy={() =>
                copyText(session.native.knownHostsLine, "knownHosts")
              }
              rows={2}
            />
          </div>
        </details>
      ) : (
        <CopyableTextBlock
          label="known_hosts entry"
          value={session.native.knownHostsLine}
          copied={copied === "knownHosts"}
          onCopy={() => copyText(session.native.knownHostsLine, "knownHosts")}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm text-muted-foreground">
        {session.native.authMode === "profile_keys" ? (
          <span className="font-mono text-xs">
            {session.native.publicHostKeyFingerprintSha256}
          </span>
        ) : (
          <span>Temporary route</span>
        )}
        <ProfileKeyLink />
      </div>
    </div>
  );
}

function TemporaryKeyFallback(props: {
  onCreateTemporaryKey: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 px-4 py-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">No saved SSH key</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Create a temporary key for this run, or use a public key already
          saved on your profile. The temporary private key stays in this tab
          through refreshes until the route expires.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={props.onCreateTemporaryKey}>
          <KeyRound className="size-4" />
          Create temporary SSH key
        </Button>
        <ProfileKeyLink />
      </div>
    </div>
  );
}

function ProfileKeyLink() {
  return (
    <Button size="sm" variant="link" render={<Link to="/profile" />}>
      Manage profile keys
    </Button>
  );
}

function SessionFact(props: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-eyebrow">{props.label}</p>
      <p
        className={`mt-1 text-sm ${props.mono ? "font-mono text-xs" : "font-medium"}`}
      >
        {props.value}
      </p>
    </div>
  );
}

function CopyableTextBlock(props: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => Promise<void>;
  rows?: number;
  copyDisabled?: boolean;
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
          disabled={props.copyDisabled}
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

async function issueNativeSshSession(
  input: NativeSshMutationInput,
): Promise<NativeTerminalSessionResponse> {
  const response = await fetch(input.sessionRequest.url, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...input.sessionRequest.body,
      mode: "native",
      ...(input.temporaryPublicKeyOpenssh
        ? { clientPublicKeyOpenssh: input.temporaryPublicKeyOpenssh }
        : {}),
    }),
  });

  const body = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (!response.ok) {
    throw new NativeSshRequestError({
      status: response.status,
      code: typeof body?.code === "string" ? body.code : null,
      message:
        typeof body?.error === "string"
          ? body.error
          : `Failed to create native SSH session (${response.status})`,
    });
  }

  const session = parseNativeSshSessionResponse(body);
  if (
    input.temporaryPublicKeyOpenssh &&
    session.native.authMode !== "issued_key"
  ) {
    throw new Error("temporary SSH key was not accepted by the route");
  }
  if (
    !input.temporaryPublicKeyOpenssh &&
    session.native.authMode === "issued_key"
  ) {
    throw new Error("native SSH route returned an unexpected temporary key");
  }
  return session;
}

export function parseNativeSshSessionResponse(
  body: Record<string, unknown> | null,
): NativeTerminalSessionResponse {
  const native = body?.native;
  if (
    !body ||
    !isRecord(native) ||
    (native.authMode !== "profile_keys" && native.authMode !== "issued_key") ||
    typeof native.authorizedKeyCount !== "number" ||
    !Number.isInteger(native.authorizedKeyCount) ||
    native.authorizedKeyCount < 1 ||
    !isBoundedSingleLine(native.host, 253) ||
    /\s/.test(native.host) ||
    typeof native.port !== "number" ||
    !Number.isInteger(native.port) ||
    native.port < 1 ||
    native.port > 65_535 ||
    !isRouteUsername(native.username) ||
    !isBoundedText(native.command, 16_384) ||
    native.command.includes("\0") ||
    !isBoundedSingleLine(native.publicHostKeyOpenssh, 8_192) ||
    !native.publicHostKeyOpenssh.startsWith("ssh-ed25519 ") ||
    !isBoundedSingleLine(native.publicHostKeyFingerprintSha256, 256) ||
    !isBoundedSingleLine(native.knownHostsLine, 8_192) ||
    !isRouteUsername(body.routeUsername) ||
    native.username !== body.routeUsername ||
    typeof body.expiresAt !== "number" ||
    !Number.isFinite(body.expiresAt) ||
    body.expiresAt <= Date.now()
  ) {
    throw new Error("native SSH session returned an invalid payload");
  }

  const keyFilename =
    typeof native.keyFilename === "string" ? native.keyFilename : undefined;
  if (native.authMode === "issued_key") {
    const expectedFilename = temporaryNativeSshKeyFilename(body.routeUsername);
    const expectedCommand = buildTemporaryNativeSshCommand({
      username: native.username,
      host: native.host,
      port: native.port,
      knownHostsLine: native.knownHostsLine,
      keyFilename: expectedFilename,
    });
    if (
      native.authorizedKeyCount !== 1 ||
      keyFilename !== expectedFilename ||
      native.command !== expectedCommand
    ) {
      throw new Error("native SSH session returned an invalid payload");
    }
  } else if (keyFilename !== undefined) {
    throw new Error("native SSH session returned an invalid payload");
  }

  return {
    routeUsername: body.routeUsername,
    expiresAt: body.expiresAt,
    native: {
      authMode: native.authMode,
      authorizedKeyCount: native.authorizedKeyCount,
      host: native.host,
      port: native.port,
      username: native.username,
      command: native.command,
      publicHostKeyOpenssh: native.publicHostKeyOpenssh,
      publicHostKeyFingerprintSha256: native.publicHostKeyFingerprintSha256,
      knownHostsLine: native.knownHostsLine,
      ...(keyFilename ? { keyFilename } : {}),
    },
  };
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isBoundedSingleLine(
  value: unknown,
  maxLength: number,
): value is string {
  return isBoundedText(value, maxLength) && !/[\r\n\0]/.test(value);
}

function isRouteUsername(value: unknown): value is string {
  return (
    isBoundedSingleLine(value, 128) && /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNoProfileKeyError(error: unknown) {
  return (
    error instanceof NativeSshRequestError &&
    error.status === 409 &&
    error.code !== null &&
    NO_PROFILE_KEY_CODES.has(error.code)
  );
}

function downloadTemporaryKey(input: {
  privateKeyOpenssh: string;
  filename: string;
}) {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    throw new Error("downloads are not available in this browser");
  }

  const url = URL.createObjectURL(
    new Blob([input.privateKeyOpenssh], {
      type: "application/octet-stream",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = input.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
