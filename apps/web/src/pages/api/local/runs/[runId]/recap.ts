import type { APIRoute } from "astro";
import { localRunRecapRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  localRunRecapRequest(request, params.runId ?? "");
