import "@xterm/xterm/css/xterm.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  REPLAY_TERMINAL_COLS,
  REPLAY_TERMINAL_FONT_FAMILY,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_ROWS,
  REPLAY_TERMINAL_XTERM_THEME,
  loadReplayTerminalFont,
} from "@/lib/replay/config";

interface WebSshTerminalProps {
  vmName: string;
  sessionRequest: {
    url: string;
    body: Record<string, unknown>;
  };
  variant?: "modal" | "embedded";
  title?: string;
  onClose?: () => void;
  showCloseButton?: boolean;
}

interface VmBrowserTerminalSessionResponse {
  routeUsername: string;
  expiresAt: number;
  browser: {
    websocketUrl: string;
  };
}

type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

type TerminalControlMessage =
  | { type: "open"; cols: number; rows: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };

type TerminalEventMessage =
  | { type: "ready" }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

const SSH_CONNECT_RETRY_ATTEMPTS = 6;
const SSH_CONNECT_RETRY_BASE_MS = 250;
const TERMINAL_MIN_COLS = 20;
const TERMINAL_MIN_ROWS = 5;
const RESIZE_SEND_DEBOUNCE_MS = 200;
const textEncoder = new TextEncoder();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientBootstrapError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("still warming up") ||
    m.includes("not ready") ||
    m.includes("temporarily unavailable") ||
    m.includes("gateway timeout")
  );
}

function isTransientConnectError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("temporarily unavailable") ||
    m.includes("connection reset") ||
    m.includes("websocket") ||
    m.includes("closed")
  );
}

