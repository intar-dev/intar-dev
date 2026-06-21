import type { APIRoute } from "astro";
import { auth } from "../../lib/auth";

export const prerender = false;

export const GET: APIRoute = async () => {
  const jwks = await auth.api.getJwks();

  return new Response(JSON.stringify(jwks), {
    status: 200,
    headers: {
      "Cache-Control":
        "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
      "Content-Type": "application/json",
    },
  });
};
