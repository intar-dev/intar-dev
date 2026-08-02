import { drizzle } from "drizzle-orm/d1";
import {
  type ImageBuildBundleMeta,
  type ScenarioCourseCatalogSnapshotV1,
} from "@/db/schema";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
} from "@/lib/build-scheduler";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  syncScenarioCourseCatalogSnapshot,
  validateScenarioCourseCatalogReferences,
} from "@/lib/scenario-course-catalogs";
import {
  jsonResponse,
  bundleObjectKey,
  hasRegistryPublishToken,
  isRecord,
  readString,
  isSafeBundleRev,
  isSafeKinoVersion,
  normalizeSha256,
  isImageArchitecture,
} from "./shared";

export const textDecoder = new TextDecoder();

export const TAR_BLOCK_SIZE = 512;

export const MAX_BUNDLE_TAR_BYTES = 64 * 1024 * 1024;

export async function handleBundleUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const authz = await requireBundleUploadAuth(request, env);
  if (authz) return authz;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "multipart form data is required" }, 400);
  }

  const meta = await readBundleMeta(form.get("meta"));
  if (!meta.ok) return meta.response;

  const bundle = form.get("bundle");
  if (!(bundle instanceof File)) {
    return jsonResponse({ error: "bundle form field is required" }, 400);
  }

  const payload = await bundle.arrayBuffer();
  if (payload.byteLength === 0) {
    return jsonResponse({ error: "bundle archive is empty" }, 400);
  }
  const archiveError = await validateBundleArchivePayload(
    payload,
    meta.value.bundleMeta,
  );
  if (archiveError) return archiveError;

  const db = drizzle(env.DB);
  const courseCatalog = meta.value.bundleMeta.courseCatalog;
  if (courseCatalog) {
    const referenceValidation = await validateScenarioCourseCatalogReferences(
      db,
      {
        snapshot: courseCatalog,
        bundleScenarioIds: meta.value.bundleMeta.scenarios.map(
          (scenario) => scenario.scenarioId,
        ),
        organizationId: null,
      },
    );
    if (!referenceValidation.ok) {
      return jsonResponse(
        {
          error: "course catalog references unavailable scenarios",
          scenario_ids: referenceValidation.invalidScenarioIds,
        },
        400,
      );
    }
  }

  const objectKey = bundleObjectKey(meta.value.rev);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      rev: meta.value.rev,
      kino_version: meta.value.kinoVersion,
    },
  });

  const now = Date.now();
  const queued = await queueImageBuildsFromBundle(db, {
    rev: meta.value.rev,
    r2Key: objectKey,
    kinoVersion: meta.value.kinoVersion,
    meta: meta.value.bundleMeta,
    nowUnixMs: now,
  });
  if (courseCatalog) {
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: courseCatalog,
      sourceRevision: meta.value.rev,
      organizationId: null,
      nowUnixMs: now,
    });
  }
  const assigned = await assignQueuedImageBuilds(db, now);

  return jsonResponse(
    {
      ok: true,
      rev: meta.value.rev,
      bundle_key: objectKey,
      queued: queued.queued,
      assigned,
    },
    202,
  );
}

export async function requireBundleUploadAuth(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  if (await hasRegistryPublishToken(request, env)) {
    return null;
  }
  return jsonResponse({ error: "unauthorized" }, 401);
}

export async function readBundleMeta(value: FormDataEntryValue | null): Promise<
  | {
      ok: true;
      value: {
        rev: string;
        kinoVersion: string;
        bundleMeta: ImageBuildBundleMeta;
      };
    }
  | { ok: false; response: Response }
