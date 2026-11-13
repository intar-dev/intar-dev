// Reading an uploaded `SourceBundleV2`: the gzip and inflated size caps, the
// schema, the compiler and format, and every rule of `validate_bundle`. The
// bundle is untrusted, so nothing is written before this passes.

import {
  IMAGE_FORMAT,
  MAX_SOURCE_BUNDLE_GZIP_BYTES,
  SOURCE_COMPILER_VERSION_V2,
} from "@/generated/constants";
import type { SourceBundleV2 } from "@/generated/contracts/source-bundle-v2";
import validateSourceBundle from "@/generated/contracts/source-bundle-v2.validate";
import { appError } from "@/lib/app-error";
import { validateBundle } from "./validate";

/**
 * The most a bundle may inflate to. Below the builder's 64 MiB: the Worker
 * holds the text and its parse in memory at once.
 */
export const MAX_SOURCE_BUNDLE_JSON_BYTES = 32 * 1024 * 1024;
/** Each scenario costs one revision, its spec blobs and its builds. */
export const MAX_SOURCE_BUNDLE_SCENARIOS = 100;

/**
 * `source_compile_digest` of intar-contracts: `p` plus the first 8 hex
 * characters of the sha256 of `<image_format>\n<compiler_version>`.
 */
export async function sourceCompileDigest(): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${IMAGE_FORMAT}\n${SOURCE_COMPILER_VERSION_V2}`),
  );
  return `p${Array.from(new Uint8Array(hash, 0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const invalid = (message: string) => appError(400, "bundle_invalid", message);

async function gunzip(gzip: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SOURCE_BUNDLE_JSON_BYTES) {
        await reader.cancel();
        throw appError(413, "payload_too_large", `The bundle inflates beyond ${MAX_SOURCE_BUNDLE_JSON_BYTES} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    throw invalid("The bundle is not gzip.");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The bundle in `gzip`, or an AppError: 413 over a size cap, 409
 * `compiler_outdated` for another compiler or image format, else 400.
 */
export async function readSourceBundle(gzip: Uint8Array<ArrayBuffer>): Promise<SourceBundleV2> {
  if (gzip.byteLength > MAX_SOURCE_BUNDLE_GZIP_BYTES) {
    throw appError(413, "payload_too_large", `The bundle is over ${MAX_SOURCE_BUNDLE_GZIP_BYTES} bytes gzipped.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await gunzip(gzip)));
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    throw invalid("The bundle is not JSON.");
  }
  // Before the schema: a newer compiler's bundle may have another shape.
  const stated = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (stated.compiler !== SOURCE_COMPILER_VERSION_V2 || stated.image_format !== IMAGE_FORMAT) {
    throw appError(
      409,
      "compiler_outdated",
      "The bundle was compiled for another compiler or image format. Re-read the compiler descriptor and publish again.",
    );
  }
  if (!validateSourceBundle(value)) {
    const [first] = validateSourceBundle.errors ?? [];
    throw invalid(`The bundle is not a v2 bundle: ${first?.instancePath || "/"} ${first?.message ?? ""}`.trim());
  }
  if (value.scenarios.length > MAX_SOURCE_BUNDLE_SCENARIOS) {
    throw invalid(`The bundle has ${value.scenarios.length} scenarios, over the limit of ${MAX_SOURCE_BUNDLE_SCENARIOS}.`);
  }
  const problems = validateBundle(value);
  if (problems.length) throw invalid(problems.join("\n"));
  return value;
}
