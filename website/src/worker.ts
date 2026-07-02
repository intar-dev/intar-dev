import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/agent/bootstrap" || url.pathname === "/api/agent/bootstrap") {
      return handleAgentBootstrap(request, env);
    }

    if (url.pathname === "/agent/connect" || url.pathname === "/api/agent/connect") {
      return handleAgentConnect(request, env);
    }

    const registryResponse = await handleImageRegistryRequest(request, env);
    if (registryResponse) {
      return registryResponse;
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
