import { beforeEach, describe, expect, it, vi } from "vitest";

const workerMock = vi.hoisted(() => ({
  env: {
    DB: "db-binding",
    VM_IMAGE_REGISTRY_BUCKET: { put: vi.fn() },
  },
}));

const dbMock = vi.hoisted(() => ({
  db: { kind: "test-db" },
  drizzle: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
}));

const schedulerMock = vi.hoisted(() => ({
  assignQueuedImageBuilds: vi.fn(),
  queueImageBuildsFromBundle: vi.fn(),
}));

const organizationMock = vi.hoisted(() => ({
  getOrganizationDetail: vi.fn(),
}));

const courseCatalogMock = vi.hoisted(() => ({
  syncCourseCatalogSnapshot: vi.fn(),
  validateCourseCatalogReferences: vi.fn(),
}));

const bundleMock = vi.hoisted(() => ({
  validateBundleArchivePayload: vi.fn(),
}));

vi.mock("cloudflare:workers", () => workerMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: authMock.requireUserContext,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json" },
    }),
}));
vi.mock("@/lib/build-scheduler", () => schedulerMock);
vi.mock("@/lib/id", () => ({ createAppId: () => "generated-id" }));
vi.mock("@/lib/organizations", () => organizationMock);
vi.mock("@/lib/course-catalogs", () => courseCatalogMock);
vi.mock("@/control-plane/image-registry/bundle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/control-plane/image-registry/bundle")
  >()),
  validateBundleArchivePayload: bundleMock.validateBundleArchivePayload,
}));

import { POST } from "./bundles";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";

describe("organization scenario bundle course catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.drizzle.mockReturnValue(dbMock.db);
    authMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-user" },
    });
    organizationMock.getOrganizationDetail.mockResolvedValue({
      id: "org-a-id",
      slug: "org-a",
      role: "admin",
    });
    schedulerMock.queueImageBuildsFromBundle.mockResolvedValue({ queued: 0 });
    schedulerMock.assignQueuedImageBuilds.mockResolvedValue([]);
    courseCatalogMock.validateCourseCatalogReferences.mockResolvedValue(
      [],
    );
    bundleMock.validateBundleArchivePayload.mockResolvedValue(null);
  });

  it("validates and synchronizes normalized metadata in organization scope", async () => {
    const snapshot = {
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
              lectureId: "01-private",
              title: "Private repair",
              summary: "Repair a private service.",
              bodyMarkdown: "# Private repair\n",
              category: "linux",
              tags: ["private"],
              difficulty: "easy",
              estimatedMinutes: 15,
              scenarioId: "org-a-private",
            },
          ],
        },
      ],
    };
    const response = await upload(
      sourceMeta({
        course_catalog: {
          version: 2,
          courses: [
            {
              course_id: "linux-operations",
              title: "Linux operations",
              summary: "Diagnose common Linux failures.",
              body_markdown: "# Linux operations\n",
              sequential: true,
              lectures: [
                {
                  lecture_id: "01-private",
                  title: "Private repair",
                  summary: "Repair a private service.",
                  body_markdown: "# Private repair\n",
                  category: "linux",
                  tags: ["private"],
                  difficulty: "easy",
                  estimated_minutes: 15,
                  scenario_id: "org-a-private",
                },
              ],
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(
      courseCatalogMock.validateCourseCatalogReferences,
    ).toHaveBeenCalledWith(dbMock.db, {
      snapshot,
      bundleScenarioIds: ["org-a-private"],
      organizationId: "org-a-id",
    });
    expect(
      courseCatalogMock.syncCourseCatalogSnapshot,
    ).toHaveBeenCalledWith(dbMock.db, {
      snapshot,
      sourceRevision: "source-revision",
      organizationId: "org-a-id",
      nowUnixMs: expect.any(Number),
    });
    expect(schedulerMock.queueImageBuildsFromBundle).toHaveBeenCalledWith(
      dbMock.db,
      expect.objectContaining({
        rev: "org-org-a-generated-id",
        organizationId: "org-a-id",
      }),
    );
  });

  it("accepts a content-only organization catalog", async () => {
    const snapshot = {
      version: 2,
      courses: [
        {
          courseId: "linux-operations",
          title: "Linux operations",
          summary: "Learn the model first.",
          bodyMarkdown: "# Linux operations\n",
          sequential: false,
          lectures: [
            {
              lectureId: "01-theory",
              title: "Theory only",
              summary: "Understand the model.",
              bodyMarkdown: "# Theory\n",
              category: "linux",
              tags: ["theory"],
              estimatedMinutes: 5,
            },
          ],
        },
      ],
    };
    const response = await upload({
      ...sourceMeta(),
      scenarios: [],
      course_catalog: {
        version: 2,
        courses: [
          {
            course_id: "linux-operations",
            title: "Linux operations",
            summary: "Learn the model first.",
            body_markdown: "# Linux operations\n",
            sequential: false,
            lectures: [
              {
                lecture_id: "01-theory",
                title: "Theory only",
                summary: "Understand the model.",
                body_markdown: "# Theory\n",
                category: "linux",
                tags: ["theory"],
                estimated_minutes: 5,
              },
            ],
          },
        ],
      },
    });

    expect(response.status).toBe(202);
    expect(
      courseCatalogMock.validateCourseCatalogReferences,
    ).toHaveBeenCalledWith(dbMock.db, {
      snapshot,
      bundleScenarioIds: [],
      organizationId: "org-a-id",
    });
    expect(
      courseCatalogMock.syncCourseCatalogSnapshot,
    ).toHaveBeenCalledWith(dbMock.db, {
      snapshot,
      sourceRevision: "source-revision",
      organizationId: "org-a-id",
      nowUnixMs: expect.any(Number),
    });
  });
});

async function upload(meta: Record<string, unknown>): Promise<Response> {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set(
    "bundle",
    new File(["bundle"], "source.tar.gz", { type: "application/gzip" }),
  );
  return POST({
    request: new Request(
      "https://intar.test/api/organizations/org-a/scenarios/bundles",
      {
        method: "POST",
        headers: { "content-length": "1024" },
        body: form,
      },
    ),
    params: { orgId: "org-a" },
  } as unknown as Parameters<typeof POST>[0]);
}

function sourceMeta(extra: Record<string, unknown> = {}) {
  return {
    rev: "source-revision",
    build_format_version: IMAGE_BUILD_FORMAT_VERSION,
    scenarios: [
      {
        scenario_id: "org-a-private",
        arch: "x86_64",
        content_hash: "d".repeat(64),
      },
    ],
    ...extra,
  };
}
