import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { readScenarioGuestToolsStaticPin } from "@/lib/scenario-guest-tools";

export const prerender = false;

const headers = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
} as const;

export const GET: APIRoute = async () => {
  try {
    readScenarioGuestToolsStaticPin(env);
  } catch {
    // The ABI 2 release requires the verified pin. Fail closed so a bad
    // deploy is visible before traffic returns.
    return new Response(
      JSON.stringify({ status: "unavailable", code: "guest_tools_pin_invalid" }),
      { status: 503, headers },
    );
  }
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
