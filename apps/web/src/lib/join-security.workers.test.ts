import { describe, expect, it } from "vitest";
import {
  hardenJoinResponse,
  JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY,
} from "./join-security";

const productionHtml = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
    <style>body { color: white; }</style>
    <script>window.fragmentBootstrap = true;</script>
    <script src="/assets/join.js"></script>
  </head>
  <body>
    <script type="module">window.astroHydration = true;</script>
    <script>window.reactHydration = true;</script>
  </body>
</html>`;

describe("join response hardening", () => {
  it("nonces every inline production script and style with a per-response policy", async () => {
    const first = hardenJoinResponse(
      new Response(productionHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const second = hardenJoinResponse(new Response(productionHtml));
    const firstPolicy = first.headers.get("content-security-policy") ?? "";
    const secondPolicy = second.headers.get("content-security-policy") ?? "";
    const firstNonce = firstPolicy.match(/script-src 'self' 'nonce-([^']+)'/u)?.[1];
    const secondNonce = secondPolicy.match(/script-src 'self' 'nonce-([^']+)'/u)?.[1];
    const html = await first.text();

    expect(firstNonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(secondNonce).toMatch(/^[A-Za-z0-9_-]{24}$/u);
    expect(secondNonce).not.toBe(firstNonce);
    expect(firstPolicy).toContain(`style-src 'self' 'nonce-${firstNonce}'`);
    expect(firstPolicy).not.toContain("'unsafe-inline'");
    expect(
      html.match(
        new RegExp(`<script(?=[^>]* nonce="${firstNonce}")[^>]*>`, "gu"),
      ),
    ).toHaveLength(3);
    expect(html).toContain('<script src="/assets/join.js"></script>');
    expect(html).not.toContain('<script src="/assets/join.js" nonce=');
    expect(html).toContain(`<style nonce="${firstNonce}">`);
    expect(html).not.toContain("http-equiv=\"Content-Security-Policy\"");
    expect(first.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("relaxes only the local development response", async () => {
    const response = hardenJoinResponse(new Response(productionHtml), {
      localDevelopment: true,
    });

    expect(response.headers.get("content-security-policy")).toBe(
      JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY,
    );
    expect(await response.text()).toBe(productionHtml);
  });
});
