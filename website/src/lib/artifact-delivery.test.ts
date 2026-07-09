import { describe, expect, it } from "vitest";
import { applyArtifactDeliveryHeaders } from "./artifact-delivery";

describe("applyArtifactDeliveryHeaders", () => {
  it.each([
    ["text/plain; charset=iso-8859-1", "text/plain; charset=utf-8"],
    ["application/json", "application/json; charset=utf-8"],
    [
      "application/x-asciicast; charset=utf-8",
      "application/x-asciicast; charset=utf-8",
    ],
  ])("allows known inert content inline: %s", (input, expected) => {
    const headers = applyHeaders({ contentType: input });

    expect(headers.get("content-type")).toBe(expected);
    expect(headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it.each(["text/html", "image/svg+xml", "application/xml", "image/png"])(
    "forces unapproved content to download as octet-stream: %s",
    (contentType) => {
      const headers = applyHeaders({ contentType });

      expect(headers.get("content-type")).toBe("application/octet-stream");
      expect(headers.get("content-disposition")).toMatch(/^attachment;/);
    },
  );

  it("honors an explicit download request for otherwise inline-safe content", () => {
    const headers = applyHeaders({
      contentType: "text/plain",
      forceDownload: true,
    });

    expect(headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("sets defense-in-depth headers and sanitizes filenames", () => {
    const headers = applyHeaders({
      filename: 'evil"\\\r\nX-Injected: yes-\u2603.txt',
    });

    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toContain("sandbox");
    expect(headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("content-disposition")).toBe(
      "inline; filename=\"evil__X-Injected: yes-_.txt\"; filename*=UTF-8''evil%22%5CX-Injected%3A%20yes-%E2%98%83.txt",
    );
  });
});

function applyHeaders(
  overrides: Partial<{
    contentType: string;
    filename: string;
    forceDownload: boolean;
  }> = {},
): Headers {
  const headers = new Headers();
  applyArtifactDeliveryHeaders(headers, {
    contentType: "text/plain",
    filename: "artifact.txt",
    forceDownload: false,
    ...overrides,
  });
  return headers;
}
