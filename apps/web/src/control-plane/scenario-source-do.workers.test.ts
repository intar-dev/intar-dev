/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import { GITHUB_WEBHOOK_PATH, handleGitHubWebhook } from "@/control-plane/github-webhook";
import type { ScenarioSourceDO } from "@/control-plane/scenario-source-do";
import { sweepScenarioSources } from "@/control-plane/scenario-source-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { normalizeCourseCatalogSnapshot } from "@/control-plane/image-registry/bundle";
import { sha256Hex } from "@/control-plane/image-registry/shared";
import {
  agentBootstrapTokens,
  agentHosts,
  courseCatalogs,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  runtimeOperationGates,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  scenarioRuns,
  scenarioSourceCommits,
  scenarioSources,
  user,
  vmScenarioProbes,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5, ScenarioProbeManifestV3 } from "@/generated/catalog";
import type { HostStateReportV2 } from "@/generated/bridge";
import {
  AGENT_SOURCES_PATH,
  SOURCE_BUNDLE_FIELD,
  SOURCE_COMPILER_VERSION,
  SOURCE_META_FIELD,
} from "@/generated/constants";
import hostReportFixture from "@/generated/fixtures/bridge/host-state-report-v2.json";
import { maintainHostBuildAssignments, queueImageBuildsFromBundle } from "@/lib/build-scheduler";
import { BUILDER_REASSIGN_AFTER_MS } from "@/lib/build-scheduler-core";
import { IMAGE_BUILD_FORMAT_VERSION, platformCompileDigest } from "@/lib/image-build-format";
import { setRegistryPause } from "@/lib/image-registry-admission";
import { IMAGE_CUTOVER_GATE, PROMOTION_HOLD_GATE } from "@/lib/run-admission-gate";
import {
  advanceImagePromotion,
  releaseImagePromotion,
  startImagePromotion,
  type PromotionAttempt,
} from "./image-promotion";
import { createCleanupServiceDouble } from "./image-registry/cleanup-service-double";
import { enableRegistryDeletion } from "./image-registry/registry-artifact-fixtures";
import {
  countUnitGuardRuns,
  loadScenarioSource,
  publicSourceRevPromotable,
  scenarioSourceScope,
  stagedSourceObjectPrefix,
} from "@/lib/scenario-sources";
import { buildTar, gzipBytes } from "@/lib/tar";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const stageLock = vi.hoisted(() => ({
  locked: false,
  before: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@/lib/scenario-catalog-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scenario-catalog-candidates")>();
  return {
    ...actual,
    stageReusableCandidateManifests: async (
      ...args: Parameters<typeof actual.stageReusableCandidateManifests>
    ) => {
      await stageLock.before?.();
      if (stageLock.locked) {
        const { appError } = await import("@/lib/app-error");
        throw appError(409, "candidate_source_locked", "locked");
      }
      return actual.stageReusableCandidateManifests(...args);
    },
  };
});

// Warm host caches and a stable guest-tools pin need a platform host and R2
// objects this suite has no use for; revisionReady has its own tests. `ready`
// answers per call, so a test can drain on a ready revision and then withhold.
const readiness = vi.hoisted(() => ({
  calls: 0,
  ready: ((_call: number) => true) as (call: number) => boolean,
}));
vi.mock("@/control-plane/image-registry/build-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/control-plane/image-registry/build-status")>();
  return {
    ...actual,
    loadRevisionStatus: async () => {
      readiness.calls += 1;
      const ready = readiness.ready(readiness.calls);
      return {
        ok: true as const,
        body: { ok: ready, state: ready ? "ready" : "warming", builds: [], hosts: [] },
      };
    },
    revisionReady: (body: { ok: boolean }) => body.ok,
  };
});

// Hooks around the promotion core and the unit guard.
const promotion = vi.hoisted(() => ({
  calls: 0,
  before: undefined as (() => Promise<void>) | undefined,
  after: undefined as ((result: unknown) => unknown) | undefined,
}));
vi.mock("@/control-plane/image-registry/catalog-promotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/control-plane/image-registry/catalog-promotion")>();
  return {
    ...actual,
    promoteCandidateRevision: async (
      ...args: Parameters<typeof actual.promoteCandidateRevision>
    ) => {
      promotion.calls += 1;
      await promotion.before?.();
      const result = await actual.promoteCandidateRevision(...args);
      return promotion.after ? await promotion.after(result) : result;
    },
  };
});
const guard = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  beforeLive: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@/lib/scenario-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scenario-sources")>();
  return {
    ...actual,
    countUnitGuardRuns: async (...args: Parameters<typeof actual.countUnitGuardRuns>) => {
      await guard.before?.();
      return actual.countUnitGuardRuns(...args);
    },
    recordPublicSourceLive: async (...args: Parameters<typeof actual.recordPublicSourceLive>) => {
      await guard.beforeLive?.();
      return actual.recordPublicSourceLive(...args);
    },
  };
});

const ORG = "org-a";
const SCOPE = `organization:${ORG}`;
const OWNER = "owner";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

let appEnv: Record<string, string>;
let scopeKey: string;
let digest: string;
let headSha: string;
let githubCalls: string[];
let githubRequests: Array<{ url: string; authorization: string | null }>;

const rev = (sha: string, at = digest) => `git-42-${sha}-${at}`;
const prefix = (sha: string, at = digest) =>
  stagedSourceObjectPrefix(scopeKey, rev(sha, at), "deploy");
const db = () => drizzle(env.DB);

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  appEnv = {
    GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
  };
  const computed = await platformCompileDigest(env.PLATFORM_BASE_IMAGES_SHA256);
  if (!computed) throw new Error("the test digest is unset");
  digest = computed;
});

beforeEach(async () => {
  await resetD1Database();
  stageLock.locked = false;
  stageLock.before = undefined;
  readiness.calls = 0;
  readiness.ready = () => true;
  promotion.calls = 0;
  promotion.before = undefined;
  promotion.after = undefined;
  guard.before = undefined;
  guard.beforeLive = undefined;
  scopeKey = SCOPE;
  headSha = SHA_A;
  githubCalls = [];
  githubRequests = [];
  await createFixtureMember({ d1: env.DB, userId: OWNER });
  await db().insert(organization).values({ id: ORG, name: "Acme", slug: "acme", createdAt: new Date() });
  await db().insert(member).values({
    id: "owner-member",
    organizationId: ORG,
    userId: OWNER,
    role: "owner",
    createdAt: new Date(),
  });
  await db().insert(scenarioSources).values({
    scopeKey: SCOPE,
    organizationId: ORG,
    githubInstallationId: 7,
    githubRepositoryId: 42,
    githubRepository: "acme/labs",
    defaultBranch: "main",
    mode: "push",
    boundByUserId: OWNER,
  });
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: "builds/" });
  if (listed.objects.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(listed.objects.map((object) => object.key));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Route = (request: Request) => Response | Promise<Response>;

/** GitHub for `acme/labs` (id 42) under installation 7, head `headSha`. */
function github(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    "POST /app/installations/7/access_tokens": () =>
      Response.json({ token: "ghs_test" }, { status: 201 }),
    "GET /installation/repositories": () =>
      Response.json({
        repositories: [{ id: 42, full_name: "acme/labs", default_branch: "main" }],
      }),
    "GET /repos/acme/labs/git/ref/heads/main": () =>
      Response.json({ object: { sha: headSha } }),
    ...checkRunRoutes("acme/other"),
    ...checkRunRoutes(),
    ...overrides,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    githubCalls.push(key);
    githubRequests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return (await routes[key]?.(request)) ?? new Response(null, { status: 404 });
  });
}

interface CheckRunCall {
  call: string;
  body: {
    name?: string;
    head_sha?: string;
    status: string;
    conclusion?: string;
    output: { title: string; summary: string };
  };
}

let checkRuns: CheckRunCall[];

/** GitHub's check-run API for `repository`; created runs get ids 901, 902, ... */
function checkRunRoutes(repository = "acme/labs"): Record<string, Route> {
  checkRuns = [];
  const record = async (call: string, request: Request) => {
    checkRuns.push({ call, body: (await request.json()) as CheckRunCall["body"] });
  };
  const routes: Record<string, Route> = {
    [`POST /repos/${repository}/check-runs`]: async (request) => {
      await record("POST", request);
      const created = checkRuns.filter((entry) => entry.call === "POST").length;
      return Response.json({ id: 900 + created }, { status: 201 });
    },
  };
  for (const id of [901, 902, 903]) {
    routes[`PATCH /repos/${repository}/check-runs/${id}`] = async (request) => {
      await record(`PATCH ${id}`, request);
      return Response.json({ id });
    };
  }
  return routes;
}

/** Each check-run call as its target, status, conclusion and title. */
const shownChecks = () =>
  checkRuns.map(({ call, body }) => ({
    call,
    status: body.status,
    conclusion: body.conclusion,
    title: body.output.title,
  }));

async function checkRunId(sha: string) {
  const [row] = await db()
    .select({ checkRunId: scenarioSourceCommits.checkRunId })
    .from(scenarioSourceCommits)
    .where(eq(scenarioSourceCommits.rev, rev(sha)));
  return row?.checkRunId;
}

/** Runs one alarm; answers the re-arm time it left, if any. */
async function tick(overrides: Record<string, unknown> = {}): Promise<number | null> {
  const values: Record<string | symbol, unknown> = { ...appEnv, ...overrides };
  const doEnv = new Proxy(env, {
    get: (target, key) => (Object.hasOwn(values, key) ? values[key] : Reflect.get(target, key)),
  });
  const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(scopeKey));
  return runInDurableObject(stub, async (instance: ScenarioSourceDO, state) => {
    Object.defineProperty(instance, "env", { configurable: true, value: doEnv });
    await state.storage.put("scope", scopeKey);
    await instance.alarm();
    const next = await state.storage.getAlarm();
    await state.storage.deleteAlarm();
    return next;
  });
}

function catalog(scenarioIds: string[], title = "Lecture") {
  return {
    version: 2,
    courses: [
      {
        course_id: "course-1",
        title: "Course",
        summary: "Summary",
        body_markdown: "Body",
        sequential: false,
        lectures: scenarioIds.length
          ? scenarioIds.map((id, index) => ({
              lecture_id: `lecture-${index}`,
              title,
              summary: "Summary",
              body_markdown: "Body",
              category: "linux",
              tags: ["linux"],
              estimated_minutes: 5,
              difficulty: "easy",
              scenario_id: id,
            }))
          : [
              {
                lecture_id: "lecture-0",
                title: "Lecture",
                summary: "Summary",
                body_markdown: "Body",
                category: "linux",
                tags: ["linux"],
                estimated_minutes: 5,
              },
            ],
      },
    ],
  };
}

interface Commit {
  sha?: string;
  digest?: string;
  scenarioIds?: string[];
  /** The scenarios the catalog links, when not exactly the bundled ones. */
  catalogIds?: string[];
  hash?: string;
  scope?: string;
  title?: string;
  meta?: Record<string, unknown>;
  archiveCatalog?: unknown;
  extraFiles?: Array<[string, Uint8Array]>;
}

/** A compiled commit's meta and bundle, as the producers send them. */
async function compiled(commit: Commit = {}) {
  const sha = commit.sha ?? SHA_A;
  const at = commit.digest ?? digest;
  const scenarioIds = commit.scenarioIds ?? ["acme-web"];
  const courseCatalog = catalog(commit.catalogIds ?? scenarioIds, commit.title);
  const meta = {
    rev: rev(sha, at),
    build_format_version: IMAGE_BUILD_FORMAT_VERSION,
    catalog_channel: "candidate",
    scenarios: scenarioIds.map((id) => ({
      scenario_id: id,
      arch: "x86_64",
      content_hash: commit.hash ?? HASH_A,
    })),
    course_catalog: courseCatalog,
    source: {
      scope: commit.scope ?? "acme",
      courses_root: "courses",
      compiler_version: SOURCE_COMPILER_VERSION,
    },
    ...commit.meta,
  };
  const text = (value: string) => new TextEncoder().encode(value);
  const files: Array<[string, Uint8Array]> = [
    ...(scenarioIds.length ? [["base-images.hcl", text("base_image {}\n")] as [string, Uint8Array]] : []),
    ["curriculum/catalog.json", text(JSON.stringify(commit.archiveCatalog ?? courseCatalog))],
    ["curriculum/course-1/course.md", text("# Course\n")],
    ...courseCatalog.courses[0]!.lectures.map(
      (lecture): [string, Uint8Array] => [
        `curriculum/course-1/${lecture.lecture_id}/lecture.md`,
        text("# Lecture\n"),
      ],
    ),
    ...scenarioIds.map((id): [string, Uint8Array] => [
      `scenarios/${id}/scenario.hcl`,
      text(`scenario "${id}" {}\n`),
    ]),
    ...(commit.extraFiles ?? []),
  ];
  const bundle = await gzipBytes(buildTar(files.map(([path, bytes]) => ({ path, bytes }))));
  return { meta, bundle };
}

/** A compiled commit, staged as the producers stage it. */
async function stage(commit: Commit = {}): Promise<void> {
  const sha = commit.sha ?? SHA_A;
  const at = commit.digest ?? digest;
  const { meta, bundle } = await compiled(commit);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`${prefix(sha, at)}meta.json`, JSON.stringify(meta));
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`${prefix(sha, at)}bundle.tar.gz`, bundle);
}

async function insertCommit(
  sha: string,
  state: typeof scenarioSourceCommits.$inferInsert.state,
  values: Partial<typeof scenarioSourceCommits.$inferInsert> = {},
) {
  await db()
    .insert(scenarioSourceCommits)
    .values({
      id: `commit-${sha[0]}`,
      scopeKey,
      purpose: "deploy",
      sha,
      rev: rev(sha),
      via: "push",
      state,
      ...values,
    });
}

