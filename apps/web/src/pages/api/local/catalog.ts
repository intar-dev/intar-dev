import type { APIRoute } from "astro";
import { localCatalogRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request }) => localCatalogRequest(request);
