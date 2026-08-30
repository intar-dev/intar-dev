import { drizzle } from "drizzle-orm/d1";
import { runtimeOperationGates } from "@/db/schema";
import { IMAGE_V10_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { hasRegistryPublishToken, isRecord, jsonResponse } from "./shared";

export async function handleImageCutoverGate(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  if (!(await hasRegistryPublishToken(request, env))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const db = drizzle(env.DB);
  if (request.method === "POST") {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return jsonResponse({ error: "JSON body is required" }, 400);
    }
    if (
      !isRecord(value) ||
      (value.state !== "open" && value.state !== "drained")
    ) {
      return jsonResponse({ error: "state must be open or drained" }, 400);
    }
    await db
      .insert(runtimeOperationGates)
      .values({
        key: IMAGE_V10_CUTOVER_GATE,
        state: value.state,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: runtimeOperationGates.key,
        set: { state: value.state, updatedAt: Date.now() },
      });
  }
  const gate = await env.DB.prepare(
    "SELECT state, updated_at FROM runtime_operation_gates WHERE key = ?",
  )
    .bind(IMAGE_V10_CUTOVER_GATE)
    .first<{ state: "open" | "drained"; updated_at: number }>();
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM host_desired_state, json_each(host_desired_state.doc_json, '$.vms') AS vm
      WHERE json_extract(vm.value, '$.desired_phase') = 'running'`,
  ).first<{ count: number }>();
  return jsonResponse({
    ok: true,
    state: gate?.state ?? "open",
    active_desired_vms: active?.count ?? 0,
    updated_at_unix_ms: gate?.updated_at ?? null,
  });
}
