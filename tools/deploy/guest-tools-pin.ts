#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type JsonRecord = Record<string, unknown>;

/**
 * Read-only generator and validator for the required ABI 2 guest-tools pin.
 *
 * The pin is the value of the Worker variable
 * SCENARIO_GUEST_TOOLS_STATIC_PIN_JSON. It is generated from the real release
 * objects, never from a declared digest, and it binds the whole tuple:
 *
 *   compressed disk object -> decompressed raw image -> embedded tools
 *   manifest -> embedded Kino binary -> standalone Kino object
 *
 * There is no network access in this tool. The release pipeline downloads the
 * objects from R2 first and passes their paths.
 */

export interface ScenarioGuestToolsPinV1 {
  schema_version: 1;
  bootstrap_abi: 2;
  tools_disk_sha256: string;
  tools_disk_size_bytes: number;
  compressed_disk_sha256: string;
  compressed_disk_size_bytes: number;
  kino_sha256: string;
  kino_size_bytes: number;
}

export interface MeasuredObject {
  sha256: string;
  size_bytes: number;
}

const RAW_DISK_BYTES = 64 * 1024 * 1024;
const MAX_EMBEDDED_MANIFEST_BYTES = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const PIN_KEYS = [
  "schema_version",
  "bootstrap_abi",
  "tools_disk_sha256",
  "tools_disk_size_bytes",
  "compressed_disk_sha256",
  "compressed_disk_size_bytes",
  "kino_sha256",
  "kino_size_bytes",
] as const;
// The image CLI prints this path next to the digest; it is not part of the pin.
const OPTIONAL_MANIFEST_KEYS = ["compressed_disk_path"] as const;
const EMBEDDED_MANIFEST_KEYS = [
  "schema_version",
  "bootstrap_abi",
  "kino_sha256",
  "kino_size_bytes",
] as const;
const EMBEDDED_MANIFEST_PATH = "/manifest.json";
const EMBEDDED_KINO_PATH = "/bin/kino";
const ZSTD_BIN_ENV = "INTAR_GUEST_TOOLS_ZSTD_BIN";
const DEBUGFS_BIN_ENV = "INTAR_GUEST_TOOLS_DEBUGFS_BIN";

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object");
  }
  return value as JsonRecord;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(label + " must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(label + " must be a positive integer");
  }
  return value;
}

function helperBinary(envName: string, defaultName: string): string {
  // Tests and non-standard runners point these at equivalent binaries.
  const override = process.env[envName];
  return override && override.trim().length > 0 ? override : defaultName;
}

/** Hash a file with a streaming reader and a hard size bound. */
export async function measureFile(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<MeasuredObject> {
  const { size } = statSync(filePath);
  if (size <= 0) throw new Error(label + " is empty: " + filePath);
  if (size > maxBytes) {
    throw new Error(label + " is larger than " + String(maxBytes) + " bytes: " + filePath);
  }
  const hash = createHash("sha256");
  let measured = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    measured += bytes.byteLength;
    if (measured > maxBytes) {
      throw new Error(label + " is larger than " + String(maxBytes) + " bytes: " + filePath);
    }
    hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), size_bytes: measured };
}

/** Run a helper command and hash its output with a hard size bound. */
function measureStream(
  command: string,
  args: readonly string[],
  options: { maxBytes: number; label: string; sinkPath?: string },
): Promise<MeasuredObject> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const sink = options.sinkPath ? createWriteStream(options.sinkPath) : null;
    const hash = createHash("sha256");
    const oversized =
      options.label + " is larger than " + String(options.maxBytes) + " bytes";
    let measured = 0;
    let failure = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      sink?.destroy();
      rejectPromise(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      measured += chunk.byteLength;
      if (measured > options.maxBytes) {
        child.kill("SIGKILL");
        fail(new Error(oversized));
        return;
      }
      hash.update(chunk);
      sink?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      failure += chunk.toString("utf8").slice(0, 4096);
    });
    child.on("error", (error) =>
      fail(new Error(options.label + " failed to run " + command + ": " + error.message)),
    );
    child.on("close", (code) => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          rejectPromise(
            new Error(
              options.label +
                " failed with status " +
                String(code) +
                ": " +
                failure.trim(),
            ),
          );
          return;
        }
        resolvePromise({ sha256: hash.digest("hex"), size_bytes: measured });
      };
      if (sink) sink.end(finish);
      else finish();
    });
  });
}

/** Decompress the release object and hash the raw image in one pass. */
function decompressDisk(
  compressedPath: string,
  rawPath: string,
  maxBytes: number,
): Promise<MeasuredObject> {
  return measureStream(
    helperBinary(ZSTD_BIN_ENV, "zstd"),
    ["--decompress", "--stdout", compressedPath],
    { maxBytes, label: "tools disk decompression", sinkPath: rawPath },
  );
}
/** Extract one file from the raw ext4 image with the e2fsprogs debugger. */
async function dumpFromImage(
  imagePath: string,
  innerPath: string,
  outputPath: string,
  maxBytes: number,
  label: string,
): Promise<MeasuredObject> {
  const debugfs = helperBinary(DEBUGFS_BIN_ENV, "debugfs");
  await measureStream(
    debugfs,
    ["-R", "dump " + innerPath + " " + outputPath, imagePath],
    { maxBytes, label: label + " extraction" },
  );
  return measureFile(outputPath, maxBytes, label);
}