export function WebSshTerminal({
  vmName,
  sessionRequest,
  variant = "modal",
  title: titleOverride,
  onClose,
  showCloseButton = true,
}: WebSshTerminalProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitGridRef = useRef<(() => void) | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const connectionGenerationRef = useRef(0);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(true);

  const title = useMemo(
    () => titleOverride ?? `Web SSH · ${vmName}`,
    [titleOverride, vmName],
  );
  const needsRecovery = status === "disconnected" || status === "error";
  const sessionRequestUrl = sessionRequest?.url ?? null;
  const sessionRequestBodyJson = useMemo(() => {
    if (!sessionRequest?.body) {
      return null;
    }

    return JSON.stringify(sessionRequest.body);
  }, [sessionRequest?.body]);

  const closeCurrentSocket = useCallback(() => {
    if (resizeSendTimerRef.current !== null) {
      clearTimeout(resizeSendTimerRef.current);
      resizeSendTimerRef.current = null;
    }
    const websocket = websocketRef.current;
    websocketRef.current = null;
    if (websocket) {
      try {
        if (websocket.readyState === WebSocket.OPEN) {
          sendTerminalControl(websocket, { type: "close" });
        }
      } catch {
        // ignore
      }
      try {
        websocket.close();
      } catch {
        // ignore
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    // Invalidate callbacks before closing the socket. A delayed close from an
    // old connection must not clear a newer live connection.
    connectionGenerationRef.current += 1;
    closeCurrentSocket();
  }, [closeCurrentSocket]);

  const ensureTerminal = useCallback(() => {
    if (terminalRef.current) {
      return terminalRef.current;
    }

    // 120x30 is only the pre-fit fallback; the grid reflows to the container
    // and every change is forwarded to the PTY as a resize control frame.
    const terminal = new Terminal({
      cols: REPLAY_TERMINAL_COLS,
      rows: REPLAY_TERMINAL_ROWS,
      convertEol: true,
      cursorBlink: true,
      fontFamily: REPLAY_TERMINAL_FONT_FAMILY,
      fontSize: 14,
      lineHeight: REPLAY_TERMINAL_LINE_HEIGHT,
      theme: REPLAY_TERMINAL_XTERM_THEME,
    });

    if (!terminalContainerRef.current) {
      throw new Error("terminal container not available");
    }

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);

    terminal.onData((data) => {
      const websocket = websocketRef.current;
      if (!websocket || websocket.readyState !== WebSocket.OPEN) {
        return;
      }
      websocket.send(textEncoder.encode(data));
    });

    terminal.onResize(({ cols, rows }) => {
      if (resizeSendTimerRef.current !== null) {
        clearTimeout(resizeSendTimerRef.current);
      }
      resizeSendTimerRef.current = setTimeout(() => {
        resizeSendTimerRef.current = null;
        const websocket = websocketRef.current;
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          sendTerminalControl(websocket, { type: "resize", cols, rows });
        }
      }, RESIZE_SEND_DEBOUNCE_MS);
    });

    const fitGrid = () => {
      // proposeDimensions() returns undefined for hidden/zero-size containers.
      const dims = fitAddon.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
        return;
      }
      const cols = Math.max(TERMINAL_MIN_COLS, dims.cols);
      const rows = Math.max(TERMINAL_MIN_ROWS, dims.rows);
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.resize(cols, rows);
      }
    };
    fitGrid();

    const container = terminalContainerRef.current;
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) {
        return;
      }
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        fitGrid();
      });
    };
    window.addEventListener("resize", scheduleFit);
    const resizeObserver =
      typeof ResizeObserver !== "undefined" && container
        ? new ResizeObserver(scheduleFit)
        : null;
    if (resizeObserver && container) {
      resizeObserver.observe(container);
    }
    resizeCleanupRef.current = () => {
      window.removeEventListener("resize", scheduleFit);
      resizeObserver?.disconnect();
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame);
        fitFrame = null;
      }
    };

    terminalRef.current = terminal;
    fitGridRef.current = fitGrid;
    return terminal;
  }, []);

  const connect = useCallback(async () => {
    const connectionGeneration = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = connectionGeneration;
    setError(null);
    setStatus("connecting");
    let terminal: Terminal | null = null;

    try {
      // xterm measures and rasterizes text onto a canvas at construction time.
      // Wait for the self-hosted face so it never locks in fallback metrics.
      await loadReplayTerminalFont();
      if (connectionGenerationRef.current !== connectionGeneration) return;

      terminal = ensureTerminal();
      const connectedTerminal = terminal;
      connectedTerminal.clear();
      connectedTerminal.writeln("[intar] Creating terminal session...");

      // The generation was invalidated before the old socket is closed, so
      // its delayed close callback cannot overwrite this attempt.
      closeCurrentSocket();
      // Fit before the websocket dance so `open` carries the real grid.
      fitGridRef.current?.();

      const sessionBundle = await createSessionWithRetries({
        sessionRequestBodyJson,
        sessionRequestUrl,
        terminal: connectedTerminal,
      });
      if (connectionGenerationRef.current !== connectionGeneration) return;
      connectedTerminal.writeln(
        `[intar] Route ${sessionBundle.routeUsername} ready. Opening terminal...`,
      );

      const websocket = await connectBrowserTerminalWithRetries({
        session: sessionBundle,
        terminal: connectedTerminal,
        isCurrent: () =>
          connectionGenerationRef.current === connectionGeneration,
        onRemoteClose: (message) => {
          if (connectionGenerationRef.current !== connectionGeneration) return;
          if (message) {
            connectedTerminal.writeln(`\r\n[intar] ${message}`);
          }
          websocketRef.current = null;
          setStatus("disconnected");
        },
        onRemoteError: (message) => {
          if (connectionGenerationRef.current !== connectionGeneration) return;
          connectedTerminal.writeln(`\r\n[intar] ERROR: ${message}`);
          websocketRef.current = null;
          setError(message);
          setStatus("error");
        },
      });
      if (connectionGenerationRef.current !== connectionGeneration) {
        websocket.close();
        return;
      }
      websocketRef.current = websocket;

      fitGridRef.current?.();
      // Cover a container resize during the connect window; server-side this
      // is an idempotent SIGWINCH.
      sendTerminalControl(websocket, {
        type: "resize",
        cols: connectedTerminal.cols,
        rows: connectedTerminal.rows,
      });
      connectedTerminal.writeln("[intar] Connected.");
      setStatus("connected");
    } catch (connectError) {
      if (connectionGenerationRef.current !== connectionGeneration) return;
      closeCurrentSocket();
      const message =
        connectError instanceof Error
          ? connectError.message
          : "failed to establish terminal session";
      terminal?.writeln(`\r\n[intar] ERROR: ${message}`);
      setError(message);
      setStatus("error");
    }
  }, [
    closeCurrentSocket,
    ensureTerminal,
    sessionRequestBodyJson,
    sessionRequestUrl,
  ]);

  const closeTerminal = useCallback(() => {
    disconnect();
    // Let the dialog commit its closed state before the parent removes it so
    // Base UI can restore focus to the element that opened the terminal.
    window.setTimeout(() => onClose?.(), 0);
  }, [disconnect, onClose]);

  useEffect(() => {
    void connect();

    return () => {
      disconnect();
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitGridRef.current = null;
    };
  }, [connect, disconnect]);

  if (variant === "embedded") {
    return (
      <div className="flex h-full min-h-0 w-full max-w-full flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{title}</p>
            {/* Stays in the DOM as the transport live region; only shown
                while the connection needs attention. */}
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={
                status === "connected"
                  ? "sr-only"
                  : "text-xs text-muted-foreground"
              }
            >
              Terminal status: {status}
            </p>
          </div>
          {showCloseButton ? (
            <Button size="sm" variant="outline" onClick={closeTerminal}>
              Close
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 bg-terminal-background p-2">
          <div className="relative h-full w-full">
            <div
              ref={terminalContainerRef}
              className="absolute inset-0 overflow-hidden"
            />
          </div>
        </div>

        {needsRecovery ? (
          <TerminalRecoveryNotice
            error={error}
            onReconnect={() => {
              void connect();
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <Dialog
      open={modalOpen}
      onOpenChange={(open) => {
        setModalOpen(open);
        if (!open) closeTerminal();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(52rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-lg bg-card p-0 sm:max-w-7xl"
      >
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm font-semibold">
              {title}
            </DialogTitle>
            <DialogDescription
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={
                status === "connected"
                  ? "sr-only"
                  : "text-xs text-muted-foreground"
              }
            >
              Terminal status: {status}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            {status === "connected" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void connect();
                }}
              >
                Reconnect
              </Button>
            ) : null}
            {showCloseButton ? (
              <DialogClose render={<Button size="sm" variant="outline" />}>
                Close
              </DialogClose>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-terminal-background p-2">
          <div className="relative h-full w-full">
            <div
              ref={terminalContainerRef}
              className="absolute inset-0 overflow-hidden"
            />
          </div>
        </div>

        {needsRecovery ? (
          <TerminalRecoveryNotice
            error={error}
            onReconnect={() => {
              void connect();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TerminalRecoveryNotice({
  error,
  onReconnect,
}: {
  error: string | null;
  onReconnect: () => void;
}) {
  const hasError = error !== null;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p
        role={hasError ? "alert" : "status"}
        aria-live={hasError ? "assertive" : "polite"}
        aria-atomic="true"
        className={`text-sm ${
          hasError ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {hasError
          ? "The terminal connection needs recovery. Reconnect to try again."
          : "The terminal session ended. Reconnect to continue."}
      </p>
      <Button
        size="sm"
        variant="outline"
        className="min-h-11 w-full shrink-0 sm:w-auto"
        onClick={onReconnect}
      >
        Reconnect terminal
      </Button>
    </div>
  );
}

async function createSessionWithRetries(input: {
  sessionRequestBodyJson: string | null;
  sessionRequestUrl: string | null;
  terminal: Terminal;
}): Promise<VmBrowserTerminalSessionResponse> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= SSH_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const sessionUrl = input.sessionRequestUrl;
      const sessionBody =
        input.sessionRequestBodyJson !== null
          ? (JSON.parse(input.sessionRequestBodyJson) as Record<string, unknown>)
          : null;
      if (!sessionUrl || !sessionBody) {
        throw new Error("terminal session request is not configured");
      }
      const response = await fetch(sessionUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...sessionBody,
          mode: "browser",
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `session bootstrap failed (${response.status})`,
        );
      }

      const session = (await response.json()) as VmBrowserTerminalSessionResponse;
      if (
        typeof session.routeUsername !== "string" ||
        typeof session.expiresAt !== "number" ||
        typeof session.browser?.websocketUrl !== "string"
      ) {
        throw new Error("session bootstrap returned an invalid payload");
      }
      return session;
    } catch (error) {
      lastError = toErrorMessage(error);
      if (
        !isTransientBootstrapError(lastError) ||
        attempt === SSH_CONNECT_RETRY_ATTEMPTS
      ) {
        throw new Error(`session bootstrap failed: ${lastError}`);
      }

      input.terminal.writeln(
        `[intar] Session bootstrap still warming up (${attempt}/${SSH_CONNECT_RETRY_ATTEMPTS})...`,
      );
      const backoffMs = SSH_CONNECT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(Math.min(backoffMs, 5_000));
    }
  }

  throw new Error(`session bootstrap failed: ${lastError}`);
}

async function connectBrowserTerminalWithRetries(input: {
  session: VmBrowserTerminalSessionResponse;
  terminal: Terminal;
  isCurrent: () => boolean;
  onRemoteClose: (message?: string) => void;
  onRemoteError: (message: string) => void;
}): Promise<WebSocket> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= SSH_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await connectBrowserTerminal(input);
    } catch (error) {
      lastError = toErrorMessage(error);
      if (
        !isTransientConnectError(lastError) ||
        attempt === SSH_CONNECT_RETRY_ATTEMPTS
      ) {
        throw new Error(`terminal connection failed: ${lastError}`);
      }

      input.terminal.writeln(
        `[intar] Terminal transport still warming up (${attempt}/${SSH_CONNECT_RETRY_ATTEMPTS})...`,
      );
      const backoffMs = SSH_CONNECT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(Math.min(backoffMs, 5_000));
    }
  }

  throw new Error(`terminal connection failed: ${lastError}`);
}

async function connectBrowserTerminal(input: {
  session: VmBrowserTerminalSessionResponse;
  terminal: Terminal;
  isCurrent: () => boolean;
  onRemoteClose: (message?: string) => void;
  onRemoteError: (message: string) => void;
}): Promise<WebSocket> {
  const websocket = new WebSocket(input.session.browser.websocketUrl);
  websocket.binaryType = "arraybuffer";
  await waitForWebSocketOpen(websocket);

  try {
    const ready = new Promise<void>((resolve, reject) => {
      let resolved = false;
      let terminalEnded = false;

      const handleMessage = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          const control = parseTerminalEvent(event.data);
          if (!control) {
            return;
          }
          switch (control.type) {
            case "ready":
              resolved = true;
              resolve();
              return;
            case "exit":
              if (!terminalEnded) {
                terminalEnded = true;
                input.onRemoteClose(`Session ended (exit ${control.code}).`);
              }
              try {
                websocket.close();
              } catch {
                // ignore
              }
              return;
            case "error":
              if (!resolved) {
                terminalEnded = true;
                reject(new Error(control.message));
              } else if (!terminalEnded) {
                terminalEnded = true;
                input.onRemoteError(control.message);
              }
              try {
                websocket.close();
              } catch {
                // ignore
              }
              return;
          }
        }

        if (event.data instanceof ArrayBuffer && input.isCurrent()) {
          input.terminal.write(decodeTerminalOutput(event.data));
        }
      };

      const handleClose = () => {
        if (!resolved) {
          reject(new Error("websocket closed before terminal opened"));
        } else if (!terminalEnded) {
          terminalEnded = true;
          input.onRemoteClose();
        }
      };

      const handleError = () => {
        if (!resolved) {
          reject(new Error("websocket connection failed"));
        }
      };

      websocket.addEventListener("message", handleMessage);
      websocket.addEventListener("close", handleClose, { once: true });
      websocket.addEventListener("error", handleError, { once: true });
    });

    sendTerminalControl(websocket, {
      type: "open",
      cols: input.terminal.cols,
      rows: input.terminal.rows,
    });
    await ready;
    return websocket;
  } catch (error) {
    try {
      websocket.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

function parseTerminalEvent(raw: string): TerminalEventMessage | null {
  try {
    const parsed = JSON.parse(raw) as TerminalEventMessage;
    if (parsed?.type === "ready") {
      return parsed;
    }
    if (parsed?.type === "exit" && typeof parsed.code === "number") {
      return parsed;
    }
    if (parsed?.type === "error" && typeof parsed.message === "string") {
      return parsed;
    }
  } catch {
    // ignore malformed control frames
  }
  return null;
}

function sendTerminalControl(
  websocket: WebSocket,
  message: TerminalControlMessage,
): void {
  if (websocket.readyState !== WebSocket.OPEN) {
    return;
  }
  websocket.send(JSON.stringify(message));
}

function waitForWebSocketOpen(websocket: WebSocket): Promise<void> {
  if (websocket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("websocket connection failed"));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("websocket closed before terminal session opened"));
    };
    const cleanup = () => {
      websocket.removeEventListener("open", handleOpen);
      websocket.removeEventListener("error", handleError);
      websocket.removeEventListener("close", handleClose);
    };

    websocket.addEventListener("open", handleOpen);
    websocket.addEventListener("error", handleError);
    websocket.addEventListener("close", handleClose);
  });
}

function decodeTerminalOutput(data: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(data));
}
