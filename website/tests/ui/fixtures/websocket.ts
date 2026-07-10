import type { Page, WebSocketRoute } from "@playwright/test";
import type { MockApiServer } from "./mock-api";

const terminalTranscript = Buffer.from(
  "\r\nintar workshop shell\r\nroot@web:~# systemctl status nginx\r\n" +
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
  await page.routeWebSocket("ws://terminal.example.test/terminal/**", (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") return;
      try {
        const control = JSON.parse(message) as { type?: string };
        if (control.type === "open") onOpen(ws, server);
      } catch {
        // Terminal input is binary; malformed text frames are ignored here.
      }
    });
  });
}
