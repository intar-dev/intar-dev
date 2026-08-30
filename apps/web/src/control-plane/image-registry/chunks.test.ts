import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/host-runtime-wake", () => ({
  tryWakeHostRuntime: vi.fn().mockResolvedValue(undefined),
}));
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

describe("chunked image registry", () => {
  it("returns complete verified metadata before a builder compresses chunks", async () => {
    const rawSha256 = "a".repeat(64);
    const encodedSha256 = "b".repeat(64);
    const response = await request(
      "/registry/v1/image-chunks/exists",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw_sha256: [rawSha256] }),
      },
      {
        head: vi.fn().mockResolvedValue({
          size: 123,
          customMetadata: {
            raw_sha256: rawSha256,
            raw_size_bytes: "4194304",
            encoded_sha256: encodedSha256,
            encoded_size_bytes: "123",
            encoding: "zstd-v1-level-6",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      existing: [
        {
          raw_sha256: rawSha256,
          raw_size_bytes: 4 * 1024 * 1024,
          encoded_sha256: encodedSha256,
          encoded_size_bytes: 123,
        },
      ],
    });
  });

  it("rejects an encoded chunk with the wrong digest", async () => {
    const response = await request(
      "/registry/v1/image-chunks/" + "a".repeat(64),
      {
        method: "PUT",
        headers: {
          "x-intar-raw-sha256": "a".repeat(64),
          "x-intar-encoded-sha256": "b".repeat(64),
          "x-intar-raw-size": "3",
          "x-intar-encoded-size": "3",
        },
        body: new Uint8Array([1, 2, 3]),
      },
      { head: vi.fn() },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "encoded image chunk SHA-256 mismatch",
    });
  });

  it("publishes a canonical sparse manifest only after validation", async () => {
    const imageId = await zeroOnlyImageId(1);
    const manifest = {
      schema_version: 1,
      image_id: imageId,
      virtual_size_bytes: 1,
      chunk_size_bytes: 4 * 1024 * 1024,
      encoding: "zstd-v1-level-6",
      chunks: [],
    };
    const payload = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestSha256 = await sha256(payload);
    const put = vi.fn().mockResolvedValue(undefined);
    const response = await request(
      `/registry/v1/image-manifests/${manifestSha256}.json`,
      {
        method: "PUT",
        headers: { "x-intar-manifest-sha256": manifestSha256 },
        body: payload,
      },
      { head: vi.fn().mockResolvedValue(null), put },
    );

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledWith(
      `image-manifests/v1/${manifestSha256}.json`,
      expect.any(ArrayBuffer),
      expect.objectContaining({
        customMetadata: expect.objectContaining({ image_id: imageId }),
      }),
    );
  });

  it("rejects a manifest whose image id is not canonical", async () => {
    const manifest = {
      schema_version: 1,
      image_id: "a".repeat(64),
      virtual_size_bytes: 1,
      chunk_size_bytes: 4 * 1024 * 1024,
      encoding: "zstd-v1-level-6",
      chunks: [],
    };
    const payload = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestSha256 = await sha256(payload);
    const response = await request(
      `/registry/v1/image-manifests/${manifestSha256}.json`,
      {
        method: "PUT",
        headers: { "x-intar-manifest-sha256": manifestSha256 },
        body: payload,
      },
      { head: vi.fn(), put: vi.fn() },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "image_id does not match ordered raw chunks",
    });
  });
});

async function request(
  path: string,
  init: RequestInit,
  bucket: Partial<R2Bucket>,
): Promise<Response> {
  const response = await handleImageRegistryRequest(
    new Request(`https://intar.test${path}`, {
      ...init,
      headers: {
        authorization: "Bearer publish-secret",
        ...init.headers,
      },
    }),
    {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: bucket,
    } as Cloudflare.Env,
  );
  if (!response) throw new Error("registry route did not match");
  return response;
}

async function zeroOnlyImageId(size: number): Promise<string> {
  const domain = new TextEncoder().encode("intar-raw-chunks-v1\0");
  const zeroDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(size)),
  );
  const bytes = new Uint8Array(domain.length + 8 + 4 + 4 + 4 + 32);
  bytes.set(domain);
  const view = new DataView(bytes.buffer);
  let offset = domain.length;
  view.setBigUint64(offset, BigInt(size), true);
  offset += 8;
  view.setUint32(offset, 4 * 1024 * 1024, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  view.setUint32(offset + 4, size, true);
  bytes.set(zeroDigest, offset + 8);
  return sha256(bytes);
}

async function sha256(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
