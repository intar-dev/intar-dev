import { drizzle } from "drizzle-orm/d1";
import {
  type CourseCatalogSnapshotV2,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type { CourseCatalogSnapshotV2 as CourseCatalogSnapshotV2Wire } from "@/generated/catalog";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
} from "@/lib/build-scheduler";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import {
  syncCourseCatalogSnapshot,
  validateCourseCatalogReferences,
} from "@/lib/course-catalogs";
import { tryReconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import { stageReusableCandidateManifests } from "@/lib/scenario-catalog-candidates";
import {
  jsonResponse,
  bundleObjectKey,
  hasRegistryPublishToken,
  isRecord,
  readString,
  isSafeBundleRev,
  normalizeSha256,
  isImageArchitecture,
  isPositiveU32,
  isScenarioDifficulty,
} from "./shared";

type ParsedBundleMeta = ImageBuildBundleMeta & {
  courseCatalog: CourseCatalogSnapshotV2;
};

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
  const invalidScenarioIds = await validateCourseCatalogReferences(
    db,
    {
      snapshot: courseCatalog,
      bundleScenarioIds: meta.value.bundleMeta.scenarios.map(
        (scenario) => scenario.scenarioId,
      ),
      organizationId: null,
    },
  );
  if (invalidScenarioIds.length) {
    return jsonResponse(
      {
        error: "course catalog references unavailable scenarios",
        scenario_ids: invalidScenarioIds,
      },
      400,
    );
  }

  const objectKey = bundleObjectKey(meta.value.rev);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(objectKey, payload, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      rev: meta.value.rev,
    },
  });

  const now = Date.now();
  const queued = await queueImageBuildsFromBundle(db, {
    rev: meta.value.rev,
    r2Key: objectKey,
    meta: meta.value.bundleMeta,
    nowUnixMs: now,
  });
  await syncCourseCatalogSnapshot(db, {
    snapshot: courseCatalog,
    sourceRevision: meta.value.rev,
    organizationId: null,
    nowUnixMs: now,
  });
  const assigned = await assignQueuedImageBuilds(db, now);
  if (queued.queued < meta.value.bundleMeta.scenarios.length) {
    await stageReusableCandidateManifests(db, {
      revision: meta.value.rev,
      organizationId: null,
      meta: meta.value.bundleMeta,
      nowUnixMs: now,
      wakeHost: (hostId) =>
        tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
    });
  }
  // Run this after the bundle/course/build pipeline has committed whenever at
  // least one accepted image has no new publication event ahead of it. This is
  // the key path for unchanged bundles (queued=0) and hosts added since the
  // original publication, without duplicating fan-out for all-new builds.
  if (
    queued.queued < meta.value.bundleMeta.scenarios.length &&
    meta.value.bundleMeta.catalogChannel !== "candidate"
  ) {
    await tryReconcileScenarioImagesForPublicationScope(db, {
      publicationOrganizationId: null,
      nowUnixMs: now,
      reason: "public_bundle_accepted_without_full_rebuild",
      wakeHostRuntime: (hostId) =>
        tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
    });
  }

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
        bundleMeta: ParsedBundleMeta;
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

  if (
    Object.hasOwn(parsed, "kino_version") ||
    Object.hasOwn(parsed, "kinoVersion")
  ) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "kino_version is no longer supported" },
        400,
      ),
    };
  }

  const rev = readString(parsed.rev);
  if (!rev || !isSafeBundleRev(rev)) {
    return { ok: false, response: jsonResponse({ error: "invalid rev" }, 400) };
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
  const catalogChannel =
    readString(parsed.catalog_channel) ??
    readString(parsed.catalogChannel) ??
    "candidate";
  if (catalogChannel !== "candidate" && catalogChannel !== "live") {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid catalog_channel" }, 400),
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

  let courseCatalog: CourseCatalogSnapshotV2 | undefined;
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
  if (!courseCatalog) {
    return {
      ok: false,
      response: jsonResponse({ error: "meta.course_catalog is required" }, 400),
    };
  }
  const linkedScenarioIds = new Set(
    courseCatalog.courses.flatMap((course) =>
      course.lectures.flatMap((lecture) =>
        lecture.scenarioId ? [lecture.scenarioId] : [],
      ),
    ),
  );
  if (
    scenarios.some((scenario) => !linkedScenarioIds.has(scenario.scenarioId))
  ) {
    return {
      ok: false,
      response: jsonResponse(
        {
          error: "meta.scenarios contains a scenario without a linked lecture",
        },
        400,
      ),
    };
  }

  const bundleMeta: ParsedBundleMeta = {
    ...parsed,
    buildFormatVersion,
    catalogChannel,
    scenarios,
    courseCatalog,
  };
  delete bundleMeta.course_catalog;

  return {
    ok: true,
    value: {
      rev,
      bundleMeta,
    },
  };
}

export function normalizeCourseCatalogSnapshot(
  value: unknown,
): CourseCatalogSnapshotV2 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "courses"]) ||
    value.version !== 2 ||
    !Array.isArray(value.courses)
  ) {
    return null;
  }
  const wire = value as unknown as CourseCatalogSnapshotV2Wire;

  const courseIds = new Set<string>();
  const scenarioIds = new Set<string>();
  const courses: CourseCatalogSnapshotV2["courses"] = [];
  for (const valueCourse of wire.courses) {
    if (
      !isRecord(valueCourse) ||
      !hasExactKeys(valueCourse, [
        "course_id",
        "title",
        "summary",
        "body_markdown",
        "sequential",
        "lectures",
      ]) ||
      !Array.isArray(valueCourse.lectures) ||
      valueCourse.lectures.length === 0
    ) {
      return null;
    }

    const courseId = readUntrimmedString(valueCourse.course_id);
    const title = readString(valueCourse.title);
    const summary = readString(valueCourse.summary);
    const bodyMarkdown = readNonEmptyString(valueCourse.body_markdown);
    if (
      !courseId ||
      !isSafeBundleRev(courseId) ||
      !title ||
      !summary ||
      !bodyMarkdown ||
      typeof valueCourse.sequential !== "boolean" ||
      courseIds.has(courseId)
    ) {
      return null;
    }

    const lectureIds = new Set<string>();
    const lectures: CourseCatalogSnapshotV2["courses"][number]["lectures"] = [];
    for (const valueLecture of valueCourse.lectures) {
      const lecture = normalizeCourseCatalogLecture(
        valueLecture,
        lectureIds,
        scenarioIds,
      );
      if (!lecture) return null;
      lectures.push(lecture);
    }

    courseIds.add(courseId);
    courses.push({
      courseId,
      title,
      summary,
      bodyMarkdown,
      sequential: valueCourse.sequential,
      lectures,
    });
  }

  return { version: 2, courses };
}

