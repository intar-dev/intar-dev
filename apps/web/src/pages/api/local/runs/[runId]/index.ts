import type { APIRoute } from "astro";
import { localRunRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) => localRunRequest(request, params.runId ?? "", "read");
