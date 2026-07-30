import { handle } from "@astrojs/cloudflare/handler";
import { handleAgentBootstrap, handleAgentConnect } from "@/control-plane/auth";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { handleWorkshopRegistryRequest } from "@/control-plane/workshop-registry";
import { handleWorkshopPublicationVerifierRequest } from "@/control-plane/workshop-publication-verifier";
import { handleWorkspaceAgentControlPlaneRequest } from "@/control-plane/workspace-agent";
import { openDueWorkshopLobbies } from "@/lib/workshops/auto-lobby";
import { sweepHetznerWorkshopPublicationVerifiers } from "@/lib/workshops/hcloud-publication-verifier";
import { sweepHetznerWorkshopRuntimes } from "@/lib/workshops/hcloud-runtime";

export default {
  async fetch(request, env, ctx) {
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

    const publicationVerifierResponse =
      await handleWorkshopPublicationVerifierRequest(request, env);
    if (publicationVerifierResponse) {
      return publicationVerifierResponse;
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

    return handle(request, env, ctx);
  },
  async scheduled(controller) {
    const [lobbies, hcloud, hcloudPublications] = await Promise.all([
      openDueWorkshopLobbies({ now: controller.scheduledTime }),
      sweepHetznerWorkshopRuntimes({ now: controller.scheduledTime }),
      sweepHetznerWorkshopPublicationVerifiers({
        now: controller.scheduledTime,
      }),
    ]);
    console.info(
      JSON.stringify({
        event: "workshop_minute_sweep",
        lobbies,
        hcloud,
        hcloudPublications,
      }),
    );
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };
