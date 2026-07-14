import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleImageRegistryRequest,
  isRuntimeImageCacheHost,
} from "@/control-plane/image-registry";
import type { ScenarioManifestV3 } from "@/generated/catalog";

const authMock = vi.hoisted(() => ({
  requireVerifiedAgentRequest: vi.fn(),
}));
const dbMock = vi.hoisted(() => {
  const db = { kind: "test-db" };
  return {
    db,
    drizzle: vi.fn(() => db),
  };
});
const schedulerMock = vi.hoisted(() => ({
  assignQueuedImageBuilds: vi.fn(),
  queueImageBuildsFromBundle: vi.fn(),
}));
const catalogManifestMock = vi.hoisted(() => ({
  seedScenarioManifest: vi.fn(),
}));
const desiredStateStoreMock = vi.hoisted(() => ({
  mutateStoredHostDesiredState: vi.fn(),
}));
const hostRuntimeWakeMock = vi.hoisted(() => ({
  tryWakeHostRuntime: vi.fn(),
}));

vi.mock("@/control-plane/auth", () => authMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("@/lib/build-scheduler", () => schedulerMock);
vi.mock("@/lib/catalog-manifest", () => catalogManifestMock);
vi.mock("@/lib/desired-state-store", () => desiredStateStoreMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeWakeMock);
vi.mock("cloudflare:workers", () => ({ env: {} }));

describe("image registry routes", () => {
  beforeEach(() => {
    authMock.requireVerifiedAgentRequest.mockReset();
    dbMock.drizzle.mockClear();
    schedulerMock.assignQueuedImageBuilds.mockReset();
    schedulerMock.queueImageBuildsFromBundle.mockReset();
    catalogManifestMock.seedScenarioManifest.mockReset();
    desiredStateStoreMock.mutateStoredHostDesiredState.mockReset();
    hostRuntimeWakeMock.tryWakeHostRuntime.mockReset();
  });

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
        build_format_version: "intar-image-build-v4",
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
            build_format_version: "intar-image-build-v4",
            buildFormatVersion: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v4",
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
        build_format_version: "intar-image-build-v3",
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

  it("accepts builder agent JWTs for image publish requests", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "builder-1", userId: "user-1", role: "builder" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer builder-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(authMock.requireVerifiedAgentRequest).toHaveBeenCalledOnce();
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "multipart form data is required",
    });
  });

  it("rejects non-builder agent JWTs for image publish requests", async () => {
    authMock.requireVerifiedAgentRequest.mockResolvedValue({
      ok: true,
      agent: { hostId: "agent-1", userId: "user-1", role: "agent" },
    });

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer agent-jwt" },
      }),
      {} as Cloudflare.Env,
    );

    expect(authMock.requireVerifiedAgentRequest).toHaveBeenCalledOnce();
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "builder role required",
    });
  });

  it("rejects publish manifests whose image keys do not match the vm identity", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        image_key: {
          scenario: "other-scenario",
          vm: "web",
          arch: "x86_64",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest image key must match scenario and vm names",
    });
  });

  it("rejects publish manifests with unsafe scenario ids before writing objects", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.scenario_id = "../broken-nginx";
    manifest.name = "../broken-nginx";
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
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
      error: "manifest scenario_id is invalid",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe vm names before writing objects", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        name: "../web",
        image_key: {
          scenario: "broken-nginx",
          vm: "../web",
          arch: "x86_64",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
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
      error: "manifest contains an invalid vm",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with duplicate vm names", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      vm,
      {
        ...vm,
        image_sha256: "c".repeat(64),
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains duplicate vm names",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with vm names that would collapse registry keys", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        name: "web a",
        image_key: {
          scenario: "broken-nginx",
          vm: "web a",
          arch: "x86_64",
        },
      },
      {
        ...vm,
        name: "web-a",
        image_key: {
          scenario: "broken-nginx",
          vm: "web-a",
          arch: "x86_64",
        },
        image_sha256: "c".repeat(64),
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains an invalid vm",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests that are not JSON objects", async () => {
    const form = new FormData();
    form.set("manifest", "null");

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest is not a JSON object",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests missing required scenario metadata", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    delete (manifest as Partial<ScenarioManifestV3>).title;
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario metadata",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with duplicate scenario hint ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.hints = [
      { id: "check-service", body_markdown: "Check systemd." },
      { id: "check-service", body_markdown: "Check nginx." },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario hints",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe scenario hint ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    manifest.hints = [
      { id: "../check-service", body_markdown: "Check systemd." },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid scenario hints",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with unsafe probe ids", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        probes: [
          {
            id: "../nginx-running",
            phase: "scenario",
            kind: "service",
            display_name: "Nginx running",
            hints: [],
          },
        ],
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains an invalid probe",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it.each([
    ["zero CPU", { cpu_millis: 0 }],
    [
      "u32-overflow CPU",
      { cpu_millis: 0x1_0000_0000, vcpu_count: 0xffff },
    ],
    ["u16-overflow vCPU count", { vcpu_count: 0x1_0000 }],
    ["u32-overflow memory", { memory_mib: 0x1_0000_0000 }],
    ["u32-overflow disk", { disk_mib: 0x1_0000_0000 }],
    [
      "unsafe integer CPU",
      { cpu_millis: Number.MAX_SAFE_INTEGER + 1, vcpu_count: 0xffff },
    ],
  ])("rejects publish manifests with invalid vm resources: %s", async (_, invalid) => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        ...invalid,
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid vm resources",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests with invalid raw-zstd boot metadata", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        image_virtual_size_bytes: 0,
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid boot metadata",
    });
  });

  it("rejects publish manifests with invalid image hashes", async () => {
    const manifest = publishManifest({
      imageSha256: "not-a-sha",
      artifactSha256: "b".repeat(64),
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid image sha256",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish manifests that do not direct-boot /dev/vda", async () => {
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    });
    const vm = manifest.vms[0];
    if (!vm) {
      throw new Error("expected publish manifest vm");
    }
    manifest.vms = [
      {
        ...vm,
        boot: {
          ...vm.boot,
          cmdline: "root=LABEL=INTARROOT rw console=ttyS0",
        },
      },
    ];
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
      } as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "manifest contains invalid boot metadata",
    });
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish requests missing required boot artifacts", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: `missing boot artifact ${artifactSha256}`,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("rejects publish requests whose boot artifact hash mismatches", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const actualArtifactSha256 = await sha256HexForTest(artifactPayload);
    const expectedArtifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256: expectedArtifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${expectedArtifactSha256}`,
      new File([artifactPayload], expectedArtifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({
      error: "boot artifact sha256 mismatch",
      expected: expectedArtifactSha256,
      actual: actualArtifactSha256,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("reuses existing content-addressed boot artifacts during publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([]);
    dbMock.drizzle.mockReturnValueOnce(db);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      artifacts: [
        {
          sha256: artifactSha256,
          object_key: `artifacts/${artifactSha256}`,
          bytes: 123_456,
          reused: true,
        },
      ],
    });
    expect(bucketHead).toHaveBeenCalledWith(`artifacts/${artifactSha256}`);
    expect(bucketPut).not.toHaveBeenCalledWith(
      `artifacts/${artifactSha256}`,
      expect.anything(),
      expect.anything(),
    );
    expect(bucketPut).toHaveBeenCalledTimes(2);
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });

  it("creates chunked uploads and reports already-present objects", async () => {
    const sha256 = "c".repeat(64);
    const bucketHead = vi.fn().mockResolvedValue(null);
    const createMultipartUpload = vi.fn().mockResolvedValue({
      key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      uploadId: "upload-1",
    });
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: {
        head: bucketHead,
        createMultipartUpload,
      },
    } as unknown as Cloudflare.Env;

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "image",
          sha256,
          image_key: "broken-nginx-web-x86_64",
          scenario_id: "broken-nginx",
          vm_name: "web",
        }),
      }),
      env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toEqual({
      ok: true,
      object_key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      upload_id: "upload-1",
      already_exists: false,
    });
    expect(createMultipartUpload).toHaveBeenCalledWith(
      `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
      expect.objectContaining({
        customMetadata: expect.objectContaining({ image_sha256: sha256 }),
      }),
    );

    bucketHead.mockResolvedValue({
      customMetadata: { image_sha256: sha256 },
    });
    const repeat = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "image",
          sha256,
          image_key: "broken-nginx-web-x86_64",
          scenario_id: "broken-nginx",
          vm_name: "web",
        }),
      }),
      env,
    );
    expect(repeat?.status).toBe(200);
    await expect(repeat?.json()).resolves.toMatchObject({
      already_exists: true,
    });
    expect(createMultipartUpload).toHaveBeenCalledOnce();
  });

  it("uploads parts and completes chunked uploads", async () => {
    const uploadPart = vi
      .fn()
      .mockResolvedValue({ partNumber: 1, etag: "etag-1" });
    const complete = vi.fn().mockResolvedValue({ size: 42 });
    const resumeMultipartUpload = vi
      .fn()
      .mockReturnValue({ uploadPart, complete });
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { resumeMultipartUpload },
    } as unknown as Cloudflare.Env;
    const objectKey = `artifacts/${"d".repeat(64)}`;

    const partResponse = await handleImageRegistryRequest(
      new Request(
        `https://intar.test/registry/v1/uploads/parts?object_key=${encodeURIComponent(objectKey)}&upload_id=upload-2&part_number=1`,
        {
          method: "PUT",
          headers: { authorization: "Bearer publish-secret" },
          body: new Uint8Array([1, 2, 3]),
        },
      ),
      env,
    );
    expect(partResponse?.status).toBe(200);
    await expect(partResponse?.json()).resolves.toEqual({
      ok: true,
      part_number: 1,
      etag: "etag-1",
    });
    expect(resumeMultipartUpload).toHaveBeenCalledWith(objectKey, "upload-2");

    const completeResponse = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads/complete", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_key: objectKey,
          upload_id: "upload-2",
          parts: [{ part_number: 1, etag: "etag-1" }],
        }),
      }),
      env,
    );
    expect(completeResponse?.status).toBe(200);
    await expect(completeResponse?.json()).resolves.toEqual({
      ok: true,
      object_key: objectKey,
      bytes: 42,
    });
    expect(complete).toHaveBeenCalledWith([{ partNumber: 1, etag: "etag-1" }]);
  });

  it("rejects chunked uploads outside the registry object space", async () => {
    const env = {
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: {},
    } as unknown as Cloudflare.Env;

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/uploads/complete", {
        method: "POST",
        headers: {
          authorization: "Bearer publish-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_key: "builds/bundles/evil.tar.gz",
          upload_id: "upload-3",
          parts: [{ part_number: 1, etag: "etag-1" }],
        }),
      }),
      env,
    );
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "invalid object_key or upload_id",
    });
  });

  it("publishes manifests that reference pre-uploaded images", async () => {
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const imageObjectKey = `images/broken-nginx-web-x86_64/${imageSha256}.raw.zst`;
    const bucketHead = vi.fn().mockImplementation((key: string) => {
      if (key === imageObjectKey) {
        return Promise.resolve({
          size: 777,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: imageSha256,
          },
        });
      }
      return Promise.resolve({
        size: 555,
        customMetadata: { artifact_sha256: artifactSha256 },
      });
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([]);
    dbMock.drizzle.mockReturnValueOnce(db);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      images: [
        {
          image_key: "broken-nginx-web-x86_64",
          image_sha256: imageSha256,
          object_key: imageObjectKey,
          bytes: 777,
          reused: true,
        },
      ],
    });
    // Only the sha256 sidecar is written; the image object itself is reused.
    expect(bucketPut).toHaveBeenCalledTimes(1);
    expect(bucketPut).toHaveBeenCalledWith(
      `${imageObjectKey}.sha256`,
      expect.anything(),
      expect.anything(),
    );
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });

  it("prunes vm images beyond the retention limit after publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "2".repeat(64);
    const staleSha256A = "3".repeat(64);
    const staleSha256B = "4".repeat(64);
    const orphanSha256 = "5".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 4_000),
        pruneCompanionObject(imageSha256, 4_000),
        pruneImageObject(keptSha256, 3_000),
        pruneCompanionObject(keptSha256, 3_000),
        pruneImageObject(staleSha256A, 2_000),
        pruneCompanionObject(staleSha256A, 2_000),
        pruneImageObject(staleSha256B, 1_000),
        pruneCompanionObject(staleSha256B, 1_000),
        pruneCompanionObject(orphanSha256, 500),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256A, staleSha256B, orphanSha256],
        },
      ],
    });
    expect(bucketList).toHaveBeenCalledWith({
      prefix: "images/broken-nginx-web-x86_64/",
    });
    expect(bucketDelete).toHaveBeenCalledTimes(1);
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst.sha256`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst.sha256`,
      `images/broken-nginx-web-x86_64/${orphanSha256}.raw.zst.sha256`,
    ]);
  });

  it("never prunes a just-published reused image with a stale uploaded timestamp", async () => {
    const imageSha256 = "e".repeat(64);
    const artifactSha256 = "f".repeat(64);
    const newerSha256A = "1".repeat(64);
    const newerSha256B = "2".repeat(64);
    const staleSha256 = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));

    const imageObjectKey = `images/broken-nginx-web-x86_64/${imageSha256}.raw.zst`;
    const bucketHead = vi.fn().mockImplementation((key: string) => {
      if (key === imageObjectKey) {
        return Promise.resolve({
          size: 777,
          customMetadata: {
            image_key: "broken-nginx-web-x86_64",
            image_sha256: imageSha256,
          },
        });
      }
      return Promise.resolve({
        size: 555,
        customMetadata: { artifact_sha256: artifactSha256 },
      });
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    // The reused image keeps its original (oldest) uploaded timestamp.
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 1_000),
        pruneCompanionObject(imageSha256, 1_000),
        pruneImageObject(newerSha256A, 4_000),
        pruneCompanionObject(newerSha256A, 4_000),
        pruneImageObject(newerSha256B, 3_000),
        pruneCompanionObject(newerSha256B, 3_000),
        pruneImageObject(staleSha256, 2_000),
        pruneCompanionObject(staleSha256, 2_000),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256],
        },
      ],
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst.sha256`,
    ]);
  });

  it("never prunes images still referenced by scenario catalog rows", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "1".repeat(64);
    const staleSha256 = "2".repeat(64);
    const referencedSha256 = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockResolvedValue({
      objects: [
        pruneImageObject(imageSha256, 4_000),
        pruneImageObject(keptSha256, 3_000),
        pruneImageObject(staleSha256, 2_000),
        pruneImageObject(referencedSha256, 1_000),
      ],
      truncated: false,
    });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(
      publishPruneDb(
        [],
        [
          {
            imageKey: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
            imageSha256: referencedSha256,
          },
        ],
      ),
    );

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256],
        },
      ],
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256}.raw.zst`,
    ]);
  });

  it("follows list cursors when pruning", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const keptSha256 = "1".repeat(64);
    const staleSha256A = "2".repeat(64);
    const staleSha256B = "3".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    // The second-newest image only shows up on the second page.
    const bucketList = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [
          pruneImageObject(imageSha256, 4_000),
          pruneImageObject(staleSha256A, 1_000),
        ],
        truncated: true,
        cursor: "next-cursor",
      })
      .mockResolvedValueOnce({
        objects: [
          pruneImageObject(keptSha256, 3_000),
          pruneImageObject(staleSha256B, 2_000),
        ],
        truncated: false,
      });
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
          list: bucketList,
          delete: bucketDelete,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      pruned: [
        {
          image_key: "broken-nginx-web-x86_64",
          deleted_sha256s: [staleSha256A, staleSha256B],
        },
      ],
    });
    expect(bucketList).toHaveBeenCalledTimes(2);
    expect(bucketList).toHaveBeenNthCalledWith(2, {
      prefix: "images/broken-nginx-web-x86_64/",
      cursor: "next-cursor",
    });
    expect(bucketDelete).toHaveBeenCalledWith([
      `images/broken-nginx-web-x86_64/${staleSha256A}.raw.zst`,
      `images/broken-nginx-web-x86_64/${staleSha256B}.raw.zst`,
    ]);
  });

  it("publishes successfully when image pruning fails", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = "b".repeat(64);
    const manifest = publishManifest({ imageSha256, artifactSha256 });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: artifactSha256 },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const bucketList = vi.fn().mockRejectedValue(new Error("r2 list failed"));
    const bucketDelete = vi.fn().mockResolvedValue(undefined);
    dbMock.drizzle.mockReturnValueOnce(publishPruneDb([], []));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/publish", {
          method: "POST",
          headers: { authorization: "Bearer publish-secret" },
          body: form,
        }),
        {
          DB: "db-binding",
          REGISTRY_PUBLISH_TOKEN: "publish-secret",
          VM_IMAGE_REGISTRY_BUCKET: {
            head: bucketHead,
            put: bucketPut,
            list: bucketList,
            delete: bucketDelete,
          },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(201);
      await expect(response?.json()).resolves.toMatchObject({
        ok: true,
        pruned: [],
      });
      expect(bucketDelete).not.toHaveBeenCalled();
      expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("replaces unverified existing boot artifacts during publish", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue({
      size: 123_456,
      customMetadata: { artifact_sha256: "b".repeat(64) },
    });
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([]);
    dbMock.drizzle.mockReturnValueOnce(db);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      artifacts: [
        {
          sha256: artifactSha256,
          object_key: `artifacts/${artifactSha256}`,
          bytes: artifactPayload.byteLength,
          reused: false,
        },
      ],
    });
    expect(bucketPut).toHaveBeenCalledWith(
      `artifacts/${artifactSha256}`,
      expect.any(ArrayBuffer),
      {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { artifact_sha256: artifactSha256 },
      },
    );
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledOnce();
  });

  it("normalizes publish manifest hashes before catalog seeding", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256: imageSha256.toUpperCase(),
      artifactSha256: artifactSha256.toUpperCase(),
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([]);
    dbMock.drizzle.mockReturnValueOnce(db);

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        DB: "db-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      images: [{ image_sha256: imageSha256 }],
      artifacts: [{ sha256: artifactSha256 }],
    });
    expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        vms: [
          expect.objectContaining({
            image_sha256: imageSha256,
            boot: expect.objectContaining({
              kernel_sha256: artifactSha256,
              initrd_sha256: artifactSha256,
            }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("does not write boot artifacts when a publish image file is missing", async () => {
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256: "a".repeat(64),
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error:
        "missing image for vm web: attach it to the form or upload it via /registry/v1/uploads first",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("does not write boot artifacts when a publish image hash mismatches", async () => {
    const imagePayload = new Uint8Array([1, 2, 3]);
    const wrongImagePayload = new Uint8Array([9, 9, 9]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const wrongImageSha256 = await sha256HexForTest(wrongImagePayload);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([wrongImagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn();

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/publish", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: form,
      }),
      {
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: {
          head: bucketHead,
          put: bucketPut,
        },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(422);
    await expect(response?.json()).resolves.toEqual({
      error: "sha256 mismatch for vm web",
      expected: imageSha256,
      actual: wrongImageSha256,
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(catalogManifestMock.seedScenarioManifest).not.toHaveBeenCalled();
  });

  it("targets non-disabled agents even while scenario starts are disabled", () => {
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: false,
        scenarioEnabled: true,
      }),
    ).toBe(true);
    expect(
      isRuntimeImageCacheHost({
        role: "builder",
        disabled: false,
        scenarioEnabled: false,
      }),
    ).toBe(false);
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: false,
        scenarioEnabled: false,
      }),
    ).toBe(true);
    expect(
      isRuntimeImageCacheHost({
        role: "agent",
        disabled: true,
        scenarioEnabled: true,
      }),
    ).toBe(false);
  });

  it("prewarms maintenance-paused agents without waking builder hosts", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const imagePayload = new Uint8Array([1, 2, 3]);
    const artifactPayload = new Uint8Array([4, 5, 6]);
    const imageSha256 = await sha256HexForTest(imagePayload);
    const artifactSha256 = await sha256HexForTest(artifactPayload);
    const manifest = publishManifest({
      imageSha256,
      artifactSha256,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifest));
    form.set(
      "image:web",
      new File([imagePayload], "broken-nginx-web-x86_64.raw.zst"),
    );
    form.set(
      `artifact:${artifactSha256}`,
      new File([artifactPayload], artifactSha256),
    );
    const bucketHead = vi.fn().mockResolvedValue(null);
    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const db = hostSelectDb([
      {
        id: "agent-1",
        role: "agent",
        disabled: false,
        scenarioEnabled: true,
      },
      {
        id: "builder-1",
        role: "builder",
        disabled: false,
        scenarioEnabled: false,
      },
      {
        id: "agent-paused",
        role: "agent",
        disabled: false,
        scenarioEnabled: false,
      },
    ]);
    dbMock.drizzle.mockReturnValueOnce(db);

    try {
      const response = await handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/publish", {
          method: "POST",
          headers: { authorization: "Bearer publish-secret" },
          body: form,
        }),
        {
          DB: "db-binding",
          REGISTRY_PUBLISH_TOKEN: "publish-secret",
          VM_IMAGE_REGISTRY_BUCKET: {
            head: bucketHead,
            put: bucketPut,
          },
        } as unknown as Cloudflare.Env,
      );

      expect(response?.status).toBe(201);
      expect(catalogManifestMock.seedScenarioManifest).toHaveBeenCalledWith(
        db,
        manifest,
        {
          enabled: true,
          nowUnixMs: now,
        },
      );
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledTimes(2);
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledWith(db, "agent-1", now, expect.any(Function));
      expect(
        desiredStateStoreMock.mutateStoredHostDesiredState,
      ).toHaveBeenCalledWith(db, "agent-paused", now, expect.any(Function));
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledTimes(2);
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
        "agent-1",
      );
      expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
        "agent-paused",
      );
    } finally {
      dateSpy.mockRestore();
    }
  });

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
        key ===
        `images/broken-nginx-web-x86_64/${validImageSha256}.raw.zst`
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

