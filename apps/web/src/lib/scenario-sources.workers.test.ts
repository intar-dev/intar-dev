/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageBuilds,
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import {
  BIND_REFUSAL_MESSAGE,
  changeScenarioSource,
  loadScenarioSource,
  redactHostPaths,
  refuseScenarioSourceWrite,
  scenarioSourceBindingPredicate,
  scenarioSourceScope,
  type ScenarioSourceEnv,
} from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const ORG_SCOPE = scenarioSourceScope(ORG);
const PUBLIC_SCOPE = scenarioSourceScope(null);
const OWNER = "owner";
const GITHUB_ID = "1001";
const LIVE_REV = `git-9-${"b".repeat(40)}-digest`;
const enabled = new StaticFeatureToggleService({ scenario_git_sources: true });
const disabled = new StaticFeatureToggleService();

type Route = () => Response;
let appEnv: ScenarioSourceEnv;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  appEnv = {
    GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
    PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID: "42",
  };
});

beforeEach(async () => {
  await resetD1Database();
  const db = drizzle(env.DB);
  await createFixtureMember({ d1: env.DB, userId: OWNER, githubAccountId: GITHUB_ID });
  await db.insert(organization).values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date() });
  await db.insert(member).values({
    id: "owner-member",
    organizationId: ORG,
    userId: OWNER,
    role: "owner",
    createdAt: new Date(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** GitHub for one repository `acme/labs` (id 42) with overrides per route. */
function github(overrides: Record<string, Route> = {}, accountId = GITHUB_ID) {
  const routes: Record<string, Route> = {
    "GET /repos/acme/labs/installation": () => Response.json({ id: 7 }),
    "POST /app/installations/7/access_tokens": () =>
      Response.json({ token: "ghs_test" }, { status: 201 }),
    "GET /installation/repositories": () =>
      Response.json({
        repositories: [{ id: 42, full_name: "acme/labs", default_branch: "main" }],
      }),
    "GET /repos/acme/labs/git/ref/heads/main": () =>
      Response.json({ object: { sha: "a".repeat(40) } }),
    [`GET /user/${accountId}`]: () =>
      Response.json({ id: Number(accountId), login: "octo" }),
    "GET /repos/acme/labs/collaborators/octo/permission": () =>
      Response.json({ permission: "admin", user: { id: Number(accountId) } }),
    ...overrides,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    return route ? route() : new Response(null, { status: 404 });
  });
}

function change(
  body: unknown,
  options: {
    scope?: typeof ORG_SCOPE;
    actorUserId?: string;
    startedAt?: number;
    toggles?: StaticFeatureToggleService;
  } = {},
) {
  return changeScenarioSource({
    scope: options.scope ?? ORG_SCOPE,
    actorUserId: options.actorUserId ?? OWNER,
    body,
    startedAt: options.startedAt ?? Date.now(),
    toggles: options.toggles ?? enabled,
    appEnv,
  });
}

async function insertBinding(
  values: Partial<typeof scenarioSources.$inferInsert> = {},
) {
  await drizzle(env.DB)
    .insert(scenarioSources)
    .values({
      scopeKey: ORG_SCOPE.key,
      organizationId: ORG,
      githubInstallationId: 3,
      githubRepositoryId: 9,
      githubRepository: "acme/old",
      defaultBranch: "main",
      boundByUserId: OWNER,
      ...values,
    });
}

async function binding(scopeKey = ORG_SCOPE.key) {
  const [row] = await drizzle(env.DB)
    .select()
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, scopeKey));
  return row;
}

