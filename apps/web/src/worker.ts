import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { handleAgentRunCliRequest } from "@/control-plane/run-cli";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { handleMaintenanceMode } from "@/maintenance";
import { hardenJoinResponse } from "@/lib/join-security";
import {
  guardCanonicalRequestPath,
  secureApplicationApiRequest,
} from "@/lib/request-security";
import { hardenWorkerResponse } from "@/lib/response-security";

export default {
  async fetch(request, env, ctx) {
    const respond = (response: Response) =>
      hardenWorkerResponse(request, response, env);
    const canonicalPath = guardCanonicalRequestPath(request);
    if (!canonicalPath.ok) return respond(canonicalPath.response);

    const maintenanceResponse = await handleMaintenanceMode(request, env);
    if (maintenanceResponse) return respond(maintenanceResponse);

    const url = new URL(request.url);

    if (
      url.pathname === "/agent/bootstrap" ||
      url.pathname === "/api/agent/bootstrap"
    ) {
      return respond(await handleAgentBootstrap(request, env));
    }

    if (
      url.pathname === "/agent/connect" ||
      url.pathname === "/api/agent/connect"
    ) {
      return respond(await handleAgentConnect(request, env));
    }

    const registryResponse = await handleImageRegistryRequest(request, env);
    if (registryResponse) {
      return respond(registryResponse);
    }

    if (url.pathname.startsWith("/agent/runs")) {
      const runCliResponse = await handleAgentRunCliRequest(request, env);
      if (runCliResponse) {
        return respond(runCliResponse);
      }
      const response = await handleAgentRunArtifactRequest(request, env);
      if (response) {
        return respond(response);
      }
    }

    const securedRequest = await secureApplicationApiRequest(request, env);
    if (!securedRequest.ok) return respond(securedRequest.response);

    const response = await handle(securedRequest.request, env, ctx);
    const applicationResponse =
      url.pathname === "/join"
        ? hardenJoinResponse(response, {
            localDevelopment:
              new URL(env.BETTER_AUTH_URL).hostname === "localhost",
          })
        : response;
    return respond(applicationResponse);
  },
  async scheduled(_controller, env) {
    // Planned control-plane maintenance must be database-independent. Cron work
    // is part of the same maintenance fence as HTTP traffic; otherwise a minute
    // tick can issue or mutate runtimes while the control plane is fenced.
    if (String(env.CONTROL_PLANE_MAINTENANCE) === "on") {
      console.info(JSON.stringify({ event: "scheduled_maintenance_fenced" }));
      return;
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };
