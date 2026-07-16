import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import {
  readString,
  normalizeSha256,
  jsonResponse,
  artifactObjectKey,
  IMAGE_KEY_RE,
  isSafeRegistrySlug,
  imageObjectKey,
  isRecord,
  hasRegistryPublishToken,
} from "./shared";

// Cloudflare caps request bodies well below typical image sizes, so images
// and boot artifacts are uploaded ahead of publish as R2 multipart uploads
// split into parts that each fit in one request. The assembled object's
// sha256 is NOT re-verified here (hashing multi-hundred-MB objects exceeds
// the worker CPU budget); agents verify the sha256 on download instead.
export const UPLOAD_MAX_PART_NUMBER = 10_000;

export type UploadTarget = {
  objectKey: string;
  customMetadata: Record<string, string>;
};

export function uploadTargetFromBody(
  body: Record<string, unknown>,
): { ok: true; target: UploadTarget } | { ok: false; response: Response } {
  const kind = readString(body.kind);
  const sha256 = normalizeSha256(readString(body.sha256) ?? "");
  if (!sha256) {
    return {
      ok: false,
      response: jsonResponse({ error: "valid sha256 is required" }, 400),
    };
  }

  if (kind === "artifact") {
    return {
      ok: true,
      target: {
        objectKey: artifactObjectKey(sha256),
        customMetadata: { artifact_sha256: sha256 },
      },
    };
  }

  if (kind === "image") {
    const imageKey = readString(body.image_key);
    const scenarioId = readString(body.scenario_id);
    const vmName = readString(body.vm_name);
    if (
      !imageKey ||
      !IMAGE_KEY_RE.test(imageKey) ||
      !scenarioId ||
      !isSafeRegistrySlug(scenarioId) ||
      !vmName ||
      !isSafeRegistrySlug(vmName)
    ) {
      return {
        ok: false,
        response: jsonResponse(
          {
            error: "image uploads require image_key, scenario_id, and vm_name",
          },
          400,
        ),
      };
    }
    return {
      ok: true,
      target: {
        objectKey: imageObjectKey(imageKey, sha256),
        customMetadata: {
          image_key: imageKey,
          image_sha256: sha256,
          scenario_id: scenarioId,
          vm_name: vmName,
        },
      },
    };
  }

  return {
    ok: false,
    response: jsonResponse({ error: "kind must be image or artifact" }, 400),
  };
}

export function isUploadableObjectKey(objectKey: string): boolean {
  return objectKey.startsWith("images/") || objectKey.startsWith("artifacts/");
}

export async function handleUploadCreate(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  if (!isRecord(body)) {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  const parsed = uploadTargetFromBody(body);
  if (!parsed.ok) return parsed.response;

  const sha256 = normalizeSha256(readString(body.sha256) ?? "") ?? "";
  const existing = await env.VM_IMAGE_REGISTRY_BUCKET.head(
    parsed.target.objectKey,
  );
  const existingSha = normalizeSha256(
    existing?.customMetadata?.image_sha256 ??
      existing?.customMetadata?.artifact_sha256 ??
      "",
  );
  if (existing && existingSha === sha256) {
    return jsonResponse({
      ok: true,
      object_key: parsed.target.objectKey,
      already_exists: true,
    });
  }

  const upload = await env.VM_IMAGE_REGISTRY_BUCKET.createMultipartUpload(
    parsed.target.objectKey,
    {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: parsed.target.customMetadata,
    },
  );
  return jsonResponse(
    {
      ok: true,
      object_key: upload.key,
      upload_id: upload.uploadId,
      already_exists: false,
    },
    201,
  );
}

export async function handleUploadPart(
  request: Request,
  env: Cloudflare.Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "PUT") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  const objectKey = url.searchParams.get("object_key") ?? "";
  const uploadId = url.searchParams.get("upload_id") ?? "";
  const partNumber = Number.parseInt(
    url.searchParams.get("part_number") ?? "",
    10,
  );
  if (!isUploadableObjectKey(objectKey) || !uploadId) {
    return jsonResponse({ error: "invalid object_key or upload_id" }, 400);
  }
  if (
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > UPLOAD_MAX_PART_NUMBER
  ) {
    return jsonResponse({ error: "invalid part_number" }, 400);
  }

  const payload = await request.arrayBuffer();
  if (payload.byteLength === 0) {
    return jsonResponse({ error: "part body is empty" }, 400);
  }

  try {
    const upload = env.VM_IMAGE_REGISTRY_BUCKET.resumeMultipartUpload(
      objectKey,
      uploadId,
    );
    const part = await upload.uploadPart(partNumber, payload);
    return jsonResponse({
      ok: true,
      part_number: part.partNumber,
      etag: part.etag,
    });
  } catch (error) {
    return jsonResponse({ error: `part upload failed: ${String(error)}` }, 400);
  }
}

export async function handleUploadComplete(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const authz = await requireBlobUploadAuth(request, env);
  if (authz) return authz;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }
  if (!isRecord(body)) {
    return jsonResponse({ error: "JSON body is required" }, 400);
  }

  const objectKey = readString(body.object_key) ?? "";
  const uploadId = readString(body.upload_id) ?? "";
  if (!isUploadableObjectKey(objectKey) || !uploadId) {
    return jsonResponse({ error: "invalid object_key or upload_id" }, 400);
  }
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    return jsonResponse({ error: "parts array is required" }, 400);
  }
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const rawPart of body.parts) {
    if (!isRecord(rawPart)) {
      return jsonResponse({ error: "invalid part entry" }, 400);
    }
    const partNumber = rawPart.part_number;
    const etag = readString(rawPart.etag);
    if (
      typeof partNumber !== "number" ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > UPLOAD_MAX_PART_NUMBER ||
      !etag
    ) {
      return jsonResponse({ error: "invalid part entry" }, 400);
    }
    parts.push({ partNumber, etag });
  }

  try {
    const upload = env.VM_IMAGE_REGISTRY_BUCKET.resumeMultipartUpload(
      objectKey,
      uploadId,
    );
    const object = await upload.complete(parts);
    return jsonResponse({
      ok: true,
      object_key: objectKey,
      bytes: object.size,
    });
  } catch (error) {
    return jsonResponse(
      { error: `upload completion failed: ${String(error)}` },
      400,
    );
  }
}

export async function requireBlobUploadAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  if (await hasRegistryPublishToken(request, env)) {
    return null;
  }

  const verified = await requireVerifiedAgentRequest(request, env);
  if (verified.ok) {
    if (verified.agent.role === "builder") {
      return null;
    }
    return jsonResponse({ error: "builder role required" }, 403);
  }

  return jsonResponse({ error: "unauthorized" }, 401);
}
