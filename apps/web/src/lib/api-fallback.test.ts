import { describe, expect, it } from "vitest";
import { ALL } from "@/pages/api/[...path]";

describe("unknown API route fallback", () => {
  it("returns an explicit JSON 404 instead of the application shell", async () => {
    const response = await ALL({} as never);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });
});
