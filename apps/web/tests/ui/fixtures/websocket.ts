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

export async function installTerminalWebSocketMock(
  page: Page,
  server: MockApiServer,
) {
  let connectionCount = 0;
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    connectionCount += 1;
    const connectionOrdinal = connectionCount;
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      try {
        const control = JSON.parse(message) as { type?: string };
        if (control.type === "open") {
          if (
            server.state.terminalMode === "delayed-first-ready" &&
            connectionOrdinal === 1
          ) {
            setTimeout(() => onOpen(ws, server), 1_000);
          } else {
            onOpen(ws, server);
          }
        }
      } catch {
        // Terminal input is binary; malformed text frames are ignored here.
      }
    });
  });
}
