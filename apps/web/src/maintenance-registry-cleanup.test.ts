import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  handleMaintenanceMode,
  handleRegistryCleanupGateRequest,
  MAX_MAINTENANCE_BYPASS_JSON_BYTES,
  REGISTRY_CLEANUP_GATE_PATH,
} from "./maintenance";

const secret = "maintenance-test-secret-that-is-long-enough";
const origin = "https://intar.dev";
const gateUrl = origin + REGISTRY_CLEANUP_GATE_PATH;

interface GateOptions {
  maintenance?: "on" | "off";
  binding?: boolean;
  fail?: string;
  noSecret?: boolean;
}

/**
 * A parent environment with a recording child binding. Every rejection test
 * asserts that the binding was never reached, so authorization is proved by
 * the absence of a call, not by the status code alone.
 */
function gateEnv(options: GateOptions = {}) {
  const calls: string[] = [];
  const pause = vi.fn(async () => {
    calls.push("pause");
    if (options.fail === "pause") throw new Error("the collector is unreachable");
    return {
      paused: true,
      pauseReason: "registry_cleanup_hold",
      idle: true,
      stalled: false,
    };
  });
  const resume = vi.fn(async () => {
    calls.push("resume");
    return { paused: false, pauseReason: null, idle: true, stalled: false };
  });
  const status = vi.fn(async () => {
    calls.push("status");
    return { schemaVersion: 1, idle: true, sweepActive: false };
  });
  const plan = vi.fn(async () => {
    calls.push("plan");
    return { schemaVersion: 1, status: "report-only" };
  });
  const run = vi.fn(async () => {
    calls.push("run");
    return { schemaVersion: 1, status: "report-only" };
  });
  const env = {
    BETTER_AUTH_URL: origin,
    CONTROL_PLANE_MAINTENANCE: options.maintenance ?? "off",
    ...(options.noSecret
      ? {}
      : { CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: secret }),
    ...(options.binding === false
      ? {}
      : { REGISTRY_CLEANUP: { pause, resume, status, plan, run } }),
  } as unknown as Cloudflare.Env;
  return { env, calls, binding: { pause, resume, status, plan, run } };
}

