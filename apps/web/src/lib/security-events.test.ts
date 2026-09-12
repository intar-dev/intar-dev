import { describe, expect, it, vi, afterEach } from "vitest";
import { recordSecurityResponse, securityEventRecord, securityRoute } from "./security-events";

afterEach(() => vi.restoreAllMocks());

describe("security events", () => {
  it("keeps trusted audit fields without request credentials or arbitrary path segments", () => {
    const request = new Request("https://intar.dev/api/auth/sso/callback/secret-provider?code=secret-code", {
      headers: {
        authorization: "Bearer secret-bearer", cookie: "session=secret-session",
        "cf-connecting-ip": "203.0.113.4", "cf-ray": "0123456789abcdef-CDG",
        "user-agent": "secret-header", "x-forwarded-for": "secret-forged-ip",
      },
    });
    const event = securityEventRecord(request, { event: "security.auth_request", outcome: "rejected", status: 403 });
    expect(event).toMatchObject({ client_ip: "203.0.113.4", ray_id: "0123456789abcdef-CDG", route: "auth/sso/callback", http_status: 403 });
    expect(JSON.stringify(event)).not.toContain("secret");
  });

  it("rejects invalid addresses and unbounded identities", () => {
    const request = new Request("https://intar.dev/api/auth/unknown-secret", { headers: { "cf-connecting-ip": "not-an-ip", "cf-ray": "forged" } });
    const event = securityEventRecord(request, { event: "security.session_created", outcome: "accepted", userId: "a".repeat(129) });
    expect(event).not.toHaveProperty("client_ip");
    expect(event).not.toHaveProperty("ray_id");
    expect(event).not.toHaveProperty("user_id");
    expect(event.route).toBe("auth/other");
    expect(securityRoute("/api/%61uth/sign-in/social")).toBe("invalid-path");
  });

  it("records failed access and rate limits but does not call an auth response a new session", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    recordSecurityResponse(new Request("https://intar.dev/api/scenarios/runs/x/ssh"), new Response(null, { status: 403 }));
    recordSecurityResponse(new Request("https://intar.dev/api/auth/sign-in/social"), new Response(null, { status: 429 }));
    recordSecurityResponse(new Request("https://intar.dev/api/auth/sign-in/social"), new Response(null, { status: 200 }));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).event).toBe("security.request_rejected");
    expect(JSON.parse(String(info.mock.calls[0]?.[0])).event).toBe("security.auth_request");
    recordSecurityResponse(new Request("https://intar.dev/api/auth/get-session"), new Response(null, { status: 200 }));
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("records an OAuth error redirect as rejected without copying its details", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSecurityResponse(new Request("https://intar.dev/api/auth/callback/github"),
      new Response(null, { status: 302, headers: { location: "/login?error=secret-upstream-error&code=secret" } }));
    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).outcome).toBe("rejected");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret");
  });
});
