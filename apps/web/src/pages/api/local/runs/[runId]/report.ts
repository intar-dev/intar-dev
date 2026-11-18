import type { APIRoute } from "astro";
import { reportLocalRunRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const POST: APIRoute = ({ request, params }) => reportLocalRunRequest(request, params.runId ?? "");
