import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/app-error";
import { requireSameOriginJsonMutation } from "./request-security";

function mutationRequest(headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/access-invites/exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: "{}",
  });
}

describe("custom mutation security", () => {
  it("accepts canonical same-origin JSON", () => {
    expect(() => requireSameOriginJsonMutation(mutationRequest())).not.toThrow();
  });

  it.each([
    ["missing origin", { origin: "" }, "invalid_origin"],
    ["sibling origin", { origin: "http://evil.localhost" }, "invalid_origin"],
    ["cross-site fetch", { "sec-fetch-site": "cross-site" }, "cross_site_request"],
    ["form content", { "content-type": "application/x-www-form-urlencoded" }, "json_required"],
  ])("rejects %s", (_name, headers, expectedCode) => {
    try {
      requireSameOriginJsonMutation(mutationRequest(headers));
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(expectedCode);
    }
  });
});