async function commitState(sha: string, at = digest) {
  const [row] = await db()
    .select({ state: scenarioSourceCommits.state, detail: scenarioSourceCommits.detail })
    .from(scenarioSourceCommits)
    .where(eq(scenarioSourceCommits.rev, rev(sha, at)));
  return row;
}

async function binding() {
  const [row] = await db().select().from(scenarioSources).where(eq(scenarioSources.scopeKey, scopeKey));
  return row!;
}

async function stagedKeys(sha: string) {
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: prefix(sha) });
  return listed.objects.map((object) => object.key);
}

describe("ScenarioSourceDO maintenance", () => {
  it("deletes its alarm and writes nothing, and fetch answers 503", async () => {
    const databaseAccess = vi.fn(() => {
      throw new Error("maintenance touched D1");
    });
    const fenced = new Proxy(env, {
      get: (target, key) =>
        key === "CONTROL_PLANE_MAINTENANCE"
          ? "on"
          : key === "DB"
            ? new Proxy({}, { get: databaseAccess })
            : Reflect.get(target, key),
    });
    const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(SCOPE));
    await runInDurableObject(stub, async (instance: ScenarioSourceDO, state) => {
      Object.defineProperty(instance, "env", { configurable: true, value: fenced });
      await state.storage.put("scope", SCOPE);
      await state.storage.setAlarm(Date.now() + 60_000);
      const response = await instance.fetch(
        new Request(`https://scenario-source/poke?scope=${SCOPE}`, { method: "POST" }),
      );
      expect(response.status).toBe(503);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(databaseAccess).not.toHaveBeenCalled();
  });

  it("arms an alarm for its own scope only", async () => {
    const scope = "organization:unbound";
    const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(scope));
    const poke = (target: string) =>
      stub.fetch(`https://scenario-source/poke?scope=${encodeURIComponent(target)}`, { method: "POST" });
    expect((await poke("public")).status).toBe(404);
    expect((await poke(scope)).status).toBe(204);
    await runInDurableObject(stub, async (_instance: ScenarioSourceDO, state) => {
      expect(await state.storage.get("scope")).toBe(scope);
      await state.storage.deleteAlarm();
    });
  });
});

describe("ScenarioSourceDO ingest", () => {
  it("ingests the staged commit into building without reading the flag", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    const flags = new Proxy({}, {
      get: () => {
        throw new Error("Flagship is down");
      },
    });

    expect(await tick({ FLAGS: flags })).toBeNull();

    expect(await commitState(SHA_A)).toEqual({ state: "building", detail: null });
    expect(await binding()).toMatchObject({ headSha: SHA_A, targetRev: rev(SHA_A) });
    const [bundle] = await db().select().from(imageBuildBundles);
    expect(bundle).toMatchObject({ rev: rev(SHA_A), organizationId: ORG });
    expect(
      await db()
        .select({ organizationId: imageBuilds.organizationId, status: imageBuilds.status })
        .from(imageBuilds),
    )
      .toEqual([{ organizationId: ORG, status: "queued" }]);
    // Candidate-only: no catalog is applied before promotion.
    expect(await db().select().from(courseCatalogs)).toEqual([]);
    expect(await stagedKeys(SHA_A)).toEqual([]);
  });

  it.each<[string, Commit]>([
    ["a meta over 1.5 MB", { meta: { padding: "x".repeat(1_500_000) } }],
    ["a scope other than the binding label", { scope: "other" }],
    ["an id in another organization's namespace", { scenarioIds: ["acme-labs-web"] }],
    ["a public-namespace id", { scenarioIds: ["web"] }],
    ["the workshop- prefix", { scenarioIds: ["workshop-web"] }],
    ["a catalog that differs from the archive", { archiveCatalog: catalog(["acme-other"]) }],
    ["more than 100 scenarios", { scenarioIds: Array.from({ length: 101 }, (_, index) => `acme-${index}`) }],
    [
      "a bundle over 4 MiB expanded",
      { extraFiles: [["scenarios/acme-web/big.bin", new Uint8Array(4 * 1024 * 1024)]] },
    ],
  ])("sets invalid before any write for %s", async (_name, commit) => {
    github();
    await db()
      .insert(organization)
      .values({ id: "org-b", name: "Acme Labs", slug: "acme-labs", createdAt: new Date() });
    await stage(commit);
    await insertCommit(SHA_A, "ingesting");

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "invalid", detail: expect.any(String) });
    expect(await db().select().from(imageBuildBundles)).toEqual([]);
    expect(await db().select().from(imageBuilds)).toEqual([]);
    expect(await stagedKeys(SHA_A)).toEqual([]);
  });

  it("grandfathers ids the scope already owns and takes a theory-only commit", async () => {
    github();
    await env.DB.prepare(
      `INSERT INTO vm_scenarios (scenario_id, organization_id, title, description, difficulty,
         estimated_minutes, tags_json, briefing_markdown, solution_markdown, hints_json)
       VALUES ('legacy-web', ?1, 'Legacy', '', 'easy', 5, '[]', '', '', '[]')`,
    ).bind(ORG).run();
    await stage({ scenarioIds: ["legacy-web"] });
    await insertCommit(SHA_A, "ingesting");
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });

    headSha = SHA_B;
    await stage({ sha: SHA_B, scenarioIds: [] });
    await insertCommit(SHA_B, "ingesting");
    await tick();
    // With no builds to wait for, it is promoted in the same alarm.
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
  });

  it("supersedes a row whose staged objects are gone and refuses a rev another scope owns", async () => {
    github();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });

    await db().update(scenarioSourceCommits).set({ state: "ingesting", attempt: 1 });
    await db().insert(imageBuildBundles).values({
      rev: rev(SHA_A),
      organizationId: null,
      r2Key: "builds/bundles/x.tar.gz",
      metaJson: { buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION, scenarios: [] },
    });
    await stage();
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({
      state: "invalid",
      detail: expect.stringContaining("rev_scope_conflict"),
    });
    expect(await stagedKeys(SHA_A)).toEqual([]);
  });

  it("re-runs from the stored bundle without its staged objects", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    await db().update(scenarioSourceCommits).set({ state: "ingesting", attempt: 1 });
    await db().update(imageBuilds).set({ status: "failed" });

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    expect(await db().select({ status: imageBuilds.status }).from(imageBuilds)).toEqual([{ status: "queued" }]);
  });

  it("does not count a refused writer or a locked candidate source", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await setRegistryPause(env, { paused: true });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await tick()).not.toBeNull();
    }
    await setRegistryPause(env, { paused: false });

    // A reused build makes ingest stage its candidate, which the lock refuses.
    await queueImageBuildsFromBundle(db(), {
      rev: "token-rev",
      r2Key: "builds/bundles/token-rev.tar.gz",
      meta: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "candidate",
        scenarios: [{ scenarioId: "acme-web", arch: "x86_64", contentHash: HASH_A }],
      },
      organizationId: ORG,
      nowUnixMs: Date.now(),
    });
    stageLock.locked = true;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await tick()).not.toBeNull();
    }
    expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });
    const writers = await env.DB.prepare("SELECT id FROM image_registry_operation_writers").all();
    expect(writers.results).toEqual([]);

    stageLock.locked = false;
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
  });

  it("refuses a meta with more than 100 scenario builds, even under 100 ids", async () => {
    github();
    const scenarioIds = Array.from({ length: 51 }, (_, index) => `acme-s${index}`);
    await deliver({
      sha: SHA_A,
      scenarioIds,
      meta: {
        scenarios: scenarioIds.flatMap((id, index) => [
          { scenario_id: id, arch: "x86_64", content_hash: (2 * index + 1).toString(16).padStart(64, "0") },
          { scenario_id: id, arch: "aarch64", content_hash: (2 * index + 2).toString(16).padStart(64, "0") },
        ]),
      },
    });

    expect(await commitState(SHA_A)).toEqual({
      state: "invalid",
      detail: "102 scenario builds exceed the limit of 100",
    });
  });

  it("fails after three tries that throw", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    const bucket = new Proxy(env.VM_IMAGE_REGISTRY_BUCKET, {
      get: (target, key) =>
        key === "put"
          ? () => Promise.reject(new Error("R2 is down"))
          : Reflect.get(target, key).bind(target),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await tick({ VM_IMAGE_REGISTRY_BUCKET: bucket })).not.toBeNull();
      expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });
    }
    await tick({ VM_IMAGE_REGISTRY_BUCKET: bucket });
    expect(await commitState(SHA_A)).toEqual({ state: "failed", detail: "ingest did not finish" });
    expect(await stagedKeys(SHA_A)).toEqual([]);
  });

  it("keeps a push claim that lands during the GitHub read", async () => {
    await stage({ sha: SHA_B });
    await insertCommit(SHA_A, "ingesting");
    // The claim moves the head after the DO's read began; observe's older
    // read must not move it back.
    github({
      "GET /repos/acme/labs/git/ref/heads/main": async () => {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE scenario_sources SET head_sha = ?1, head_observed_at = ?2",
          ).bind(SHA_B, Date.now() + 60_000),
          env.DB.prepare(
            `INSERT INTO scenario_source_commits (id, scope_key, purpose, sha, rev, via, state)
             VALUES ('commit-b', ?1, 'deploy', ?2, ?3, 'push', 'ingesting')`,
          ).bind(SCOPE, SHA_B, rev(SHA_B)),
        ]);
        return Response.json({ object: { sha: SHA_A } });
      },
    });
    await tick();

    expect((await binding()).headSha).toBe(SHA_B);
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
  });

  it("does not finish an ingest whose rev stopped being the head during the write", async () => {
    github();
    await stage();
    await stage({ sha: SHA_B });
    await insertCommit(SHA_A, "ingesting");
    let claimed = false;
    const bucket = new Proxy(env.VM_IMAGE_REGISTRY_BUCKET, {
      get: (target, key) =>
        key === "put"
          ? async (...args: Parameters<R2Bucket["put"]>) => {
              if (!claimed) {
                claimed = true;
                headSha = SHA_B;
                await db().update(scenarioSources).set({ headSha: SHA_B, headObservedAt: Date.now() });
                await insertCommit(SHA_B, "ingesting");
              }
              return target.put(...args);
            }
          : Reflect.get(target, key).bind(target),
    });
    await tick({ VM_IMAGE_REGISTRY_BUCKET: bucket });

    expect(claimed).toBe(true);
    expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });
    expect((await binding()).targetRev).toBeNull();

    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    expect((await binding()).targetRev).toBe(rev(SHA_B));
  });
});

describe("ScenarioSourceDO fail and heal", () => {
  async function building() {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
  }

  it("heals out-of-order A/B to B", async () => {
    await building();
    // An older ingest lands after the target's and supersedes its build.
    await queueImageBuildsFromBundle(db(), {
      rev: "late-rev",
      r2Key: "builds/bundles/late-rev.tar.gz",
      meta: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "candidate",
        scenarios: [{ scenarioId: "acme-web", arch: "x86_64", contentHash: HASH_B }],
      },
      organizationId: ORG,
      nowUnixMs: Date.now(),
    });

    await tick();

    const builds = await db()
      .select({ contentHash: imageBuilds.contentHash, status: imageBuilds.status })
      .from(imageBuilds);
    expect(builds).toEqual(expect.arrayContaining([
      { contentHash: HASH_A, status: "queued" },
      { contentHash: HASH_B, status: "stale" },
    ]));
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
  });

  it("restages a candidate the target lacks after sharing an older rev's build", async () => {
    await building();
    // B leaves acme-web unchanged, so its ingest dedups onto A's queued build.
    headSha = SHA_B;
    await stage({ sha: SHA_B });
    await insertCommit(SHA_B, "ingesting");
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    expect(await db().select({ rev: imageBuilds.rev }).from(imageBuilds)).toEqual([{ rev: rev(SHA_A) }]);

    // The build succeeds under A, and its publish stages A's candidate only.
    const [build] = await db().select({ id: imageBuilds.id }).from(imageBuilds);
    const manifest = { scenario_id: "acme-web", vms: [] } as never;
    await db().update(imageBuilds).set({ status: "succeeded", publishedManifestJson: manifest });
    await db().insert(scenarioCatalogCandidates).values({
      id: `${ORG}:${rev(SHA_A)}:acme-web`,
      revision: rev(SHA_A),
      organizationId: ORG,
      scenarioId: "acme-web",
      buildId: build!.id,
      manifestJson: manifest,
    });

    await tick();

    expect(
      await db()
        .select({ organizationId: scenarioCatalogCandidates.organizationId })
        .from(scenarioCatalogCandidates)
        .where(eq(scenarioCatalogCandidates.revision, rev(SHA_B))),
    ).toEqual([{ organizationId: ORG }]);
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
  });

  it("fails a stale exact build without the superseded prefix", async () => {
    await building();
    await db().update(imageBuilds).set({ status: "stale", error: "builder stopped reporting build progress" });
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("builder stopped reporting"),
    });
  });

  it("skips heal when the target is live", async () => {
    await building();
    await db().update(scenarioSources).set({ liveRev: rev(SHA_A) });
    await db().update(scenarioSourceCommits).set({ state: "live" });
    await db().update(imageBuilds).set({ status: "stale", error: "superseded by bundle late-rev" });
    await tick();
    expect(await db().select({ status: imageBuilds.status }).from(imageBuilds)).toEqual([{ status: "stale" }]);
  });

  it("fails after three heals in a row that throw, and a finished heal resets the count", async () => {
    await building();
    const superseded = () =>
      db().update(imageBuilds).set({ status: "stale", error: "superseded by bundle late-rev" });
    const [stored] = await db().select().from(imageBuildBundles);
    // An unsupported catalog version makes the requeue throw.
    const broken = () =>
      db()
        .update(imageBuildBundles)
        .set({ metaJson: { ...stored!.metaJson, courseCatalog: { version: 1 } as never } });
    const fixed = () => db().update(imageBuildBundles).set({ metaJson: stored!.metaJson });

    await superseded();
    await broken();
    await tick();
    await tick();
    await fixed();
    await tick();
    expect(await db().select({ status: imageBuilds.status }).from(imageBuilds)).toEqual([{ status: "queued" }]);

    await superseded();
    await broken();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await tick()).not.toBeNull();
      expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    }
    await tick();
    expect(await commitState(SHA_A)).toEqual({ state: "failed", detail: "heal did not finish" });
    // Each throw came before the first write, so none left a writer hold.
    const writers = await env.DB.prepare("SELECT id FROM image_registry_operation_writers").all();
    expect(writers.results).toEqual([]);
  });
});

