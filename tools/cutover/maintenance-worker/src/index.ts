interface Env {
  CUTOVER_FENCE_MARKER: string;
}

const MARKER_PATH = "/.well-known/intar-clean-d1-cutover-fence";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = {
      "Cache-Control": "private, no-store",
      "Cloudflare-CDN-Cache-Control": "no-store",
      "X-Intar-Cutover-Fence": "active",
    };
    if (request.method === "GET" && url.pathname === MARKER_PATH) {
      return new Response(env.CUTOVER_FENCE_MARKER, {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (request.method === "HEAD" && url.pathname === MARKER_PATH) {
      return new Response(null, { status: 200, headers });
    }
    return Response.json(
      {
        code: "control_plane_cutover_in_progress",
        error: "Intar is temporarily unavailable while the control plane is replaced.",
      },
      { status: 503, headers },
    );
  },
  // Retain the production cron registration so a version rollback restores
  // the legacy scheduled handler without a second configuration mutation.
  scheduled(): void {},
} satisfies ExportedHandler<Env>;