function gateRequest(
  body: unknown,
  init: { path?: string; method?: string; headers?: Record<string, string> } = {},
) {
  return new Request(origin + (init.path ?? REGISTRY_CLEANUP_GATE_PATH), {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

describe("image registry cleanup deployment gate", () => {
  it("holds the collector through the secret-authenticated surface", async () => {
    const { env, binding } = gateEnv();

    const response = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause", wait_ms: 60_000 }),
      env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      action: "pause",
      result: {
        paused: true,
        pauseReason: "registry_cleanup_hold",
        idle: true,
        stalled: false,
      },
    });
    expect(binding.pause).toHaveBeenCalledWith({
      reason: undefined,
      waitMs: 60_000,
    });
  });

  it("clamps the wait and trims the reason", async () => {
    const { env, binding } = gateEnv();

    await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause", reason: " migration ", wait_ms: -1 }),
      env,
    );
    await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause", wait_ms: 99_999_999 }),
      env,
    );

    expect(binding.pause).toHaveBeenNthCalledWith(1, {
      reason: "migration",
      waitMs: 0,
    });
    expect(binding.pause).toHaveBeenNthCalledWith(2, {
      reason: undefined,
      waitMs: 10 * 60 * 1000,
    });
  });

  it("releases the collector with a resume", async () => {
    const { env, binding } = gateEnv();

    const response = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "resume" }),
      env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      action: "resume",
      result: { paused: false, idle: true },
    });
    expect(binding.resume).toHaveBeenCalledTimes(1);
  });

  it("reads status, plan, and run from the collector", async () => {
    const { env, binding } = gateEnv();

    const status = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "status" }),
      env,
    );
    const plan = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "plan" }),
      env,
    );
    const run = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "run", plan_only: true }),
      env,
    );

    expect(status?.status).toBe(200);
    await expect(status?.json()).resolves.toMatchObject({
      action: "status",
      result: { idle: true },
    });
    expect(plan?.status).toBe(200);
    expect(run?.status).toBe(200);
    expect(binding.status).toHaveBeenCalledTimes(1);
    // A plan always plans; `plan_only` is what a caller may ask of `run`.
    expect(binding.plan).toHaveBeenCalledWith({ planOnly: false });
    expect(binding.run).toHaveBeenCalledWith({ planOnly: true });
  });

  it("refuses a hold without the bypass secret and never reaches the collector", async () => {
    const { env, calls } = gateEnv();

    const wrong = await handleRegistryCleanupGateRequest(
      gateRequest({ secret: "wrong-secret-that-is-long-enough", action: "pause" }),
      env,
    );
    const missing = await handleRegistryCleanupGateRequest(
      gateRequest({ action: "status" }),
      env,
    );

    expect(wrong?.status).toBe(403);
    expect(missing?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("never echoes the secret in any answer", async () => {
    const { env } = gateEnv();
    const bodies: string[] = [];

    for (const request of [
      gateRequest({ secret, action: "status" }),
      gateRequest({ secret, action: "pause" }),
      gateRequest({ secret, action: "nonsense" }),
      gateRequest({ secret: "wrong-secret-that-is-long-enough", action: "pause" }),
    ]) {
      const response = await handleRegistryCleanupGateRequest(request, env);
      bodies.push((await response?.text()) ?? "");
    }

    for (const body of bodies) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("wrong-secret");
    }
  });

  it("refuses a foreign origin and a cross-site fetch", async () => {
    const { env, calls } = gateEnv();

    const foreign = await handleRegistryCleanupGateRequest(
      gateRequest(
        { secret, action: "pause" },
        { headers: { origin: "https://attacker.example" } },
      ),
      env,
    );
    const crossSite = await handleRegistryCleanupGateRequest(
      gateRequest(
        { secret, action: "pause" },
        { headers: { "sec-fetch-site": "cross-site" } },
      ),
      env,
    );
    const sameOrigin = await handleRegistryCleanupGateRequest(
      gateRequest(
        { secret, action: "pause" },
        { headers: { origin, "sec-fetch-site": "same-origin" } },
      ),
      env,
    );

    expect(foreign?.status).toBe(403);
    expect(crossSite?.status).toBe(403);
    // A same-origin browser call is the one shape the ceremony allows.
    expect(sameOrigin?.status).toBe(200);
    expect(calls).toEqual(["pause"]);
  });

  it("refuses a non-JSON content type", async () => {
    const { env, calls } = gateEnv();

    const response = await handleRegistryCleanupGateRequest(
      new Request(gateUrl, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ secret, action: "pause" }),
      }),
      env,
    );

    expect(response?.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a body over the bounded limit before the collector is reached", async () => {
    const { env, calls } = gateEnv();
    const oversized = JSON.stringify({
      secret,
      action: "pause",
      padding: "x".repeat(MAX_MAINTENANCE_BYPASS_JSON_BYTES),
    });

    const declared = await handleRegistryCleanupGateRequest(
      new Request(gateUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(oversized.length),
        },
        body: oversized,
      }),
      env,
    );
    const streamed = await handleRegistryCleanupGateRequest(
      new Request(gateUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      }),
      env,
    );

    expect(declared?.status).toBe(413);
    expect(streamed?.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown action and a non-POST request", async () => {
    const { env, calls } = gateEnv();

    const unknown = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "delete" }),
      env,
    );
    const read = await handleRegistryCleanupGateRequest(
      gateRequest(null, { method: "GET" }),
      env,
    );

    expect(unknown?.status).toBe(400);
    expect(read?.status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("answers 503 with a distinct code while no collector is bound", async () => {
    const { env } = gateEnv({ binding: false });

    const response = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause" }),
      env,
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      code: "registry_cleanup_unavailable",
    });
  });

  it("answers 503 while the parent carries no usable secret", async () => {
    const { env, calls } = gateEnv({ noSecret: true });

    const response = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause" }),
      env,
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      code: "registry_cleanup_gate_unconfigured",
    });
    expect(calls).toEqual([]);
  });

  it("reports a collector that does not answer", async () => {
    const { env } = gateEnv({ fail: "pause" });

    const response = await handleRegistryCleanupGateRequest(
      gateRequest({ secret, action: "pause" }),
      env,
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toMatchObject({
      code: "registry_cleanup_gate_failed",
    });
  });

  it("ignores every other path", async () => {
    const { env, calls } = gateEnv();

    await expect(
      handleRegistryCleanupGateRequest(
        gateRequest({ secret, action: "pause" }, { path: "/api/scenarios" }),
        env,
      ),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("stays behind the maintenance fence while maintenance is on", async () => {
    const { env, calls } = gateEnv({ maintenance: "on" });

    // The fence answers this path, so the gate handler is never reached: no
    // collector call happens, and the caller sees the maintenance code rather
    // than a gate answer.
    const fenced = await handleMaintenanceMode(
      gateRequest({ secret, action: "pause" }),
      env,
    );

    expect(fenced?.status).toBe(503);
    await expect(fenced?.json()).resolves.toMatchObject({ code: "maintenance" });
    expect(calls).toEqual([]);
  });

  it("registers the gate after the fence in the worker", () => {
    const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    const fence = source.indexOf("handleMaintenanceMode(request, env)");
    const gate = source.indexOf("handleRegistryCleanupGateRequest(request, env)");

    expect(fence).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    // The ordering is the guarantee: a reorder would expose the collector
    // while maintenance is on, so it fails here instead of in production.
    expect(fence).toBeLessThan(gate);
  });
});
