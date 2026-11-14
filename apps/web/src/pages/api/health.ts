import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

const headers = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
} as const;

export const GET: APIRoute = async () => {
  try {
    const result = await env.DB.prepare("SELECT 1 AS healthy").first<{
      healthy: number;
    }>();
    if (result?.healthy !== 1) throw new Error("D1 health check failed");
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers,
    });
  } catch {
    return new Response(JSON.stringify({ status: "unavailable" }), {
      status: 503,
      headers,
    });
  }
};
