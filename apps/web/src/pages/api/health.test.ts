import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => ({
  first: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    DB: {
      prepare: databaseMock.prepare,
    },
  },
}));

import { GET } from "./health";

describe("health API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.prepare.mockReturnValue({ first: databaseMock.first });
  });

  it("reports healthy only after D1 responds", async () => {
    databaseMock.first.mockResolvedValue({ healthy: 1 });

    const response = await GET({} as never);

    expect(databaseMock.prepare).toHaveBeenCalledWith("SELECT 1 AS healthy");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("fails closed when D1 is unavailable", async () => {
    databaseMock.first.mockRejectedValue(new Error("D1 unavailable"));

    const response = await GET({} as never);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });
});
