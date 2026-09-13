import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  measureFile,
  parseStaticPin,
  pinSha256,
  readToolsManifest,
  verifyRelease,
} from "./guest-tools-pin";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const toolPath = join(repositoryRoot, "tools/deploy/guest-tools-pin.ts");
const RAW_DISK_BYTES = 64 * 1024 * 1024;
const KINO_BYTES = "kino-binary-bytes\n";

let scratch: string;
let compressedDiskPath: string;
let kinoPath: string;
let debugfsPath: string;
let embeddedManifestPath: string;
let embeddedKinoPath: string;
let manifest: Record<string, unknown>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runFixtureZstd(args: readonly string[]): void {
  const result = spawnSync("zstd", [...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("fixture zstd failed: " + result.stderr);
  }
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "intar-guest-tools-pin-test-"));
  const rawDiskPath = join(scratch, "tools.ext4");
  const kinoBytes = Buffer.from(KINO_BYTES);
  writeFileSync(kinoPath = join(scratch, "kino"), kinoBytes);

  // A deterministic 64 MiB raw image, compressed by the real zstd binary the
  // release pipeline uses. The tool never sees a declared raw digest.
  const raw = Buffer.alloc(RAW_DISK_BYTES);
  for (let offset = 0; offset < raw.byteLength; offset += 4096) {
    raw.writeUInt32LE(offset, offset);
  }
  writeFileSync(rawDiskPath, raw);
  compressedDiskPath = join(scratch, "tools.ext4.zst");
  runFixtureZstd(["-q", "-f", "-o", compressedDiskPath, rawDiskPath]);

  embeddedManifestPath = join(scratch, "embedded-manifest.json");
  embeddedKinoPath = join(scratch, "embedded-kino");
  writeFileSync(embeddedKinoPath, kinoBytes);
  writeFileSync(
    embeddedManifestPath,
    JSON.stringify({
      schema_version: 1,
      bootstrap_abi: 2,
      kino_sha256: sha256(kinoBytes),
      kino_size_bytes: kinoBytes.byteLength,
    }),
  );

  // The e2fsprogs debugfs binary is not present on every development host, so
  // tests use the documented override with an equivalent extractor.
  debugfsPath = join(scratch, "debugfs");
  writeFileSync(
    debugfsPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'test "$1" = "-R"',
      'request="$2"',
      'inner="${request#dump }"',
      'inner="${inner%% *}"',
      'out="${request##* }"',
      'case "${inner}" in',
      '  /manifest.json) cp "${FAKE_DEBUGFS_MANIFEST:?}" "${out}" ;;',
      '  /bin/kino) cp "${FAKE_DEBUGFS_KINO:?}" "${out}" ;;',
      '  *) echo "fake debugfs: unknown path ${inner}" >&2; exit 3 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(debugfsPath, 0o755);

  const compressed = readFileSync(compressedDiskPath);
  manifest = {
    schema_version: 1,
    bootstrap_abi: 2,
    tools_disk_sha256: sha256(readFileSync(rawDiskPath)),
    tools_disk_size_bytes: RAW_DISK_BYTES,
    compressed_disk_sha256: sha256(compressed),
    compressed_disk_size_bytes: compressed.byteLength,
    kino_sha256: sha256(kinoBytes),
    kino_size_bytes: kinoBytes.byteLength,
  };

  process.env.INTAR_GUEST_TOOLS_DEBUGFS_BIN = debugfsPath;
  process.env.FAKE_DEBUGFS_MANIFEST = embeddedManifestPath;
  process.env.FAKE_DEBUGFS_KINO = embeddedKinoPath;
}, 120_000);

afterAll(() => {
  delete process.env.INTAR_GUEST_TOOLS_DEBUGFS_BIN;
  delete process.env.FAKE_DEBUGFS_MANIFEST;
  delete process.env.FAKE_DEBUGFS_KINO;
  rmSync(scratch, { recursive: true, force: true });
});

function verify(overrides: Record<string, unknown> = {}) {
  return verifyRelease({
    manifest: { ...manifest, ...overrides },
    compressedDiskPath,
    kinoPath,
  });
}

