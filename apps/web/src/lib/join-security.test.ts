import { describe, expect, it } from "vitest";
import {
  hardenJoinResponse,
  JOIN_CONTENT_SECURITY_POLICY,
  JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY,
} from "./join-security";

describe("join response hardening", () => {
  it("uses the hash-pinned policy by default", () => {
    const response = hardenJoinResponse(new Response("join"));

    expect(response.headers.get("content-security-policy")).toBe(
      JOIN_CONTENT_SECURITY_POLICY,
    );
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("relaxes only the local development response", () => {
    const response = hardenJoinResponse(new Response("join"), {
      localDevelopment: true,
    });

    expect(response.headers.get("content-security-policy")).toBe(
      JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY,
    );
    expect(JOIN_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-inline'");
  });
});
