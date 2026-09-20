import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { createHostEnrollment } from "@/lib/host-enrollment";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  const auth = await requireUserContext(request);
  if (!auth.ok) return auth.response;
  const input = await request.json().catch(() => null) as { name?: unknown; scope?: unknown; role?: unknown } | null;
  if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80) {
    return jsonResponse({ error: "Enter a server name of 1 to 80 characters." }, { status: 400 });
  }
  const scope = input.scope ?? "personal";
  const role = input.role ?? "agent";
  if ((scope !== "personal" && scope !== "platform") || (role !== "agent" && role !== "builder")) {
    return jsonResponse({ error: "Invalid server type." }, { status: 400 });
  }
  if ((scope === "platform" || role === "builder") && !auth.context.isAdmin) {
    return jsonResponse({ error: "Platform admin required." }, { status: 403 });
  }
  if (scope === "personal" && role !== "agent") {
    return jsonResponse({ error: "Personal servers cannot build images." }, { status: 400 });
  }
  const gate = await env.DB.prepare("SELECT state FROM runtime_operation_gates WHERE key = ?")
    .bind(scope === "platform" ? "platform_metal_registration" : "personal_metal_registration")
    .first<{ state: string }>();
  if (gate?.state !== "open") {
    return jsonResponse({ error: "Server registration is not available yet." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  try {
    const result = await createHostEnrollment(env.DB, auth.context, { name: input.name.trim(), scope, role });
    return jsonResponse(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "Server registration failed. Try again.");
    return jsonResponse(body, { status, headers: { "cache-control": "no-store" } });
  }
};
