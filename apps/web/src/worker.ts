import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { handleWorkshopRegistryRequest } from "@/control-plane/workshop-registry/v2";
import { handleWorkspaceAgentControlPlaneRequest } from "@/control-plane/workspace-agent";
import { openDueWorkshopLobbies } from "@/lib/workshops/auto-lobby";
import { sweepWorkshopProviderRuntimes } from "@/lib/workshops/provider-runtime";
import { recoverWorkshopRuntimesFromFailedProvider } from "@/lib/workshops/runtime-orchestrator";
import { handleMaintenanceMode } from "@/maintenance";
import { hardenJoinResponse } from "@/lib/join-security";

export default {
  async fetch(request, env, ctx) {
    const maintenanceResponse = await handleMaintenanceMode(request, env);
    if (maintenanceResponse) return maintenanceResponse;

    const url = new URL(request.url);

    if (
      url.pathname === "/agent/bootstrap" ||
      url.pathname === "/api/agent/bootstrap"
    ) {
      return handleAgentBootstrap(request, env);
    }

    if (
      url.pathname === "/agent/connect" ||
      url.pathname === "/api/agent/connect"
    ) {
      return handleAgentConnect(request, env);
    }

    const workspaceAgentResponse =
      await handleWorkspaceAgentControlPlaneRequest(request, env);
    if (workspaceAgentResponse) {
      return workspaceAgentResponse;
    }

    const registryResponse = await handleImageRegistryRequest(request, env);
    if (registryResponse) {
      return registryResponse;
    }

    const workshopRegistryResponse = await handleWorkshopRegistryRequest(
      request,
      env,
    );
    if (workshopRegistryResponse) {
      return workshopRegistryResponse;
    }

    if (url.pathname.startsWith("/agent/runs")) {
      const response = await handleAgentRunArtifactRequest(request, env);
      if (response) {
        return response;
      }
    }

    const response = await handle(request, env, ctx);
    return url.pathname === "/join"
      ? hardenJoinResponse(response, {
          localDevelopment:
            new URL(env.BETTER_AUTH_URL).hostname === "localhost",
        })
      : response;
  },
  async scheduled(controller, env) {
    // The pure beta replacement must be database-independent while its D1
    // schema and credential rows are reset. Cron work is part of the same
    // maintenance fence as HTTP traffic; otherwise a minute tick can issue or
    // mutate runtimes in the middle of the cutover.
    if (String(env.BETA_ACCESS_MAINTENANCE) === "on") {
      console.info(
        JSON.stringify({ event: "scheduled_maintenance_fenced" }),
      );
      return;
    }
    const [lobbies, providerRuntimes] = await Promise.all([
      openDueWorkshopLobbies({ now: controller.scheduledTime }),
      sweepWorkshopProviderRuntimes({ now: controller.scheduledTime }),
    ]);
    // Provider observations decide whether a failed direct-cloud learner needs
    // reconstruction. Run recovery after that sweep so a durable
    // `reconstruct_required` transition can be acted on in the same minute.
    const providerRecoveries = await recoverWorkshopRuntimesFromFailedProvider({
      now: controller.scheduledTime,
    });
    console.info(
      JSON.stringify({
        event: "workshop_minute_sweep",
        lobbies,
        providerRuntimes,
        providerRecoveries,
      }),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };
