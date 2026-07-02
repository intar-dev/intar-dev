import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { requireVerifiedAgentRequest } from "@/control-plane/auth";
import { agentHosts, vmScenarioVms } from "@/db/schema";
import type {
  ImageArchitecture,
  ImageKey,
  ScenarioManifestV1,
  ScenarioVmManifestV1,
} from "@/generated/catalog";
import { seedScenarioManifest } from "@/lib/catalog-manifest";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { upsertDesiredCachedImage } from "@/lib/desired-state";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";

const textEncoder = new TextEncoder();
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const IMAGE_KEY_RE = /^[A-Za-z0-9._-]+$/;

export async function handleImageRegistryRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/registry/v1/publish") {
    return handlePublish(request, env);
  }

  if (url.pathname === "/agent/registry/images") {
    return handleAgentImageIndex(request, env);
  }

  const downloadMatch = url.pathname.match(
    /^\/agent\/registry\/images\/([^/]+)\/([A-Fa-f0-9]{64})$/,
  );
  if (downloadMatch) {
    return handleAgentImageDownload(
      request,
      env,
      decodeURIComponent(downloadMatch[1] ?? ""),
      (downloadMatch[2] ?? "").toLowerCase(),
    );
  }

  return null;
}

async function handlePublish(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authz = requirePublishToken(request, env);
  if (authz) return authz;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }

  const manifest = await readManifest(form.get("manifest"));
  if (!manifest.ok) return manifest.response;

  const validationError = validateManifest(manifest.value);
  if (validationError) return validationError;

  const uploaded = [];
  for (const vm of manifest.value.vms) {
    const imageKey = registryImageKey(vm.image_key);
    const expectedSha256 = normalizeSha256(vm.image_sha256);
    if (!expectedSha256) {
      return jsonResponse(
        { error: `invalid image_sha256 for vm ${vm.name}` },
        400,
      );
    }

    const file = imageFileForVm(form, vm);
    if (!file) {
      return jsonResponse(
        { error: `missing image file for vm ${vm.name}` },
        400,
      );
    }

    const payload = await file.arrayBuffer();
    const actualSha256 = await sha256Hex(payload);
    if (actualSha256 !== expectedSha256) {
      return jsonResponse(
        {
          error: `sha256 mismatch for vm ${vm.name}`,
          expected: expectedSha256,
          actual: actualSha256,
        },
        422,
      );
    }

    const objectKey = imageObjectKey(imageKey, expectedSha256);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        image_key: imageKey,
        image_sha256: expectedSha256,
        scenario_id: manifest.value.scenario_id,
        vm_name: vm.name,
      },
    });
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      `${objectKey}.sha256`,
      textEncoder.encode(`${expectedSha256}  ${imageKey}.qcow2\n`),
      { httpMetadata: { contentType: "text/plain; charset=utf-8" } },
    );

    uploaded.push({
      image_key: imageKey,
      image_sha256: expectedSha256,
      object_key: objectKey,
      bytes: payload.byteLength,
    });
  }

  const db = drizzle(env.DB);
  await seedScenarioManifest(db, manifest.value, {
    enabled: true,
    nowUnixMs: Date.now(),
  });
  await bumpHostCachedImages(db, manifest.value);

  return jsonResponse(
    {
      ok: true,
      scenario_id: manifest.value.scenario_id,
      images: uploaded,
    },
    201,
  );
}

async function bumpHostCachedImages(
  db: DrizzleD1Database,
  manifest: ScenarioManifestV1,
): Promise<void> {
  const nowUnixMs = Date.now();
  const images = manifest.vms.map((vm) => ({
    image_key: vm.image_key,
    image_sha256: vm.image_sha256,
  }));
  const hosts = await db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(eq(agentHosts.disabled, false));

  for (const host of hosts) {
    await mutateStoredHostDesiredState(db, host.id, nowUnixMs, (draft) => {
      for (const image of images) {
        upsertDesiredCachedImage(draft, image);
      }
    });
    await tryWakeHostRuntime(host.id);
  }
}

async function handleAgentImageIndex(
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
    })
    .from(vmScenarioVms);

  const byKey = new Map<string, {
    image_key: string;
    image_sha256: string;
    bytes: number;
    download_url: string;
  }>();

  for (const row of rows) {
    if (!isImageKey(row.imageKey)) continue;
    const sha256 = normalizeSha256(row.imageSha256 ?? "");
    if (!sha256) continue;

    const imageKey = registryImageKey(row.imageKey);
    const objectKey = imageObjectKey(imageKey, sha256);
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(objectKey);
    if (!object) continue;

    byKey.set(`${imageKey}:${sha256}`, {
      image_key: imageKey,
      image_sha256: sha256,
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

async function handleAgentImageDownload(
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
  if (!object) {
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

function requirePublishToken(
  request: Request,
  env: Cloudflare.Env,
): Response | null {
  const expected = env.REGISTRY_PUBLISH_TOKEN?.trim();
  if (!expected) {
    return jsonResponse({ error: "registry publish token is not configured" }, 500);
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (bearer !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  return null;
}

async function readManifest(
  value: FormDataEntryValue | null,
): Promise<{ ok: true; value: ScenarioManifestV1 } | { ok: false; response: Response }> {
  if (!value) {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest form field is required" }, 400),
    };
  }

  const raw = typeof value === "string" ? value : await value.text();
  try {
    return { ok: true, value: JSON.parse(raw) as ScenarioManifestV1 };
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "manifest is not valid JSON" }, 400),
    };
  }
}

function validateManifest(manifest: ScenarioManifestV1): Response | null {
  if (manifest.schema_version !== 1) {
    return jsonResponse({ error: "manifest schema_version must be 1" }, 400);
  }
  if (!manifest.scenario_id?.trim()) {
    return jsonResponse({ error: "manifest scenario_id is required" }, 400);
  }
  if (!Array.isArray(manifest.vms) || manifest.vms.length === 0) {
    return jsonResponse({ error: "manifest must contain at least one vm" }, 400);
  }
  for (const vm of manifest.vms) {
    if (!vm.name?.trim() || !isImageKey(vm.image_key)) {
      return jsonResponse({ error: "manifest contains an invalid vm" }, 400);
    }
  }
  return null;
}

function imageFileForVm(form: FormData, vm: ScenarioVmManifestV1): File | null {
  const field = form.get(`image:${vm.name}`);
  if (field instanceof File) return field;

  const imageKey = `${registryImageKey(vm.image_key)}.qcow2`;
  for (const entry of form.getAll("image")) {
    if (entry instanceof File && entry.name === imageKey) {
      return entry;
    }
  }

  return null;
}

function isImageKey(value: unknown): value is ImageKey {
  const maybe = value as Partial<ImageKey> | null;
  return Boolean(
    maybe &&
      typeof maybe.scenario === "string" &&
      typeof maybe.vm === "string" &&
      isImageArchitecture(maybe.arch),
  );
}

function isImageArchitecture(value: unknown): value is ImageArchitecture {
  return value === "x86_64" || value === "aarch64";
}

function registryImageKey(imageKey: ImageKey): string {
  return `${safeSlug(imageKey.scenario)}-${safeSlug(imageKey.vm)}-${imageKey.arch}`;
}

function safeSlug(value: string): string {
  return value
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function imageObjectKey(imageKey: string, sha256: string): string {
  return `images/${imageKey}/${sha256}.qcow2`;
}

function normalizeSha256(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return SHA256_HEX_RE.test(normalized) ? normalized : null;
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