describe("binding a repository", () => {
  it.each([
    ["no installation", { "GET /repos/acme/labs/installation": () => new Response(null, { status: 404 }) }],
    ["a moved repository", {
      "GET /repos/acme/labs/installation": () =>
        new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42/installation" } }),
    }],
    ["a failed mint", { "POST /app/installations/7/access_tokens": () => new Response(null, { status: 404 }) }],
    ["an unknown GitHub account", { [`GET /user/${GITHUB_ID}`]: () => new Response(null, { status: 404 }) }],
    ["a permission without a user", {
      "GET /repos/acme/labs/collaborators/octo/permission": () =>
        Response.json({ permission: "admin", user: null }),
    }],
    ["an installed repository the caller does not administer", {
      "GET /repos/acme/labs/collaborators/octo/permission": () =>
        Response.json({ permission: "write", user: { id: 1001 } }),
    }],
  ])("refuses %s uniformly, no earlier than 3 s", async (_name, overrides) => {
    github(overrides);
    const startedAt = Date.now() - 2_900;
    await expect(
      change({ action: "connect", repository: "acme/labs" }, { startedAt }),
    ).rejects.toMatchObject({
      status: 422,
      code: "scenario_source_bind_refused",
      message: BIND_REFUSAL_MESSAGE,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000);
    expect(await binding()).toBeUndefined();
  });

  it("connects a pull binding with the caller as binder", async () => {
    github();
    const view = await change({ action: "connect", repository: "acme/labs" });
    expect(view).toMatchObject({
      repository: "acme/labs",
      defaultBranch: "main",
      mode: "pull",
      pausedAt: null,
      disconnectedAt: null,
    });
    expect(await binding()).toMatchObject({
      githubInstallationId: 7,
      githubRepositoryId: 42,
      boundByUserId: OWNER,
      pokedAt: expect.any(Number),
    });
  });

  it("refuses a connected scope and a repository another scope holds", async () => {
    github();
    await insertBinding();
    await expect(
      change({ action: "connect", repository: "acme/labs" }),
    ).rejects.toMatchObject({ status: 409, code: "scenario_source_connected" });

    await drizzle(env.DB)
      .update(scenarioSources)
      .set({ disconnectedAt: 1, githubRepositoryId: 5 });
    await drizzle(env.DB).insert(scenarioSources).values({
      scopeKey: "public",
      githubInstallationId: 7,
      githubRepositoryId: 42,
      githubRepository: "acme/labs",
      defaultBranch: "main",
    });
    await expect(
      change({ action: "connect", repository: "acme/labs" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "scenario_source_repository_taken",
      message: "This repository is already connected to another Intar scope.",
    });
  });

  it("re-binds a disconnected scope and keeps its live commit", async () => {
    github();
    await insertBinding({
      mode: "push",
      headSha: "c".repeat(40),
      headObservedAt: 5,
      targetRev: "git-9-target",
      liveRev: LIVE_REV,
      liveSha: "b".repeat(40),
      liveAt: 4,
      pausedAt: 2,
      pauseReason: "suspended",
      disconnectedAt: 3,
      disconnectReason: "admin",
      boundByUserId: null,
    });
    await change({ action: "connect", repository: "acme/labs" });
    expect(await binding()).toMatchObject({
      githubInstallationId: 7,
      githubRepositoryId: 42,
      githubRepository: "acme/labs",
      mode: "pull",
      headSha: null,
      headObservedAt: 0,
      targetRev: LIVE_REV,
      liveRev: LIVE_REV,
      liveSha: "b".repeat(40),
      liveAt: 4,
      pausedAt: null,
      pauseReason: null,
      disconnectedAt: null,
      disconnectReason: null,
      boundByUserId: OWNER,
    });
  });

  it("binds public only to the pinned repository, for an active platform admin", async () => {
    github({}, "1002");
    await createFixtureMember({ d1: env.DB, userId: "operator", role: "admin", githubAccountId: "1002" });
    await expect(
      change({ action: "connect", repository: "acme/labs" }, {
        scope: PUBLIC_SCOPE,
        actorUserId: "operator",
      }),
    ).resolves.toMatchObject({ repository: "acme/labs" });

    await drizzle(env.DB).delete(scenarioSources);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = 'operator'").run();
    await expect(
      change({ action: "connect", repository: "acme/labs" }, {
        scope: PUBLIC_SCOPE,
        actorUserId: "operator",
      }),
    ).rejects.toMatchObject({ code: "scenario_source_authority_changed" });

    appEnv = { ...appEnv, PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID: "43" };
    await env.DB.prepare("UPDATE user SET banned = 0 WHERE id = 'operator'").run();
    await expect(
      change({ action: "connect", repository: "acme/labs" }, {
        scope: PUBLIC_SCOPE,
        actorUserId: "operator",
      }),
    ).rejects.toMatchObject({ code: "scenario_source_repository_not_pinned" });
    appEnv = { ...appEnv, PUBLIC_SCENARIO_SOURCE_REPOSITORY_ID: "42" };
    expect(await binding("public")).toBeUndefined();
  });

  it("resumes through the bind checks and makes the caller the binder", async () => {
    github({}, "1003");
    await createFixtureMember({ d1: env.DB, userId: "admin-2", githubAccountId: "1003" });
    await drizzle(env.DB).insert(member).values({
      id: "admin-member",
      organizationId: ORG,
      userId: "admin-2",
      role: "admin",
      createdAt: new Date(),
    });
    await insertBinding({
      githubRepositoryId: 42,
      githubRepository: "acme/labs",
      pausedAt: 1,
      pauseReason: "binder_lost_admin",
    });
    await change({ action: "resume" }, { actorUserId: "admin-2" });
    expect(await binding()).toMatchObject({
      pausedAt: null,
      pauseReason: null,
      boundByUserId: "admin-2",
      githubInstallationId: 7,
    });
  });
});

describe("scenario source changes", () => {
  it("needs the flag for bind, resume and mode, but never for pause and disconnect", async () => {
    await insertBinding();
    for (const body of [
      { action: "connect", repository: "acme/labs" },
      { action: "resume" },
      { action: "mode", mode: "push" },
    ]) {
      await expect(change(body, { toggles: disabled })).rejects.toMatchObject({
        status: 404,
      });
    }
    await change({ action: "pause" }, { toggles: disabled });
    expect(await binding()).toMatchObject({ pauseReason: "admin" });
    await change({ action: "disconnect" }, { toggles: disabled });
    expect(await binding()).toMatchObject({
      disconnectedAt: expect.any(Number),
      mode: "pull",
    });
  });

  it("lets an admin pause override a suspension but not a lost binder", async () => {
    await insertBinding({ pausedAt: 5, pauseReason: "suspended" });
    await change({ action: "pause" });
    expect(await binding()).toMatchObject({ pausedAt: 5, pauseReason: "admin" });

    await drizzle(env.DB)
      .update(scenarioSources)
      .set({ pauseReason: "binder_lost_admin" });
    await change({ action: "pause" });
    expect(await binding()).toMatchObject({ pauseReason: "binder_lost_admin" });
  });

  it("supersedes fetching and compiling rows on a mode change", async () => {
    await insertBinding();
    const db = drizzle(env.DB);
    await db.insert(scenarioSourceCommits).values(
      (["fetching", "compiling", "building", "live"] as const).map((state) => ({
        id: state,
        scopeKey: ORG_SCOPE.key,
        purpose: "deploy" as const,
        sha: "a".repeat(40),
        rev: `git-9-${state}`,
        via: "pull" as const,
        state,
      })),
    );
    await change({ action: "mode", mode: "push" });
    const states = await db
      .select({ id: scenarioSourceCommits.id, state: scenarioSourceCommits.state })
      .from(scenarioSourceCommits)
      .orderBy(scenarioSourceCommits.id);
    expect(states).toEqual([
      { id: "building", state: "building" },
      { id: "compiling", state: "superseded" },
      { id: "fetching", state: "superseded" },
      { id: "live", state: "live" },
    ]);
    expect(await binding()).toMatchObject({ mode: "push" });
  });

  it("refuses impersonated sessions and limits each user on any address", async () => {
    const counts = new Map<string, number>();
    const workerEnv = {
      ACCESS_INVITE_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { success: (counts.get(key) ?? 0) <= 20 };
        },
      },
    };
    const post = (ip: string) =>
      new Request("https://intar.dev/api/organizations/org-a/scenario-source", {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
      });
    await expect(
      refuseScenarioSourceWrite(post("192.0.2.1"), { userId: OWNER, impersonated: true }, workerEnv),
    ).rejects.toMatchObject({ status: 403, code: "impersonation_forbidden" });

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect(
        await refuseScenarioSourceWrite(post(`192.0.2.${attempt}`), { userId: OWNER }, workerEnv),
      ).toBeNull();
    }
    const refused = await refuseScenarioSourceWrite(post("198.51.100.9"), { userId: OWNER }, workerEnv);
    expect(refused?.status).toBe(429);
    expect([...counts.keys()]).toEqual([`web-edge:scenario-source:user:${OWNER}`]);
  });
});

