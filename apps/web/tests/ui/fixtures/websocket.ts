import type { Page, WebSocketRoute } from "@playwright/test";
import type { MockApiServer } from "./mock-api";

const terminalTranscript = Buffer.from(
  "\r\nintar scenario shell\r\nroot@web:~# systemctl status nginx\r\n" +
    "nginx.service - A high performance web server\r\n" +
    "   Active: failed (Result: exit-code)\r\nroot@web:~# ",
  "utf8",
);

function onOpen(websocket: WebSocketRoute, server: MockApiServer) {
  if (server.state.terminalMode === "error") {
    websocket.send(
      JSON.stringify({
        type: "error",
        message: "Deterministic terminal transport failure",
      }),
    );
    return;
  }

  websocket.send(JSON.stringify({ type: "ready" }));
  websocket.send(terminalTranscript);

  if (server.state.terminalMode === "disconnected") {
    setTimeout(() => {
      void websocket.close({ code: 1001, reason: "Fixture disconnect" });
    }, 50);
  }
}

// The real gateway accepts the socket while the VM boots and sends `ready`
// only once the target can take a shell. Mirror that, so a boot screen stays
// on screen until the fixture run actually reaches a usable terminal.
function terminalTargetReady(server: MockApiServer) {
  const vms = (server.state.run as { vms?: Array<Record<string, unknown>> }).vms;
  return Boolean(
    vms?.some((vm) => {
      const target = vm.terminalTarget as { host?: unknown } | undefined;
      return vm.canOpenTerminal === true && Boolean(target?.host);
    }),
  );
}

function openWhenTargetReady(
  websocket: WebSocketRoute,
  server: MockApiServer,
  isClosed: () => boolean,
) {
  if (isClosed()) return;
  if (terminalTargetReady(server)) {
    onOpen(websocket, server);
    return;
  }
  setTimeout(() => openWhenTargetReady(websocket, server, isClosed), 100);
}

export async function installTerminalWebSocketMock(
  page: Page,
  server: MockApiServer,
) {
  await page.routeWebSocket(/\/api\/scenarios\/runs\/[^/]+\/status\/stream$/, (ws) => {
    const runId = decodeURIComponent(new URL(ws.url()).pathname.split("/")[4]!);
    ws.send(JSON.stringify({ type: "subscribed", runId }));
  });
  let connectionCount = 0;
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    connectionCount += 1;
    const connectionOrdinal = connectionCount;
    let closed = false;
    ws.onClose(() => {
      closed = true;
    });
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      try {
        const control = JSON.parse(message) as { type?: string };
        if (control.type === "open") {
          if (
            server.state.terminalMode === "delayed-first-ready" &&
            connectionOrdinal === 1
          ) {
            setTimeout(
              () => openWhenTargetReady(ws, server, () => closed),
              1_000,
            );
          } else {
            openWhenTargetReady(ws, server, () => closed);
          }
        }
      } catch {
        // Terminal input is binary; malformed text frames are ignored here.
      }
    });
  });
}