> {
  if (!value) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta form field is required" }, 400),
    };
  }

  const raw = typeof value === "string" ? value : await value.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "meta is not valid JSON" }, 400),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta is not a JSON object" }, 400),
    };
  }

  const rev = readString(parsed.rev);
  const kinoVersion =
    readString(parsed.kino_version) ?? readString(parsed.kinoVersion);
  if (!rev || !isSafeBundleRev(rev)) {
    return { ok: false, response: jsonResponse({ error: "invalid rev" }, 400) };
  }
  if (!kinoVersion) {
    return {
      ok: false,
      response: jsonResponse({ error: "kino_version is required" }, 400),
    };
  }
  if (!isSafeKinoVersion(kinoVersion)) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid kino_version" }, 400),
    };
  }
  const buildFormatVersion =
    readString(parsed.build_format_version) ??
    readString(parsed.buildFormatVersion);
  if (buildFormatVersion !== IMAGE_BUILD_FORMAT_VERSION) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "unsupported build_format_version" },
        400,
      ),
    };
  }

  if (!Array.isArray(parsed.scenarios)) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta.scenarios is required" }, 400),
    };
  }
  const scenarios: ImageBuildBundleMeta["scenarios"] = [];
  for (const rawScenario of parsed.scenarios) {
    const scenario = normalizeBundleScenario(rawScenario);
    if (!scenario) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "meta.scenarios contains an invalid scenario entry" },
          400,
        ),
      };
    }
    scenarios.push(scenario);
  }
  if (!scenarios.length) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta.scenarios is required" }, 400),
    };
  }
  const scenarioKeys = new Set<string>();
  for (const scenario of scenarios) {
    const key = `${scenario.scenarioId}:${scenario.arch}`;
    if (scenarioKeys.has(key)) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "meta contains duplicate scenario/arch entries" },
          400,
        ),
      };
    }
    scenarioKeys.add(key);
  }

  let courseCatalog: ScenarioCourseCatalogSnapshotV1 | undefined;
  if (Object.hasOwn(parsed, "course_catalog")) {
    const normalized = normalizeCourseCatalogSnapshot(parsed.course_catalog);
    if (!normalized) {
      return {
        ok: false,
        response: jsonResponse(
          { error: "meta.course_catalog is invalid" },
          400,
        ),
      };
    }
    courseCatalog = normalized;
  }

  const bundleMeta: ImageBuildBundleMeta = {
    ...parsed,
    buildFormatVersion,
    scenarios,
  };
  delete bundleMeta.courseCatalog;
  if (courseCatalog) bundleMeta.courseCatalog = courseCatalog;

  return {
    ok: true,
    value: {
      rev,
      kinoVersion,
      bundleMeta,
    },
  };
}

export function normalizeCourseCatalogSnapshot(
  value: unknown,
): ScenarioCourseCatalogSnapshotV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "mode", "courses"])) {
    return null;
  }
  if (value.version !== 1 || value.mode !== "replace") {
    return null;
  }
  if (!Array.isArray(value.courses)) {
    return null;
  }

  const courseIds = new Set<string>();
  const memberIds = new Set<string>();
  const courses: ScenarioCourseCatalogSnapshotV1["courses"] = [];
  for (const valueCourse of value.courses) {
    if (
      !isRecord(valueCourse) ||
      !hasExactKeys(valueCourse, [
        "course_id",
        "title",
        "description",
        "scenario_ids",
      ])
    ) {
      return null;
    }
    const courseId = readUntrimmedString(valueCourse.course_id);
    const title = readString(valueCourse.title);
    const description = readString(valueCourse.description);
    if (
      !courseId ||
      !isSafeBundleRev(courseId) ||
      !title ||
      !description ||
      !Array.isArray(valueCourse.scenario_ids) ||
      valueCourse.scenario_ids.length === 0 ||
      courseIds.has(courseId)
    ) {
      return null;
    }

    const scenarioIds: string[] = [];
    for (const valueScenarioId of valueCourse.scenario_ids) {
      const scenarioId = readUntrimmedString(valueScenarioId);
      if (
        !scenarioId ||
        !isSafeBundleRev(scenarioId) ||
        memberIds.has(scenarioId)
      ) {
        return null;
      }
      memberIds.add(scenarioId);
      scenarioIds.push(scenarioId);
    }
    courseIds.add(courseId);
    courses.push({ courseId, title, description, scenarioIds });
  }

  return { version: 1, mode: "replace", courses };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function readUntrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeBundleScenario(
  value: unknown,
): ImageBuildBundleMeta["scenarios"][number] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const scenarioId = readString(raw.scenario_id) ?? readString(raw.scenarioId);
  const arch = readString(raw.arch);
  const contentHash =
    normalizeSha256(readString(raw.content_hash) ?? "") ??
    normalizeSha256(readString(raw.contentHash) ?? "");
  if (
    !scenarioId ||
    !isSafeBundleRev(scenarioId) ||
    !isImageArchitecture(arch) ||
    !contentHash
  ) {
    return null;
  }
  return {
    scenarioId,
    arch,
    contentHash,
  };
}

