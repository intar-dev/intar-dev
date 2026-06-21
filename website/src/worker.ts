import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";

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

    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };
