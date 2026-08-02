import { describe, expect, it } from "vitest";

import worker from "./index";

const env = { CUTOVER_FENCE_MARKER: '{"runId":"123"}' };

describe("clean D1 maintenance Worker", () => {
  it("serves only the exact no-store fence marker", async () => {
    const response = await worker.fetch(
      new Request("https://intar.dev/.well-known/intar-clean-d1-cutover-fence"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-intar-cutover-fence")).toBe("active");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe(env.CUTOVER_FENCE_MARKER);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "fails closed for %s application traffic",
    async (method) => {
      const response = await worker.fetch(
        new Request("https://intar.dev/api/workshops", { method }),
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-intar-cutover-fence")).toBe("active");
    },
  );
});
