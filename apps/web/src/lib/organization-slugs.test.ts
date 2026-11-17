import { describe, expect, it } from "vitest";
import {
  chosenSlugRefusal,
  isScenarioNamespace,
  RESERVED_ORGANIZATION_SLUGS,
} from "@/lib/organization-slugs";

describe("organization slugs", () => {
  it("accepts lowercase slugs of 3 to 39 characters with single hyphens", () => {
    for (const slug of ["abc", "rawkode-academy", "a1-b2-c3", "x".repeat(39)]) {
      expect(chosenSlugRefusal(slug), slug).toBeNull();
    }
  });

  it("refuses slugs outside the chosen shape", () => {
    for (const slug of [
      "",
      "ab",
      "x".repeat(40),
      "Acme",
      "-acme",
      "acme-",
      "ac--me",
      "ac_me",
      "ac.me",
      "ac/me",
      " acme",
      // The shape of an organization id.
      "abcdefghijklmnopqrstuvwx",
    ]) {
      expect(chosenSlugRefusal(slug), slug).toBe("invalid_organization_slug");
    }
  });

  it("reserves the public namespace and the top-level route words", () => {
    for (const slug of ["intar", "admin", "api", "play", "runs", "courses", "docs", "v2", "www", "support", "public", "platform", "system"]) {
      expect(RESERVED_ORGANIZATION_SLUGS.has(slug), slug).toBe(true);
      expect(chosenSlugRefusal(slug), slug).toBe("organization_slug_reserved");
    }
    expect(chosenSlugRefusal("intar-labs")).toBeNull();
  });

  it("keeps existing generated slugs valid as namespaces", () => {
    expect(isScenarioNamespace("platform-team-a1b2c3")).toBe(true);
    expect(isScenarioNamespace("x".repeat(55))).toBe(true);
    expect(isScenarioNamespace("x".repeat(56))).toBe(false);
    expect(isScenarioNamespace("intar")).toBe(false);
    expect(isScenarioNamespace("Team-A1")).toBe(false);
    expect(isScenarioNamespace("team_a")).toBe(false);
  });
});
