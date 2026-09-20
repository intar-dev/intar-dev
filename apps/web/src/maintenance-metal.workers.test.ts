import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { handleMaintenanceMode } from "./maintenance";
import { resetD1Database } from "@/test/d1-migrations";

const secret = "release-test-secret-with-at-least-thirty-two-characters";
const maintenanceEnv = { ...env, BETTER_AUTH_URL: "https://intar.dev", CONTROL_PLANE_MAINTENANCE: "on", CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: secret } as unknown as Cloudflare.Env;
function request(token = secret) {
  return new Request("https://intar.dev/api/maintenance/personal-metal/retire", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ hostId: "retired-host" }),
  });
}
beforeEach(async () => {
  await resetD1Database();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user (id, name, email, metal_placement) VALUES ('owner', 'Owner', 'owner@example.test', 'personal')"),
    env.DB.prepare("INSERT INTO agent_hosts (id, user_id, name, disabled, scenario_enabled) VALUES ('retired-host', 'owner', 'Old host', 1, 0)"),
    env.DB.prepare("INSERT INTO runtime_operation_gates (key, state) VALUES ('image_cutover', 'drained'), ('personal_metal_registration', 'drained'), ('platform_metal_registration', 'drained')"),
  ]);
});
it("denies an invalid machine credential before accessing D1", async () => {
  const prepare = vi.fn(() => { throw new Error("D1 accessed"); });
  const response = await handleMaintenanceMode(request("invalid"), { ...maintenanceEnv, DB: { prepare } } as unknown as Cloudflare.Env);
  expect(response?.status).toBe(403);
  expect(prepare).not.toHaveBeenCalled();
});
it("refuses retirement while registration is open or a host is active", async () => {
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'open' WHERE key = 'personal_metal_registration'").run();
  expect((await handleMaintenanceMode(request(), maintenanceEnv))?.status).toBe(409);
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'drained'").run();
  await env.DB.prepare("UPDATE agent_hosts SET scope = 'personal', disabled = 0").run();
  expect((await handleMaintenanceMode(request(), maintenanceEnv))?.status).toBe(409);
});
it("clears old recovery state and alarms through the existing removal mechanism", async () => {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("retired-host"));
  await runInDurableObject(stub, async (runtime, state) => {
    Object.defineProperty(runtime, "env", { configurable: true, value: maintenanceEnv });
    await state.storage.put("hostId", "retired-host");
    await state.storage.put("old-recovery", { executionId: "old-execution" });
    await state.storage.setAlarm(Date.now() + 60000);
  });
  const response = await handleMaintenanceMode(request(), maintenanceEnv);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ ok: true, hostId: "retired-host", alarmCleared: true });
  await runInDurableObject(stub, async (_runtime, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    expect((await state.storage.list()).size).toBe(0);
  });
  expect(await env.DB.prepare("SELECT metal_placement FROM user WHERE id = 'owner'").first()).toEqual({ metal_placement: "personal" });
  expect((await env.DB.prepare("SELECT * FROM host_desired_state").all()).results).toEqual([]);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