describe("ScenarioSourceDO observe", () => {
  it.each(["compiling", "ingesting"] as const)(
    "drops a %s head row of a paused binding and deletes its objects",
    async (state) => {
      github();
      await stage();
      await env.VM_IMAGE_REGISTRY_BUCKET.put(`${prefix(SHA_A)}source.tar.gz`, "snapshot");
      await insertCommit(SHA_A, state);
      await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });

      await tick();

      expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
      expect(await stagedKeys(SHA_A)).toEqual([]);

      // Building, waiting and promoting rows hold nothing and stay.
      await db().update(scenarioSourceCommits).set({ state: "building" });
      await tick();
      expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    },
  );

  it("mints no token for a disconnected binding and settles its rows", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await db().update(scenarioSources).set({ disconnectedAt: 1, headSha: SHA_A });

    await tick();

    expect(githubCalls).toEqual([]);
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
  });

  it.each<[string, () => Promise<unknown>]>([
    ["demoted", () => db().update(member).set({ role: "member" })],
    ["removed", () => db().delete(member)],
    ["revoked", () => db().update(user).set({ banned: true }).where(eq(user.id, OWNER))],
    ["deleted", () => db().update(user).set({ deletedAt: new Date() }).where(eq(user.id, OWNER))],
  ])("pauses the binding when its binder is %s", async (_name, lose) => {
    github();
    await lose();
    await tick();
    expect(await binding()).toMatchObject({ pausedAt: expect.any(Number), pauseReason: "binder_lost_admin" });
  });

  it("applies the confirmed mint outcomes", async () => {
    const installation = (suspended: boolean) => ({
      "GET /app/installations/7": () =>
        Response.json({ id: 7, suspended_at: suspended ? "2026-09-01T00:00:00Z" : null }),
    });
    const refused = (status: number) => ({
      "POST /app/installations/7/access_tokens": () => new Response(null, { status }),
    });

    github({ ...refused(403), ...installation(true) });
    await tick();
    expect(await binding()).toMatchObject({ pauseReason: "suspended" });

    // The unsuspend arrived before a replayed suspend: only the mint decides.
    vi.restoreAllMocks();
    github();
    await tick();
    expect(await binding()).toMatchObject({ pausedAt: null, pauseReason: null });

    for (const status of [403, 429]) {
      vi.restoreAllMocks();
      github({ ...refused(status), ...installation(false) });
      expect(await tick()).not.toBeNull();
      expect(await binding()).toMatchObject({ pausedAt: null, disconnectedAt: null });
    }

    vi.restoreAllMocks();
    github({
      ...refused(422),
      ...installation(false),
      "GET /repos/acme/labs/installation": () => Response.json({ id: 7 }),
    });
    await tick();
    expect(await binding()).toMatchObject({ pausedAt: null, disconnectedAt: null });

    await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });
    for (const routes of [{ ...refused(403), ...installation(true) }, {}]) {
      vi.restoreAllMocks();
      github(routes);
      await tick();
      expect(await binding()).toMatchObject({ pausedAt: 1, pauseReason: "admin" });
    }

    vi.restoreAllMocks();
    github(refused(404));
    await tick();
    expect(await binding()).toMatchObject({ disconnectedAt: expect.any(Number), disconnectReason: "github_gone" });
  });

  it("waits for a first commit without a row, a pause or a disconnect", async () => {
    github({ "GET /repos/acme/labs/git/ref/heads/main": () => new Response(null, { status: 409 }) });
    await tick();
    expect(await binding()).toMatchObject({ headSha: null, pausedAt: null, disconnectedAt: null });
    expect(await db().select().from(scenarioSourceCommits)).toEqual([]);
  });

  it("freezes every row while the digest is unset", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await insertCommit(SHA_B, "building");
    await insertCommit("c".repeat(40), "waiting");

    await tick({ PLATFORM_BASE_IMAGES_SHA256: "" });

    expect(await binding()).toMatchObject({ headSha: SHA_A, targetRev: null });
    expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    expect(await commitState("c".repeat(40))).toMatchObject({ state: "waiting" });
    expect(await stagedKeys(SHA_A)).toHaveLength(2);

    // A paused binding still drops its in-flight rows: that compares no rev.
    await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });
    await tick({ PLATFORM_BASE_IMAGES_SHA256: "" });

    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(await stagedKeys(SHA_A)).toEqual([]);
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    expect(await commitState("c".repeat(40))).toMatchObject({ state: "waiting" });
  });
});

const ADMIN = "platform-admin";

/** Binds the fixture repository to `public` instead, as a platform admin. */
async function bindPublic() {
  await createFixtureMember({ d1: env.DB, userId: ADMIN, role: "admin" });
  await db().delete(scenarioSources);
  await db().insert(scenarioSources).values({
    scopeKey: "public",
    organizationId: null,
    githubInstallationId: 7,
    githubRepositoryId: 42,
    githubRepository: "acme/labs",
    defaultBranch: "main",
    mode: "push",
    boundByUserId: ADMIN,
  });
  scopeKey = "public";
  github();
}

describe("ScenarioSourceDO public binding", () => {
  beforeEach(bindPublic);

  it("refuses an id with an organization slug prefix", async () => {
    await stage({ scope: "public", scenarioIds: ["acme-web"] });
    await insertCommit(SHA_A, "ingesting");
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({
      state: "invalid",
      detail: "acme-web is outside your namespace",
    });
  });

  it("ingests a clean id without an organization and pauses when the admin is demoted", async () => {
    await stage({ scope: "public", scenarioIds: ["web"] });
    await insertCommit(SHA_A, "ingesting");
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    expect(await binding()).toMatchObject({ targetRev: rev(SHA_A), pausedAt: null });
    expect(
      await db().select({ organizationId: imageBuildBundles.organizationId }).from(imageBuildBundles),
    ).toEqual([{ organizationId: null }]);
    expect(await db().select({ organizationId: imageBuilds.organizationId }).from(imageBuilds)).toEqual([
      { organizationId: null },
    ]);

    await db().update(user).set({ role: "user" }).where(eq(user.id, ADMIN));
    await tick();
    expect(await binding()).toMatchObject({ pauseReason: "binder_lost_admin" });
  });
});

const LEARNER = "learner";
const IMAGE_A = "f".repeat(64);

function scenarioManifest(scenarioId: string): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: scenarioId,
    name: scenarioId,
    title: "Web",
    category: "linux",
    description: "Repair the web server",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: [],
    briefing_markdown: "briefing",
    solution_markdown: "solution",
    hints: [],
    vms: [
      {
        name: "web",
        image_key: { scenario: scenarioId, vm: "web", arch: "x86_64" },
        image_id: IMAGE_A,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 4_096,
        chunk_manifest_sha256: "c".repeat(64),
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: "d".repeat(64),
          initrd_sha256: "e".repeat(64),
          cmdline: "console=ttyS0",
        },
        cpu_millis: 1_000,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}

/** What the builder publish leaves: each open build succeeded, its candidate staged for `sha`. */
async function publish(
  sha: string,
  {
    organizationId = ORG,
    manifestOf = scenarioManifest,
    at = digest,
    scenarioIds,
  }: {
    organizationId?: string | null;
    manifestOf?: (scenarioId: string) => ScenarioManifestV5;
    at?: string;
    scenarioIds?: string[];
  } = {},
) {
  const open = await db().select().from(imageBuilds);
  for (const build of open.filter(
    (row) => row.status !== "succeeded" && (!scenarioIds || scenarioIds.includes(row.scenarioId)),
  )) {
    const manifest = manifestOf(build.scenarioId);
    await db()
      .update(imageBuilds)
      .set({ status: "succeeded", phase: "succeeded", publishedManifestJson: manifest })
      .where(eq(imageBuilds.id, build.id));
    await db().insert(scenarioCatalogCandidates).values({
      id: `${organizationId ?? "public"}:${rev(sha, at)}:${build.scenarioId}`,
      revision: rev(sha, at),
      organizationId,
      scenarioId: build.scenarioId,
      buildId: build.id,
      manifestJson: manifest,
    });
  }
}

/** Delivers `sha` as the head and runs the alarm that ingests it. */
async function deliver(commit: Commit & { sha: string }) {
  headSha = commit.sha;
  await stage(commit);
  await insertCommit(commit.sha, "ingesting");
  return tick();
}

/** Takes a settled row over for its rev again, as a producer re-delivery does. */
async function redeliver(sha: string, at = digest) {
  await env.DB.prepare(
    `UPDATE scenario_source_commits SET state = 'ingesting', attempt = attempt + 1
      WHERE rev = ?1`,
  )
    .bind(rev(sha, at))
    .run();
}

/** `acme-web` goes live from commit A. */
async function liveWeb() {
  github();
  await deliver({ sha: SHA_A });
  await publish(SHA_A);
  await tick();
  expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
}

/** A run of the learner on `course-1`/`lecture-0` of `acme-web`. */
async function startRun(runId: string, values: Partial<typeof scenarioRuns.$inferInsert> = {}) {
  await db().insert(scenarioRuns).values({
    runId,
    userId: LEARNER,
    organizationId: ORG,
    hostId: "host",
    scenarioId: "acme-web",
    scenarioName: "acme-web",
    courseScopeKey: SCOPE,
    courseId: "course-1",
    lectureId: "lecture-0",
    title: "Web",
    tagline: "Test",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 5,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: "running",
    stateRank: 1,
    stateJson: "{}",
    ...values,
  });
}

/** A member of the organization, and a host for their runs. */
async function seedLearner() {
  await createFixtureMember({ d1: env.DB, userId: LEARNER });
  await db().insert(member).values({
    id: "learner-member",
    organizationId: ORG,
    userId: LEARNER,
    role: "member",
    createdAt: new Date(),
  });
  await db().insert(agentHosts).values({ id: "host", userId: OWNER, name: "Host", createdAt: 1, updatedAt: 1 });
}

const snapshot = (scenarioIds: string[]) => normalizeCourseCatalogSnapshot(catalog(scenarioIds))!;

/** Enabled scenarios a catalog may link, in one statement. */
async function seedScenarios(organizationId: string | null, scenarioIds: string[]) {
  await env.DB.prepare(
    `INSERT INTO vm_scenarios (scenario_id, organization_id, title, description, difficulty,
       estimated_minutes, tags_json, briefing_markdown, solution_markdown, hints_json, enabled)
     SELECT value, ?2, 'Seeded', '', 'easy', 5, '[]', '', '', '[]', 1 FROM json_each(?1)`,
  )
    .bind(JSON.stringify(scenarioIds), organizationId)
    .run();
}

const enabledScenarioIds = async () =>
  (
    await db()
      .select({ id: vmScenarios.scenarioId })
      .from(vmScenarios)
      .where(eq(vmScenarios.enabled, true))
      .orderBy(vmScenarios.scenarioId)
  ).map((row) => row.id);

