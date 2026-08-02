import type { APIRoute } from "astro";

export const prerender = false;

export const ALL: APIRoute = () =>
  new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
