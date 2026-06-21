import astroWorker from "@astrojs/cloudflare/entrypoints/server";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";

const astro = astroWorker as ExportedHandler<Cloudflare.Env>;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/agent/bootstrap") {
      return handleAgentBootstrap(request, env);
    }

    if (url.pathname === "/agent/connect") {
      return handleAgentConnect(request, env);
    }

    if (url.pathname.startsWith("/agent/runs")) {
      const response = await handleAgentRunArtifactRequest(request, env);
      if (response) {
        return response;
      }
    }

    if (typeof astro.fetch !== "function") {
      return jsonResponse({ error: "astro fetch handler is unavailable" }, 500);
    }

    return astro.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
