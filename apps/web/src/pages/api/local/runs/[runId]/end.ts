import type { APIRoute } from "astro";
import { localRunRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const POST: APIRoute = ({ request, params }) => localRunRequest(request, params.runId ?? "", "end");
