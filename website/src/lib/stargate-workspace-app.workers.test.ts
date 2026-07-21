/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import {
  parseStargateWorkspaceAppSessionResponse,
  type ParseStargateWorkspaceAppSessionResponseOptions,
} from "./stargate";

const NOW = 1_800_000_000_000;
const MAXIMUM_EXPIRES_AT = NOW + 15 * 60_000;
const VALID_ROUTE_ID = "wa-secure-route";

function validResponse(): Record<string, unknown> {
  return {
    route_id: VALID_ROUTE_ID,
    url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time`,
    bootstrap_expires_at: (NOW + 60_000) / 1_000,
    expires_at: MAXIMUM_EXPIRES_AT / 1_000,
  };
}

function validOptions(): ParseStargateWorkspaceAppSessionResponseOptions {
  return {
    expectedRouteId: VALID_ROUTE_ID,
    baseDomain: "intar.app",
    now: NOW,
    maximumExpiresAt: MAXIMUM_EXPIRES_AT,
  };
}

describe("Stargate workspace application bootstrap contract", () => {
  it("accepts only the requested first-level HTTPS route origin", () => {
    expect(
      parseStargateWorkspaceAppSessionResponse(validResponse(), validOptions()),
    ).toEqual({
      routeId: VALID_ROUTE_ID,
      url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time`,
      bootstrapExpiresAt: NOW + 60_000,
      expiresAt: MAXIMUM_EXPIRES_AT,
    });
  });

  it("allows an explicit default HTTPS port and unrelated query parameters", () => {
    const value = validResponse();
    value.url = `https://${VALID_ROUTE_ID}.intar.app:443/?theme=dark&__intar_bootstrap=one-time`;

    expect(
      parseStargateWorkspaceAppSessionResponse(value, validOptions()),
    ).toMatchObject({ routeId: VALID_ROUTE_ID, url: value.url });
  });

  it("allows an encoded hash inside the bootstrap capability", () => {
    const value = validResponse();
    value.url = `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time%23nonce`;

    expect(
      parseStargateWorkspaceAppSessionResponse(value, validOptions()),
    ).toMatchObject({ routeId: VALID_ROUTE_ID, url: value.url });
  });

  it("accepts the longest canonical DNS route label", () => {
    const routeId = `wa-${"a".repeat(60)}`;
    const value = validResponse();
    value.route_id = routeId;
    value.url = `https://${routeId}.intar.app/?__intar_bootstrap=one-time`;

    expect(
      parseStargateWorkspaceAppSessionResponse(value, {
        ...validOptions(),
        expectedRouteId: routeId,
      }),
    ).toMatchObject({ routeId });
  });

  it.each([
    ["a different route id", { route_id: "wa-another-route" }],
    [
      "HTTP",
      {
        url: `http://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "credentials",
      {
        url: `https://learner:secret@${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "the wrong domain",
      {
        url: `https://${VALID_ROUTE_ID}.example.test/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "a suffix-spoofed domain",
      {
        url: `https://${VALID_ROUTE_ID}.intar.app.example.test/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "a nested app domain",
      {
        url: `https://${VALID_ROUTE_ID}.apps.intar.app/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "a non-default port",
      {
        url: `https://${VALID_ROUTE_ID}.intar.app:8443/?__intar_bootstrap=one-time`,
      },
    ],
    [
      "a fragment",
      {
        url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time#leak`,
      },
    ],
    [
      "an empty fragment delimiter",
      {
        url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one-time#`,
      },
    ],
    [
      "uppercase hostname bytes",
      {
        url: `https://${VALID_ROUTE_ID.toUpperCase()}.INTAR.APP/?__intar_bootstrap=one-time`,
      },
    ],
    ["no bootstrap capability", { url: `https://${VALID_ROUTE_ID}.intar.app/` }],
    [
      "an empty bootstrap capability",
      { url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=` },
    ],
    [
      "a blank bootstrap capability",
      { url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=%20` },
    ],
    [
      "duplicate bootstrap capabilities",
      {
        url: `https://${VALID_ROUTE_ID}.intar.app/?__intar_bootstrap=one&__intar_bootstrap=two`,
      },
    ],
    ["a fractional bootstrap timestamp", { bootstrap_expires_at: 1.5 }],
    ["a fractional route timestamp", { expires_at: 1.5 }],
    [
      "an expired bootstrap capability",
      { bootstrap_expires_at: NOW / 1_000 },
    ],
    [
      "a bootstrap capability longer than sixty seconds",
      { bootstrap_expires_at: (NOW + 61_000) / 1_000 },
    ],
    [
      "a bootstrap capability beyond the route expiry",
      {
        bootstrap_expires_at: (NOW + 60_000) / 1_000,
        expires_at: (NOW + 30_000) / 1_000,
      },
    ],
    ["an expired route", { expires_at: NOW / 1_000 }],
    [
      "a route beyond the requested deadline",
      { expires_at: (MAXIMUM_EXPIRES_AT + 1_000) / 1_000 },
    ],
  ])("rejects a response containing %s", (_label, overrides) => {
    expect(() =>
      parseStargateWorkspaceAppSessionResponse(
        { ...validResponse(), ...overrides },
        validOptions(),
      ),
    ).toThrow("invalid stargate workspace application response");
  });

  it.each([
    "route-without-prefix",
    "wa-",
    "wa-Uppercase",
    "wa--leading-hyphen",
    "wa-trailing-hyphen-",
    `wa-${"a".repeat(61)}`,
  ])("rejects non-canonical requested route id %s", (expectedRouteId) => {
    const value = validResponse();
    value.route_id = expectedRouteId;
    value.url = `https://${expectedRouteId}.intar.app/?__intar_bootstrap=one-time`;

    expect(() =>
      parseStargateWorkspaceAppSessionResponse(value, {
        ...validOptions(),
        expectedRouteId,
      }),
    ).toThrow("invalid stargate workspace application response");
  });

  it.each(["INTAR.app", "intar.app.", "*.intar.app", "intar", "intar..app"])(
    "rejects invalid configured base domain %s",
    (baseDomain) => {
      expect(() =>
        parseStargateWorkspaceAppSessionResponse(validResponse(), {
          ...validOptions(),
          baseDomain,
        }),
      ).toThrow("STARGATE_WORKSPACE_APP_BASE_DOMAIN is invalid");
    },
  );
});
