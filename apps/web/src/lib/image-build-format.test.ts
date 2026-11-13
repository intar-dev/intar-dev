import { describe, expect, it } from "vitest";
import compileDigestFixture from "@/generated/fixtures/source/compile-digest.json";
import { platformCompileDigest } from "./image-build-format";

describe("image build format", () => {
  it("derives the platform compile digest the Rust contract derives", async () => {
    await expect(
      platformCompileDigest(
        compileDigestFixture.base_images_sha256,
        compileDigestFixture.format_version,
        compileDigestFixture.compiler_version,
      ),
    ).resolves.toBe(compileDigestFixture.digest);
  });

  it("has no platform compile digest while the base-image hash is unset", async () => {
    await expect(platformCompileDigest("")).resolves.toBeNull();
    await expect(platformCompileDigest(undefined)).resolves.toBeNull();
  });
});
