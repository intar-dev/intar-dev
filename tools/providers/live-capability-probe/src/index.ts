import type { ProviderCapabilities } from "@intar/provider-contracts";

interface ProviderService<Kind extends "hetzner_cloud" | "gcp_compute"> {
  capabilities(): Promise<ProviderCapabilities<Kind>>;
}

interface Env {
  HETZNER_PROVIDER_SERVICE: ProviderService<"hetzner_cloud">;
  GCP_PROVIDER_SERVICE: ProviderService<"gcp_compute">;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/capabilities") {
      return new Response("Not Found", { status: 404 });
    }
    const [hetzner, gcp] = await Promise.all([
      env.HETZNER_PROVIDER_SERVICE.capabilities(),
      env.GCP_PROVIDER_SERVICE.capabilities(),
    ]);
    return Response.json({ hetzner, gcp }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
} satisfies ExportedHandler<Env>;
