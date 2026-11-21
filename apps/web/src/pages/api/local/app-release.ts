import type { APIRoute } from "astro";
import { appReleaseRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request }) => appReleaseRequest(request);