describe("ScenarioSourceDO organization apply", () => {
  it("promotes a commit as a whole and leaves public content alone", async () => {
    await db().insert(courseCatalogs).values({
      scopeKey: "public",
      organizationId: null,
      catalogJson: snapshot(["web"]),
      sourceRevision: "public-rev",
    });
    await env.DB.prepare(
      `INSERT INTO vm_scenarios (scenario_id, organization_id, title, description, difficulty,
         estimated_minutes, tags_json, briefing_markdown, solution_markdown, hints_json, enabled)
       VALUES ('web', NULL, 'Public', '', 'easy', 5, '[]', '', '', '[]', 1)`,
    ).run();
    const publicRows = async () => ({
      catalogs: await db().select().from(courseCatalogs).where(eq(courseCatalogs.scopeKey, "public")),
      scenarios: await db().select().from(vmScenarios).where(eq(vmScenarios.scenarioId, "web")),
    });
    const before = await publicRows();

    await liveWeb();

    expect(await binding()).toMatchObject({
      targetRev: rev(SHA_A),
      liveRev: rev(SHA_A),
      liveSha: SHA_A,
      liveAt: expect.any(Number),
    });
    expect(
      await db()
        .select({
          organizationId: vmScenarios.organizationId,
          enabled: vmScenarios.enabled,
          sourceRevision: vmScenarios.sourceRevision,
        })
        .from(vmScenarios)
        .where(eq(vmScenarios.scenarioId, "acme-web")),
    ).toEqual([{ organizationId: ORG, enabled: true, sourceRevision: rev(SHA_A) }]);
    expect(
      await db()
        .select({ organizationId: courseCatalogs.organizationId, sourceRevision: courseCatalogs.sourceRevision })
        .from(courseCatalogs)
        .where(eq(courseCatalogs.scopeKey, SCOPE)),
    ).toEqual([{ organizationId: ORG, sourceRevision: rev(SHA_A) }]);
    expect(await publicRows()).toEqual(before);

    // A second poke finds the target live and promotes nothing.
    await tick();
    expect(promotion.calls).toBe(1);
    const writers = await env.DB.prepare("SELECT id FROM image_registry_operation_writers").all();
    expect(writers.results).toEqual([]);
  });

  it("promotes a .keep-only commit in its ingest alarm without a rollback snapshot", async () => {
    github();
    await deliver({ sha: SHA_A, scenarioIds: [] });
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(await db().select().from(scenarioCatalogSnapshots)).toEqual([]);
    expect(await db().select({ scopeKey: courseCatalogs.scopeKey }).from(courseCatalogs)).toEqual([
      { scopeKey: SCOPE },
    ]);
  });

  it("promotes a target its heal made ready in the re-armed alarm", async () => {
    github();
    await deliver({ sha: SHA_A });
    // B leaves acme-web unchanged, so its ingest dedups onto A's open build.
    await deliver({ sha: SHA_B });
    await publish(SHA_A);

    // The build's terminal poke runs the heal, which restages B's candidate.
    expect(await tick()).not.toBeNull();
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
  });

  it("re-enables a removed scenario without a rebuild", async () => {
    await liveWeb();
    await deliver({ sha: SHA_B, scenarioIds: [] });
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    const enabled = async () =>
      (await db().select({ enabled: vmScenarios.enabled }).from(vmScenarios))[0]?.enabled;
    expect(await enabled()).toBe(false);

    await deliver({ sha: SHA_C });

    expect(await commitState(SHA_C)).toMatchObject({ state: "live" });
    expect(await enabled()).toBe(true);
    expect(await db().select({ rev: imageBuilds.rev }).from(imageBuilds)).toEqual([{ rev: rev(SHA_A) }]);
  });

  it("supersedes the previous live row and redeploys a rev that was live before", async () => {
    github();
    const other = await platformCompileDigest("0".repeat(64));
    if (!other) throw new Error("the second digest is unset");
    const liveRev = async () => (await binding()).liveRev;

    await deliver({ sha: SHA_A, scenarioIds: [] });
    expect(await liveRev()).toBe(rev(SHA_A));

    // A digest change d1 -> d2 -> d1 with an unchanged sha.
    await stage({ sha: SHA_A, digest: other, scenarioIds: [] });
    await insertCommit(SHA_A, "ingesting", { id: "commit-a2", rev: rev(SHA_A, other) });
    await tick({ PLATFORM_BASE_IMAGES_SHA256: "0".repeat(64) });
    expect(await commitState(SHA_A, other)).toMatchObject({ state: "live" });
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(await liveRev()).toBe(rev(SHA_A, other));

    await redeliver(SHA_A);
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(await commitState(SHA_A, other)).toMatchObject({ state: "superseded" });
    expect(await liveRev()).toBe(rev(SHA_A));

    // A force-push to B and back to A.
    await deliver({ sha: SHA_B, scenarioIds: [] });
    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    headSha = SHA_A;
    await redeliver(SHA_A);
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "superseded" });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A), liveSha: SHA_A });
  });

  it.each([
    ["incomplete_builds", "building"],
    ["incomplete_catalog", "building"],
    ["image_in_use", "waiting"],
    ["ownership_conflict", "invalid"],
  ] as const)("maps a %s refusal to %s", async (kind, state) => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);
    promotion.after = () => ({ ok: false, kind, status: 409, error: `refused: ${kind}` });

    await tick();

    expect(await commitState(SHA_A)).toEqual({ state, detail: `refused: ${kind}` });
    expect(await binding()).toMatchObject({ liveRev: null });
    expect(await db().select().from(courseCatalogs)).toEqual([]);
  });

  it("keeps promoting after a writer refusal or a throw after the commit", async () => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);

    await setRegistryPause(env, { paused: true });
    expect(await tick()).not.toBeNull();
    expect(await commitState(SHA_A)).toMatchObject({ state: "promoting" });
    expect(promotion.calls).toBe(0);
    await setRegistryPause(env, { paused: false });

    promotion.after = () => {
      throw new Error("desired-state CAS ran out of attempts");
    };
    expect(await tick()).not.toBeNull();
    expect(await commitState(SHA_A)).toMatchObject({ state: "promoting" });
    // The core committed; the catalog step did not run.
    expect(await db().select({ scenarioId: vmScenarios.scenarioId }).from(vmScenarios)).toEqual([
      { scenarioId: "acme-web" },
    ]);
    expect(await db().select().from(courseCatalogs)).toEqual([]);

    promotion.after = undefined;
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(
      await db().select({ sourceRevision: courseCatalogs.sourceRevision }).from(courseCatalogs),
    ).toEqual([{ sourceRevision: rev(SHA_A) }]);
  });

  it("finishes a promoting row while the binding is paused and the digest is unset", async () => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);
    promotion.after = () => {
      throw new Error("family lock timed out");
    };
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "promoting" });
    await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });

    promotion.after = undefined;
    await tick({ PLATFORM_BASE_IMAGES_SHA256: "" });

    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A), pausedAt: 1 });
  });

  it("syncs the catalog after a commit whose host reconcile failed", async () => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);
    promotion.after = (result) => {
      const committed = result as { ok: true; outcome: Record<string, unknown> };
      return { ...committed, outcome: { ...committed.outcome, failedHostIds: ["host-1"] } };
    };

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(
      await db().select({ sourceRevision: courseCatalogs.sourceRevision }).from(courseCatalogs),
    ).toEqual([{ sourceRevision: rev(SHA_A) }]);
  });

  it.each<[string, Partial<typeof scenarioSources.$inferInsert>]>([
    ["is paused", { pausedAt: 1, pauseReason: "admin" }],
    ["moves its head", { headSha: SHA_B, headObservedAt: Date.now() + 60_000 }],
  ])("writes no promoting row once the binding %s during the alarm", async (_name, change) => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);
    guard.before = async () => {
      await db().update(scenarioSources).set(change);
    };

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    expect(promotion.calls).toBe(0);
  });

  it("finishes a promotion whose head moved before the catalog step", async () => {
    github();
    await deliver({ sha: SHA_A });
    await publish(SHA_A);
    promotion.after = async (result) => {
      headSha = SHA_B;
      await db().update(scenarioSources).set({ headSha: SHA_B, headObservedAt: Date.now() + 60_000 });
      return result;
    };

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(await binding()).toMatchObject({ headSha: SHA_B, liveRev: rev(SHA_A) });
  });

  it("holds a commit in waiting while a run with access would lose it", async () => {
    await liveWeb();
    await seedLearner();
    await startRun("run-1");

    await deliver({ sha: SHA_B, scenarioIds: [] });

    expect(await commitState(SHA_B)).toEqual({ state: "waiting", detail: "active runs would lose access" });
    expect(await loadScenarioSource(scenarioSourceScope(ORG))).toMatchObject({ activeRuns: 1 });

    await db().update(scenarioRuns).set({ state: "completed", completedAt: 1 });
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    expect(await loadScenarioSource(scenarioSourceScope(ORG))).toMatchObject({ activeRuns: 0 });
  });

  it("is not held by a run that starts during the promotion", async () => {
    await liveWeb();
    await seedLearner();
    promotion.before = () => startRun("run-1");

    await deliver({ sha: SHA_B, scenarioIds: [] });
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });

    // The run lost access with B, so it holds no newer commit either.
    promotion.before = undefined;
    await deliver({ sha: SHA_C });
    expect(await commitState(SHA_C)).toMatchObject({ state: "live" });
  });

  // D1 refuses a statement with more than 100 bound parameters.
  it("rotates the images of 60 scenarios within D1's bound parameters", async () => {
    github();
    const scenarioIds = Array.from({ length: 60 }, (_, index) => `acme-s${index}`);
    const withImages = (tag: string) => (scenarioId: string): ScenarioManifestV5 => {
      const manifest = scenarioManifest(scenarioId);
      const image = tag + scenarioIds.indexOf(scenarioId).toString(16).padStart(63, "0");
      manifest.vms = manifest.vms.map((vm) => ({ ...vm, image_id: image }));
      return manifest;
    };
    await deliver({ sha: SHA_A, scenarioIds });
    await publish(SHA_A, { manifestOf: withImages("a") });
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });

    await deliver({ sha: SHA_B, scenarioIds, hash: HASH_B });
    await publish(SHA_B, { manifestOf: withImages("b") });
    await tick();

    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    const [rollback] = await db().select().from(scenarioCatalogSnapshots);
    expect(rollback?.snapshotJson.targetScenarioIds).toHaveLength(60);
  });

  it("promotes and syncs a catalog that links 120 scenarios", async () => {
    github();
    const own = Array.from({ length: 20 }, (_, index) => `acme-s${index}`);
    const shared = Array.from({ length: 100 }, (_, index) => `shared-${index}`);
    await seedScenarios(null, shared);
    await seedScenarios(ORG, ["acme-old"]);

    await deliver({ sha: SHA_A, scenarioIds: own, catalogIds: [...own, ...shared] });
    await publish(SHA_A);
    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
    expect(
      await db()
        .select({ sourceRevision: courseCatalogs.sourceRevision })
        .from(courseCatalogs)
        .where(eq(courseCatalogs.scopeKey, SCOPE)),
    ).toEqual([{ sourceRevision: rev(SHA_A) }]);
    expect(await enabledScenarioIds()).toEqual([...own, ...shared].sort());
  });
});

describe("unit guard", () => {
  beforeEach(async () => {
    await seedLearner();
    await db().insert(vmScenarios).values({
      scenarioId: "acme-web",
      organizationId: ORG,
      title: "Web",
      description: "",
      difficulty: "easy",
      estimatedMinutes: 5,
      tagsJson: [],
      briefingMarkdown: "",
      solutionMarkdown: "",
      hintsJson: [],
      enabled: true,
      enabledAt: 1,
    });
    await db().insert(courseCatalogs).values({
      scopeKey: SCOPE,
      organizationId: ORG,
      catalogJson: snapshot(["acme-web"]),
      sourceRevision: "old",
    });
  });

  const count = (scenarioIds: string[]) => countUnitGuardRuns(env.DB, ORG, snapshot(scenarioIds));

  it("counts only unfinished runs that have access and would lose it", async () => {
    await startRun("run-1");
    await startRun("run-done", { state: "completed", completedAt: 1 });
    expect(await count(["acme-web"])).toBe(0);
    expect(await count([])).toBe(1);

    const moved = snapshot(["acme-web"]);
    moved.courses[0]!.courseId = "course-2";
    expect(await countUnitGuardRuns(env.DB, ORG, moved)).toBe(1);

    // A removed member's run already lacks access.
    await db().delete(member).where(eq(member.userId, LEARNER));
    expect(await count([])).toBe(0);
  });

  it("does not count a run without access in another organization", async () => {
    await db().insert(organization).values({ id: "org-b", name: "Beta", slug: "beta", createdAt: new Date() });
    await startRun("run-b", { organizationId: "org-b", courseScopeKey: "organization:org-b" });
    expect(await count([])).toBe(0);
  });

  it("counts a run whose scenario the commit disables", async () => {
    // The run reaches the organization's scenario through another catalog.
    await db().insert(courseCatalogs).values({
      scopeKey: "public",
      organizationId: null,
      catalogJson: snapshot(["acme-web"]),
      sourceRevision: "public-rev",
    });
    await db().update(courseCatalogs).set({ catalogJson: snapshot([]) }).where(eq(courseCatalogs.scopeKey, SCOPE));
    await startRun("run-1", { courseScopeKey: "public" });
    // Its public lecture stays, but the commit disables the scenario.
    expect(await count([])).toBe(1);
  });

  it("counts runs in and outside organizations for a public commit", async () => {
    const [scenario] = await db().select().from(vmScenarios);
    await db().insert(vmScenarios).values({ ...scenario!, scenarioId: "web", organizationId: null });
    await db().insert(courseCatalogs).values({
      scopeKey: "public",
      organizationId: null,
      catalogJson: snapshot(["web"]),
      sourceRevision: "public-rev",
    });
    const web = { scenarioId: "web", courseScopeKey: "public" };
    await startRun("run-org", web);
    await startRun("run-public", { ...web, organizationId: null });

    expect(await countUnitGuardRuns(env.DB, null, snapshot(["web"]))).toBe(0);
    expect(await countUnitGuardRuns(env.DB, null, snapshot([]))).toBe(2);
  });
});

