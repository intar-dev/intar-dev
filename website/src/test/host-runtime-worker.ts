import { HostRuntimeDO } from "@/control-plane/host-runtime-do";

export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;

export { HostRuntimeDO };
