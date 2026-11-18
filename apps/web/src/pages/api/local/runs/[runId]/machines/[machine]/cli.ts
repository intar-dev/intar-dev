import type { APIRoute } from "astro";
import { handleLocalRunCliRequest } from "@/control-plane/run-cli";

export const prerender = false;

export const POST: APIRoute = ({ request, params }) =>
  handleLocalRunCliRequest(request, params.runId ?? "", params.machine ?? "");
