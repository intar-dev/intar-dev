import { gzipSync } from "node:zlib";
import {
  imageRegistryMocks,
  sourceBundleFixture,
  sourceBundleFixtureWithCourses,
  sourceBundleFixtureWithInvalidTarHeader,
  sourceBundleFixtureWithMetadataEntry,
  resetImageRegistryMocks,
} from "./image-registry/test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { readBundleMeta } from "@/control-plane/image-registry/bundle";

const {
  authMock,
  dbMock,
  schedulerMock,
  scenarioCourseCatalogMock,
  scenarioImageCacheMock,
} = imageRegistryMocks();

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
      expect(
        scenarioImageCacheMock.tryReconcileScenarioImagesForPublicationScope,
      ).not.toHaveBeenCalled();
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

describe("course catalog bundle metadata", () => {
  beforeEach(resetImageRegistryMocks);

  it("normalizes ordered version-one replacement snapshots", async () => {
    const result = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          course_catalog: {
            version: 1,
            mode: "replace",
            courses: [
              {
                course_id: "linux-operations",
                title: " Linux operations ",
                description: " Diagnose common Linux failures. ",
                scenario_ids: ["broken-nginx", "pair-ping"],
              },
            ],
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleMeta.courseCatalog).toEqual({
      version: 1,
      mode: "replace",
      courses: [
        {
          courseId: "linux-operations",
          title: "Linux operations",
          description: "Diagnose common Linux failures.",
          scenarioIds: ["broken-nginx", "pair-ping"],
        },
      ],
    });
  });

  it("accepts an explicit empty replacement snapshot", async () => {
    const result = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          course_catalog: { version: 1, mode: "replace", courses: [] },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleMeta.courseCatalog?.courses).toEqual([]);
  });

  it("does not treat unvalidated camel-case metadata as a course snapshot", async () => {
    const result = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          courseCatalog: {
            version: 99,
            mode: "merge",
            courses: "not-an-array",
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleMeta.courseCatalog).toBeUndefined();
  });

  it("rejects invalid versions, shapes, IDs, and duplicate membership", async () => {
    const invalidSnapshots: unknown[] = [
      { version: 2, mode: "replace", courses: [] },
      { version: 1, mode: "merge", courses: [] },
      { version: 1, mode: "replace", courses: [], extra: true },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ course_id: "../unsafe" })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ course_id: " linux-operations " })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ title: " " })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ description: " " })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ scenario_ids: [] })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ scenario_ids: ["../unsafe"] })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ scenario_ids: [" broken-nginx "] })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta(), courseMeta()],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta(), courseMeta({ course_id: "second-course" })],
      },
      {
        version: 1,
        mode: "replace",
        courses: [courseMeta({ extra: true })],
      },
    ];

    for (const courseCatalog of invalidSnapshots) {
      const result = await readBundleMeta(
        JSON.stringify(sourceMeta({ course_catalog: courseCatalog })),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      await expect(result.response.json()).resolves.toEqual({
        error: "meta.course_catalog is invalid",
      });
    }
  });

  it("requires provenance and synchronizes a valid public snapshot", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const bucketPut = vi.fn();
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 0 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([]);
    const snapshot = {
      version: 1 as const,
      mode: "replace" as const,
      courses: [
        {
          course_id: "linux-operations",
          title: "Linux operations",
          description: "Diagnose common Linux failures.",
          scenario_ids: ["broken-nginx"],
        },
      ],
    };
    const form = sourceBundleForm(
      snapshot,
      sourceBundleFixtureWithCourses(
        ["broken-nginx"],
        'course "linux-operations" {}\n',
      ),
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
      const normalizedSnapshot = {
        version: 1,
        mode: "replace",
        courses: [
          {
            courseId: "linux-operations",
            title: "Linux operations",
            description: "Diagnose common Linux failures.",
            scenarioIds: ["broken-nginx"],
          },
        ],
      };
      expect(
        scenarioCourseCatalogMock.validateScenarioCourseCatalogReferences,
      ).toHaveBeenCalledWith(dbMock.db, {
        snapshot: normalizedSnapshot,
        bundleScenarioIds: ["broken-nginx"],
        organizationId: null,
      });
      expect(
        scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
      ).toHaveBeenCalledWith(dbMock.db, {
        snapshot: normalizedSnapshot,
        sourceRevision: "abc123",
        organizationId: null,
        nowUnixMs: now,
      });
      expect(bucketPut).toHaveBeenCalledOnce();
      expect(
        scenarioImageCacheMock.tryReconcileScenarioImagesForPublicationScope,
      ).toHaveBeenCalledWith(dbMock.db, {
        publicationOrganizationId: null,
        nowUnixMs: now,
        reason: "public_bundle_accepted_without_full_rebuild",
        wakeHostRuntime: expect.any(Function),
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("synchronizes an explicit empty snapshot but preserves an omitted one", async () => {
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 0 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([]);
    const bucketPut = vi.fn();
    const env = {
      DB: "db-binding",
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
    } as unknown as Cloudflare.Env;

    const emptyResponse = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(
          { version: 1, mode: "replace", courses: [] },
          sourceBundleFixtureWithCourses(["broken-nginx"], ""),
        ),
      }),
      env,
    );
    expect(emptyResponse?.status).toBe(202);
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).toHaveBeenCalledOnce();
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).toHaveBeenCalledWith(
      dbMock.db,
      expect.objectContaining({
        snapshot: { version: 1, mode: "replace", courses: [] },
      }),
    );

    scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot.mockClear();
    const omittedResponse = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(
          undefined,
          sourceBundleFixture(["broken-nginx"]),
        ),
      }),
      env,
    );
    expect(omittedResponse?.status).toBe(202);
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).not.toHaveBeenCalled();
  });

  it("rejects missing provenance and unavailable references before storage", async () => {
    const bucketPut = vi.fn();
    const env = {
      DB: "db-binding",
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
    } as unknown as Cloudflare.Env;
    const snapshot = {
      version: 1 as const,
      mode: "replace" as const,
      courses: [courseMeta()],
    };

    const missingProvenance = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(snapshot, sourceBundleFixture(["broken-nginx"])),
      }),
      env,
    );
    expect(missingProvenance?.status).toBe(400);
    await expect(missingProvenance?.json()).resolves.toEqual({
      error: "bundle archive is missing courses.hcl",
    });

    scenarioCourseCatalogMock.validateScenarioCourseCatalogReferences.mockResolvedValueOnce(
      { ok: false, invalidScenarioIds: ["broken-nginx"] },
    );
    const invalidReference = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(
          snapshot,
          sourceBundleFixtureWithCourses(["broken-nginx"], "course {}\n"),
        ),
      }),
      env,
    );
    expect(invalidReference?.status).toBe(400);
    await expect(invalidReference?.json()).resolves.toEqual({
      error: "course catalog references unavailable scenarios",
      scenario_ids: ["broken-nginx"],
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).not.toHaveBeenCalled();
  });
});

function sourceMeta(extra: Record<string, unknown> = {}) {
  return {
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
    ...extra,
  };
}

function courseMeta(extra: Record<string, unknown> = {}) {
  return {
    course_id: "linux-operations",
    title: "Linux operations",
    description: "Diagnose common Linux failures.",
    scenario_ids: ["broken-nginx"],
    ...extra,
  };
}

function sourceBundleForm(
  courseCatalog: unknown | undefined,
  bundle: ArrayBuffer,
): FormData {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify(
      sourceMeta(
        courseCatalog === undefined ? {} : { course_catalog: courseCatalog },
      ),
    ),
  );
  form.set(
    "bundle",
    new File([bundle], "abc123.tar.gz", { type: "application/gzip" }),
  );
  return form;
}