describe("ScenarioSourceDO public apply", () => {
  const IMAGE_B = "9".repeat(64);
  const PROBE: ScenarioProbeManifestV3 = {
    id: "nginx-up",
    phase: "scenario",
    kind: "port_open",
    display_name: "nginx answers",
    hints: [],
  };
  const withImage = (imageId: string, probes: ScenarioProbeManifestV3[] = []) =>
    (scenarioId: string): ScenarioManifestV5 => {
      const manifest = scenarioManifest(scenarioId);
      manifest.vms = manifest.vms.map((vm) => ({ ...vm, image_id: imageId, probes }));
      return manifest;
    };
  const publicCommit = (sha: string, commit: Commit = {}) =>
    deliver({ sha, scope: "public", scenarioIds: ["web"], ...commit });
  const catalogRev = async () =>
    (await db().select().from(courseCatalogs).where(eq(courseCatalogs.scopeKey, "public")))[0]
      ?.sourceRevision;
  const liveImages = () => db().select({ imageId: vmScenarioVms.imageSha256 }).from(vmScenarioVms);
  const drain = () =>
    db().insert(runtimeOperationGates).values({ key: IMAGE_CUTOVER_GATE, state: "drained" });

  beforeEach(async () => {
    await bindPublic();
    // `web` goes live from A: nothing was live, so nothing goes out.
    await publicCommit(SHA_A);
    await publish(SHA_A, { organizationId: null });
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "live" });
  });

  it("applies a lecture-only and a probe-only commit over identical images without a drain", async () => {
    // B reuses A's build and goes live in its ingest alarm.
    await publicCommit(SHA_B, { title: "Reworded" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    expect(await db().select({ title: vmScenarios.title }).from(vmScenarios)).toEqual([
      { title: "Reworded" },
    ]);

    // C builds again, and its image comes out byte-identical.
    await publicCommit(SHA_C, { hash: HASH_B });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_A, [PROBE]) });
    await tick();

    expect(await commitState(SHA_C)).toMatchObject({ state: "live" });
    expect(await db().select({ name: vmScenarioProbes.name }).from(vmScenarioProbes)).toEqual([
      { name: "nginx-up" },
    ]);
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_C), liveSha: SHA_C });
    expect(await catalogRev()).toBe(rev(SHA_C));
    expect(promotion.calls).toBe(3);
  });

  it("applies an image-replacing commit's catalog and awaits the drained lane once its candidates are complete", async () => {
    await publicCommit(SHA_B, { hash: HASH_B, title: "Next" });
    await publish(SHA_B, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    // The collector retires B's candidate between heal and apply.
    guard.before = async () => {
      guard.before = undefined;
      await db()
        .delete(scenarioCatalogCandidates)
        .where(eq(scenarioCatalogCandidates.revision, rev(SHA_B)));
    };

    expect(await tick()).not.toBeNull();
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });
    expect(await catalogRev()).toBe(rev(SHA_B));

    // Heal restages the candidate, and the next alarm enters awaiting_promote.
    await tick();
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "awaiting_promote" });
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "awaiting_promote" });

    // The images wait for the drained lane.
    expect(promotion.calls).toBe(1);
    expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A), targetRev: rev(SHA_B) });
  });

  it.each([IMAGE_CUTOVER_GATE, PROMOTION_HOLD_GATE])("holds a new head in waiting while %s is drained", async (key) => {
    await db().insert(runtimeOperationGates).values({ key, state: "drained" });
    await publicCommit(SHA_B, { title: "Next" });

    expect(await commitState(SHA_B)).toEqual({
      state: "waiting",
      detail: "the fleet is drained for an image swap",
    });
    expect(await catalogRev()).toBe(rev(SHA_A));

    await db().update(runtimeOperationGates).set({ state: "open" });
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
  });

  it("starts no apply once the fleet drains during the alarm", async () => {
    const drainDuringAlarm = async () => {
      guard.before = undefined;
      await drain();
    };

    // Nothing outgoing: the promoting write carries the gate.
    guard.before = drainDuringAlarm;
    await publicCommit(SHA_B, { title: "Next" });
    expect(await commitState(SHA_B)).toMatchObject({ state: "building" });

    // Images replaced: the re-read before the catalog sync sees the gate.
    await db().delete(runtimeOperationGates);
    await publicCommit(SHA_C, { hash: HASH_B });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    guard.before = drainDuringAlarm;
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "building" });

    expect(await catalogRev()).toBe(rev(SHA_A));
    expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);
    expect(promotion.calls).toBe(1);
  });

  it("promotes live_rev again when the head returns to it after another rev's catalog applied", async () => {
    // B adds `db` over A's image and goes live without a drain.
    await publicCommit(SHA_B, { scenarioIds: ["web", "db"] });
    await publish(SHA_B, { organizationId: null });
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });

    // C replaces web's image and drops `db`: its catalog applies first.
    await publicCommit(SHA_C, { hash: HASH_B, title: "Next" });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "awaiting_promote" });
    expect(await catalogRev()).toBe(rev(SHA_C));
    const scenarios = () =>
      db()
        .select({ id: vmScenarios.scenarioId, title: vmScenarios.title, enabled: vmScenarios.enabled })
        .from(vmScenarios)
        .orderBy(vmScenarios.scenarioId);
    expect(await scenarios()).toEqual([
      { id: "db", title: "Lecture", enabled: false },
      { id: "web", title: "Next", enabled: true },
    ]);

    // The author resets main back to B while the collector retires B's
    // candidates and an image release drains the fleet.
    await db().delete(scenarioCatalogCandidates).where(eq(scenarioCatalogCandidates.revision, rev(SHA_B)));
    await drain();
    headSha = SHA_B;
    await tick();
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "superseded" });
    expect(await commitState(SHA_B)).toEqual({
      state: "waiting",
      detail: "the fleet is drained for an image swap",
    });
    expect(await catalogRev()).toBe(rev(SHA_C));

    await db().delete(runtimeOperationGates);
    await tick();
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_B), targetRev: rev(SHA_B), liveSha: SHA_B });
    expect(await catalogRev()).toBe(rev(SHA_B));
    expect(await scenarios()).toEqual([
      { id: "db", title: "Lecture", enabled: true },
      { id: "web", title: "Lecture", enabled: true },
    ]);
    expect(await liveImages()).toEqual([{ imageId: IMAGE_A }, { imageId: IMAGE_A }]);
    expect(await publicSourceRevPromotable(env.DB, rev(SHA_C))).toBe(false);
  });

  it("applies a catalog-first catalog that links 120 scenarios within D1's bound parameters", async () => {
    const shared = Array.from({ length: 119 }, (_, index) => `shared-${index}`);
    await seedScenarios(null, [...shared, "old"]);

    await publicCommit(SHA_B, { hash: HASH_B, catalogIds: ["web", ...shared] });
    await publish(SHA_B, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();

    expect(await commitState(SHA_B)).toMatchObject({ state: "awaiting_promote" });
    expect(await catalogRev()).toBe(rev(SHA_B));
    expect(await enabledScenarioIds()).toEqual([...shared, "web"].sort());
  });

  it("returns live_rev's row to live when the head moves on from its restore", async () => {
    await publicCommit(SHA_C, { hash: HASH_B });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "awaiting_promote" });

    // The author resets main back to A while an image release drains the fleet.
    await drain();
    headSha = SHA_A;
    const sent = checkRuns.length;
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "waiting" });
    // The drained lane no longer takes the abandoned catalog-first rev.
    expect(await publicSourceRevPromotable(env.DB, rev(SHA_C))).toBe(false);

    // Then pushes D before the restore could run.
    await publicCommit(SHA_D, { hash: "3".repeat(64) });

    expect(await commitState(SHA_A)).toEqual({ state: "live", detail: null });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A), targetRev: rev(SHA_D) });
    expect(shownChecks().slice(sent)).toEqual([
      { call: "PATCH 902", status: "completed", conclusion: "neutral", title: "Superseded by a newer commit" },
      { call: "POST", status: "in_progress", title: "Restoring" },
      { call: "PATCH 903", status: "completed", conclusion: "success", title: "Live" },
      { call: "POST", status: "in_progress", title: "Building 0/1" },
    ]);
  });

  it("re-enables what an abandoned catalog-first commit disabled when live_rev is restored", async () => {
    // B adds `old`, and C drops it again over the same `web` build.
    await publicCommit(SHA_B, { scenarioIds: ["web", "old"] });
    await publish(SHA_B, { organizationId: null });
    await tick();
    await publicCommit(SHA_C, { title: "Reworded" });
    expect(await commitState(SHA_C)).toMatchObject({ state: "live" });

    // D replaces `old`'s image and links nothing else: its catalog disables `web`.
    await publicCommit(SHA_D, { scenarioIds: ["old"], hash: HASH_B });
    await publish(SHA_D, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();
    expect(await commitState(SHA_D)).toMatchObject({ state: "awaiting_promote" });
    expect(await enabledScenarioIds()).toEqual([]);

    headSha = SHA_C;
    await tick();

    expect(await commitState(SHA_C)).toMatchObject({ state: "live" });
    expect(await catalogRev()).toBe(rev(SHA_C));
    expect(await enabledScenarioIds()).toEqual(["web"]);
  });

  it("re-enables a scenario live_rev links outside its bundle when live_rev is restored", async () => {
    await seedScenarios(null, ["shared-x"]);
    // B reuses A's build and also links an existing public scenario.
    await publicCommit(SHA_B, { title: "Linked", catalogIds: ["web", "shared-x"] });
    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });

    // C replaces web's image and links only `web`: its catalog disables `shared-x`.
    await publicCommit(SHA_C, { hash: HASH_B });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "awaiting_promote" });
    expect(await enabledScenarioIds()).toEqual(["web"]);

    headSha = SHA_B;
    await tick();
    await tick();

    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    expect(await catalogRev()).toBe(rev(SHA_B));
    expect(await enabledScenarioIds()).toEqual(["shared-x", "web"]);
  });

  it("leaves a linked scenario disabled when a new rev promotes", async () => {
    await seedScenarios(null, ["shared-x"]);
    await drain();
    await publicCommit(SHA_B, { title: "Linked", catalogIds: ["web", "shared-x"] });
    expect(await commitState(SHA_B)).toMatchObject({ state: "waiting" });
    // An admin disables it after ingest validated the link.
    await db().update(vmScenarios).set({ enabled: false }).where(eq(vmScenarios.scenarioId, "shared-x"));

    await db().delete(runtimeOperationGates);
    await tick();

    expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
    expect(await enabledScenarioIds()).toEqual(["web"]);
  });

  it("refuses an abandoned catalog-first rev while a paused binding cannot retarget", async () => {
    await publicCommit(SHA_C, { hash: HASH_B });
    await publish(SHA_C, { organizationId: null, manifestOf: withImage(IMAGE_B) });
    await tick();
    expect(await commitState(SHA_C)).toMatchObject({ state: "awaiting_promote" });
    expect(await publicSourceRevPromotable(env.DB, rev(SHA_C))).toBe(true);

    // The binder loses admin, then the author resets main back to A.
    await db().update(scenarioSources).set({ pausedAt: 1, pauseReason: "binder_lost_admin" });
    headSha = SHA_A;
    await tick();

    expect(await commitState(SHA_C)).toMatchObject({ state: "superseded" });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A), targetRev: rev(SHA_C) });
    expect(await publicSourceRevPromotable(env.DB, rev(SHA_C))).toBe(false);
  });

  describe("Intar's image promotion", () => {
    // The collector's sweep verifies every retained artifact, and this suite's
    // images are ids without objects; the promotion tests run the real sweep.
    // Here a pass either completes or reports it could not.
    let cleanupApplies = true;
    const promotionEnv = () => {
      const double = createCleanupServiceDouble({
        DB: env.DB,
        VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
      });
      const run = async () => ({
        ...(await double.plan()),
        status: cleanupApplies ? ("ok" as const) : ("core-failed" as const),
        plan: null,
        result: null,
        error: cleanupApplies ? null : "the sweep is stuck",
      });
      return { ...env, REGISTRY_CLEANUP: { ...double, run } } as unknown as Cloudflare.Env;
    };
    const advance = () => advanceImagePromotion(promotionEnv());
    const gate = async (key = PROMOTION_HOLD_GATE) =>
      (await db().select().from(runtimeOperationGates).where(eq(runtimeOperationGates.key, key)))[0];
    const attempt = async () =>
      JSON.parse((await gate())?.evidenceJson ?? "null") as PromotionAttempt | null;
    /** B replaces A's image, so its catalog applies and its images wait. */
    const awaitB = async () => {
      await publicCommit(SHA_B, { hash: HASH_B, title: "Next" });
      await publish(SHA_B, { organizationId: null, manifestOf: withImage(IMAGE_B) });
      for (let pass = 0; pass < 4 && (await commitState(SHA_B))?.state !== "awaiting_promote"; pass += 1) {
        await tick();
      }
      expect(await commitState(SHA_B)).toMatchObject({ state: "awaiting_promote" });
    };
    // A learner VM on a user's host: counted as running, never an image user
    // of the platform catalog.
    const runVm = async () => {
      await db().insert(agentHosts).values({
        id: "learner-host",
        userId: OWNER,
        name: "Learner",
        scope: "personal",
        createdAt: 1,
        updatedAt: 1,
      });
      await env.DB.prepare(
        "INSERT INTO host_desired_state (host_id, version, doc_json) VALUES ('learner-host', 1, ?1)",
      )
        .bind(JSON.stringify({ vms: [{ desired_phase: "running" }] }))
        .run();
    };
    const stopVm = () => db().delete(agentHosts).where(eq(agentHosts.id, "learner-host"));

    // Deletes happen only under enforced admission, as in production.
    beforeEach(async () => {
      cleanupApplies = true;
      await enableRegistryDeletion(env.DB);
    });

    it("reopens an automatic hold after 30 minutes of pending cleanup", async () => {
      await awaitB();
      cleanupApplies = false;
      await advance();
      expect(await attempt()).toMatchObject({ phase: "cleaning", detail: "the sweep is stuck" });
      expect(await gate()).toMatchObject({ state: "drained" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);

      const held = JSON.parse((await gate())?.evidenceJson ?? "{}") as PromotionAttempt;
      await db()
        .update(runtimeOperationGates)
        .set({ evidenceJson: JSON.stringify({ ...held, committedAt: (held.committedAt ?? 0) - 31 * 60_000 }) })
        .where(eq(runtimeOperationGates.key, PROMOTION_HOLD_GATE));
      await advance();
      expect(await attempt()).toMatchObject({
        phase: "done",
        detail: "the registry cleanup is still pending",
      });
      expect(await gate()).toMatchObject({ state: "open" });
    });

    it("drains nothing while the registry cleanup could not delete", async () => {
      await awaitB();
      await env.DB.prepare("UPDATE image_registry_admission SET enforcement = 'report_only'").run();
      await advance();
      expect(await attempt()).toMatchObject({
        phase: "waiting",
        detail: "registry admission is report_only, so the cleanup cannot delete",
      });
      expect(await gate()).toMatchObject({ state: "open" });
    });

    it("waits for an idle moment, then swaps the images and reopens runs", async () => {
      await awaitB();
      expect(shownChecks().at(-1)).toMatchObject({
        status: "in_progress",
        title: "Waiting for an idle moment",
      });
      await runVm();

      await advance();
      expect(await attempt()).toMatchObject({
        origin: "auto",
        revision: rev(SHA_B),
        phase: "waiting",
        detail: "waiting for an idle moment: 1 VM running",
      });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);

      await stopVm();
      await advance();
      expect(await attempt()).toMatchObject({ phase: "done", detail: null });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);
      expect(await binding()).toMatchObject({ liveRev: rev(SHA_B), liveSha: SHA_B });
      expect(await commitState(SHA_B)).toMatchObject({ state: "live" });
      await tick();
      expect(shownChecks().at(-1)).toMatchObject({ status: "completed", title: "Live" });
    });

    it("lets an admin promote inside an operator drain and leaves that drain in place", async () => {
      await awaitB();
      await drain();
      await advance();
      expect(await attempt()).toMatchObject({
        origin: "auto",
        phase: "waiting",
        detail: "an operator drain is active",
      });

      await runVm();
      await startImagePromotion(promotionEnv(), { revision: rev(SHA_B), actorUserId: ADMIN });
      await advance();
      expect(await attempt()).toMatchObject({
        origin: "admin",
        requestedBy: ADMIN,
        phase: "drained",
        detail: "1 VM still running",
      });
      expect(await gate()).toMatchObject({ state: "drained" });
      await tick();
      expect(shownChecks().at(-1)).toMatchObject({ status: "in_progress", title: "Promoting images" });

      await stopVm();
      await advance();
      expect(await attempt()).toMatchObject({ phase: "done" });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await gate(IMAGE_CUTOVER_GATE)).toMatchObject({ state: "drained" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);
    });

    it("commits nothing when an admin reopens runs while the swap is in flight", async () => {
      await awaitB();
      // Runs inside the promotion call, after the machine decided to commit.
      stageLock.before = async () => {
        stageLock.before = undefined;
        await releaseImagePromotion(promotionEnv(), { actorUserId: ADMIN });
      };

      await advance();
      expect(await attempt()).toMatchObject({ phase: "cancelled", detail: "cancelled by an admin" });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);
      expect(await commitState(SHA_B)).toMatchObject({ state: "awaiting_promote" });
      // The fenced-out writer settled; an `unknown` one would hold the collector.
      await expect(
        env.DB.prepare("SELECT COUNT(*) AS count FROM image_registry_operation_writers").first(),
      ).resolves.toEqual({ count: 0 });

      // A cancelled revision is not started again automatically.
      await advance();
      expect(await attempt()).toMatchObject({ phase: "cancelled" });
    });

    it("yields to an operator drain and waits for it to end", async () => {
      await awaitB();
      readiness.ready = (call) => call === 1;
      await advance();
      const drained = await attempt();
      expect(drained).toMatchObject({ phase: "drained" });

      await drain();
      await advance();
      expect(await attempt()).toMatchObject({ phase: "yielded", detail: "an operator drain took over" });
      expect(await gate()).toMatchObject({ state: "open" });

      // Yielding does not count against the revision.
      readiness.ready = () => true;
      await advance();
      const next = await attempt();
      expect(next).toMatchObject({ phase: "waiting", detail: "an operator drain is active" });
      expect(next?.id).not.toBe(drained?.id);
    });

    it("fails an automatic drain that is not ready in time, then cools down", async () => {
      await awaitB();
      readiness.ready = (call) => call === 1;
      await advance();
      const held = await gate();
      const late = { ...(JSON.parse(held?.evidenceJson ?? "{}") as PromotionAttempt) };
      late.drainedAt = (late.drainedAt ?? 0) - 11 * 60_000;
      await db()
        .update(runtimeOperationGates)
        .set({ evidenceJson: JSON.stringify(late) })
        .where(eq(runtimeOperationGates.key, PROMOTION_HOLD_GATE));

      await advance();
      expect(await attempt()).toMatchObject({ phase: "failed" });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);

      readiness.ready = () => true;
      await advance();
      expect(await attempt()).toMatchObject({ phase: "failed", id: late.id });
    });

    it("steps aside when the commit moved on", async () => {
      await awaitB();
      readiness.ready = () => false;
      await advance();
      expect(await attempt()).toMatchObject({ phase: "waiting", revision: rev(SHA_B) });

      // C reuses A's image, so it goes live directly and B is superseded.
      await publicCommit(SHA_C, { title: "Reworded" });
      await advance();
      expect(await attempt()).toMatchObject({
        phase: "yielded",
        detail: "the public commit is no longer waiting",
      });
      expect(await gate()).toMatchObject({ state: "open" });
    });

    it("starts again after a pause of the public source", async () => {
      await awaitB();
      readiness.ready = () => false;
      await advance();
      const paused = () =>
        db().update(scenarioSources).set({ pausedAt: Date.now(), pauseReason: "admin" })
          .where(eq(scenarioSources.scopeKey, "public"));
      await paused();
      await advance();
      expect(await attempt()).toMatchObject({ phase: "yielded" });

      await db().update(scenarioSources).set({ pausedAt: null, pauseReason: null })
        .where(eq(scenarioSources.scopeKey, "public"));
      readiness.ready = () => true;
      await advance();
      expect(await attempt()).toMatchObject({ phase: "done", revision: rev(SHA_B) });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);
    });

    it("ends a hold at once when the revision can no longer be promoted", async () => {
      await awaitB();
      await runVm();
      await startImagePromotion(promotionEnv(), { revision: rev(SHA_B), actorUserId: ADMIN });
      await advance();
      expect(await attempt()).toMatchObject({ phase: "drained" });

      // The public catalog moves back to A, as a retarget does.
      await db().update(courseCatalogs).set({ sourceRevision: rev(SHA_A) })
        .where(eq(courseCatalogs.scopeKey, "public"));
      await advance();
      expect(await attempt()).toMatchObject({
        phase: "failed",
        detail: "the scenario source revision is no longer promotable",
      });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_A }]);
    });

    it("records the swap live when runs reopen after its tick died, and a retry promotes nothing twice", async () => {
      await awaitB();
      cleanupApplies = false;
      let died = false;
      guard.beforeLive = async () => {
        if (!died) {
          died = true;
          throw new Error("the tick died");
        }
      };
      await advance();
      expect(await attempt()).toMatchObject({ phase: "cleaning" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);
      expect(await binding()).toMatchObject({ liveRev: rev(SHA_A) });

      await releaseImagePromotion(promotionEnv(), { actorUserId: ADMIN });
      expect(await attempt()).toMatchObject({ phase: "released" });
      expect(await gate()).toMatchObject({ state: "open" });
      expect(await binding()).toMatchObject({ liveRev: rev(SHA_B) });
      expect(await commitState(SHA_B)).toMatchObject({ state: "live" });

      // An admin retry of the committed revision swaps nothing and finishes.
      cleanupApplies = true;
      await startImagePromotion(promotionEnv(), { revision: rev(SHA_B), actorUserId: ADMIN });
      await advance();
      expect(await attempt()).toMatchObject({ origin: "admin", phase: "done" });
      expect(await liveImages()).toEqual([{ imageId: IMAGE_B }]);
    });

    it("reopens an automatic hold after 10 minutes of hosts that did not converge", async () => {
      await awaitB();
      // Ready for the three checks before the commit, then not.
      readiness.ready = (call) => call <= 3;
      await advance();
      expect(await attempt()).toMatchObject({ phase: "verifying" });
      expect(await gate()).toMatchObject({ state: "drained" });

      const held = JSON.parse((await gate())?.evidenceJson ?? "{}") as PromotionAttempt;
      await db()
        .update(runtimeOperationGates)
        .set({ evidenceJson: JSON.stringify({ ...held, cleanedAt: (held.cleanedAt ?? 0) - 11 * 60_000 }) })
        .where(eq(runtimeOperationGates.key, PROMOTION_HOLD_GATE));
      await advance();
      expect(await attempt()).toMatchObject({
        phase: "done",
        detail: "the hosts had not reported the new images yet",
      });
      expect(await gate()).toMatchObject({ state: "open" });
    });

    it("lets only an active platform admin start or end a promotion", async () => {
      await awaitB();
      await expect(
        startImagePromotion(promotionEnv(), { revision: rev(SHA_B), actorUserId: OWNER }),
      ).rejects.toMatchObject({ status: 409, code: "promotion_changed" });
      await startImagePromotion(promotionEnv(), { revision: rev(SHA_B), actorUserId: ADMIN });
      await expect(
        releaseImagePromotion(promotionEnv(), { actorUserId: OWNER }),
      ).rejects.toMatchObject({ status: 409, code: "promotion_changed" });
      expect(await attempt()).toMatchObject({ origin: "admin", phase: "waiting" });
    });
  });
});

