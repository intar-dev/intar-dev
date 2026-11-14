import {
  imageRegistryMocks,
  bundleDownloadDb,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { authMock, dbMock } = imageRegistryMocks();

describe("image registry agent routes", () => {
  beforeEach(resetImageRegistryMocks);

  it("rejects source bundle downloads from non-builder agents", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent", scope: "platform", credentialGeneration: 1 },
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
      agent: { hostId: "builder-1", userId: "user-1", role: "builder", scope: "platform", credentialGeneration: 1 },
    });
    const db = bundleDownloadDb([{ id: "build-1", r2Key: "builds/bundles/abc123.tar.gz" }]);
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

  it("rejects unsafe build log ids before looking up build ownership", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder", scope: "platform", credentialGeneration: 1 },
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
});
