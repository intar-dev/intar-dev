import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import {
  readBundleMeta,
  validateBundleArchivePayload,
} from "@/control-plane/image-registry/bundle";
import { bundleObjectKey } from "@/control-plane/image-registry/shared";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
} from "@/lib/build-scheduler";
import { createAppId } from "@/lib/id";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import { getOrganizationDetail } from "@/lib/organizations";
import { requireOrganizationScenarioBundleMultipart } from "@/lib/request-security";
import {
  syncScenarioCourseCatalogSnapshot,
  validateScenarioCourseCatalogReferences,
} from "@/lib/scenario-course-catalogs";
import { tryReconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    requireOrganizationScenarioBundleMultipart(request);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "invalid scenario bundle upload",
    );
    return jsonResponse(body, { status });
  }

  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const organization = await getOrganizationDetail({
      organizationKey: params.orgId ?? "",
      userId: authz.context.userId,
    });
    if (organization.role !== "owner" && organization.role !== "admin") {
      return jsonResponse(
        { error: "organization admin role required" },
        { status: 403 },
      );
    }
    const form = await request.formData();
    const parsed = await readBundleMeta(form.get("meta"));
    if (!parsed.ok) return parsed.response;
    const prefix = `${organization.slug}-`;
    if (
      !parsed.value.bundleMeta.scenarios.every(
        (scenario) =>
          scenario.scenarioId.startsWith(prefix) &&
          scenario.scenarioId.length > prefix.length,
      )
    ) {
      return jsonResponse(
        {
          error: `every scenario id must use the ${prefix}<local-id> namespace`,
        },
        { status: 400 },
      );
    }
    const bundle = form.get("bundle");
    if (!(bundle instanceof File)) {
      return jsonResponse(
        { error: "bundle form field is required" },
        { status: 400 },
      );
    }
    const payload = await bundle.arrayBuffer();
    if (payload.byteLength === 0) {
      return jsonResponse(
        { error: "bundle archive is empty" },
        { status: 400 },
      );
    }
    const rev = `org-${organization.slug}-${createAppId()}`;
    const meta = {
      ...parsed.value.bundleMeta,
      rev,
    };
    const archiveError = await validateBundleArchivePayload(payload, meta);
    if (archiveError) return archiveError;

    const db = drizzle(env.DB);
    const courseCatalog = parsed.value.bundleMeta.courseCatalog;
    const invalidScenarioIds = await validateScenarioCourseCatalogReferences(
      db,
      {
        snapshot: courseCatalog,
        bundleScenarioIds: parsed.value.bundleMeta.scenarios.map(
          (scenario) => scenario.scenarioId,
        ),
        organizationId: organization.id,
      },
    );
    if (invalidScenarioIds.length) {
      return jsonResponse(
        {
          error: "course catalog references unavailable scenarios",
          scenario_ids: invalidScenarioIds,
        },
        { status: 400 },
      );
    }

    const objectKey = bundleObjectKey(rev);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: {
        rev,
        organization_id: organization.id,
      },
    });
    const now = Date.now();
    const queued = await queueImageBuildsFromBundle(db, {
      rev,
      r2Key: objectKey,
      meta,
      organizationId: organization.id,
      nowUnixMs: now,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: courseCatalog,
      sourceRevision: parsed.value.rev,
      organizationId: organization.id,
      nowUnixMs: now,
    });
    const assigned = await assignQueuedImageBuilds(db, now);
    if (queued.queued < meta.scenarios.length) {
      await tryReconcileScenarioImagesForPublicationScope(db, {
        publicationOrganizationId: organization.id,
        nowUnixMs: now,
        reason: "organization_bundle_accepted_without_full_rebuild",
        wakeHostRuntime: (hostId) =>
          tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
      });
    }
    return jsonResponse(
      {
        ok: true,
        rev,
        queued: queued.queued,
        assigned,
      },
      { status: 202 },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to upload organization scenario bundle",
    );
    return jsonResponse(body, { status });
  }
};