describe("ScenarioSourceDO pull delivery", () => {
  const SCOPE_B = "organization:org-b";
  const SNAPSHOT = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
  const codeload = (repository: string, sha: string) =>
    `https://codeload.github.com/${repository}/legacy.tar.gz/${sha}?token=SECRET-CODELOAD-TOKEN`;
  let woken: string[];
  const hostRuntime = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async () => {
        woken.push(name);
        return new Response(null, { status: 204 });
      },
    }),
  };
  const pullTick = (overrides: Record<string, unknown> = {}) =>
    tick({ HOST_RUNTIME: hostRuntime, ...overrides });

  /** The API's 302 to codeload, and codeload's answer: no Content-Length. */
  function tarball(
    sha: string,
    repository = "acme/labs",
    answer: Route = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(SNAPSHOT);
            controller.close();
          },
        }),
      ),
  ): Record<string, Route> {
    return {
      [`GET /repos/${repository}/tarball/${sha}`]: () =>
        new Response(null, { status: 302, headers: { location: codeload(repository, sha) } }),
      [`GET /${repository}/legacy.tar.gz/${sha}`]: answer,
    };
  }

  async function seedBuilder(hostId: string, platform = digest) {
    const now = Date.now();
    await db().insert(agentHosts).values({
      id: hostId,
      userId: OWNER,
      name: hostId,
      scope: "platform",
      role: "builder",
      credentialGeneration: 1,
      activeSessionId: `${hostId}-session`,
      lastClientHelloAt: now,
      connected: true,
    });
    const report = {
      ...structuredClone(hostReportFixture),
      host_id: hostId,
      observed_at_unix_ms: now,
      vms: [],
      builds: [],
    } as HostStateReportV2;
    report.capabilities.source_compile_platform = platform;
    await db().insert(hostActualState).values({
      hostId,
      appliedDesiredVersion: 0,
      observedAt: now,
      reportJson: report,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** A second pull binding, `acme/other` (id 43), whose head waits longer. */
  async function seedSecondBinding() {
    await createFixtureMember({ d1: env.DB, userId: "owner-b" });
    await db().insert(organization).values({ id: "org-b", name: "Beta", slug: "beta", createdAt: new Date() });
    await db().insert(member).values({
      id: "owner-member-b",
      organizationId: "org-b",
      userId: "owner-b",
      role: "owner",
      createdAt: new Date(),
    });
    await db().insert(scenarioSources).values({
      scopeKey: SCOPE_B,
      organizationId: "org-b",
      githubInstallationId: 7,
      githubRepositoryId: 43,
      githubRepository: "acme/other",
      defaultBranch: "main",
      mode: "pull",
      boundByUserId: "owner-b",
      headSha: SHA_B,
      headObservedAt: 1,
    });
  }

  async function rows(scope = SCOPE) {
    return db()
      .select()
      .from(scenarioSourceCommits)
      .where(eq(scenarioSourceCommits.scopeKey, scope));
  }

  async function desired(hostId: string) {
    const [row] = await db().select().from(hostDesiredState).where(eq(hostDesiredState.hostId, hostId));
    return row ? { version: row.version, compiles: row.docJson.source_compiles } : null;
  }

  async function clearFloor(scope = scopeKey) {
    const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(scope));
    await runInDurableObject(stub, (_instance: ScenarioSourceDO, state) =>
      state.storage.delete("delivered_at"),
    );
  }

  /** Expires the running compile and runs the alarm that delivers it again. */
  async function expireCompile() {
    await db()
      .update(scenarioSourceCommits)
      .set({ compileAssignedAt: Date.now() - BUILDER_REASSIGN_AFTER_MS });
    await clearFloor();
    await pullTick();
  }

  const tarballReads = (repository = "acme/labs") =>
    githubRequests.filter((request) => request.url.includes(`/repos/${repository}/tarball/`)).length;

  function captureConsole(): unknown[][] {
    const lines: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    return lines;
  }

  beforeEach(async () => {
    woken = [];
    await db().update(scenarioSources).set({ mode: "pull" });
    await seedBuilder("builder-1");
  });

  it("fetches the head once and hands it to a free builder on this digest", async () => {
    await seedBuilder("builder-old", "p00000000");
    github(tarball(SHA_A));
    const logs = captureConsole();

    expect(await pullTick()).toBeNull();

    const [row] = await rows();
    expect(row).toMatchObject({
      rev: rev(SHA_A),
      via: "pull",
      state: "compiling",
      attempt: 1,
      compileHostId: "builder-1",
      detail: null,
    });
    expect(await desired("builder-1")).toEqual({
      version: 1,
      compiles: [
        { compile_id: row!.id, attempt: 1, rev: rev(SHA_A), validate_only: false, arch: "x86_64" },
      ],
    });
    expect(woken).toEqual(["builder-1"]);
    expect(await desired("builder-old")).toBeNull();

    const archive = await env.VM_IMAGE_REGISTRY_BUCKET.get(`${prefix(SHA_A)}source.tar.gz`);
    expect(new Uint8Array(await archive!.arrayBuffer())).toEqual(SNAPSHOT);
    expect(archive!.customMetadata).toEqual({});
    // Only codeload is followed, and without the installation token.
    expect(githubRequests.filter((request) => !request.url.startsWith("https://api.github.com/")))
      .toEqual([{ url: codeload("acme/labs", SHA_A), authorization: null }]);
    expect(JSON.stringify(logs)).not.toContain("SECRET-CODELOAD-TOKEN");
  });

  it.each<[string, Record<string, Route>, { state: string; detail: string }]>([
    [
      "a redirect off codeload",
      {
        [`GET /repos/acme/labs/tarball/${SHA_A}`]: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/archive?token=SECRET-CODELOAD-TOKEN" },
          }),
      },
      { state: "fetching", detail: "GitHub could not be read; retrying" },
    ],
    [
      "an archive over 8 MiB",
      tarball(SHA_A, "acme/labs", () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
      { state: "invalid", detail: expect.stringContaining("8 MiB pull limit") },
    ],
    [
      "a codeload 404 for an unknown sha",
      tarball(SHA_A, "acme/labs", () => new Response(null, { status: 404 })),
      { state: "invalid", detail: "GitHub has no archive for this commit." },
    ],
    [
      "an API 422",
      { [`GET /repos/acme/labs/tarball/${SHA_A}`]: () => new Response(null, { status: 422 }) },
      { state: "invalid", detail: "GitHub has no archive for this commit." },
    ],
  ])("handles %s without writing or logging the tarball URL", async (_name, routes, outcome) => {
    github(routes);
    const logs = captureConsole();

    await pullTick();

    expect((await rows())[0]).toMatchObject({ ...outcome, diagnosticsJson: null });
    expect(githubRequests.some((request) => request.url.startsWith("https://evil.example/"))).toBe(false);
    expect(JSON.stringify([logs, await rows()])).not.toContain("SECRET-CODELOAD-TOKEN");
    const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({
      prefix: "builds/",
      include: ["customMetadata"],
    });
    expect(listed.objects).toEqual([]);
  });

  it("retries a GitHub error after the floor without counting it, and fails after three crashed fetches", async () => {
    github(tarball(SHA_A, "acme/labs", () => new Response("bad gateway", { status: 502 })));
    const before = Date.now();
    const next = await pullTick();
    expect(next).toBeGreaterThanOrEqual(before + 60_000);
    expect((await rows())[0]).toMatchObject({
      state: "fetching",
      detail: "GitHub could not be read; retrying",
    });
    // The floor holds a poke that comes sooner.
    expect(await pullTick()).toBe(next);
    expect(tarballReads()).toBe(1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await clearFloor();
      await pullTick();
    }
    expect((await rows())[0]).toMatchObject({ state: "fetching" });

    vi.restoreAllMocks();
    github(tarball(SHA_A));
    const bucket = new Proxy(env.VM_IMAGE_REGISTRY_BUCKET, {
      get: (target, key) =>
        key === "put"
          ? () => Promise.reject(new Error("R2 is down"))
          : Reflect.get(target, key).bind(target),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearFloor();
      await pullTick({ VM_IMAGE_REGISTRY_BUCKET: bucket });
      expect((await rows())[0]).toMatchObject({ state: "fetching" });
    }
    await clearFloor();
    await pullTick({ VM_IMAGE_REGISTRY_BUCKET: bucket });
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "fetch did not finish" });
  });

  it("waits for a compiler without claiming, and a compile end wakes the binding that waited longest", async () => {
    await seedSecondBinding();
    github({ ...tarball(SHA_A), ...tarball(SHA_B, "acme/other") });
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state: "compiling", compileHostId: "builder-1" });

    scopeKey = SCOPE_B;
    expect(await pullTick()).toBeNull();
    expect(await rows(SCOPE_B)).toEqual([]);
    expect(tarballReads("acme/other")).toBe(0);

    // A's third delivery expires: its row fails and the builder is free.
    scopeKey = SCOPE;
    await db()
      .update(scenarioSourceCommits)
      .set({ attempt: 3, compileAssignedAt: Date.now() - BUILDER_REASSIGN_AFTER_MS });
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "compiler did not finish" });
    expect(await desired("builder-1")).toMatchObject({ version: 2, compiles: undefined });
    const [waiting] = await db().select().from(scenarioSources).where(eq(scenarioSources.scopeKey, SCOPE_B));
    expect(waiting?.pokedAt).toEqual(expect.any(Number));

    scopeKey = SCOPE_B;
    await pullTick();
    expect((await rows(SCOPE_B))[0]).toMatchObject({ state: "compiling", compileHostId: "builder-1" });
  });

  it("keeps the archive when another binding takes the builder first, and assigns it later without a second download", async () => {
    await seedSecondBinding();
    const archive = tarball(SHA_B, "acme/other");
    github({
      ...archive,
      // A's assign lands while B downloads.
      [`GET /acme/other/legacy.tar.gz/${SHA_B}`]: async (request) => {
        await db().insert(scenarioSourceCommits).values({
          id: "commit-a",
          scopeKey: SCOPE,
          purpose: "deploy",
          sha: SHA_A,
          rev: rev(SHA_A),
          via: "pull",
          attempt: 1,
          state: "compiling",
          compileHostId: "builder-1",
          compileAssignedAt: Date.now(),
        });
        return archive[`GET /acme/other/legacy.tar.gz/${SHA_B}`]!(request);
      },
    });
    scopeKey = SCOPE_B;
    const before = Date.now();
    expect(await pullTick()).toBeGreaterThanOrEqual(before + 60_000);
    expect((await rows(SCOPE_B))[0]).toMatchObject({ state: "fetching", attempt: 0 });
    const staged = stagedSourceObjectPrefix(SCOPE_B, `git-43-${SHA_B}-${digest}`, "deploy");
    const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: staged });
    expect(listed.objects.map((object) => object.key)).toEqual([`${staged}source.tar.gz`]);

    await db()
      .update(scenarioSourceCommits)
      .set({ state: "ingesting" })
      .where(eq(scenarioSourceCommits.id, "commit-a"));
    await clearFloor();
    await pullTick();
    expect((await rows(SCOPE_B))[0]).toMatchObject({ state: "compiling", attempt: 1 });
    expect(tarballReads("acme/other")).toBe(1);
  });

  it("does not assign a builder that disconnected during the download", async () => {
    const archive = tarball(SHA_A);
    github({
      ...archive,
      [`GET /acme/labs/legacy.tar.gz/${SHA_A}`]: async (request) => {
        await db().update(agentHosts).set({ connected: false }).where(eq(agentHosts.id, "builder-1"));
        return archive[`GET /acme/labs/legacy.tar.gz/${SHA_A}`]!(request);
      },
    });

    await pullTick();

    expect((await rows())[0]).toMatchObject({ state: "fetching", attempt: 0, compileHostId: null });
    expect(await stagedKeys(SHA_A)).toEqual([`${prefix(SHA_A)}source.tar.gz`]);
    expect(await desired("builder-1")).toBeNull();
  });

  it("expires a compile back to its stored archive, and fails it on the third expiry", async () => {
    github(tarball(SHA_A));
    await pullTick();
    for (const attempt of [2, 3]) {
      await db()
        .update(scenarioSourceCommits)
        .set({ compileAssignedAt: Date.now() - BUILDER_REASSIGN_AFTER_MS });
      await clearFloor();
      await pullTick();
      expect((await rows())[0]).toMatchObject({ state: "compiling", attempt });
      expect((await desired("builder-1"))?.compiles).toEqual([expect.objectContaining({ attempt })]);
    }
    expect(tarballReads()).toBe(1);

    await db()
      .update(scenarioSourceCommits)
      .set({ compileAssignedAt: Date.now() - BUILDER_REASSIGN_AFTER_MS });
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "compiler did not finish" });
    expect(await stagedKeys(SHA_A)).toEqual([]);
    expect((await desired("builder-1"))?.compiles).toBeUndefined();
  });

  it("gives a formerly live row that is head again three fresh compile tries", async () => {
    // It went live from attempt 1 and was superseded when live_rev moved.
    await insertCommit(SHA_A, "superseded", { via: "pull", attempt: 1 });
    github(tarball(SHA_A));
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state: "compiling", attempt: 2, claimedAttempt: 1 });
    for (const attempt of [3, 4]) {
      await expireCompile();
      expect((await rows())[0]).toMatchObject({ state: "compiling", attempt });
    }

    await expireCompile();
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "compiler did not finish" });
  });

  it("takes an organization pull commit from its compile result to live", async () => {
    // A digest whose base catalog is the staged base-images.hcl.
    const baseImages = new TextEncoder().encode("base_image {}\n");
    const overrides = { PLATFORM_BASE_IMAGES_SHA256: await sha256Hex(baseImages.buffer) };
    const at = await platformCompileDigest(overrides.PLATFORM_BASE_IMAGES_SHA256);
    if (!at) throw new Error("the base catalog digest is unset");
    await seedBuilder("builder-2", at);
    github(tarball(SHA_A));

    await pullTick(overrides);
    const [row] = await rows();
    expect(row).toMatchObject({ rev: rev(SHA_A, at), state: "compiling", compileHostId: "builder-2" });

    await db().insert(agentBootstrapTokens).values({
      id: "builder-2-bootstrap",
      hostId: "builder-2",
      tokenHash: await sha256Text("builder-2-token"),
      credentialGeneration: 1,
      expiresAt: Date.now() + 60_000,
    });
    const bootstrap = await handleAgentBootstrap(
      new Request("https://intar.test/agent/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "builder-2", bootstrapToken: "builder-2-token" }),
      }),
      env,
    );
    const { accessToken } = (await bootstrap.json()) as { accessToken: string };
    const { meta, bundle } = await compiled({ sha: SHA_A, digest: at });
    const form = new FormData();
    form.set(SOURCE_META_FIELD, JSON.stringify(meta));
    form.set(SOURCE_BUNDLE_FIELD, new Blob([new Uint8Array(bundle)]), `${rev(SHA_A, at)}.tar.gz`);
    const multipart = new Response(form);
    const body = await multipart.arrayBuffer();
    const result = await handleImageRegistryRequest(
      new Request(`https://intar.test${AGENT_SOURCES_PATH}/${row!.id}/result?attempt=${row!.attempt}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": multipart.headers.get("content-type") ?? "",
          "content-length": String(body.byteLength),
        },
        body,
      }),
      { ...env, HOST_RUNTIME: hostRuntime, ...overrides } as unknown as Cloudflare.Env,
    );
    expect(result?.status, await result?.clone().text()).toBe(202);
    expect(await commitState(SHA_A, at)).toMatchObject({ state: "ingesting" });

    await pullTick(overrides);
    expect(await commitState(SHA_A, at)).toMatchObject({ state: "building" });
    await publish(SHA_A, { at });
    await pullTick(overrides);
    expect(await commitState(SHA_A, at)).toMatchObject({ state: "live" });
    expect(await binding()).toMatchObject({ liveRev: rev(SHA_A, at), liveSha: SHA_A });
    expect(
      await db()
        .select({ organizationId: vmScenarios.organizationId, sourceRevision: vmScenarios.sourceRevision })
        .from(vmScenarios),
    ).toEqual([{ organizationId: ORG, sourceRevision: rev(SHA_A, at) }]);
  });

  it("supersedes a compile on a digest bump and removes its entry", async () => {
    github(tarball(SHA_A));
    await pullTick();
    expect(await desired("builder-1")).toMatchObject({ version: 1 });
    woken = [];

    await clearFloor();
    await pullTick({ PLATFORM_BASE_IMAGES_SHA256: "f".repeat(64) });

    expect((await rows())[0]).toMatchObject({ state: "superseded" });
    expect(await desired("builder-1")).toEqual({ version: 2, compiles: undefined });
    expect(woken).toEqual(["builder-1"]);
    expect(await stagedKeys(SHA_A)).toEqual([]);
    // The builder is on the old digest, so the new head waits for a compiler.
    expect(await rows()).toHaveLength(1);
  });

  it.each(["invalid", "failed"] as const)("does not deliver a %s head again until a check_suite re-run, which restarts its compile tries", async (state) => {
    github(tarball(SHA_A));
    // Three compiles used up.
    await insertCommit(SHA_A, state, { via: "pull", attempt: 3, detail: "did not compile" });
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state });
    expect(tarballReads()).toBe(0);

    const body = JSON.stringify({
      action: "rerequested",
      check_suite: { head_sha: SHA_A },
      installation: { id: 7 },
      repository: { id: 42 },
    });
    const response = await handleGitHubWebhook(
      new Request(`https://intar.dev${GITHUB_WEBHOOK_PATH}`, {
        method: "POST",
        headers: { "x-github-event": "check_suite", "x-hub-signature-256": await sign(body) },
        body,
      }),
      env,
    );
    expect(response.status).toBe(204);
    await pullTick();
    expect((await rows())[0]).toMatchObject({ state: "compiling", attempt: 5, detail: null });
    for (const attempt of [6, 7]) {
      await expireCompile();
      expect((await rows())[0]).toMatchObject({ state: "compiling", attempt });
    }
    await expireCompile();
    expect((await rows())[0]).toMatchObject({ state: "failed", detail: "compiler did not finish" });
  });

  it("shows a delivered head as compiling on a new deploy check run", async () => {
    github(tarball(SHA_A));
    await pullTick();
    expect(shownChecks()).toEqual([{ call: "POST", status: "in_progress", title: "Compiling" }]);
    expect(checkRuns[0]!.body).toMatchObject({ name: "Intar / deploy", head_sha: SHA_A });
    expect(await checkRunId(SHA_A)).toBe(901);
  });

  it("fails the deploy check run of an archive over 8 MiB", async () => {
    github(tarball(SHA_A, "acme/labs", () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))));
    await pullTick();
    expect(shownChecks()).toEqual([
      { call: "POST", status: "completed", conclusion: "failure", title: "Invalid" },
    ]);
    expect(checkRuns[0]!.body.output.summary).toContain("8 MiB pull limit");
  });

  it("lets the host runtime re-add a missing compile entry and drop a stale one", async () => {
    await insertCommit(SHA_A, "compiling", {
      via: "pull",
      attempt: 1,
      compileHostId: "builder-1",
      compileAssignedAt: Date.now(),
    });
    await maintainHostBuildAssignments(db(), "builder-1", Date.now());
    expect((await desired("builder-1"))?.compiles).toEqual([
      { compile_id: "commit-a", attempt: 1, rev: rev(SHA_A), validate_only: false, arch: "x86_64" },
    ]);

    await db().update(scenarioSourceCommits).set({ state: "superseded" });
    await maintainHostBuildAssignments(db(), "builder-1", Date.now());
    expect(await desired("builder-1")).toEqual({ version: 2, compiles: undefined });
  });
});

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_APP_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("scenario source cron", () => {
  function recordingEnv() {
    const poked: string[] = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async () => {
          poked.push(name);
          return new Response(null, { status: 204 });
        },
      }),
    };
    const cronEnv = new Proxy(env, {
      get: (target, key) => (key === "SCENARIO_SOURCE" ? namespace : Reflect.get(target, key)),
    });
    return { poked, cronEnv };
  }

  it("pokes due bindings and disconnected ones only while they hold an in-flight row", async () => {
    const now = Date.now();
    const insert = (
      scopeKey: string,
      repositoryId: number,
      values: Partial<typeof scenarioSources.$inferInsert>,
    ) =>
      db().insert(scenarioSources).values({
        scopeKey,
        organizationId: scopeKey.slice("organization:".length),
        githubInstallationId: 7,
        githubRepositoryId: repositoryId,
        githubRepository: `acme/r${repositoryId}`,
        defaultBranch: "main",
        boundByUserId: OWNER,
        ...values,
      });
    for (const id of ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"]) {
      await db().insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
    }
    await db().update(scenarioSources).set({ pokedAt: now, polledAt: now });
    for (const [index, id] of ["o1", "o2", "o3", "o4", "o5", "o6"].entries()) {
      await insert(`organization:${id}`, 100 + index, { polledAt: index + 1 });
    }
    await insert("organization:o7", 200, { disconnectedAt: 1, pokedAt: now });
    await insert("organization:o8", 201, { disconnectedAt: 1 });
    await db().insert(scenarioSourceCommits).values({
      id: "in-flight",
      scopeKey: "organization:o8",
      purpose: "deploy",
      sha: SHA_A,
      rev: "git-201-x",
      via: "pull",
      state: "compiling",
    });

    const { poked, cronEnv } = recordingEnv();
    await sweepScenarioSources(cronEnv, now);

    // The poke first, then the five longest-unpolled; o8 is one of them.
    expect(poked).toEqual([
      SCOPE,
      ...["o8", "o1", "o2", "o3", "o4"].map((id) => `organization:${id}`),
    ]);
    expect(await binding()).toMatchObject({ pokedAt: null, polledAt: now });
  });

  it("prunes staged objects nothing holds once they are 10 minutes old", async () => {
    await stage();
    await stage({ sha: SHA_B });
    await insertCommit(SHA_A, "ingesting");
    const { cronEnv } = recordingEnv();

    await sweepScenarioSources(cronEnv);
    expect(await stagedKeys(SHA_B)).toHaveLength(2);

    await sweepScenarioSources(cronEnv, Date.now() + 11 * 60_000);
    expect(await stagedKeys(SHA_A)).toHaveLength(2);
    expect(await stagedKeys(SHA_B)).toEqual([]);
  });
});

