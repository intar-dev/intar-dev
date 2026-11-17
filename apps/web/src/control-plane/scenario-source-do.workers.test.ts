/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import { GITHUB_WEBHOOK_PATH, handleGitHubWebhook } from "@/control-plane/github-webhook";
import { stateReport } from "@/control-plane/host-runtime-do/test-fixtures";
import type { ScenarioSourceDO } from "@/control-plane/scenario-source-do";
import { sweepScenarioSources } from "@/control-plane/scenario-source-do";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentBootstrapTokens,
  agentHosts,
  hostActualState,
  hostDesiredState,
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
  user,
} from "@/db/schema";
import {
  AGENT_SOURCES_PATH,
  SOURCE_BUNDLE_FIELD,
  SOURCE_META_FIELD,
} from "@/generated/constants";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import { mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { BUILDER_REASSIGN_AFTER_MS, syncBuilderDesiredState } from "@/lib/machine-builds";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { stagedSourceObjectPrefix } from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const SCOPE = `organization:${ORG}`;
const OWNER = "owner";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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
  digest = await sourceCompileDigest();
});

beforeEach(async () => {
  await resetD1Database();
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

interface Commit {
  sha?: string;
  digest?: string;
}

/** A compiled commit, staged as the producers stage it. */
async function stage(commit: Commit = {}): Promise<void> {
  const sha = commit.sha ?? SHA_A;
  const at = commit.digest ?? digest;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    `${prefix(sha, at)}bundle.json.gz`,
    new Uint8Array(gzipSync(JSON.stringify(bundleFixture))),
  );
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
      helloJson: JSON.stringify({ builder: { source_compile_digest: platform } }),
    });
    await mutateHostDesiredStateV3(db(), hostId, now, () => {});
    const report = stateReport(hostId, { observedAt: now, appliedDesiredVersion: 0 }).report;
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
        { compile_id: row!.id, attempt: 1, rev: rev(SHA_A), validate_only: false },
      ],
    });
    expect(woken).toEqual(["builder-1"]);
    expect(await desired("builder-old")).toEqual({ version: 0, compiles: [] });

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
    expect(await desired("builder-1")).toMatchObject({ version: 2, compiles: [] });
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
    expect(await desired("builder-1")).toEqual({ version: 0, compiles: [] });
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
    expect((await desired("builder-1"))?.compiles).toEqual([]);
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

  it("takes an organization pull commit from its v2 compile result to building revisions", async () => {
    await seedBuilder("builder-2");
    await db().update(agentHosts).set({ connected: false }).where(eq(agentHosts.id, "builder-1"));
    github(tarball(SHA_A));

    await pullTick();
    const [row] = await rows();
    expect(row).toMatchObject({ rev: rev(SHA_A), state: "compiling", compileHostId: "builder-2" });

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
        headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
        body: JSON.stringify({ hostId: "builder-2", bootstrapToken: "builder-2-token" }),
      }),
      env,
    );
    const { accessToken } = (await bootstrap.json()) as { accessToken: string };
    const form = new FormData();
    form.set(SOURCE_META_FIELD, JSON.stringify({ rev: rev(SHA_A) }));
    form.set(SOURCE_BUNDLE_FIELD, new Blob([new Uint8Array(gzipSync(JSON.stringify(bundleFixture)))]), `${rev(SHA_A)}.json.gz`);
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
      { ...env, HOST_RUNTIME: hostRuntime } as unknown as Cloudflare.Env,
    );
    expect(result?.status, await result?.clone().text()).toBe(202);
    expect(await commitState(SHA_A)).toMatchObject({ state: "ingesting" });

    await pullTick();
    expect(await commitState(SHA_A)).toMatchObject({ state: "building" });
    expect(await env.DB.prepare("SELECT scenario_id, state FROM scenario_revisions WHERE rev = ?1")
      .bind(rev(SHA_A)).all().then((all) => all.results)).toEqual([{ scenario_id: "acme/broken-nginx", state: "building" }]);
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

  it("mirrors a compiling row into its builder's desired state and drops a stale one", async () => {
    await insertCommit(SHA_A, "compiling", {
      via: "pull",
      attempt: 1,
      compileHostId: "builder-1",
      compileAssignedAt: Date.now(),
    });
    await mutateHostDesiredStateV3(db(), "builder-1", Date.now(), () => {});
    await syncBuilderDesiredState(env, "builder-1", Date.now());
    expect((await desired("builder-1"))?.compiles).toEqual([
      { compile_id: "commit-a", attempt: 1, rev: rev(SHA_A), validate_only: false },
    ]);

    await db().update(scenarioSourceCommits).set({ state: "superseded" });
    await syncBuilderDesiredState(env, "builder-1", Date.now());
    expect(await desired("builder-1")).toEqual({ version: 2, compiles: [] });
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
    expect(await stagedKeys(SHA_B)).toHaveLength(1);

    await sweepScenarioSources(cronEnv, Date.now() + 11 * 60_000);
    expect(await stagedKeys(SHA_A)).toHaveLength(1);
    expect(await stagedKeys(SHA_B)).toEqual([]);
  });
});
