import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import { imageBuilds, imageBuildBundles, vmScenarioVms } from "@/db/schema";
import {
  jsonResponse,
  isSafeBundleRev,
  isSafeBuildId,
  isImageKey,
  normalizeSha256,
  registryImageKey,
  imageObjectKey,
  artifactObjectKey,
  readString,
  IMAGE_KEY_RE,
  SHA256_HEX_RE,
} from "./shared";

export async function handleAgentBundleDownload(
  request: Request,
  env: Cloudflare.Env,
  rev: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBundleRev(rev)) {
    return jsonResponse({ error: "invalid bundle rev" }, 400);
  }

  const rows = await drizzle(env.DB)
    .select({ r2Key: imageBuildBundles.r2Key })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, rev))
    .limit(1);
  const objectKey = rows[0]?.r2Key;
  if (!objectKey) {
    return jsonResponse({ error: "bundle not found" }, 404);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!object) {
    return jsonResponse({ error: "bundle object not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-build-bundle-rev": rev,
    },
  });
}

export async function handleAgentBuildLogUpload(
  request: Request,
  env: Cloudflare.Env,
  buildId: string,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireBuilderAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!isSafeBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, 400);
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({ hostId: imageBuilds.hostId })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  const build = rows[0];
  if (!build) {
    return jsonResponse({ error: "build not found" }, 404);
  }
  if (build.hostId !== verified.agent.hostId) {
    return jsonResponse(
      { error: "build is not assigned to this builder" },
      409,
    );
  }

  const payload = await request.arrayBuffer();
  const objectKey = `builds/logs/${buildId}.log`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: {
      build_id: buildId,
      host_id: verified.agent.hostId,
    },
  });

  const updated = await db
    .update(imageBuilds)
    .set({
      logR2Key: objectKey,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(imageBuilds.id, buildId),
        eq(imageBuilds.hostId, verified.agent.hostId),
      ),
    )
    .returning({ id: imageBuilds.id });
  if (!updated.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(objectKey);
    return jsonResponse(
      { error: "build assignment changed during log upload" },
      409,
    );
  }

  return jsonResponse({ ok: true, build_id: buildId, log_key: objectKey });
}

export async function handleAgentImageIndex(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      imageKey: vmScenarioVms.imageKeyJson,
      imageSha256: vmScenarioVms.imageSha256,
      imageFormat: vmScenarioVms.imageFormat,
      imageVirtualSizeBytes: vmScenarioVms.imageVirtualSizeBytes,
      kernelSha256: vmScenarioVms.kernelSha256,
      initrdSha256: vmScenarioVms.initrdSha256,
      bootCmdline: vmScenarioVms.bootCmdline,
    })
    .from(vmScenarioVms);

  const byKey = new Map<
    string,
    {
      image_key: string;
      image_sha256: string;
      image_format: string;
      image_virtual_size_bytes: number;
      boot: {
        kernel_sha256: string;
        initrd_sha256: string;
        cmdline: string;
      };
      bytes: number;
      download_url: string;
    }
  >();

  for (const row of rows) {
    if (!isImageKey(row.imageKey)) continue;
    const sha256 = normalizeSha256(row.imageSha256 ?? "");
    if (!sha256) continue;
    const kernelSha256 = normalizeSha256(row.kernelSha256 ?? "");
    const initrdSha256 = normalizeSha256(row.initrdSha256 ?? "");
    const bootCmdline = row.bootCmdline?.trim() ?? "";
    if (
      row.imageFormat !== "raw_zstd" ||
      row.imageVirtualSizeBytes <= 0 ||
      !kernelSha256 ||
      !initrdSha256 ||
      !bootCmdline
    ) {
      continue;
    }

    const imageKey = registryImageKey(row.imageKey);
    const objectKey = imageObjectKey(imageKey, sha256);
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
    if (!imageObjectMatchesSha(object, imageKey, sha256)) continue;
    if (!(await bootArtifactsExist(env, [kernelSha256, initrdSha256]))) {
      continue;
    }

    byKey.set(`${imageKey}:${sha256}`, {
      image_key: imageKey,
      image_sha256: sha256,
      image_format: row.imageFormat,
      image_virtual_size_bytes: row.imageVirtualSizeBytes,
      boot: {
        kernel_sha256: kernelSha256,
        initrd_sha256: initrdSha256,
        cmdline: bootCmdline,
      },
      bytes: object.size,
      download_url: `/agent/registry/images/${encodeURIComponent(imageKey)}/${sha256}`,
    });
  }

  return jsonResponse({
    images: [...byKey.values()].sort((a, b) =>
      a.image_key.localeCompare(b.image_key),
    ),
  });
}

export async function bootArtifactsExist(
  env: Cloudflare.Env,
  sha256s: string[],
): Promise<boolean> {
  const objectKeys = [...new Set(sha256s.map(artifactObjectKey))];
  const heads = await Promise.all(
    objectKeys.map((objectKey) => env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey)),
  );
  return heads.every((head, index) => {
    const objectKey = objectKeys[index];
    const sha256 = objectKey?.slice("artifacts/".length) ?? "";
    return bootArtifactObjectMatchesSha(head, sha256);
  });
}

export function imageObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, imageKey: string, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.image_sha256 ??
      object.customMetadata?.imageSha256 ??
      "",
  );
  const metadataImageKey =
    readString(object.customMetadata?.image_key) ??
    readString(object.customMetadata?.imageKey);
  return metadataSha256 === sha256 && metadataImageKey === imageKey;
}

export function bootArtifactObjectMatchesSha<
  T extends { customMetadata?: Record<string, string> },
>(object: T | null, sha256: string): object is T {
  if (!object) {
    return false;
  }
  const metadataSha256 = normalizeSha256(
    object.customMetadata?.artifact_sha256 ??
      object.customMetadata?.artifactSha256 ??
      "",
  );
  return metadataSha256 === sha256;
}

export async function handleAgentImageDownload(
  request: Request,
  env: Cloudflare.Env,
  imageKey: string,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!IMAGE_KEY_RE.test(imageKey) || !SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid image key or sha256" }, 400);
  }

  const objectKey = imageObjectKey(imageKey, sha256);
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(objectKey);
  if (!imageObjectMatchesSha(object, imageKey, sha256)) {
    return jsonResponse({ error: "image not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-image-key": imageKey,
      "x-image-sha256": sha256,
    },
  });
}

export async function handleAgentArtifactDownload(
  request: Request,
  env: Cloudflare.Env,
  sha256: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified.response;

  if (!SHA256_HEX_RE.test(sha256)) {
    return jsonResponse({ error: "invalid artifact sha256" }, 400);
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    artifactObjectKey(sha256),
  );
  if (!bootArtifactObjectMatchesSha(object, sha256)) {
    return jsonResponse({ error: "artifact not found" }, 404);
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "private, max-age=31536000, immutable",
      etag: object.httpEtag,
      "x-artifact-sha256": sha256,
    },
  });
}

export async function requireBuilderAgentRequest(
  request: Request,
  env: Cloudflare.Env,
) {
  const verified = await requireVerifiedAgentRequest(request, env);
  if (!verified.ok) return verified;
  if (verified.agent.role !== "builder") {
    return {
      ok: false as const,
      response: jsonResponse({ error: "builder role required" }, 403),
    };
  }
  return verified;
}
