/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioSourceDO } from "@/control-plane/scenario-source-do";
import { sweepScenarioSources } from "@/control-plane/scenario-source-do";
import { normalizeCourseCatalogSnapshot } from "@/control-plane/image-registry/bundle";
import {
  agentHosts,
  courseCatalogs,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  scenarioRuns,
  scenarioSourceCommits,
  scenarioSources,
  user,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { SOURCE_COMPILER_VERSION } from "@/generated/constants";
import { queueImageBuildsFromBundle } from "@/lib/build-scheduler";
import { IMAGE_BUILD_FORMAT_VERSION, platformCompileDigest } from "@/lib/image-build-format";
import { setRegistryPause } from "@/lib/image-registry-admission";
import {
  countUnitGuardRuns,
  loadScenarioSource,
  scenarioSourceScope,
  stagedSourceObjectPrefix,
} from "@/lib/scenario-sources";
import { buildTar, gzipBytes } from "@/lib/tar";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const stageLock = vi.hoisted(() => ({ locked: false }));
vi.mock("@/lib/scenario-catalog-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scenario-catalog-candidates")>();
  return {
    ...actual,
    stageReusableCandidateManifests: async (
      ...args: Parameters<typeof actual.stageReusableCandidateManifests>
    ) => {
      if (stageLock.locked) {
        const { appError } = await import("@/lib/app-error");
        throw appError(409, "candidate_source_locked", "locked");
      }
      return actual.stageReusableCandidateManifests(...args);
    },
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
const guard = vi.hoisted(() => ({ before: undefined as (() => Promise<void>) | undefined }));
vi.mock("@/lib/scenario-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scenario-sources")>();
  return {
    ...actual,
    countUnitGuardRuns: async (...args: Parameters<typeof actual.countUnitGuardRuns>) => {
      await guard.before?.();
      return actual.countUnitGuardRuns(...args);
    },
  };
});

const ORG = "org-a";
const SCOPE = `organization:${ORG}`;
const OWNER = "owner";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

let appEnv: Record<string, string>;
let scopeKey: string;
let digest: string;
let headSha: string;
let githubCalls: string[];

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
  promotion.calls = 0;
  promotion.before = undefined;
  promotion.after = undefined;
  guard.before = undefined;
  scopeKey = SCOPE;
  headSha = SHA_A;
  githubCalls = [];
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

type Route = () => Response | Promise<Response>;

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
    ...overrides,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    githubCalls.push(key);
    return (await routes[key]?.()) ?? new Response(null, { status: 404 });
  });
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

function catalog(scenarioIds: string[]) {
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
              title: "Lecture",
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
  hash?: string;
  scope?: string;
  meta?: Record<string, unknown>;
  archiveCatalog?: unknown;
  extraFiles?: Array<[string, Uint8Array]>;
}

/** A compiled commit's meta and bundle, as the producers stage them. */
async function stage(commit: Commit = {}): Promise<void> {
  const sha = commit.sha ?? SHA_A;
  const at = commit.digest ?? digest;
  const scenarioIds = commit.scenarioIds ?? ["acme-web"];
  const courseCatalog = catalog(scenarioIds);
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

describe("ScenarioSourceDO public binding", () => {
  const ADMIN = "platform-admin";

  beforeEach(async () => {
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
  });

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
async function publish(sha: string) {
  const open = await db().select().from(imageBuilds);
  for (const build of open.filter((row) => row.status !== "succeeded")) {
    const manifest = scenarioManifest(build.scenarioId);
    await db()
      .update(imageBuilds)
      .set({ status: "succeeded", phase: "succeeded", publishedManifestJson: manifest })
      .where(eq(imageBuilds.id, build.id));
    await db().insert(scenarioCatalogCandidates).values({
      id: `${ORG}:${rev(sha)}:${build.scenarioId}`,
      revision: rev(sha),
      organizationId: ORG,
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
});

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