export function readToolsManifest(value: unknown): ScenarioGuestToolsPinV1 {
  const manifest = record(value, "tools manifest");
  const unknownKeys = Object.keys(manifest).filter(
    (key) =>
      !(PIN_KEYS as readonly string[]).includes(key) &&
      !(OPTIONAL_MANIFEST_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error("tools manifest has unknown keys " + unknownKeys.sort().join(", "));
  }
  if (manifest.schema_version !== 1) {
    throw new Error(
      "tools manifest schema_version must be 1, got " + String(manifest.schema_version),
    );
  }
  if (manifest.bootstrap_abi !== 2) {
    throw new Error(
      "tools manifest bootstrap_abi must be 2, got " +
        String(manifest.bootstrap_abi) +
        ": ABI 1 has no compatibility path",
    );
  }
  if (manifest.tools_disk_size_bytes !== RAW_DISK_BYTES) {
    throw new Error(
      "tools manifest tools_disk_size_bytes must be " +
        String(RAW_DISK_BYTES) +
        ", got " +
        String(manifest.tools_disk_size_bytes),
    );
  }
  return {
    schema_version: 1,
    bootstrap_abi: 2,
    tools_disk_sha256: digest(manifest.tools_disk_sha256, "tools_disk_sha256"),
    tools_disk_size_bytes: RAW_DISK_BYTES,
    compressed_disk_sha256: digest(
      manifest.compressed_disk_sha256,
      "compressed_disk_sha256",
    ),
    compressed_disk_size_bytes: positiveInteger(
      manifest.compressed_disk_size_bytes,
      "compressed_disk_size_bytes",
    ),
    kino_sha256: digest(manifest.kino_sha256, "kino_sha256"),
    kino_size_bytes: positiveInteger(manifest.kino_size_bytes, "kino_size_bytes"),
  };
}

export function parseStaticPin(value: unknown): ScenarioGuestToolsPinV1 {
  return readToolsManifest(value);
}

export function pinSha256(pin: ScenarioGuestToolsPinV1): string {
  return createHash("sha256").update(JSON.stringify(pin)).digest("hex");
}

export interface ReleaseEvidence {
  pin: ScenarioGuestToolsPinV1;
  compressed_disk: MeasuredObject;
  raw_disk: MeasuredObject;
  kino: MeasuredObject;
  embedded_manifest: MeasuredObject;
  embedded_kino: MeasuredObject;
}

/**
 * Measure every release object and prove the whole tuple before the pin is
 * emitted. Any mismatch between the manifest, the objects, the raw image, and
 * the embedded tools is a release failure.
 */
export async function verifyRelease(input: {
  manifest: unknown;
  compressedDiskPath: string;
  kinoPath: string;
}): Promise<ReleaseEvidence> {
  const pin = readToolsManifest(input.manifest);
  if (input.compressedDiskPath === input.kinoPath) {
    throw new Error("the disk object and the Kino object must be different files");
  }
  const compressedDisk = await measureFile(
    input.compressedDiskPath,
    RAW_DISK_BYTES,
    "compressed disk object",
  );
  if (
    compressedDisk.sha256 !== pin.compressed_disk_sha256 ||
    compressedDisk.size_bytes !== pin.compressed_disk_size_bytes
  ) {
    throw new Error(
      "compressed disk object does not match the tools manifest: measured " +
        compressedDisk.sha256 +
        " (" +
        String(compressedDisk.size_bytes) +
        " bytes)",
    );
  }
  const kino = await measureFile(input.kinoPath, RAW_DISK_BYTES, "Kino object");
  if (kino.sha256 !== pin.kino_sha256 || kino.size_bytes !== pin.kino_size_bytes) {
    throw new Error(
      "Kino object does not match the tools manifest: measured " +
        kino.sha256 +
        " (" +
        String(kino.size_bytes) +
        " bytes)",
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "intar-guest-tools-pin-"));
  try {
    const rawPath = join(scratch, "tools.ext4");
    const rawDisk = await decompressDisk(input.compressedDiskPath, rawPath, RAW_DISK_BYTES);
    if (rawDisk.size_bytes !== pin.tools_disk_size_bytes) {
      throw new Error(
        "decompressed tools disk is " +
          String(rawDisk.size_bytes) +
          " bytes, not " +
          String(pin.tools_disk_size_bytes),
      );
    }
    if (rawDisk.sha256 !== pin.tools_disk_sha256) {
      throw new Error(
        "decompressed tools disk does not match the tools manifest: measured " + rawDisk.sha256,
      );
    }

    const embeddedManifestPath = join(scratch, "embedded-manifest.json");
    const embeddedManifest = await dumpFromImage(
      rawPath,
      EMBEDDED_MANIFEST_PATH,
      embeddedManifestPath,
      MAX_EMBEDDED_MANIFEST_BYTES,
      "embedded tools manifest",
    );
    const embedded = readEmbeddedManifest(
      readFileSync(embeddedManifestPath, "utf8"),
    );
    if (
      embedded.kino_sha256 !== pin.kino_sha256 ||
      embedded.kino_size_bytes !== pin.kino_size_bytes
    ) {
      throw new Error(
        "embedded tools manifest does not name the released Kino: it names " +
          embedded.kino_sha256 +
          " (" +
          String(embedded.kino_size_bytes) +
          " bytes)",
      );
    }

    const embeddedKino = await dumpFromImage(
      rawPath,
      EMBEDDED_KINO_PATH,
      join(scratch, "embedded-kino"),
      RAW_DISK_BYTES,
      "embedded Kino binary",
    );
    if (
      embeddedKino.sha256 !== pin.kino_sha256 ||
      embeddedKino.size_bytes !== pin.kino_size_bytes
    ) {
      throw new Error(
        "embedded Kino binary does not match the standalone Kino object: measured " +
          embeddedKino.sha256 +
          " (" +
          String(embeddedKino.size_bytes) +
          " bytes) at " +
          EMBEDDED_KINO_PATH,
      );
    }
    return {
      pin,
      compressed_disk: compressedDisk,
      raw_disk: rawDisk,
      kino,
      embedded_manifest: embeddedManifest,
      embedded_kino: embeddedKino,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readEmbeddedManifest(source: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("embedded tools manifest is not valid JSON");
  }
  const manifest = record(value, "embedded tools manifest");
  const keys = Object.keys(manifest).sort();
  if (
    keys.length !== EMBEDDED_MANIFEST_KEYS.length ||
    keys.join(",") !== [...EMBEDDED_MANIFEST_KEYS].sort().join(",")
  ) {
    throw new Error(
      "embedded tools manifest must name exactly " + EMBEDDED_MANIFEST_KEYS.join(", "),
    );
  }
  if (manifest.schema_version !== 1) {
    throw new Error("embedded tools manifest schema_version must be 1");
  }
  if (manifest.bootstrap_abi !== 2) {
    throw new Error(
      "embedded tools manifest bootstrap_abi must be 2, got " + String(manifest.bootstrap_abi),
    );
  }
  return {
    schema_version: 1,
    bootstrap_abi: 2,
    kino_sha256: digest(manifest.kino_sha256, "embedded kino_sha256"),
    kino_size_bytes: positiveInteger(manifest.kino_size_bytes, "embedded kino_size_bytes"),
  };
}

interface Flags {
  [name: string]: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? "";
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) usage();
    flags[name.slice(2)] = value;
  }
  return flags;
}

function requireFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (!value) usage();
  return value;
}

