import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import compileDigestFixture from "@/generated/fixtures/source/compile-digest.json";
import {
  IMAGE_BUILD_FORMAT_VERSION,
  platformCompileDigest,
} from "./image-build-format";

const rustContentHashPath = fileURLToPath(
  new URL(
    "../../../../crates/intar-image-scenario/src/content_hash.rs",
    import.meta.url,
  ),
);

describe("image build format", () => {
  it("matches the Rust content-hash format", () => {
    expect(readFileSync(rustContentHashPath, "utf8")).toContain(
      `pub const BUILD_FORMAT_VERSION: &str = "${IMAGE_BUILD_FORMAT_VERSION}";`,
    );
  });

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
