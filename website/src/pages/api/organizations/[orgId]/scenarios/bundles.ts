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
import { getOrganizationDetail } from "@/lib/organizations";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
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
      kino_version: parsed.value.kinoVersion,
    };
    const archiveError = await validateBundleArchivePayload(payload, meta);
    if (archiveError) return archiveError;

    const objectKey = bundleObjectKey(rev);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: {
        rev,
        kino_version: parsed.value.kinoVersion,
        organization_id: organization.id,
      },
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    const queued = await queueImageBuildsFromBundle(db, {
      rev,
      r2Key: objectKey,
      kinoVersion: parsed.value.kinoVersion,
      meta,
      organizationId: organization.id,
      nowUnixMs: now,
    });
    const assigned = await assignQueuedImageBuilds(db, now);
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