function readJson(jsonPath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      label + " is not readable JSON: " + (error instanceof Error ? error.message : ""),
    );
  }
}

async function releaseCommand(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const manifestPath = requireFlag(flags, "manifest");
  const evidence = await verifyRelease({
    manifest: readJson(manifestPath, "tools manifest"),
    compressedDiskPath: requireFlag(flags, "disk"),
    kinoPath: requireFlag(flags, "kino"),
  });
  writeFileSync(requireFlag(flags, "out"), JSON.stringify(evidence.pin) + "\n");
  process.stdout.write(
    JSON.stringify({
      status: "verified",
      manifest: manifestPath,
      static_pin_sha256: pinSha256(evidence.pin),
      compressed_disk_sha256: evidence.compressed_disk.sha256,
      tools_disk_sha256: evidence.raw_disk.sha256,
      kino_sha256: evidence.kino.sha256,
      embedded_manifest_sha256: evidence.embedded_manifest.sha256,
      embedded_kino_sha256: evidence.embedded_kino.sha256,
      pin: evidence.pin,
    }) + "\n",
  );
}

function checkCommand(argv: readonly string[]): void {
  const flags = parseFlags(argv);
  const pin = parseStaticPin(readJson(requireFlag(flags, "pin"), "static pin"));
  process.stdout.write(
    JSON.stringify({
      status: "valid",
      static_pin_sha256: pinSha256(pin),
      tools_disk_sha256: pin.tools_disk_sha256,
      kino_sha256: pin.kino_sha256,
    }) + "\n",
  );
}

function usage(): never {
  throw new Error(
    [
      "usage:",
      "  tools/deploy/guest-tools-pin.ts release --manifest <file> --disk <file> --kino <file> --out <file>",
      "  tools/deploy/guest-tools-pin.ts check --pin <file>",
      "",
      "release measures the compressed disk object, the decompressed raw image",
      "(exactly 64 MiB), the standalone Kino object, the tools manifest inside",
      "the raw image, and the Kino binary inside the raw image.",
      "",
      "environment overrides: " + ZSTD_BIN_ENV + ", " + DEBUGFS_BIN_ENV,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "release") return releaseCommand(rest);
  if (command === "check") return checkCommand(rest);
  usage();
}

if (import.meta.main) await main();
