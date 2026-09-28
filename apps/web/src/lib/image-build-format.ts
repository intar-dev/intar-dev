import { SOURCE_COMPILER_VERSION } from "@/generated/constants";

// Keep this in lockstep with `intar_image_scenario::BUILD_FORMAT_VERSION`.
// The Worker cannot import the Rust constant directly, so bundle uploads and
// registry validation must agree on the current image format.
// Bump in lockstep with the Rust constant whenever the compiled image changes
// without a change to any hashed scenario input, such as the generated guest
// startup unit or an embedded kernel fix. See the Rust constant for the full
// rule.
export const IMAGE_BUILD_FORMAT_VERSION = "intar-image-build-v17";

/**
 * The platform compile digest, as `intar_contracts::platform_compile_digest`
 * derives it: `p` plus the first 8 hex characters of the sha256 of the format
 * version, the compiler version and the base-image catalog hash, joined by
 * `\n`. Null while the base-image hash is unset, so no builder matches it.
 */
export async function platformCompileDigest(
  baseImagesSha256: string | undefined,
  formatVersion = IMAGE_BUILD_FORMAT_VERSION,
  compilerVersion = SOURCE_COMPILER_VERSION,
): Promise<string | null> {
  if (!baseImagesSha256) return null;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${formatVersion}\n${compilerVersion}\n${baseImagesSha256}`,
    ),
  );
  const hex = [...new Uint8Array(hash, 0, 4)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `p${hex}`;
}
