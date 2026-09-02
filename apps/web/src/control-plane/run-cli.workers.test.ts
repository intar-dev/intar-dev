import { describe, expect, it } from "vitest";
import { runCliSuccessResponse } from "@/control-plane/run-cli";

describe("scenario run CLI response", () => {
  it("returns only completion aliases for completion requests", async () => {
    const response = runCliSuccessResponse(
      "request-1",
      { kind: "completion" },
      { kind: "completion", aliases: ["general", "check-1"] },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      request_id: "request-1",
      result: { kind: "completion", aliases: ["check-1", "general"] },
    });
  });
});
