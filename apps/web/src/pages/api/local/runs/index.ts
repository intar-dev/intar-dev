import type { APIRoute } from "astro";
import { startLocalRunRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const POST: APIRoute = ({ request }) => startLocalRunRequest(request);
