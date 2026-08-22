import type {
  ProviderCapabilities,
  ProviderRpcResult,
} from "@intar/provider-contracts";
import type { GcpProviderReadinessResult } from "@intar/provider-contracts/gcp";

interface ProviderService<Kind extends "hetzner_cloud" | "gcp_compute"> {
  capabilities(): Promise<ProviderCapabilities<Kind>>;
}

interface GcpProviderService extends ProviderService<"gcp_compute"> {
  readiness(): Promise<ProviderRpcResult<GcpProviderReadinessResult>>;
}

interface Env {
  HETZNER_PROVIDER_SERVICE: ProviderService<"hetzner_cloud">;
  GCP_PROVIDER_SERVICE: GcpProviderService;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/capabilities") {
      return new Response("Not Found", { status: 404 });
    }
    const [hetzner, gcp, gcpReadiness] = await Promise.all([
      env.HETZNER_PROVIDER_SERVICE.capabilities(),
      env.GCP_PROVIDER_SERVICE.capabilities(),
      env.GCP_PROVIDER_SERVICE.readiness(),
    ]);
    return Response.json({ hetzner, gcp, gcpReadiness }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  },
} satisfies ExportedHandler<Env>;
