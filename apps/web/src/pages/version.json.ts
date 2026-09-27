import type { APIRoute } from "astro";

// Built once per deploy and served from the static assets, so the app's
// update checks never reach the Worker.
export const prerender = true;

export const GET: APIRoute = () =>
  Response.json({
    version: import.meta.env.PUBLIC_RELEASE_VERSION || "development",
  });
