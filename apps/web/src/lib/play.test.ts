import { describe, expect, it } from "vitest";
import { playPagePath, safeSignInReturnPath, sanitizePlayRef } from "./play";

describe("safeSignInReturnPath", () => {
  it.each([
    "/play/intar/repair-nginx",
    "/play/intar/repair-nginx?ref=rka",
    "/play/intar/scenario.v2?ref=a_b-c&x=1",
  ])("keeps the same-origin play path %s", (path) => {
    expect(safeSignInReturnPath(path)).toBe(path);
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "/courses",
    "/play",
    "/play/",
    "play/intar/x",
    "//evil.example/play/intar/x",
    "/play//evil.example",
    "/play/intar//x",
    "\\\\evil.example/play/x",
    "/play\\evil.example",
    "/play/intar\\x",
    "https://evil.example/play/intar/x",
    "javascript:alert(1)//play/x",
    "/play/%2F%2Fevil.example",
    "/play/intar/x%0d%0aSet-Cookie:a",
    "/play/../admin",
    "/play/intar/../../admin",
    "/play/./x",
    "/play/intar/x#frag",
    "/play/intar/x?next=https://evil.example",
    "/play/intar/x y",
    "/play/intar/x\n",
    "/play/intar/ünïcode",
    "/play/" + "a".repeat(600),
  ])("falls back to /courses for %j", (value) => {
    expect(safeSignInReturnPath(value)).toBe("/courses");
  });
});

describe("playPagePath", () => {
  it("builds a return path the sign-in validator keeps", () => {
    for (const path of [
      playPagePath("intar", "repair-nginx"),
      playPagePath("intar", "repair-nginx", "rka"),
    ]) {
      expect(safeSignInReturnPath(path)).toBe(path);
    }
    expect(playPagePath("intar", "repair-nginx", "rka")).toBe(
      "/play/intar/repair-nginx?ref=rka",
    );
  });
});

describe("sanitizePlayRef", () => {
  it("keeps a short plain tag", () => {
    expect(sanitizePlayRef("rka")).toBe("rka");
    expect(sanitizePlayRef("A_b-9".padEnd(32, "x"))).toHaveLength(32);
  });

  it.each([undefined, "", "a".repeat(33), "a b", "a/b", "ä", "<x>", 7])(
    "drops %j",
    (value) => {
      expect(sanitizePlayRef(value)).toBeUndefined();
    },
  );
});
