import "@xterm/xterm/css/xterm.css";

import {
  type ReactNode,
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
  headerActions?: ReactNode;
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
  headerActions,
}: WebSshTerminalProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitGridRef = useRef<(() => void) | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(true);

  const title = useMemo(
    () => titleOverride ?? `Web SSH · ${vmName}`,
    [titleOverride, vmName],
  );
  const sessionRequestUrl = sessionRequest?.url ?? null;
  const sessionRequestBodyJson = useMemo(() => {
    if (!sessionRequest?.body) {
      return null;
    }

    return JSON.stringify(sessionRequest.body);
  }, [sessionRequest?.body]);

  const disconnect = useCallback(async () => {
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
    setError(null);
    setStatus("connecting");

    // xterm measures and rasterizes text onto a canvas at construction time.
    // Wait for the self-hosted face so it never locks in fallback metrics.
    await loadReplayTerminalFont();
    const terminal = ensureTerminal();
    terminal.clear();
    terminal.writeln("[intar] Creating terminal session...");

    await disconnect();
    // Fit before the websocket dance so `open` carries the real grid.
    fitGridRef.current?.();

    try {
      const sessionBundle = await createSessionWithRetries({
        sessionRequestBodyJson,
        sessionRequestUrl,
        terminal,
      });
      terminal.writeln(
        `[intar] Route ${sessionBundle.routeUsername} ready. Opening terminal...`,
      );

      const websocket = await connectBrowserTerminalWithRetries({
        session: sessionBundle,
        terminal,
        onRemoteClose: (message) => {
          if (message) {
            terminal.writeln(`\r\n[intar] ${message}`);
          }
          websocketRef.current = null;
          setStatus("disconnected");
        },
        onRemoteError: (message) => {
          terminal.writeln(`\r\n[intar] ERROR: ${message}`);
          websocketRef.current = null;
          setError(message);
          setStatus("error");
        },
      });
      websocketRef.current = websocket;

      fitGridRef.current?.();
      // Cover a container resize during the connect window; server-side this
      // is an idempotent SIGWINCH.
      sendTerminalControl(websocket, {
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
      terminal.writeln("[intar] Connected.");
      setStatus("connected");
    } catch (connectError) {
      await disconnect();
      const message =
        connectError instanceof Error
          ? connectError.message
          : "failed to establish terminal session";
      terminal.writeln(`\r\n[intar] ERROR: ${message}`);
      setError(message);
      setStatus("error");
    }
  }, [
    disconnect,
    ensureTerminal,
    sessionRequestBodyJson,
    sessionRequestUrl,
  ]);

  const closeTerminal = useCallback(() => {
    void disconnect();
    // Let the dialog commit its closed state before the parent removes it so
    // Base UI can restore focus to the element that opened the terminal.
    window.setTimeout(() => onClose?.(), 0);
  }, [disconnect, onClose]);

  useEffect(() => {
    void connect();

    return () => {
      void disconnect();
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void connect();
              }}
              disabled={status === "connecting"}
            >
              {status === "connecting" ? "Connecting..." : "Reconnect"}
            </Button>
            {headerActions}
            {showCloseButton ? (
              <Button size="sm" variant="outline" onClick={closeTerminal}>
                Close
              </Button>
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

        {error || status === "disconnected" ? (
          <div className="flex shrink-0 border-t px-4 py-3">
            <p
              role={error ? "alert" : "status"}
              aria-live={error ? "assertive" : "polite"}
              aria-atomic="true"
              className={`text-xs ${
                error ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {error ?? "Terminal session ended."}
            </p>
          </div>
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
              className="text-xs"
            >
              Terminal status: {status}
            </DialogDescription>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => {
                void connect();
              }}
              disabled={status === "connecting"}
            >
              {status === "connecting" ? "Connecting..." : "Reconnect"}
            </Button>
            {headerActions}
            {showCloseButton ? (
              <DialogClose
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full sm:w-auto"
                  />
                }
              >
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

        {error || status === "disconnected" ? (
          <div className="flex border-t px-4 py-3">
            <p
              role={error ? "alert" : "status"}
              aria-live={error ? "assertive" : "polite"}
              aria-atomic="true"
              className={`text-xs ${
                error ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {error ?? "Terminal session ended."}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
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
  onRemoteClose: (message?: string) => void;
  onRemoteError: (message: string) => void;
}): Promise<WebSocket> {
  const websocket = new WebSocket(input.session.browser.websocketUrl);
  websocket.binaryType = "arraybuffer";
  await waitForWebSocketOpen(websocket);

  try {
    const ready = new Promise<void>((resolve, reject) => {
      let resolved = false;

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
              input.onRemoteClose(`Session ended (exit ${control.code}).`);
              try {
                websocket.close();
              } catch {
                // ignore
              }
              return;
            case "error":
              if (!resolved) {
                reject(new Error(control.message));
              } else {
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

        if (event.data instanceof ArrayBuffer) {
          input.terminal.write(decodeTerminalOutput(event.data));
        }
      };

      const handleClose = () => {
        if (!resolved) {
          reject(new Error("websocket closed before terminal opened"));
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
