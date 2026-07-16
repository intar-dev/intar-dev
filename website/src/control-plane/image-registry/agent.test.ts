import {
  imageRegistryMocks,
  buildLogDb,
  imageIndexDb,
  bundleDownloadDb,
  imageIndexRow,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { authMock, dbMock } = imageRegistryMocks();

describe("image registry agent routes", () => {
  beforeEach(resetImageRegistryMocks);

  it("advertises only valid raw-zstd direct-boot image index entries", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const validImageSha256 = "a".repeat(64);
    const validKernelSha256 = "b".repeat(64);
    const validInitrdSha256 = "c".repeat(64);
    const missingImageSha256 = "3".repeat(64);
    const missingArtifactImageSha256 = "6".repeat(64);
    const missingArtifactKernelSha256 = "7".repeat(64);
    const missingArtifactInitrdSha256 = "8".repeat(64);
    const staleMetadataImageSha256 = "9".repeat(64);
    const valid = imageIndexRow({
      imageSha256: validImageSha256,
      kernelSha256: validKernelSha256,
      initrdSha256: validInitrdSha256,
    });
    const invalidFormat = imageIndexRow({
      imageSha256: "d".repeat(64),
      imageFormat: "qcow2",
      kernelSha256: "e".repeat(64),
      initrdSha256: "f".repeat(64),
    });
    const invalidBoot = imageIndexRow({
      imageSha256: "1".repeat(64),
      kernelSha256: "not-a-sha",
      initrdSha256: "2".repeat(64),
    });
    const missingObject = imageIndexRow({
      imageSha256: missingImageSha256,
      kernelSha256: "4".repeat(64),
      initrdSha256: "5".repeat(64),
    });
    const missingArtifact = imageIndexRow({
      imageSha256: missingArtifactImageSha256,
      kernelSha256: missingArtifactKernelSha256,
      initrdSha256: missingArtifactInitrdSha256,
    });
    const staleMetadata = imageIndexRow({
      imageSha256: staleMetadataImageSha256,
      kernelSha256: "0".repeat(64),
      initrdSha256: "1".repeat(64),
    });
    dbMock.drizzle.mockReturnValueOnce(
      imageIndexDb([
        valid,
        invalidFormat,
        invalidBoot,
        missingObject,
        missingArtifact,
        staleMetadata,
      ]),
    );
    const bucketHead = vi.fn(async (key: string) => {
      if (
        key === `images/broken-nginx-web-x86_64/${validImageSha256}.raw.zst`
      ) {
        return {
          size: 123_456,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: validImageSha256,
          },
        };
      }
      if (
        key === `artifacts/${validKernelSha256}` ||
        key === `artifacts/${validInitrdSha256}`
      ) {
        const sha256 = key.slice("artifacts/".length);
        return { size: 42, customMetadata: { artifact_sha256: sha256 } };
      }
      if (
        key ===
        `images/broken-nginx-web-x86_64/${missingArtifactImageSha256}.raw.zst`
      ) {
        return {
          size: 654_321,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: missingArtifactImageSha256,
          },
        };
      }
      if (
        key ===
        `images/broken-nginx-web-x86_64/${staleMetadataImageSha256}.raw.zst`
      ) {
        return {
          size: 987_654,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: "0".repeat(64),
          },
        };
      }
      return null;
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/images", {
        method: "GET",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      images: [
        {
          image_key: "broken-nginx-web-x86_64",
          image_sha256: validImageSha256,
          image_format: "raw_zstd",
          image_virtual_size_bytes: 8_589_934_592,
          boot: {
            kernel_sha256: validKernelSha256,
            initrd_sha256: validInitrdSha256,
            cmdline:
              "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
          },
          bytes: 123_456,
          download_url: `/agent/registry/images/broken-nginx-web-x86_64/${validImageSha256}`,
        },
      ],
    });
    expect(bucketHead).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${validImageSha256}.raw.zst`,
    );
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${validKernelSha256}`);
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${validInitrdSha256}`);
    expect(bucketHead).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${missingImageSha256}.raw.zst`,
    );
    expect(bucketHead).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${missingArtifactImageSha256}.raw.zst`,
    );
    expect(bucketHead).toHaveBeenCalledWith(
      `artifacts/${missingArtifactKernelSha256}`,
    );
    expect(bucketHead).toHaveBeenCalledWith(
      `artifacts/${missingArtifactInitrdSha256}`,
    );
    expect(bucketHead).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${staleMetadataImageSha256}.raw.zst`,
    );
    expect(bucketHead).toHaveBeenCalledTimes(8);
  });

  it("streams raw-zstd images to verified agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageKey = "broken-nginx-web-x86_64";
    const imageSha256 = "a".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "image-bytes",
      size: 11,
      httpEtag: '"image-etag"',
      customMetadata: {
        image_key: imageKey,
        image_sha256: imageSha256,
      },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/images/${imageKey}/${imageSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("image-bytes");
    expect(response?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response?.headers.get("content-length")).toBe("11");
    expect(response?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response?.headers.get("etag")).toBe('"image-etag"');
    expect(response?.headers.get("x-image-key")).toBe(imageKey);
    expect(response?.headers.get("x-image-sha256")).toBe(imageSha256);
    expect(bucketGet).toHaveBeenCalledWith(
      `images/${imageKey}/${imageSha256}.raw.zst`,
    );
  });

  it("rejects image downloads with stale object metadata", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const imageKey = "broken-nginx-web-x86_64";
    const imageSha256 = "a".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "image-bytes",
      size: 11,
      httpEtag: '"image-etag"',
      customMetadata: {
        image_key: imageKey,
        image_sha256: "b".repeat(64),
      },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/images/${imageKey}/${imageSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: "image not found",
    });
    expect(bucketGet).toHaveBeenCalledWith(
      `images/${imageKey}/${imageSha256}.raw.zst`,
    );
  });

  it("streams boot artifacts to verified agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const artifactSha256 = "b".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "artifact-bytes",
      size: 14,
      httpEtag: '"artifact-etag"',
      customMetadata: { artifact_sha256: artifactSha256 },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/artifacts/${artifactSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("artifact-bytes");
    expect(response?.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response?.headers.get("content-length")).toBe("14");
    expect(response?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(response?.headers.get("etag")).toBe('"artifact-etag"');
    expect(response?.headers.get("x-artifact-sha256")).toBe(artifactSha256);
    expect(bucketGet).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
  });

  it("rejects boot artifact downloads with stale object metadata", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });
    const artifactSha256 = "b".repeat(64);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "artifact-bytes",
      size: 14,
      httpEtag: '"artifact-etag"',
      customMetadata: { artifact_sha256: "c".repeat(64) },
    });

    const response = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/agent/registry/artifacts/${artifactSha256}`,
        {
          method: "GET",
          headers: { authorization: "Bearer agent-jwt" },
        },
      ),
      {
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({
      error: "artifact not found",
    });
    expect(bucketGet).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
  });

  it("rejects source bundle downloads from non-builder agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/bundles/abc123", {
        method: "GET",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "builder role required",
    });
  });

  it("streams source bundles to builder agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = bundleDownloadDb([{ r2Key: "builds/bundles/abc123.tar.gz" }]);
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketGet = vi.fn().mockResolvedValue({
      body: "bundle-bytes",
      size: 12,
      httpEtag: '"etag"',
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/registry/bundles/abc123", {
        method: "GET",
        headers: { authorization: "Bearer builder-jwt" },
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          get: bucketGet,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.text()).resolves.toBe("bundle-bytes");
    expect(response?.headers.get("content-type")).toBe("application/gzip");
    expect(response?.headers.get("content-length")).toBe("12");
    expect(response?.headers.get("x-build-bundle-rev")).toBe("abc123");
    expect(response?.headers.get("etag")).toBe('"etag"');
    expect(bucketGet).toHaveBeenCalledWith("builds/bundles/abc123.tar.gz");
  });

  it("rejects build log uploads from builders that do not own the build", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-2", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/builds/build-1/log", {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "build is not assigned to this builder",
    });
    expect(bucketPut).not.toHaveBeenCalled();
  });

  it("rejects unsafe build log ids before looking up build ownership", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const unsafeBuildId = "a".repeat(129);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request(`https://intar.test/agent/builds/${unsafeBuildId}/log`, {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid build id",
    });
    expect(dbMock.drizzle).not.toHaveBeenCalled();
    expect(bucketPut).not.toHaveBeenCalled();
  });

  it("stores build logs for the assigned builder", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [{ id: "build-1" }],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();

    try {
      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/agent/builds/build-1/log", {
          method: "PUT",
          headers: { authorization: "Bearer builder-jwt" },
          body: "log text",
        }),
        {
          DB: "db-binding",
          VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toEqual({
        ok: true,
        build_id: "build-1",
        log_key: "builds/logs/build-1.log",
      });
      expect(bucketPut).toHaveBeenCalledWith(
        "builds/logs/build-1.log",
        expect.any(ArrayBuffer),
        {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: {
            build_id: "build-1",
            host_id: "builder-1",
          },
        },
      );
      expect(db.updateSet).toHaveBeenCalledWith({
        logR2Key: "builds/logs/build-1.log",
        updatedAt: now,
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("deletes uploaded build logs if assignment changes during upload", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });
    const db = buildLogDb({
      selectRows: [{ hostId: "builder-1" }],
      updatedRows: [],
    });
    dbMock.drizzle.mockReturnValueOnce(db);
    const bucketPut = vi.fn();
    const bucketDelete = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/agent/builds/build-1/log", {
        method: "PUT",
        headers: { authorization: "Bearer builder-jwt" },
        body: "log text",
      }),
      {
        DB: "db-binding",
        VM_IMAGE_REGISTRY_BUCKET: {
          put: bucketPut,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "build assignment changed during log upload",
    });
    expect(bucketPut).toHaveBeenCalledOnce();
    expect(bucketDelete).toHaveBeenCalledWith("builds/logs/build-1.log");
  });
});