function buildLogDb(input: {
  selectRows: Array<{ hostId: string | null }>;
  updatedRows: Array<{ id: string }>;
}) {
  const selectLimit = vi.fn().mockResolvedValue(input.selectRows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const updateReturning = vi.fn().mockResolvedValue(input.updatedRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    kind: "test-db",
    select,
    update,
    updateSet,
  };
}

function hostSelectDb(rows: HostSelectRow[]) {
  const selectWhere = vi.fn().mockResolvedValue(rows);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

interface HostSelectRow {
  id: string;
  role: "agent" | "builder";
  disabled: boolean;
  scenarioEnabled: boolean;
}

// Publish runs two select().from().where() queries in order: the cached-image
// host bump (agentHosts) and then the prune's catalog-reference guard
// (vmScenarioVms).
function publishPruneDb(
  hostRows: HostSelectRow[],
  imageRefRows: Array<{ imageKey: unknown; imageSha256: string | null }>,
) {
  const selectWhere = vi
    .fn()
    .mockResolvedValueOnce(hostRows)
    .mockResolvedValueOnce(imageRefRows);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

function pruneImageObject(sha256: string, uploadedMs: number) {
  return {
    key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
    uploaded: new Date(uploadedMs),
  };
}

function pruneCompanionObject(sha256: string, uploadedMs: number) {
  return {
    key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst.sha256`,
    uploaded: new Date(uploadedMs),
  };
}

function imageIndexDb(rows: ImageIndexRow[]) {
  const selectFrom = vi.fn().mockResolvedValue(rows);
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

function bundleDownloadDb(rows: Array<{ r2Key: string }>) {
  const selectLimit = vi.fn().mockResolvedValue(rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

function sourceBundleFixture(scenarioIds: string[]): ArrayBuffer {
  return toArrayBuffer(
    gzipSync(tarArchiveFixture(bundleFixtureFiles(scenarioIds))),
  );
}

function sourceBundleFixtureWithInvalidTarHeader(
  scenarioIds: string[],
): ArrayBuffer {
  const files = bundleFixtureFiles(scenarioIds);
  const tar = tarArchiveFixture(files);
  const firstByte = tar[0] ?? 0;
  tar[0] = firstByte === 0 ? 1 : firstByte + 1;
  return toArrayBuffer(gzipSync(tar));
}

function sourceBundleFixtureWithMetadataEntry(
  scenarioIds: string[],
): ArrayBuffer {
  const metadataEntry = tarEntryFixture("pax-header", "", "x");
  const tar = concatBytes([
    metadataEntry,
    tarArchiveFixture(bundleFixtureFiles(scenarioIds)),
  ]);
  return toArrayBuffer(gzipSync(tar));
}

function bundleFixtureFiles(scenarioIds: string[]): Array<[string, string]> {
  return [
    ["base-images.hcl", "base_image \"trixie\" {}\n"],
    ["build-tools.hcl", "kino { version = \"0.4.0\" }\n"],
    ...scenarioIds.map(
      (scenarioId): [string, string] => [
        `scenarios/${scenarioId}/scenario.hcl`,
        `scenario "${scenarioId}" {}\n`,
      ],
    ),
  ];
}

function tarArchiveFixture(files: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of files) {
    chunks.push(tarEntryFixture(path, content, "0"));
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

function tarEntryFixture(
  path: string,
  content: string,
  typeflag: string,
): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarOctal(header, 148, 8, tarChecksum(header));

  const chunks: Uint8Array[] = [header, bytes];
  const padding = (512 - (bytes.byteLength % 512)) % 512;
  if (padding > 0) {
    chunks.push(new Uint8Array(padding));
  }
  return concatBytes(chunks);
}

function writeTarString(
  output: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  output.set(bytes.subarray(0, length), offset);
}

function writeTarOctal(
  output: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const raw = value.toString(8).padStart(length - 1, "0");
  writeTarString(output, offset, length, raw);
}

function tarChecksum(header: Uint8Array): number {
  return header.reduce((sum, byte) => sum + byte, 0);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

interface ImageIndexRow {
  imageKey: {
    scenario: string;
    vm: string;
    arch: "x86_64" | "aarch64";
  };
  imageSha256: string;
  imageFormat: string;
  imageVirtualSizeBytes: number;
  kernelSha256: string;
  initrdSha256: string;
  bootCmdline: string;
}

function imageIndexRow(overrides: Partial<ImageIndexRow> = {}): ImageIndexRow {
  return {
    imageKey: {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64",
    },
    imageSha256: "a".repeat(64),
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 8_589_934_592,
    kernelSha256: "b".repeat(64),
    initrdSha256: "c".repeat(64),
    bootCmdline:
      "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
    ...overrides,
  };
}

function publishManifest(input: {
  imageSha256: string;
  artifactSha256: string;
}): ScenarioManifestV3 {
  return {
    schema_version: 3,
    scenario_id: "broken-nginx",
    name: "broken-nginx",
    title: "Broken Nginx",
    category: "web",
    description: "Repair nginx.",
    difficulty: "easy",
    estimated_minutes: 15,
    tags: ["nginx"],
    briefing_markdown: "Repair the web server.",
    solution_markdown: "Enable nginx.",
    hints: [],
    vms: [
      {
        name: "web",
        image_key: {
          scenario: "broken-nginx",
          vm: "web",
          arch: "x86_64",
        },
        image_sha256: input.imageSha256,
        image_format: "raw_zstd",
        image_virtual_size_bytes: 8_589_934_592,
        boot: {
          kernel_sha256: input.artifactSha256,
          initrd_sha256: input.artifactSha256,
          cmdline:
            "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
        },
        cpu_millis: 2_000,
        vcpu_count: 2,
        memory_mib: 2048,
        disk_mib: 8192,
        probes: [],
      },
    ],
  };
}

async function sha256HexForTest(payload: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
