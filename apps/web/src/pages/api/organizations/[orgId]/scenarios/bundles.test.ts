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
  syncScenarioCourseCatalogSnapshot: vi.fn(),
  validateScenarioCourseCatalogReferences: vi.fn(),
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
vi.mock("@/lib/scenario-course-catalogs", () => courseCatalogMock);
vi.mock(
  "@/control-plane/image-registry/bundle",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/control-plane/image-registry/bundle")
    >()),
    validateBundleArchivePayload: bundleMock.validateBundleArchivePayload,
  }),
);

import { POST } from "./bundles";

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
    courseCatalogMock.validateScenarioCourseCatalogReferences.mockResolvedValue(
      { ok: true, invalidScenarioIds: [] },
    );
    bundleMock.validateBundleArchivePayload.mockResolvedValue(null);
  });

  it("validates and synchronizes normalized metadata in organization scope", async () => {
    const snapshot = {
      version: 1,
      mode: "replace",
      courses: [
        {
          courseId: "linux-operations",
          title: "Linux operations",
          description: "Diagnose common Linux failures.",
          scenarioIds: ["public-scenario", "org-a-private"],
        },
      ],
    };
    const response = await upload(
      sourceMeta({
        course_catalog: {
          version: 1,
          mode: "replace",
          courses: [
            {
              course_id: "linux-operations",
              title: "Linux operations",
              description: "Diagnose common Linux failures.",
              scenario_ids: ["public-scenario", "org-a-private"],
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(
      courseCatalogMock.validateScenarioCourseCatalogReferences,
    ).toHaveBeenCalledWith(dbMock.db, {
      snapshot,
      bundleScenarioIds: ["org-a-private"],
      organizationId: "org-a-id",
    });
    expect(
      courseCatalogMock.syncScenarioCourseCatalogSnapshot,
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

  it("preserves the organization snapshot when metadata is omitted", async () => {
    const response = await upload(sourceMeta());

    expect(response.status).toBe(202);
    expect(
      courseCatalogMock.validateScenarioCourseCatalogReferences,
    ).not.toHaveBeenCalled();
    expect(
      courseCatalogMock.syncScenarioCourseCatalogSnapshot,
    ).not.toHaveBeenCalled();
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
    request: new Request("https://intar.test/api/organizations/org-a/scenarios/bundles", {
      method: "POST",
      headers: { "content-length": "1024" },
      body: form,
    }),
    params: { orgId: "org-a" },
  } as unknown as Parameters<typeof POST>[0]);
}

function sourceMeta(extra: Record<string, unknown> = {}) {
  return {
    rev: "source-revision",
    build_format_version: "intar-image-build-v10",
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
