import { describe, expect, it } from "vitest";
import { buildTar, gzipBytes } from "./tar";

function parseHeaders(tar: Uint8Array) {
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; size: number }> = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = Number.parseInt(
      decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(),
      8,
    );
    // Verify checksum like tar readers do.
    const stored = decoder
      .decode(header.subarray(148, 156))
      .replace(/[\0 ]+$/, "")
      .trim();
    let computed = 0;
    for (let i = 0; i < 512; i++) {
      computed += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    }
    expect(Number.parseInt(stored, 8)).toBe(computed);
    entries.push({ path, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("buildTar", () => {
  it("produces readable ustar entries with valid checksums", () => {
    const encoder = new TextEncoder();
    const tar = buildTar([
      { path: "base-images.hcl", bytes: encoder.encode("base") },
      {
        path: "scenarios/demo/scenario.hcl",
        bytes: encoder.encode("scenario body that is longer than one word"),
      },
    ]);
    expect(tar.length % 512).toBe(0);
    const entries = parseHeaders(tar);
    expect(entries).toEqual([
      { path: "base-images.hcl", size: 4 },
      { path: "scenarios/demo/scenario.hcl", size: 42 },
    ]);
  });

  it("rejects over-long paths", () => {
    expect(() =>
      buildTar([{ path: "x/".repeat(60) + "f", bytes: new Uint8Array(1) }]),
    ).toThrow(/too long/);
  });

  it("gzip round-trips", async () => {
    const tar = buildTar([
      { path: "a.txt", bytes: new TextEncoder().encode("hello") },
    ]);
    const gz = await gzipBytes(tar);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const back = new Uint8Array(
      await new Response(
        new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    );
    expect(back).toEqual(tar);
  });
});
