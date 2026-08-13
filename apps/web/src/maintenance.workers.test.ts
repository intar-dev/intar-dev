import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleMaintenanceMode } from "./maintenance";

const maintenanceEnv = {
  BETTER_AUTH_URL: "https://intar.dev",
  BETA_ACCESS_MAINTENANCE: "on",
  BETA_MAINTENANCE_BYPASS_SECRET:
    "maintenance-test-secret-that-is-long-enough",
} as unknown as Cloudflare.Env;

describe("beta cutover maintenance fence", () => {
  it("fences every durable-object ingress without touching D1", async () => {
    const databaseAccess = vi.fn(() => {
      throw new Error("maintenance fence touched D1");
    });
    const db = new Proxy(
      {},
      {
        get: databaseAccess,
      },
    ) as D1Database;
    const maintenanceDoEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "BETA_ACCESS_MAINTENANCE") return "on";
        if (property === "DB") return db;
        return Reflect.get(target, property, receiver);
      },
    });
    const stub = env.HOST_RUNTIME.get(
      env.HOST_RUNTIME.idFromName("maintenance-ingress-fence"),
    );

    await runInDurableObject(stub, async (runtime, state) => {
      Object.defineProperty(runtime, "env", {
        configurable: true,
        value: maintenanceDoEnv,
      });
      await state.storage.setAlarm(Date.now() + 60_000);
      const close = vi.fn();
      const socket = { close } as unknown as WebSocket;

      const response = await runtime.fetch(
        new Request("https://host-runtime/_internal/wake", { method: "POST" }),
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "maintenance",
      });

      await runtime.alarm();
      await expect(state.storage.getAlarm()).resolves.toBeNull();

      await runtime.webSocketMessage(socket, "{}");
      expect(close).toHaveBeenCalledWith(1012, "maintenance");
      await runtime.webSocketClose(socket, 1000, "closed", true);
      await runtime.webSocketError(socket, new Error("closed"));
    });
    expect(databaseAccess).not.toHaveBeenCalled();
  });

  it("is database-independent and defaults open when disabled", async () => {
    await expect(
      handleMaintenanceMode(
        new Request("https://intar.dev/courses"),
        { ...maintenanceEnv, BETA_ACCESS_MAINTENANCE: "off" } as unknown as Cloudflare.Env,
      ),
    ).resolves.toBeNull();
  });

  it("blocks application and API traffic without querying D1", async () => {
    const page = await handleMaintenanceMode(
      new Request("https://intar.dev/courses"),
      maintenanceEnv,
    );
    const api = await handleMaintenanceMode(
      new Request("https://intar.dev/api/scenarios"),
      maintenanceEnv,
    );

    expect(page?.status).toBe(503);
    expect(page?.headers.get("cache-control")).toContain("no-store");
    expect(page?.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(api?.status).toBe(503);
    await expect(api?.json()).resolves.toMatchObject({ code: "maintenance" });
  });

  it("renders an accessible, nonce-bound operator form without persisting the secret", async () => {
    const first = await handleMaintenanceMode(
      new Request("https://intar.dev/courses"),
      maintenanceEnv,
    );
    const second = await handleMaintenanceMode(
      new Request("https://intar.dev/courses"),
      maintenanceEnv,
    );
    const firstCsp = first?.headers.get("content-security-policy") ?? "";
    const secondCsp = second?.headers.get("content-security-policy") ?? "";
    const firstNonce = firstCsp.match(/script-src 'nonce-([^']+)'/u)?.[1];
    const secondNonce = secondCsp.match(/script-src 'nonce-([^']+)'/u)?.[1];
    const html = await first?.text();

    expect(firstNonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(secondNonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(secondNonce).not.toBe(firstNonce);
    expect(firstCsp).toContain(`style-src 'nonce-${firstNonce}'`);
    expect(firstCsp).toContain("form-action 'none'");
    expect(firstCsp).not.toContain("'unsafe-inline'");
    expect(html).toContain(`<style nonce="${firstNonce}">`);
    expect(html).toContain(`<script nonce="${firstNonce}">`);
    expect(html).toContain(
      '<form id="operator-login" action="/api/maintenance/bypass" method="post">',
    );
    expect(html).toContain(
      '<input id="operator-secret" type="password" autocomplete="off"',
    );
    expect(html).not.toContain('id="operator-secret" name=');
    expect(html).toContain(
      'id="operator-status" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(html).toContain('fetch("/api/maintenance/bypass"');
    expect(html).toContain('"content-type": "application/json"');
    expect(html).not.toMatch(/localStorage|sessionStorage|console\./u);
  });

  it("uses a same-origin JSON ceremony for a short-lived operator cookie", async () => {
    const establish = await handleMaintenanceMode(
      new Request("https://intar.dev/api/maintenance/bypass", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://intar.dev",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          secret: maintenanceEnv.BETA_MAINTENANCE_BYPASS_SECRET,
        }),
      }),
      maintenanceEnv,
    );
    expect(establish?.status).toBe(200);
    const setCookie = establish?.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";", 1)[0];
    expect(cookie).toContain("__Host-intar-maintenance=");

    const status = await handleMaintenanceMode(
      new Request("https://intar.dev/api/maintenance/status", {
        headers: { cookie: cookie ?? "" },
      }),
      maintenanceEnv,
    );
    expect(status?.status).toBe(200);
    await expect(status?.json()).resolves.toEqual({
      maintenance: true,
      fence: "verified",
    });

    for (const request of [
      new Request("https://intar.dev/join", {
        headers: { cookie: cookie ?? "" },
      }),
      new Request(
        "https://intar.dev/api/auth/callback/github?code=test&state=test",
        { headers: { cookie: cookie ?? "" } },
      ),
      new Request("https://intar.dev/api/access-invites/current", {
        headers: { cookie: cookie ?? "" },
      }),
    ]) {
      const fenced = await handleMaintenanceMode(request, maintenanceEnv);
      expect(fenced?.status).toBe(503);
    }

    const mutation = await handleMaintenanceMode(
      new Request("https://intar.dev/api/admin/access-invites", {
        method: "POST",
        headers: {
          cookie: cookie ?? "",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      maintenanceEnv,
    );
    expect(mutation?.status).toBe(503);
    await expect(mutation?.json()).resolves.toMatchObject({
      code: "maintenance",
      error: "beta access maintenance is in progress",
    });
  });

  it("rejects cross-origin and non-JSON bypass submissions", async () => {
    for (const headers of [
      {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://intar.dev",
        "sec-fetch-site": "same-origin",
      },
    ]) {
      const response = await handleMaintenanceMode(
        new Request("https://intar.dev/api/maintenance/bypass", {
          method: "POST",
          headers,
          body: "secret=do-not-accept-form-fallback",
        }),
        maintenanceEnv,
      );
      expect(response?.status).toBe(403);
      expect(response?.headers.has("set-cookie")).toBe(false);
    }
  });
});
