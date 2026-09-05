import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMAGE_BUILD_FORMAT_VERSION } from "./image-build-format";

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
});
