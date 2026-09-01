import { gzipSync } from "node:zlib";
import {
  imageRegistryMocks,
  sourceBundleFixture,
  sourceBundleFixtureWithCurriculum,
  sourceBundleFixtureWithInvalidTarHeader,
  sourceBundleFixtureWithMetadataEntry,
  resetImageRegistryMocks,
} from "./image-registry/test-fixtures";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { readBundleMeta } from "@/control-plane/image-registry/bundle";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";

const {
  authMock,
  dbMock,
  schedulerMock,
  scenarioCourseCatalogMock,
  scenarioImageCacheMock,
  candidateCatalogMock,
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
    form.set("meta", JSON.stringify(sourceMeta()));
    form.set(
      "bundle",
      new File(
        [
          sourceBundleFixtureWithCurriculum(
            ["broken-nginx"],
            [{ courseId: "linux-operations", lectureIds: ["01-broken-nginx"] }],
          ),
        ],
        "abc123.tar.gz",
        { type: "application/gzip" },
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
          },
        },
      );
      expect(dbMock.drizzle).toHaveBeenCalledWith("db-binding");
      expect(schedulerMock.queueImageBuildsFromBundle).toHaveBeenCalledWith(
        dbMock.db,
        {
          rev: "abc123",
          r2Key: "builds/bundles/abc123.tar.gz",
          meta: {
            rev: "abc123",
            build_format_version: IMAGE_BUILD_FORMAT_VERSION,
            buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
            catalogChannel: "candidate",
            scenarios: [
              {
                scenarioId: "broken-nginx",
                arch: "x86_64",
                contentHash: "d".repeat(64),
              },
            ],
            courseCatalog: {
              version: 2,
              courses: [
                {
                  courseId: "linux-operations",
                  title: "Linux operations",
                  summary: "Diagnose common Linux failures.",
                  bodyMarkdown: "# Linux operations\n",
                  sequential: true,
                  lectures: [
                    {
                      lectureId: "01-broken-nginx",
                      title: "Repair nginx",
                      summary: "Learn the nginx recovery loop.",
                      bodyMarkdown: "# Repair nginx\n",
                      category: "linux",
                      tags: ["nginx"],
                      difficulty: "easy",
                      estimatedMinutes: 15,
                      scenarioId: "broken-nginx",
                    },
                  ],
                },
              ],
            },
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
    form.set("meta", JSON.stringify(sourceMeta()));
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
    form.set("meta", JSON.stringify(sourceMeta()));
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
    form.set("meta", JSON.stringify(sourceMeta()));
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
    form.set("meta", JSON.stringify(sourceMeta()));
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
    form.set("meta", JSON.stringify(sourceMeta()));
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
    form.set("meta", JSON.stringify(sourceMeta()));
    form.set(
      "bundle",
      new File(
        [
          sourceBundleFixtureWithCurriculum(
            ["workshop-cluster"],
            [{ courseId: "linux-operations", lectureIds: ["01-broken-nginx"] }],
          ),
        ],
        "abc123.tar.gz",
        { type: "application/gzip" },
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
      JSON.stringify(
        sourceMeta({
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
      JSON.stringify(
        sourceMeta({
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
      JSON.stringify(
        sourceMeta({
          rev: "..",
        }),
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
      JSON.stringify(
        sourceMeta({
          scenarios: [
            {
              scenario_id: "..",
              arch: "x86_64",
              content_hash: "d".repeat(64),
            },
          ],
        }),
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
      error: "meta.scenarios contains an invalid scenario entry",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects obsolete kino metadata", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify(
        sourceMeta({
          kino_version: "../0.4.0",
        }),
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
      error: "kino_version is no longer supported",
    });
    expect(bucketPut).not.toHaveBeenCalled();
    expect(schedulerMock.queueImageBuildsFromBundle).not.toHaveBeenCalled();
    expect(schedulerMock.assignQueuedImageBuilds).not.toHaveBeenCalled();
  });

  it("rejects source bundle metadata with an unsupported build format version", async () => {
    const form = new FormData();
    form.set(
      "meta",
      JSON.stringify(
        sourceMeta({
          build_format_version: "intar-image-build-v7",
        }),
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

  it("normalizes ordered version-two snapshots", async () => {
    const result = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          course_catalog: {
            version: 2,
            courses: [
              {
                course_id: "linux-operations",
                title: " Linux operations ",
                summary: " Diagnose common Linux failures. ",
                body_markdown: "\n# Linux operations\n",
                sequential: true,
                lectures: [
                  {
                    lecture_id: "01-broken-nginx",
                    title: " Repair nginx ",
                    summary: " Learn the nginx recovery loop. ",
                    body_markdown: "\n# Repair nginx\n",
                    category: " linux ",
                    tags: ["nginx", "service"],
                    difficulty: "easy",
                    estimated_minutes: 15,
                    scenario_id: "broken-nginx",
                  },
                  {
                    lecture_id: "02-theory",
                    title: " Theory only ",
                    summary: " Learn the model first. ",
                    body_markdown: "# Theory\n",
                    category: "linux",
                    tags: ["theory"],
                    estimated_minutes: 5,
                  },
                ],
              },
            ],
          },
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleMeta.courseCatalog).toEqual({
      version: 2,
      courses: [
        {
          courseId: "linux-operations",
          title: "Linux operations",
          summary: "Diagnose common Linux failures.",
          bodyMarkdown: "\n# Linux operations\n",
          sequential: true,
          lectures: [
            {
              lectureId: "01-broken-nginx",
              title: "Repair nginx",
              summary: "Learn the nginx recovery loop.",
              bodyMarkdown: "\n# Repair nginx\n",
              category: "linux",
              tags: ["nginx", "service"],
              difficulty: "easy",
              estimatedMinutes: 15,
              scenarioId: "broken-nginx",
            },
            {
              lectureId: "02-theory",
              title: "Theory only",
              summary: "Learn the model first.",
              bodyMarkdown: "# Theory\n",
              category: "linux",
              tags: ["theory"],
              estimatedMinutes: 5,
            },
          ],
        },
      ],
    });
  });

  it("accepts zero-scenario content-only catalogs and explicit clears", async () => {
    const result = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          scenarios: [],
          course_catalog: courseCatalogWire({
            lectures: [pureLectureMeta()],
          }),
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bundleMeta.scenarios).toEqual([]);
    expect(result.value.bundleMeta.courseCatalog?.courses[0]?.lectures).toEqual(
      [
        {
          lectureId: "01-theory",
          title: "Theory only",
          summary: "Learn the model first.",
          bodyMarkdown: "# Theory\n",
          category: "linux",
          tags: ["theory"],
          estimatedMinutes: 5,
        },
      ],
    );

    const clear = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          scenarios: [],
          course_catalog: { version: 2, courses: [] },
        }),
      ),
    );
    expect(clear.ok).toBe(true);
    if (clear.ok) {
      expect(clear.value.bundleMeta.courseCatalog).toEqual({
        version: 2,
        courses: [],
      });
    }
  });

  it("rejects V1, unknown fields, bad values, and duplicate IDs", async () => {
    const invalidSnapshots: unknown[] = [
      { version: 1, courses: [courseMeta()] },
      { version: 2, courses: [], extra: true },
      {
        version: 2,
        courses: [courseMeta({ course_id: "../unsafe" })],
      },
      {
        version: 2,
        courses: [courseMeta({ course_id: " linux-operations " })],
      },
      {
        version: 2,
        courses: [courseMeta({ body_markdown: " " })],
      },
      {
        version: 2,
        courses: [courseMeta({ sequential: "true" })],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [] })],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta({ tags: [] })] })],
      },
      {
        version: 2,
        courses: [
          courseMeta({
            lectures: [lectureMeta({ tags: ["nginx", " nginx "] })],
          }),
        ],
      },
      {
        version: 2,
        courses: [
          courseMeta({ lectures: [lectureMeta({ estimated_minutes: 0 })] }),
        ],
      },
      {
        version: 2,
        courses: [
          courseMeta({ lectures: [lectureMeta({ difficulty: undefined })] }),
        ],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta(), lectureMeta()] })],
      },
      {
        version: 2,
        courses: [courseMeta(), courseMeta()],
      },
      {
        version: 2,
        courses: [
          courseMeta(),
          courseMeta({
            course_id: "second-course",
            lectures: [lectureMeta({ lecture_id: "01-other" })],
          }),
        ],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta({ extra: true })] })],
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

  it("requires a catalog and a linked lecture for every bundled scenario", async () => {
    const missingCatalog = await readBundleMeta(
      JSON.stringify(sourceMeta({ course_catalog: undefined })),
    );
    expect(missingCatalog.ok).toBe(false);
    if (!missingCatalog.ok) {
      await expect(missingCatalog.response.json()).resolves.toEqual({
        error: "meta.course_catalog is required",
      });
    }

    const orphanScenario = await readBundleMeta(
      JSON.stringify(
        sourceMeta({
          course_catalog: courseCatalogWire({
            lectures: [pureLectureMeta()],
          }),
        }),
      ),
    );
    expect(orphanScenario.ok).toBe(false);
    if (!orphanScenario.ok) {
      await expect(orphanScenario.response.json()).resolves.toEqual({
        error: "meta.scenarios contains a scenario without a linked lecture",
      });
    }
  });

  it("requires provenance and synchronizes a valid public snapshot", async () => {
    const now = 1_762_041_660_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const bucketPut = vi.fn();
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 0 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([]);
    const snapshot = courseCatalogWire();
    const form = sourceBundleForm(
      snapshot,
      sourceBundleFixtureWithCurriculum(
        ["broken-nginx"],
        [{ courseId: "linux-operations", lectureIds: ["01-broken-nginx"] }],
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
        version: 2,
        courses: [
          {
            courseId: "linux-operations",
            title: "Linux operations",
            summary: "Diagnose common Linux failures.",
            bodyMarkdown: "# Linux operations\n",
            sequential: true,
            lectures: [
              {
                lectureId: "01-broken-nginx",
                title: "Repair nginx",
                summary: "Learn the nginx recovery loop.",
                bodyMarkdown: "# Repair nginx\n",
                category: "linux",
                tags: ["nginx"],
                difficulty: "easy",
                estimatedMinutes: 15,
                scenarioId: "broken-nginx",
              },
            ],
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
        candidateCatalogMock.stageReusableCandidateManifests,
      ).toHaveBeenCalledWith(dbMock.db, {
        revision: "abc123",
        organizationId: null,
        meta: expect.objectContaining({ catalogChannel: "candidate" }),
        nowUnixMs: now,
        wakeHost: expect.any(Function),
      });
      expect(
        scenarioImageCacheMock.tryReconcileScenarioImagesForPublicationScope,
      ).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("accepts a content-only archive without base-images.hcl", async () => {
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 0 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([]);
    const bucketPut = vi.fn();
    const env = {
      DB: "db-binding",
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
    } as unknown as Cloudflare.Env;

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(
          courseCatalogWire({ lectures: [pureLectureMeta()] }),
          sourceBundleFixtureWithCurriculum(
            [],
            [{ courseId: "linux-operations", lectureIds: ["01-theory"] }],
          ),
          { scenarios: [] },
        ),
      }),
      env,
    );
    expect(response?.status).toBe(202);
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).toHaveBeenCalledOnce();
    expect(
      scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).toHaveBeenCalledWith(
      dbMock.db,
      expect.objectContaining({
        snapshot: expect.objectContaining({ version: 2 }),
      }),
    );
    expect(schedulerMock.queueImageBuildsFromBundle).toHaveBeenCalledWith(
      dbMock.db,
      expect.objectContaining({
        meta: expect.objectContaining({ scenarios: [] }),
      }),
    );
  });

  it("rejects missing provenance and unavailable references before storage", async () => {
    const bucketPut = vi.fn();
    const env = {
      DB: "db-binding",
      REGISTRY_PUBLISH_TOKEN: "publish-secret",
      VM_IMAGE_REGISTRY_BUCKET: { put: bucketPut },
    } as unknown as Cloudflare.Env;
    const snapshot = courseCatalogWire();

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
      error: "bundle archive is missing curriculum/catalog.json",
    });

    scenarioCourseCatalogMock.validateScenarioCourseCatalogReferences.mockResolvedValueOnce(
      ["broken-nginx"],
    );
    const invalidReference = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/bundles", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
        body: sourceBundleForm(
          snapshot,
          sourceBundleFixtureWithCurriculum(
            ["broken-nginx"],
            [{ courseId: "linux-operations", lectureIds: ["01-broken-nginx"] }],
          ),
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
    build_format_version: IMAGE_BUILD_FORMAT_VERSION,
    scenarios: [
      {
        scenario_id: "broken-nginx",
        arch: "x86_64",
        content_hash: "d".repeat(64),
      },
    ],
    course_catalog: courseCatalogWire(),
    ...extra,
  };
}

