/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { jsonResponse } from "./agent-bridge";

describe("jsonResponse", () => {
  it("preserves Headers instances while supplying the JSON content type", () => {
    const headers = new Headers({ "retry-after": "60" });

    const response = jsonResponse(
      { error: "rate limited" },
      { status: 429, headers },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("does not overwrite an explicitly supplied content type", () => {
    const response = jsonResponse(
      { ok: true },
      { headers: { "content-type": "application/problem+json" } },
    );

    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });
});
