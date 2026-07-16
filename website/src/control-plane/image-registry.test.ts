import { gzipSync } from "node:zlib";
import {
  imageRegistryMocks,
  sourceBundleFixture,
  sourceBundleFixtureWithInvalidTarHeader,
  sourceBundleFixtureWithMetadataEntry,
  resetImageRegistryMocks,
} from "./image-registry/test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const { authMock, dbMock, schedulerMock } = imageRegistryMocks();

describe("image registry source bundles", () => {
  beforeEach(resetImageRegistryMocks);

  it("requires the registry publish token for source bundle uploads", async () => {
    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("accepts the registry publish token before reading bundle multipart data", async () => {
    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "multipart form data is required",
    });
  });

  it("does not accept builder agent JWTs for source bundle uploads", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: "unauthorized" });
    expect(authMock.requireVerifiedAgentRequest).not.toHaveBeenCalled();
  });

  it("stores source bundles and queues builds from bundle metadata", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const bucketPut = vi.fn();
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 1 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([
      { buildId: "build-1", hostId: "builder-1" },
    ]);
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File([sourceBundleFixture(["broken-nginx"])], "abc123.tar.gz", {
        type: "application/gzip",
      }),
    );

    try {
      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/bundles", {
          method: "POST",
          headers: { authorization: "Bearer publish-secret" },
          body: form,
        }),
        {
          DB: "db-binding",
          REGISTRY_PUBLISH_TOKEN: "publish-secret",
          VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(202);
      await expect(response?.json()).resolves.toEqual({
        ok: true,
        rev: "abc123",
        bundle_key: "builds/bundles/abc123.tar.gz",
        queued: 1,
        assigned: [{ buildId: "build-1", hostId: "builder-1" }],
      });
      expect(bucketPut).toHaveBeenCalledWith(
        "builds/bundles/abc123.tar.gz",
        expect.any(ArrayBuffer),
        {
          httpMetadata: { contentType: "application/gzip" },
          customMetadata: {
            rev: "abc123",
            kino_version: "0.4.0",
          },
        },
      );
      expect(dbMock.drizzle).toHaveBeenCalledWith("db-binding");
      expect(schedulerMock.queueImageBuildsFromBundle).toHaveBeenCalledWith(
        dbMock.db,
        {
          rev: "abc123",
          r2Key: "builds/bundles/abc123.tar.gz",
          kinoVersion: "0.4.0",
          meta: {
            rev: "abc123",
            kino_version: "0.4.0",
            build_format_version: "intar-image-build-v8",
            buildFormatVersion: "intar-image-build-v8",
            scenarios: [
              {
                scenarioId: "broken-nginx",
                arch: "x86_64",
                contentHash: "d".repeat(64),
              },
            ],
          },
          nowUnixMs: now,
        },
      );
      expect(schedulerMock.assignQueuedImageBuilds).toHaveBeenCalledWith(
        dbMock.db,
        now,
      );
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("rejects empty source bundle archives before queueing builds", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File([], "abc123.tar.gz", {
        type: "application/gzip",
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive is empty",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects corrupt source bundle archives before queueing builds", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File([new Uint8Array([1, 2, 3])], "abc123.tar.gz", {
        type: "application/gzip",
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive is not valid gzip",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects oversized inflated source bundles before queueing builds", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File(
        [gzipSync(new Uint8Array(64 * 1024 * 1024 + 1))],
        "abc123.tar.gz",
        {
          type: "application/gzip",
        },
      ),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive is too large",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundles with invalid tar headers before queueing builds", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File(
        [sourceBundleFixtureWithInvalidTarHeader(["broken-nginx"])],
        "abc123.tar.gz",
        {
          type: "application/gzip",
        },
      ),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive contains an invalid header",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundles with unsupported tar entry types before queueing builds", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File(
        [sourceBundleFixtureWithMetadataEntry(["broken-nginx"])],
        "abc123.tar.gz",
        {
          type: "application/gzip",
        },
      ),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive contains an unsupported entry type",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundles missing declared scenario sources", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    form.set(
      "bundle",
      new File([sourceBundleFixture(["workshop-cluster"])], "abc123.tar.gz", {
        type: "application/gzip",
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "bundle archive is missing scenarios/broken-nginx/scenario.hcl",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with duplicate scenario architecture entries", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "e".repeat(64),
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "meta contains duplicate scenario/arch entries",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with any invalid scenario entry", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
          {
            scenario_id: "workshop-cluster",
            arch: "x86_64",
            content_hash: "not-a-sha256",
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "meta.scenarios contains an invalid scenario entry",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with dot path component revs", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "..",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid rev",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with unsafe scenario ids", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v8",
        scenarios: [
          {
            scenario_id: "..",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "meta.scenarios contains an invalid scenario entry",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with unsafe kino versions", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "../0.4.0",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid kino_version",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with an unsupported build format version", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify({
        rev: "abc123",
        kino_version: "0.4.0",
        build_format_version: "intar-image-build-v7",
        scenarios: [
          {
            scenario_id: "broken-nginx",
            arch: "x86_64",
            content_hash: "d".repeat(64),
          },
        ],
      }),
    );
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "unsupported build_format_version",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata that is not a JSON object", async () => {
    const form = new FormData();
    form.set("meta", "null");
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "meta is not a JSON object",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });
});
