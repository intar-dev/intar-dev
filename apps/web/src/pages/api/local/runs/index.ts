import type { APIRoute } from "astro";
import { localRunHistoryRequest, startLocalRunRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const POST: APIRoute = ({ request }) => startLocalRunRequest(request);

export const GET: APIRoute = ({ request }) => localRunHistoryRequest(request);
