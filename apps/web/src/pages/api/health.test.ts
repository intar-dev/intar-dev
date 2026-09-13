import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({
  first: vi.fn(),
  prepare: vi.fn(),
}));

const envMock = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({
  env: envMock.env,
}));

import { GET } from "./health";

const STATIC_PIN_JSON = JSON.stringify({
  schema_version: 1,
  bootstrap_abi: 2,
  tools_disk_sha256: "1".repeat(64),
  tools_disk_size_bytes: 67108864,
  compressed_disk_sha256: "3".repeat(64),
  compressed_disk_size_bytes: 1,
  kino_sha256: "2".repeat(64),
  kino_size_bytes: 1,
});

describe("health API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.prepare.mockReturnValue({ first: databaseMock.first });
    envMock.env.DB = { prepare: databaseMock.prepare };
    envMock.env.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON = STATIC_PIN_JSON;
  });

  it("reports healthy only after D1 responds and the ABI 2 pin is configured", async () => {
    databaseMock.first.mockResolvedValue({ healthy: 1 });

    const response = await GET({} as never);

    expect(databaseMock.prepare).toHaveBeenCalledWith("SELECT 1 AS healthy");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("fails closed without touching D1 when the cutover pin is missing", async () => {
    delete envMock.env.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON;
    databaseMock.first.mockResolvedValue({ healthy: 1 });

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      code: "guest_tools_pin_invalid",
    });
    expect(databaseMock.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the cutover pin is not an ABI 2 pin", async () => {
    envMock.env.SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON = JSON.stringify({
      ...JSON.parse(STATIC_PIN_JSON),
      bootstrap_abi: 1,
    });
    databaseMock.first.mockResolvedValue({ healthy: 1 });

    const response = await GET({} as never);

    expect(response.status).toBe(503);
  });

  it("fails closed when D1 is unavailable", async () => {
    databaseMock.first.mockRejectedValue(new Error("D1 unavailable"));

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });
});