describe("ScenarioSourceDO deploy check run", () => {
  it("is created on the first claim and follows every state to live, sending only changes", async () => {
    github();
    await stage({ scenarioIds: ["acme-web", "acme-db"] });
    await insertCommit(SHA_A, "ingesting");
    // A refused writer keeps the claim ingesting.
    await setRegistryPause(env, { paused: true });
    await tick();
    await setRegistryPause(env, { paused: false });
    await tick();
    await tick();
    await publish(SHA_A, { scenarioIds: ["acme-web"] });
    await tick();
    await publish(SHA_A);
    await tick();

    expect(shownChecks()).toEqual([
      { call: "POST", status: "queued", title: "Queued" },
      { call: "PATCH 901", status: "in_progress", title: "Building 0/2" },
      { call: "PATCH 901", status: "in_progress", title: "Building 1/2" },
      { call: "PATCH 901", status: "completed", conclusion: "success", title: "Live" },
    ]);
    expect(checkRuns[0]!.body).toMatchObject({ name: "Intar / deploy", head_sha: SHA_A });
    expect(checkRuns[2]!.body.output.summary).toBe(
      "- acme-web (x86_64): succeeded, succeeded\n- acme-db (x86_64): queued, queued",
    );
    expect(await checkRunId(SHA_A)).toBe(901);
    // Every check-run call carries the installation token, never the App JWT.
    expect(
      githubRequests
        .filter((request) => request.url.includes("/check-runs"))
        .map((request) => request.authorization),
    ).toEqual(Array(4).fill("Bearer ghs_test"));
  });

  it("shows a failed build's phase and redacted error, and no host data", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    await db().insert(agentHosts).values({
      id: "builder-7f3a",
      userId: OWNER,
      name: "builder-7f3a.fleet.internal",
      createdAt: 1,
      updatedAt: 1,
    });
    await db().update(imageBuilds).set({
      status: "failed",
      phase: "building_base",
      hostId: "builder-7f3a",
      error: "failed to unpack '/var/lib/intar-builder/revs/x/bundle.tar.gz': disk full (/dev/nvme0n1)",
    });

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "failed" });
    expect(checkRuns.at(-1)).toEqual({
      call: "PATCH 901",
      body: {
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Failed",
          summary:
            "image build acme-web (x86_64) failed: failed to unpack '&lt;path&gt;': disk full (&lt;path&gt;)\n" +
            "- acme-web (x86_64): failed, building_base: failed to unpack '&lt;path&gt;': disk full (&lt;path&gt;)",
        },
      },
    });
    expect(JSON.stringify(checkRuns)).not.toMatch(/builder-7f3a|fleet|\/var\/|\/dev\//);
  });

  it("waits for active runs without showing them", async () => {
    await liveWeb();
    vi.restoreAllMocks();
    github();
    await seedLearner();
    await startRun("run-1");

    await deliver({ sha: SHA_B, scenarioIds: [] });

    expect(await commitState(SHA_B)).toMatchObject({ state: "waiting" });
    expect(checkRuns).toEqual([
      {
        call: "POST",
        body: {
          name: "Intar / deploy",
          head_sha: SHA_B,
          status: "in_progress",
          output: { title: "Waiting", summary: "active runs would lose access" },
        },
      },
    ]);
  });

  it("closes the check of a commit the head replaced before showing the new head", async () => {
    github();
    await deliver({ sha: SHA_A });
    await deliver({ sha: SHA_B, hash: HASH_B });

    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(shownChecks()).toEqual([
      { call: "POST", status: "in_progress", title: "Building 0/1" },
      {
        call: "PATCH 901",
        status: "completed",
        conclusion: "neutral",
        title: "Superseded by a newer commit",
      },
      { call: "POST", status: "in_progress", title: "Building 0/1" },
    ]);
    expect(checkRuns[2]!.body.head_sha).toBe(SHA_B);
    expect(await checkRunId(SHA_B)).toBe(902);
  });

  it("closes the check of a row the head left outside a promotion", async () => {
    github();
    await deliver({ sha: SHA_A });
    // A row on the live rev that is not live stays where observe leaves it.
    await db().update(scenarioSourceCommits).set({ state: "waiting" });
    await db().update(scenarioSources).set({ liveRev: rev(SHA_A) });
    await deliver({ sha: SHA_B, hash: HASH_B });

    expect(await commitState(SHA_A)).toMatchObject({ state: "waiting" });
    expect(shownChecks()).toEqual([
      { call: "POST", status: "in_progress", title: "Building 0/1" },
      {
        call: "PATCH 901",
        status: "completed",
        conclusion: "neutral",
        title: "Superseded by a newer commit",
      },
      { call: "POST", status: "in_progress", title: "Building 0/1" },
    ]);
  });

  it("shows a commit of 100 scenarios within D1's 100 bound parameters", async () => {
    github();
    const scenarioIds = Array.from({ length: 100 }, (_, index) => `acme-s${index}`);
    await stage({
      scenarioIds,
      meta: {
        scenarios: scenarioIds.map((id, index) => ({
          scenario_id: id,
          arch: "x86_64",
          content_hash: String(index).padStart(64, "0"),
        })),
      },
    });
    await insertCommit(SHA_A, "ingesting");
    await tick();
    await publish(SHA_A, { scenarioIds: ["acme-s0"] });
    // D1 refuses a statement over 100 bound parameters; the local SQLite does not.
    const limited = <T extends object>(target: T, wrap: (key: PropertyKey, value: unknown) => unknown) =>
      new Proxy(target, {
        get(object, key) {
          const value = Reflect.get(object, key, object);
          return wrap(key, typeof value === "function" ? value.bind(object) : value);
        },
      });
    const DB = limited(env.DB, (key, prepare) =>
      key !== "prepare"
        ? prepare
        : (query: string) =>
            limited((prepare as D1Database["prepare"])(query), (name, bind) =>
              name !== "bind"
                ? bind
                : (...values: unknown[]) => {
                    if (values.length > 100) throw new Error("too many SQL variables");
                    return (bind as D1PreparedStatement["bind"])(...values);
                  },
            ),
    );
    await tick({ DB });

    expect(shownChecks()).toEqual([
      { call: "POST", status: "in_progress", title: "Building 0/100" },
      { call: "PATCH 901", status: "in_progress", title: "Building 1/100" },
    ]);
  });

  it("shows a head that waits to be delivered again as queued", async () => {
    github();
    await insertCommit(SHA_A, "ingesting");
    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(checkRuns.map(({ body }) => [body.status, body.output])).toEqual([
      ["queued", { title: "Queued", summary: "the staged bundle is gone" }],
    ]);
  });

  it("re-runs a failed commit through the check_run webhook on a new check run", async () => {
    github();
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    await db().update(imageBuilds).set({ status: "failed", error: "boom" });
    await tick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "failed" });

    const body = JSON.stringify({
      action: "rerequested",
      check_run: { id: await checkRunId(SHA_A) },
      installation: { id: 7 },
      repository: { id: 42 },
    });
    const response = await handleGitHubWebhook(
      new Request(`https://intar.dev${GITHUB_WEBHOOK_PATH}`, {
        method: "POST",
        headers: { "x-github-event": "check_run", "x-hub-signature-256": await sign(body) },
        body,
      }),
      env,
    );
    expect(response.status).toBe(204);
    expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });

    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    expect(shownChecks()).toEqual([
      { call: "POST", status: "in_progress", title: "Building 0/1" },
      { call: "PATCH 901", status: "completed", conclusion: "failure", title: "Failed" },
      { call: "POST", status: "in_progress", title: "Building 0/1" },
    ]);
    expect(await checkRunId(SHA_A)).toBe(902);
  });

  it("sends a state again after GitHub refused it", async () => {
    github({
      "POST /repos/acme/labs/check-runs": () => new Response(null, { status: 502 }),
    });
    await stage();
    await insertCommit(SHA_A, "ingesting");
    await tick();
    await tick();
    expect(await checkRunId(SHA_A)).toBeNull();
    // Only the refused send wants the alarm again.
    expect(await tick()).not.toBeNull();

    vi.restoreAllMocks();
    github();
    expect(await tick()).toBeNull();
    expect(shownChecks()).toEqual([{ call: "POST", status: "in_progress", title: "Building 0/1" }]);
    expect(await checkRunId(SHA_A)).toBe(901);
  });

  it("leaves the check of a repository the scope was bound to before", async () => {
    github();
    await deliver({ sha: SHA_A });
    // A reconnect re-binds the same scope to acme/other (id 43).
    await db()
      .update(scenarioSources)
      .set({ githubRepositoryId: 43, githubRepository: "acme/other", headSha: SHA_B });
    await db().insert(scenarioSourceCommits).values({
      id: "commit-other",
      scopeKey,
      purpose: "deploy",
      sha: SHA_B,
      rev: `git-43-${SHA_B}-${digest}`,
      via: "push",
      state: "ingesting",
    });

    await tick();
    await tick();

    expect(await commitState(SHA_A)).toMatchObject({ state: "superseded" });
    expect(githubCalls.filter((call) => call.includes("/check-runs"))).toEqual([
      "POST /repos/acme/labs/check-runs",
      "POST /repos/acme/other/check-runs",
    ]);
  });
});