describe("guest-tools pin tool", () => {
  it("binds the objects, the raw image, and the embedded tools into one pin", async () => {
    const evidence = await verify();

    expect(evidence.pin).toEqual(manifest);
    expect(evidence.compressed_disk.sha256).toBe(manifest.compressed_disk_sha256);
    expect(evidence.raw_disk).toEqual({
      sha256: manifest.tools_disk_sha256,
      size_bytes: RAW_DISK_BYTES,
    });
    expect(evidence.kino.sha256).toBe(manifest.kino_sha256);
    expect(evidence.embedded_manifest.sha256).toBe(
      sha256(readFileSync(embeddedManifestPath)),
    );
    expect(evidence.embedded_kino.sha256).toBe(manifest.kino_sha256);
    expect(pinSha256(evidence.pin)).toMatch(/^[0-9a-f]{64}$/u);
    expect(parseStaticPin(JSON.parse(JSON.stringify(evidence.pin)))).toEqual(
      evidence.pin,
    );
  }, 120_000);

  it("accepts the image CLI compressed_disk_path field and drops it", () => {
    const pin = readToolsManifest({
      ...manifest,
      compressed_disk_path: compressedDiskPath,
    });

    expect(Object.keys(pin)).not.toContain("compressed_disk_path");
  });

  it("refuses an ABI 1 manifest", async () => {
    await expect(verify({ bootstrap_abi: 1 })).rejects.toThrow(
      /bootstrap_abi must be 2, got 1: ABI 1 has no compatibility path/,
    );
  });

  it("refuses an object whose bytes do not match the manifest digest", async () => {
    await expect(
      verify({ compressed_disk_sha256: "0".repeat(64) }),
    ).rejects.toThrow(/compressed disk object does not match the tools manifest/);
  });

  it("refuses a compressed object whose size does not match the manifest", async () => {
    await expect(
      verify({ compressed_disk_size_bytes: Number(manifest.compressed_disk_size_bytes) + 1 }),
    ).rejects.toThrow(/compressed disk object does not match the tools manifest/);
  });

  it("refuses a valid compressed object whose raw image digest is wrong", async () => {
    // The compressed bytes are real; only the declared raw digest is wrong, so
    // the failure must come from the decompressed image.
    await expect(verify({ tools_disk_sha256: "0".repeat(64) })).rejects.toThrow(
      /decompressed tools disk does not match the tools manifest/,
    );
  });

  it("refuses a Kino object that does not match the manifest", async () => {
    await expect(verify({ kino_sha256: "0".repeat(64) })).rejects.toThrow(
      /Kino object does not match the tools manifest/,
    );
  });

  it("refuses when the embedded tools manifest names another Kino", async () => {
    writeFileSync(
      embeddedManifestPath,
      JSON.stringify({
        schema_version: 1,
        bootstrap_abi: 2,
        kino_sha256: "0".repeat(64),
        kino_size_bytes: Buffer.byteLength(KINO_BYTES),
      }),
    );
    try {
      await expect(verify()).rejects.toThrow(
        /embedded tools manifest does not name the released Kino/,
      );
    } finally {
      writeFileSync(
        embeddedManifestPath,
        JSON.stringify({
          schema_version: 1,
          bootstrap_abi: 2,
          kino_sha256: sha256(Buffer.from(KINO_BYTES)),
          kino_size_bytes: Buffer.byteLength(KINO_BYTES),
        }),
      );
    }
  });

  it("refuses an embedded tools manifest that is not ABI 2", async () => {
    writeFileSync(
      embeddedManifestPath,
      JSON.stringify({
        schema_version: 1,
        bootstrap_abi: 1,
        kino_sha256: sha256(Buffer.from(KINO_BYTES)),
        kino_size_bytes: Buffer.byteLength(KINO_BYTES),
      }),
    );
    try {
      await expect(verify()).rejects.toThrow(
        /embedded tools manifest bootstrap_abi must be 2, got 1/,
      );
    } finally {
      writeFileSync(
        embeddedManifestPath,
        JSON.stringify({
          schema_version: 1,
          bootstrap_abi: 2,
          kino_sha256: sha256(Buffer.from(KINO_BYTES)),
          kino_size_bytes: Buffer.byteLength(KINO_BYTES),
        }),
      );
    }
  });

  it("refuses an embedded Kino binary that differs from the standalone object", async () => {
    writeFileSync(embeddedKinoPath, "another-kino-binary\n");
    try {
      await expect(verify()).rejects.toThrow(
        /embedded Kino binary does not match the standalone Kino object/,
      );
    } finally {
      writeFileSync(embeddedKinoPath, KINO_BYTES);
    }
  });

  it("refuses a missing release object", async () => {
    await expect(
      verifyRelease({
        manifest,
        compressedDiskPath: join(scratch, "absent.ext4.zst"),
        kinoPath,
      }),
    ).rejects.toThrow(/ENOENT|no such file/u);
  });

  it("refuses one file for both objects, unknown keys, and oversized inputs", async () => {
    await expect(
      verifyRelease({ manifest, compressedDiskPath, kinoPath: compressedDiskPath }),
    ).rejects.toThrow(/must be different files/);
    await expect(verify({ extra: 1 })).rejects.toThrow(/unknown keys extra/);
    await expect(measureFile(compressedDiskPath, 16, "compressed disk object")).rejects.toThrow(
      /is larger than 16 bytes/,
    );
  });

  it("verifies the release from the command line and writes the pin", () => {
    const outPath = join(scratch, "static-pin.json");
    const manifestPath = join(scratch, "candidate.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(
      "bun",
      [
        toolPath,
        "release",
        "--manifest",
        manifestPath,
        "--disk",
        compressedDiskPath,
        "--kino",
        kinoPath,
        "--out",
        outPath,
      ],
      { encoding: "utf8", env: process.env },
    );

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.status).toBe("verified");
    expect(evidence.tools_disk_sha256).toBe(manifest.tools_disk_sha256);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(manifest);

    const check = spawnSync("bun", [toolPath, "check", "--pin", outPath], {
      encoding: "utf8",
      env: process.env,
    });
    expect(check.status, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout).status).toBe("valid");

    const abiOnePath = join(scratch, "abi-one.json");
    writeFileSync(abiOnePath, JSON.stringify({ ...manifest, bootstrap_abi: 1 }));
    const rejected = spawnSync("bun", [toolPath, "check", "--pin", abiOnePath], {
      encoding: "utf8",
      env: process.env,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toBe("");
  }, 120_000);
});
