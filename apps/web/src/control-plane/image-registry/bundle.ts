import { drizzle } from "drizzle-orm/d1";
import {
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import type { CourseCatalogSnapshotV2 as CourseCatalogSnapshotV2Wire } from "@/generated/catalog";
import { appError, toErrorResponse } from "@/lib/app-error";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { mintInstallationToken, readRepository } from "@/lib/github-app";
import { verifyGithubActionsToken } from "@/lib/github-oidc";
import { canonicalApplicationOrigin } from "@/lib/request-security";
import {
  acceptScenarioSourceUpload,
  loadPushScenarioSource,
  scenarioSourceScope,
  sourceRefusal,
} from "@/lib/scenario-sources";
import {
  jsonResponse,
  isRecord,
  readString,
  isSafeBundleRev,
  SHA256_HEX_RE,
  isPositiveU32,
  isScenarioDifficulty,
} from "./shared";

/**
 * The push producer: a GitHub Actions OIDC token from the pinned reusable
 * workflow, for a push-mode binding whose default-branch head, re-read through
 * the App, is the token's commit. It then runs the shared request half.
 */
export async function handleSourceBundleUpload(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (!token) throw appError(401, "unauthorized", "unauthorized");
    const claims = await verifyGithubActionsToken(token, {
      audience: canonicalApplicationOrigin(env),
      workflowShas: env.SCENARIO_PUBLISH_WORKFLOW_SHAS,
    });
    const binding = await loadPushScenarioSource(
      drizzle(env.DB),
      claims.repositoryId,
    );
    if (!binding) {
      throw sourceRefusal(
        409,
        "binding_inactive",
        "No active push-mode scenario source is connected to this repository.",
      );
    }
    const observedAt = Date.now();
    const mint = await mintInstallationToken(env, {
      installationId: binding.githubInstallationId,
      fullName: binding.githubRepository,
      repositoryId: binding.githubRepositoryId,
    }).catch(() => ({ status: "transient" }) as const);
    if (mint.status === "gone" || mint.status === "suspended") {
      throw sourceRefusal(
        409,
        "binding_inactive",
        "The Intar GitHub App can no longer read this repository.",
      );
    }
    const head = mint.status === "ok" ? await readRepository(mint.token) : null;
    if (!head) {
      throw appError(503, "github_unavailable", "GitHub could not be read. Try again.");
    }
    if (
      claims.ref !== `refs/heads/${head.defaultBranch}` ||
      claims.sha !== head.headSha
    ) {
      throw sourceRefusal(
        409,
        "superseded",
        "This commit is no longer the head of the default branch.",
      );
    }
    return await acceptScenarioSourceUpload(request, env, {
      scope: scenarioSourceScope(binding.organizationId),
      repositoryId: binding.githubRepositoryId,
      sha: claims.sha,
      purpose: "deploy",
      claim: { via: "push", headSha: head.headSha, observedAt },
    });
  } catch (error) {
    const refusal = toErrorResponse(error, "scenario source upload failed");
    return jsonResponse(refusal.body, refusal.status);
  }
}

/**
 * The public compiler descriptor the reusable workflow reads: the CLI release,
 * its sha256 per target, and the v2 source compile digest. 503 until the
 * release is configured.
 */
export async function handleSourceCompilerDescriptor(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }
  const digest = await sourceCompileDigest();
  const version = env.SCENARIO_COMPILER_CLI_VERSION ?? "";
  let sha256: unknown = null;
  try {
    sha256 = JSON.parse(env.SCENARIO_COMPILER_CLI_SHA256 || "null");
  } catch {
    // An unreadable value is unconfigured.
  }
  if (
    !digest ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    !isRecord(sha256) ||
    !Object.keys(sha256).length ||
    !Object.values(sha256).every(
      (value) => typeof value === "string" && SHA256_HEX_RE.test(value),
    )
  ) {
    return jsonResponse({ error: "the scenario compiler is not configured" }, 503);
  }
  return jsonResponse({ cli_version: version, sha256, digest });
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