describe("the binding predicate", () => {
  async function writable() {
    return drizzle(env.DB)
      .select({ scopeKey: scenarioSources.scopeKey })
      .from(scenarioSources)
      .where(scenarioSourceBindingPredicate());
  }

  it("matches an organization binder and refuses a demoted one", async () => {
    await insertBinding();
    expect(await writable()).toEqual([{ scopeKey: ORG_SCOPE.key }]);
    await drizzle(env.DB).update(member).set({ role: "member" });
    expect(await writable()).toEqual([]);
  });

  it("matches an active platform admin for public and refuses a paused binding", async () => {
    await createFixtureMember({ d1: env.DB, userId: "operator", role: "admin" });
    await drizzle(env.DB).insert(scenarioSources).values({
      scopeKey: "public",
      githubInstallationId: 7,
      githubRepositoryId: 42,
      githubRepository: "intar-dev/scenarios",
      defaultBranch: "main",
      boundByUserId: "operator",
    });
    expect(await writable()).toEqual([{ scopeKey: "public" }]);
    await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = 'operator'").run();
    expect(await writable()).toEqual([]);
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'operator'").run();
    await drizzle(env.DB).update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });
    expect(await writable()).toEqual([]);
  });
});

describe("the tenant projection", () => {
  it("removes absolute paths and keeps repository-relative ones", () => {
    expect(
      redactHostPaths(
        "failed to unpack '/var/lib/intar-builder/cache/git-1/bundle.tar.zst': No such file",
      ),
    ).toBe("failed to unpack '<path>': No such file");
    expect(redactHostPaths("read /tmp/work/intar.yaml failed")).toBe(
      "read <path> failed",
    );
    expect(redactHostPaths("courses/a/b/scenario.hcl:3: bad block")).toBe(
      "courses/a/b/scenario.hcl:3: bad block",
    );
  });

  it("redacts the commit detail, its diagnostics and build errors", async () => {
    const rev = `git-42-${"a".repeat(40)}-digest`;
    await insertBinding();
    await env.DB.prepare(
      "INSERT INTO image_build_bundles (rev, organization_id, r2_key, meta_json) VALUES (?1, ?2, 'key', '{}')",
    )
      .bind(rev, ORG)
      .run();
    const db = drizzle(env.DB);
    await db.insert(imageBuilds).values({
      id: "build",
      organizationId: ORG,
      scenarioId: "org-a-demo",
      arch: "x86_64",
      rev,
      contentHash: "hash",
      status: "failed",
      error: "copy '/srv/cache/org-a/disk.qcow2' failed",
    });
    await db.insert(scenarioSourceCommits).values({
      id: "commit",
      scopeKey: ORG_SCOPE.key,
      purpose: "deploy",
      sha: "a".repeat(40),
      rev,
      via: "pull",
      state: "invalid",
      detail: "compile failed in /work/unpack/x",
      diagnosticsJson: JSON.stringify([
        { path: "courses/a/b/scenario.hcl", line: 3, code: "hcl", message: "open '/work/unpack/courses/a' failed" },
      ]),
    });
    expect(await loadScenarioSource(ORG_SCOPE)).toMatchObject({
      commit: {
        state: "invalid",
        detail: "compile failed in <path>",
        diagnostics: [
          { path: "courses/a/b/scenario.hcl", line: 3, message: "open '<path>' failed" },
        ],
      },
      builds: [
        { scenarioId: "org-a-demo", status: "failed", error: "copy '<path>' failed" },
      ],
    });
  });
});
