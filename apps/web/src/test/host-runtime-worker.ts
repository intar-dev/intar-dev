import { HostRuntimeDO } from "@/control-plane/host-runtime-do";
import { ScenarioSourceDO } from "@/control-plane/scenario-source-do";

export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO, ScenarioSourceDO };