export async function validateBundleArchivePayload(
  payload: ArrayBuffer,
  meta: ImageBuildBundleMeta,
): Promise<Response | null> {
  const archive = await readGzipBundleArchive(payload);
  if (!archive.ok) return archive.response;

  const entries = inspectTarArchive(archive.bytes);
  if (!entries.ok) {
    return jsonResponse({ error: entries.error }, 400);
  }

  for (const requiredPath of requiredBundlePaths(meta)) {
    if (!entries.files.has(requiredPath)) {
      return jsonResponse(
        { error: `bundle archive is missing ${requiredPath}` },
        400,
      );
    }
  }

  return null;
}

export async function readGzipBundleArchive(
  payload: ArrayBuffer,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; response: Response }
> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([payload])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "bundle archive is not valid gzip" },
        400,
      ),
    };
  }

  try {
    return await readLimitedBundleArchiveStream(stream);
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        { error: "bundle archive is not valid gzip" },
        400,
      ),
    };
  }
}

export async function readLimitedBundleArchiveStream(
  stream: ReadableStream<Uint8Array>,
): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; response: Response }
> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    length += value.byteLength;
    if (length > MAX_BUNDLE_TAR_BYTES) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      return {
        ok: false,
        response: jsonResponse({ error: "bundle archive is too large" }, 413),
      };
    }
    chunks.push(value);
  }
  reader.releaseLock();

  return { ok: true, bytes: concatUint8Arrays(chunks, length) };
}

export function concatUint8Arrays(
  chunks: Uint8Array[],
  length: number,
): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.byteLength === length) {
    return chunks[0];
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export type TarInspectionResult =
  | { ok: true; files: Set<string> }
  | { ok: false; error: string };

export function inspectTarArchive(bytes: Uint8Array): TarInspectionResult {
  if (bytes.length === 0) {
    return {
      ok: false,
      error: "bundle archive tar is empty",
    };
  }

  const files = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;

    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) {
        break;
      }
      continue;
    }
    zeroBlocks = 0;

    const path = tarHeaderPath(header);
    if (!path || !isSafeBundleArchivePath(path)) {
      return { ok: false, error: "bundle archive contains an unsafe path" };
    }
    if (!hasValidTarHeaderChecksum(header)) {
      return { ok: false, error: "bundle archive contains an invalid header" };
    }

    const size = tarHeaderSize(header);
    if (size === null) {
      return { ok: false, error: "bundle archive contains an invalid size" };
    }
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const dataEnd = offset + size;
    const paddedEnd = offset + paddedSize;
    if (dataEnd > bytes.length || paddedEnd > bytes.length) {
      return { ok: false, error: "bundle archive is truncated" };
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "\0" || typeflag === "0") {
      if (files.has(path)) {
        return {
          ok: false,
          error: `bundle archive contains duplicate file ${path}`,
        };
      }
      files.add(path);
    } else if (typeflag === "5") {
      // Directory entry.
    } else {
      return {
        ok: false,
        error: "bundle archive contains an unsupported entry type",
      };
    }

    offset = paddedEnd;
  }

  if (zeroBlocks < 2) {
    return { ok: false, error: "bundle archive is missing tar terminator" };
  }
  if (files.size === 0) {
    return { ok: false, error: "bundle archive contains no files" };
  }

  return { ok: true, files };
}

export function isZeroBlock(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

export function tarHeaderPath(header: Uint8Array): string | null {
  const name = tarHeaderString(header.subarray(0, 100));
  const prefix = tarHeaderString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  return path || null;
}

export function tarHeaderString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return textDecoder.decode(bytes.subarray(0, end)).trim();
}

export function tarHeaderSize(header: Uint8Array): number | null {
  const raw = tarHeaderString(header.subarray(124, 136)).replace(/\0/g, "");
  if (!/^[0-7]*$/.test(raw)) return null;
  const size = raw ? Number.parseInt(raw, 8) : 0;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function hasValidTarHeaderChecksum(header: Uint8Array): boolean {
  const expected = tarHeaderChecksumValue(header);
  return expected !== null && expected === tarHeaderChecksum(header);
}

export function tarHeaderChecksumValue(header: Uint8Array): number | null {
  const raw = tarHeaderString(header.subarray(148, 156)).replace(/\0/g, "");
  if (!/^[0-7]+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function tarHeaderChecksum(header: Uint8Array): number {
  return header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );
}

export function isSafeBundleArchivePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function requiredBundlePaths(meta: ImageBuildBundleMeta): string[] {
  return [
    "base-images.hcl",
    "build-tools.hcl",
    ...(meta.courseCatalog ? ["courses.hcl"] : []),
    ...meta.scenarios.map(
      (scenario) => `scenarios/${scenario.scenarioId}/scenario.hcl`,
    ),
  ];
}
