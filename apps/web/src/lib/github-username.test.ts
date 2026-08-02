import { describe, expect, it } from "vitest";
import { isValidGithubUsername, toAllowlistKey } from "./github-username";

describe("isValidGithubUsername", () => {
  it("accepts real usernames", () => {
    expect(isValidGithubUsername("octocat")).toBe(true);
    expect(isValidGithubUsername("a")).toBe(true);
    expect(isValidGithubUsername("my-name-1")).toBe(true);
    expect(isValidGithubUsername("  padded  ")).toBe(true);
  });

  it("rejects invalid shapes", () => {
    expect(isValidGithubUsername("")).toBe(false);
    expect(isValidGithubUsername("-leading")).toBe(false);
    expect(isValidGithubUsername("trailing-")).toBe(false);
    expect(isValidGithubUsername("double--dash")).toBe(false);
    expect(isValidGithubUsername("has space")).toBe(false);
    expect(isValidGithubUsername("way".repeat(20))).toBe(false);
    expect(isValidGithubUsername("dot.name")).toBe(false);
  });
});

describe("toAllowlistKey", () => {
  it("normalizes to trimmed lowercase", () => {
    expect(toAllowlistKey("  OctoCat ")).toBe("octocat");
  });
  it("returns null for empty input", () => {
    expect(toAllowlistKey("")).toBeNull();
    expect(toAllowlistKey("   ")).toBeNull();
    expect(toAllowlistKey(null)).toBeNull();
    expect(toAllowlistKey(undefined)).toBeNull();
  });
});
