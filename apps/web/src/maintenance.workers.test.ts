import { describe, expect, it } from "vitest";
import { handleMaintenanceMode } from "./maintenance";

const maintenanceEnv = {
  BETTER_AUTH_URL: "https://intar.dev",
  BETA_ACCESS_MAINTENANCE: "on",
  BETA_MAINTENANCE_BYPASS_SECRET:
    "maintenance-test-secret-that-is-long-enough",
} as unknown as Cloudflare.Env;

describe("beta cutover maintenance fence", () => {
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
    expect(api?.status).toBe(503);
    await expect(api?.json()).resolves.toMatchObject({ code: "maintenance" });
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
    expect(setCookie).toContain("SameSite=Lax");
    const cookie = setCookie.split(";", 1)[0];
    expect(cookie).toContain("__Host-intar-maintenance=");

    await expect(
      handleMaintenanceMode(
        new Request("https://intar.dev/join", {
          headers: { cookie: cookie ?? "" },
        }),
        maintenanceEnv,
      ),
    ).resolves.toBeNull();
  });
});