function courseCatalogWire(extra: Record<string, unknown> = {}) {
  return {
    version: 2,
    courses: [courseMeta(extra)],
  };
}

function courseMeta(extra: Record<string, unknown> = {}) {
  return {
    course_id: "linux-operations",
    title: "Linux operations",
    summary: "Diagnose common Linux failures.",
    body_markdown: "# Linux operations\n",
    sequential: true,
    lectures: [lectureMeta()],
    ...extra,
  };
}

function lectureMeta(extra: Record<string, unknown> = {}) {
  return {
    lecture_id: "01-broken-nginx",
    title: "Repair nginx",
    summary: "Learn the nginx recovery loop.",
    body_markdown: "# Repair nginx\n",
    category: "linux",
    tags: ["nginx"],
    difficulty: "easy",
    estimated_minutes: 15,
    scenario_id: "broken-nginx",
    ...extra,
  };
}

function pureLectureMeta(extra: Record<string, unknown> = {}) {
  return {
    lecture_id: "01-theory",
    title: "Theory only",
    summary: "Learn the model first.",
    body_markdown: "# Theory\n",
    category: "linux",
    tags: ["theory"],
    estimated_minutes: 5,
    ...extra,
  };
}

function sourceBundleForm(
  courseCatalog: unknown | undefined,
  bundle: ArrayBuffer,
  extra: Record<string, unknown> = {},
): FormData {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify(
      sourceMeta({
        ...extra,
        ...(courseCatalog === undefined
          ? {}
          : { course_catalog: courseCatalog }),
      }),
    ),
  );
  form.set(
    "bundle",
    new File([bundle], "abc123.tar.gz", { type: "application/gzip" }),
  );
  return form;
}
