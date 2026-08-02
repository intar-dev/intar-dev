interface Env {
  CUTOVER_FENCE_MARKER: string;
}

const MARKER_PATH = "/.well-known/intar-clean-d1-cutover-fence";
const FENCE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Intar-Cutover-Fence": "active",
};

function maintenanceResponse(): Response {
  return Response.json(
    {
      code: "control_plane_cutover_in_progress",
      error: "Intar is temporarily unavailable while the control plane is replaced.",
    },
    { status: 503, headers: FENCE_HEADERS },
  );
}

// Cloudflare requires every class owning an existing Durable Object namespace
// to remain exported by code-only versions. The maintenance implementation is
// deliberately inert: it performs no storage or control-plane work.
export class HostRuntimeDO {
  fetch(): Response {
    return maintenanceResponse();
  }

  alarm(): void {}

  webSocketMessage(webSocket: WebSocket): void {
    webSocket.close(1012, "control plane maintenance");
  }

  webSocketClose(): void {}

  webSocketError(): void {}
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === MARKER_PATH) {
      return new Response(env.CUTOVER_FENCE_MARKER, {
        status: 200,
        headers: {
          ...FENCE_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }
    if (request.method === "HEAD" && url.pathname === MARKER_PATH) {
      return new Response(null, { status: 200, headers: FENCE_HEADERS });
    }
    return maintenanceResponse();
  },
  // Retain the production cron registration so a version rollback restores
  // the legacy scheduled handler without a second configuration mutation.
  scheduled(): void {},
} satisfies ExportedHandler<Env>;