function normalizeCourseCatalogLecture(
  value: CourseCatalogSnapshotV2Wire["courses"][number]["lectures"][number],
  lectureIds: Set<string>,
  scenarioIds: Set<string>,
): CourseCatalogSnapshotV2["courses"][number]["lectures"][number] | null {
  if (!isRecord(value)) return null;

  const requiredKeys = [
    "lecture_id",
    "title",
    "summary",
    "body_markdown",
    "category",
    "tags",
    "estimated_minutes",
  ];
  if (Object.hasOwn(value, "difficulty")) requiredKeys.push("difficulty");
  if (Object.hasOwn(value, "scenario_id")) requiredKeys.push("scenario_id");
  if (!hasExactKeys(value, requiredKeys)) return null;

  const lectureId = readUntrimmedString(value.lecture_id);
  const title = readString(value.title);
  const summary = readString(value.summary);
  const bodyMarkdown = readNonEmptyString(value.body_markdown);
  const category = readString(value.category);
  const tags = normalizeCourseCatalogTags(value.tags);
  const estimatedMinutes = value.estimated_minutes;
  if (
    !lectureId ||
    !isSafeBundleRev(lectureId) ||
    !title ||
    !summary ||
    !bodyMarkdown ||
    !category ||
    !tags ||
    typeof estimatedMinutes !== "number" ||
    !isPositiveU32(estimatedMinutes) ||
    lectureIds.has(lectureId)
  ) {
    return null;
  }

  let difficulty:
    | CourseCatalogSnapshotV2["courses"][number]["lectures"][number]["difficulty"]
    | undefined;
  if (Object.hasOwn(value, "difficulty")) {
    if (!isCourseCatalogDifficulty(value.difficulty)) return null;
    difficulty = value.difficulty;
  }

  let scenarioId: string | undefined;
  if (Object.hasOwn(value, "scenario_id")) {
    scenarioId = readUntrimmedString(value.scenario_id) ?? undefined;
    if (
      !scenarioId ||
      !isSafeBundleRev(scenarioId) ||
      scenarioIds.has(scenarioId)
    ) {
      return null;
    }
    if (!difficulty) return null;
  }

  lectureIds.add(lectureId);
  if (scenarioId) scenarioIds.add(scenarioId);
  return {
    lectureId,
    title,
    summary,
    bodyMarkdown,
    category,
    tags,
    estimatedMinutes,
    ...(difficulty ? { difficulty } : {}),
    ...(scenarioId ? { scenarioId } : {}),
  };
}

function normalizeCourseCatalogTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const valueTag of value) {
    const tag = readString(valueTag);
    if (!tag || seen.has(tag)) return null;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function isCourseCatalogDifficulty(
  value: unknown,
): value is NonNullable<
  CourseCatalogSnapshotV2["courses"][number]["lectures"][number]["difficulty"]
> {
  return isScenarioDifficulty(value);
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
  { ok: true; files: Set<string> } | { ok: false; error: string };

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
    ...(meta.scenarios.length ? ["base-images.hcl"] : []),
    ...(meta.courseCatalog
      ? [
          "curriculum/catalog.json",
          ...meta.courseCatalog.courses.flatMap((course) => [
            `curriculum/${course.courseId}/course.md`,
            ...course.lectures.map(
              (lecture) =>
                `curriculum/${course.courseId}/${lecture.lectureId}/lecture.md`,
            ),
          ]),
        ]
      : []),
    ...meta.scenarios.map(
      (scenario) => `scenarios/${scenario.scenarioId}/scenario.hcl`,
    ),
  ];
}
