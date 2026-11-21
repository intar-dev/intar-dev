/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  bundles,
  hostDesiredState,
  member,
  organization,
  pipelineUploadSessions,
  scenarioRevisions,
  scenarioSourceCommits,
  scenarioSources,
  scenarios,
  scopeMachineImages,
} from "@/db/schema";
import { pipelinePlan } from "@/lib/pipeline-revisions";
import { arm64MachineImages } from "@/lib/scenario-runs/revision-begin";
import { mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { syncBuilderDesiredState } from "@/lib/machine-builds";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import {
  BIND_REFUSAL_MESSAGE,
  changeScenarioSource,
  loadScenarioSource,
  redactHostPaths,
  refuseScenarioSourceWrite,
  scenarioSourceBindingPredicate,
  scenarioSourceCard,
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
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
    asPlatform?: boolean;
  } = {},
) {
  return changeScenarioSource({
    scope: options.scope ?? ORG_SCOPE,
    actorUserId: options.actorUserId ?? OWNER,
    body,
    startedAt: options.startedAt ?? Date.now(),
    toggles: options.toggles ?? enabled,
    appEnv,
    ...(options.asPlatform ? { asPlatform: true } : {}),
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

  it("connects a push binding with the caller as binder", async () => {
    github();
    const view = await change({ action: "connect", repository: "acme/labs" });
    expect(view).toMatchObject({
      repository: "acme/labs",
      defaultBranch: "main",
      mode: "push",
      imageProducer: "builder",
      promotion: "manual",
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
      mode: "pull",
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
      // Whatever it was before, a source that is bound again publishes by push.
      mode: "push",
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

  it("drops a fetch or compile a pull source left in flight when it is bound again", async () => {
    github();
    await insertBinding({ mode: "pull", disconnectedAt: 3, disconnectReason: "admin" });
    const rows = (state: string) => ({
      id: state, scopeKey: ORG_SCOPE.key, purpose: "deploy" as const, sha: state.padEnd(40, "0"),
      rev: `git-9-${state}`, via: "pull" as const, state: state as "fetching",
    });
    await drizzle(env.DB).insert(scenarioSourceCommits).values([rows("fetching"), rows("compiling"), rows("building")]);
    await change({ action: "connect", repository: "acme/labs" });
    const states = await drizzle(env.DB).select({ id: scenarioSourceCommits.id, state: scenarioSourceCommits.state })
      .from(scenarioSourceCommits).orderBy(scenarioSourceCommits.id);
    expect(states).toEqual([
      { id: "building", state: "building" }, { id: "compiling", state: "superseded" }, { id: "fetching", state: "superseded" },
    ]);
  });

  it("waits for a purge of the last repository before re-binding", async () => {
    github();
    await insertBinding({ disconnectedAt: 3, disconnectReason: "purging" });
    await expect(
      change({ action: "connect", repository: "acme/labs" }),
    ).rejects.toMatchObject({ status: 409, code: "scenario_source_purging" });
    expect(await binding()).toMatchObject({ disconnectReason: "purging", githubRepositoryId: 9 });
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

  it("resumes a renamed repository through a token minted by its bound id", async () => {
    const fetch = github();
    await insertBinding({
      githubInstallationId: 7,
      githubRepositoryId: 42,
      githubRepository: "acme/old",
      pausedAt: 1,
      pauseReason: "binder_lost_admin",
    });
    await change({ action: "resume" });
    expect(await binding()).toMatchObject({
      pausedAt: null,
      githubRepository: "acme/labs",
    });
    const mints = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith("/app/installations/7/access_tokens"),
    );
    expect(mints).toHaveLength(1);
    expect(JSON.parse(String(mints[0]?.[1]?.body))).toMatchObject({
      repository_ids: [42],
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

  it("supersedes fetching and compiling rows on a mode change and ends the compile", async () => {
    await insertBinding();
    const db = drizzle(env.DB);
    await db.insert(agentHosts).values({
      id: "builder-1", userId: OWNER, name: "builder-1", role: "builder", scope: "platform",
    });
    await db.insert(scenarioSourceCommits).values(
      (["fetching", "compiling", "building", "live"] as const).map((state, index) => ({
        id: state,
        scopeKey: ORG_SCOPE.key,
        purpose: "deploy" as const,
        sha: "a".repeat(40),
        rev: `git-9-${"a".repeat(40)}-p0000000${index}`,
        via: "pull" as const,
        state,
        ...(state === "compiling" ? { compileHostId: "builder-1", attempt: 1 } : {}),
      })),
    );
    await mutateHostDesiredStateV3(db, "builder-1", Date.now(), () => {});
    await syncBuilderDesiredState(env, "builder-1", Date.now());
    const compiles = async () =>
      (await db.select().from(hostDesiredState))[0]?.docJson.source_compiles;
    expect(await compiles()).toHaveLength(1);

    await change({ action: "mode", mode: "push" });

    // The builder kills the compile once its entry leaves.
    expect(await compiles()).toEqual([]);
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

describe("a source's settings", () => {
  const ADMIN = "platform-admin";
  const KEY = `sha256:${"c".repeat(64)}`;
  const REV = `git-9-${"a".repeat(40)}-digest`;
  const pipelineOn = new StaticFeatureToggleService({ scenario_git_sources: true, scenario_pipeline_images: true });
  // The organization's owner changes its settings; a platform administrator
  // who is not one of its own only steps it back.
  const as = (body: unknown, toggles: StaticFeatureToggleService = pipelineOn, actorUserId = OWNER) =>
    change(body, { actorUserId, toggles });
  const platform = (body: unknown, toggles: StaticFeatureToggleService = pipelineOn, actorUserId = ADMIN) =>
    change(body, { actorUserId, toggles, asPlatform: true });
  const db = () => drizzle(env.DB);

  beforeEach(async () => {
    await createFixtureMember({ d1: env.DB, userId: ADMIN, role: "admin", githubAccountId: "1000" });
  });

  /** A pipeline's bundle of `REV` with one building revision and its building commit row. */
  async function pipelineHead(producer: "pipeline" | "builder" = "pipeline") {
    await db().insert(bundles).values({
      rev: REV, scopeKey: ORG_SCOPE.key, organizationId: ORG, compilerVersion: "c", r2Key: "k", imageProducer: producer,
    });
    await db().insert(scenarios).values({
      id: `${ORG}/lab`, namespace: ORG, slug: "lab", organizationId: ORG, scopeKey: ORG_SCOPE.key, enabled: true, play: false,
    });
    await db().insert(scenarioRevisions).values({
      scenarioId: `${ORG}/lab`, rev: REV, guestContract: 3, state: "building",
      docJson: { machines: [{ name: "m", build_key: KEY, image_digest: null }] } as never,
    });
    await db().insert(scenarioSourceCommits).values({
      id: "head", scopeKey: ORG_SCOPE.key, purpose: "deploy", sha: "a".repeat(40), rev: REV, via: "push", state: "building",
    });
  }
  const image = (architecture: "amd64" | "arm64", imageDigest = `sha256:${"1".repeat(64)}`, scopeKey = ORG_SCOPE.key) =>
    db().insert(scopeMachineImages).values({
      scopeKey, buildKey: KEY, architecture, imageDigest, imageFormat: "intar-image-4", sizeBytes: 1,
      githubRepositoryId: 9, githubRepository: "acme/old", sha: "a".repeat(40), runId: "1", runAttempt: 1,
      runnerEnvironment: "github-hosted", jobWorkflowSha: "w",
    });

  it("are its scope's administrators' alone: not a platform administrator's, a member's or a stranger's", async () => {
    await insertBinding({ mode: "push" });
    await image("amd64");
    const everyFlag = new StaticFeatureToggleService({
      scenario_git_sources: true, scenario_pipeline_images: true, scenario_automatic_promotion: true,
    });
    const bodies = [
      { action: "image_producer", producer: "pipeline" },
      { action: "image_producer", producer: "builder" },
      { action: "runner_policy", allow_self_hosted: true },
      { action: "promotion", promotion: "automatic" },
      { action: "promotion", promotion: "manual" },
      { action: "forget_image", build_key: KEY, architecture: "amd64" },
    ];
    // A platform administrator is not one of the organization's.
    for (const body of bodies) {
      await expect(as(body, everyFlag, ADMIN)).rejects.toMatchObject({ status: 404, code: "not_found" });
    }
    // Nor is the owner once they are a plain member.
    await db().update(member).set({ role: "member" }).where(eq(member.userId, OWNER));
    for (const body of bodies) {
      await expect(as(body, everyFlag)).rejects.toMatchObject({ status: 404, code: "not_found" });
    }
    expect(await binding()).toMatchObject({ imageProducer: "builder", allowSelfHostedRunners: false, promotion: "manual" });
    expect(await db().select().from(scopeMachineImages)).toHaveLength(1);

    // The owner again: each one goes through.
    await db().update(member).set({ role: "owner" }).where(eq(member.userId, OWNER));
    expect(await as(bodies[0], everyFlag)).toMatchObject({ imageProducer: "pipeline" });
    expect(await as(bodies[2], everyFlag)).toMatchObject({ allowSelfHostedRunners: true });
    expect(await as(bodies[3], everyFlag)).toMatchObject({ promotion: "automatic" });
    await as(bodies[5], everyFlag);
    expect(await db().select().from(scopeMachineImages)).toEqual([]);
    for (const body of [
      { action: "image_producer", producer: "host" },
      { action: "runner_policy", allow_self_hosted: "yes" },
      { action: "promotion", promotion: "always" },
      { action: "forget_image", build_key: "latest", architecture: "amd64" },
      { action: "forget_image", build_key: KEY, architecture: "riscv" },
    ]) {
      await expect(as(body)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("are a platform administrator's on the platform's own source, as before, and nobody else's", async () => {
    const everyFlag = new StaticFeatureToggleService({
      scenario_git_sources: true, scenario_pipeline_images: true, scenario_automatic_promotion: true,
    });
    await db().insert(scenarioSources).values({
      scopeKey: "public", organizationId: null, githubInstallationId: 8, githubRepositoryId: 42,
      githubRepository: "intar/labs", defaultBranch: "main", mode: "push", boundByUserId: ADMIN,
    });
    await image("amd64", `sha256:${"2".repeat(64)}`, "public");
    const onPublic = (body: unknown, actorUserId: string) =>
      change(body, { scope: PUBLIC_SCOPE, actorUserId, toggles: everyFlag });
    const bodies = [
      { action: "image_producer", producer: "pipeline" },
      { action: "runner_policy", allow_self_hosted: true },
      { action: "promotion", promotion: "automatic" },
      { action: "forget_image", build_key: KEY, architecture: "amd64" },
    ];
    // An organization's owner is nobody on the platform's source.
    for (const body of bodies) {
      await expect(onPublic(body, OWNER)).rejects.toMatchObject({ status: 404, code: "not_found" });
    }
    expect(await binding("public")).toMatchObject({ imageProducer: "builder", allowSelfHostedRunners: false, promotion: "manual" });
    expect(await onPublic(bodies[0], ADMIN)).toMatchObject({ imageProducer: "pipeline" });
    expect(await onPublic(bodies[1], ADMIN)).toMatchObject({ allowSelfHostedRunners: true });
    expect(await onPublic(bodies[2], ADMIN)).toMatchObject({ promotion: "automatic" });
    await onPublic(bodies[3], ADMIN);
    expect(await db().select().from(scopeMachineImages)).toEqual([]);
    // Pull mode is theirs here too, once the builder builds again.
    await onPublic({ action: "image_producer", producer: "builder" }, ADMIN);
    expect(await onPublic({ action: "mode", mode: "pull" }, ADMIN)).toMatchObject({ mode: "pull" });
  });

  it("keeps one organization's administrator out of another's source, and its images apart", async () => {
    const everyFlag = new StaticFeatureToggleService({
      scenario_git_sources: true, scenario_pipeline_images: true, scenario_automatic_promotion: true,
    });
    await insertBinding({ mode: "push" });
    // The owner of another organization.
    await createFixtureMember({ d1: env.DB, userId: "other-owner" });
    await db().insert(organization).values({ id: "org-b", name: "Other", slug: "other", createdAt: new Date() });
    await db().insert(member).values({ id: "m-other", organizationId: "org-b", userId: "other-owner", role: "owner", createdAt: new Date() });
    await image("amd64");
    await image("amd64", `sha256:${"3".repeat(64)}`, "organization:org-b");
    for (const body of [
      { action: "image_producer", producer: "pipeline" },
      { action: "runner_policy", allow_self_hosted: true },
      { action: "promotion", promotion: "automatic" },
      { action: "forget_image", build_key: KEY, architecture: "amd64" },
      { action: "pause" },
    ]) {
      await as(body, everyFlag, "other-owner").then(
        () => undefined, (error: unknown) => expect(error).toMatchObject({ status: 404 }),
      );
    }
    expect(await binding()).toMatchObject({ imageProducer: "builder", allowSelfHostedRunners: false, promotion: "manual", pausedAt: null });
    expect(await db().select().from(scopeMachineImages)).toHaveLength(2);
    // The organization's own owner forgets its image: the other scope's, of the same key, stays.
    await as({ action: "forget_image", build_key: KEY, architecture: "amd64" }, everyFlag);
    expect((await db().select().from(scopeMachineImages)).map((row) => row.scopeKey)).toEqual(["organization:org-b"]);
  });

  it("lets a platform administrator step any organization's source back, and nothing more", async () => {
    const everyFlag = new StaticFeatureToggleService({
      scenario_git_sources: true, scenario_pipeline_images: true, scenario_automatic_promotion: true,
    });
    await insertBinding({ mode: "push", imageProducer: "pipeline", allowSelfHostedRunners: true, promotion: "automatic" });
    await image("amd64");
    // What widens, connects or removes is the organization's own to do.
    for (const body of [
      { action: "image_producer", producer: "pipeline" },
      { action: "runner_policy", allow_self_hosted: true },
      { action: "promotion", promotion: "automatic" },
      { action: "mode", mode: "push" },
      { action: "resume" },
      { action: "disconnect" },
      { action: "purge" },
      { action: "connect", repository: "acme/labs" },
    ]) {
      await expect(platform(body, everyFlag)).rejects.toMatchObject({ status: 400, code: "scenario_source_change_invalid" });
    }
    // Not for someone who is no platform administrator, whatever they are in the organization.
    for (const body of [
      { action: "promotion", promotion: "manual" },
      { action: "runner_policy", allow_self_hosted: false },
      { action: "image_producer", producer: "builder" },
      { action: "forget_image", build_key: KEY, architecture: "amd64" },
      { action: "mode", mode: "pull" },
    ]) {
      await expect(platform(body, everyFlag, OWNER)).rejects.toMatchObject({ status: 404 });
    }
    // A pause is the owner's own on their route, but not through the platform's rights.
    await expect(platform({ action: "pause" }, everyFlag, OWNER)).rejects.toMatchObject({ status: 404 });
    expect(await binding()).toMatchObject({ pausedAt: null });
    expect(await binding()).toMatchObject({ imageProducer: "pipeline", allowSelfHostedRunners: true, promotion: "automatic", pausedAt: null });

    // Every step back, with every flag off.
    expect(await platform({ action: "promotion", promotion: "manual" }, disabled)).toMatchObject({ promotion: "manual" });
    expect(await platform({ action: "runner_policy", allow_self_hosted: false }, disabled)).toMatchObject({ allowSelfHostedRunners: false });
    expect(await platform({ action: "image_producer", producer: "builder" }, disabled)).toMatchObject({ imageProducer: "builder" });
    await platform({ action: "forget_image", build_key: KEY, architecture: "amd64" }, disabled);
    expect(await db().select().from(scopeMachineImages)).toEqual([]);
    expect(await platform({ action: "pause" }, disabled)).toMatchObject({ pauseReason: "admin" });
    // Pull mode too, with every flag off.
    expect(await platform({ action: "mode", mode: "pull" }, disabled)).toMatchObject({ mode: "pull" });
  });

  it("leaves pull mode to the platform: an organization's administrator cannot switch to it", async () => {
    await insertBinding({ mode: "push" });
    await expect(as({ action: "mode", mode: "pull" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await binding()).toMatchObject({ mode: "push" });
    expect(await platform({ action: "mode", mode: "pull" })).toMatchObject({ mode: "pull" });
    // Back to push is the organization's own again.
    expect(await as({ action: "mode", mode: "push" })).toMatchObject({ mode: "push" });
  });

  it("puts an organization on automatic promotion whatever public-play grant row it still has", async () => {
    const promotionOn = new StaticFeatureToggleService({ scenario_git_sources: true, scenario_automatic_promotion: true });
    await insertBinding({ mode: "push" });
    await env.DB.prepare("INSERT INTO organization_entitlements (organization_id, public_play_granted_at) VALUES (?1, 1)").bind(ORG).run();
    expect(await as({ action: "promotion", promotion: "automatic" }, promotionOn)).toMatchObject({ promotion: "automatic" });
    expect(await binding()).toMatchObject({ promotion: "automatic" });
  });

  it("starts an organization that may use its pipeline on it, and every other source on the builder", async () => {
    github();
    await change({ action: "connect", repository: "acme/labs" }, { toggles: pipelineOn });
    expect(await binding()).toMatchObject({ mode: "push", imageProducer: "pipeline" });
    // Bound again without the flag: on the builder, whatever it was.
    await db().update(scenarioSources).set({ disconnectedAt: 1, disconnectReason: "admin" });
    await change({ action: "connect", repository: "acme/labs" }, { toggles: enabled });
    expect(await binding()).toMatchObject({ mode: "push", imageProducer: "builder", disconnectedAt: null });
    // And bound again with it: on its pipeline.
    await db().update(scenarioSources).set({ disconnectedAt: 1, disconnectReason: "admin" });
    await change({ action: "connect", repository: "acme/labs" }, { toggles: pipelineOn });
    expect(await binding()).toMatchObject({ imageProducer: "pipeline", disconnectedAt: null });
  });

  it("needs its flag only for what widens: a pipeline and self-hosted runners", async () => {
    await insertBinding({ mode: "push" });
    // `enabled` has the sources flag only; `disabled` has none.
    await expect(as({ action: "image_producer", producer: "pipeline" }, enabled)).rejects.toMatchObject({ status: 404 });
    await expect(as({ action: "runner_policy", allow_self_hosted: true }, disabled)).rejects.toMatchObject({ status: 404 });
    expect(await binding()).toMatchObject({ imageProducer: "builder", allowSelfHostedRunners: false });

    expect(await as({ action: "image_producer", producer: "pipeline" })).toMatchObject({ imageProducer: "pipeline" });
    expect(await as({ action: "runner_policy", allow_self_hosted: true }, enabled)).toMatchObject({ allowSelfHostedRunners: true });
    // The way back, and forgetting, with every flag off.
    await image("amd64");
    expect(await as({ action: "image_producer", producer: "builder" }, disabled)).toMatchObject({ imageProducer: "builder" });
    expect(await as({ action: "runner_policy", allow_self_hosted: false }, disabled)).toMatchObject({ allowSelfHostedRunners: false });
    await as({ action: "forget_image", build_key: KEY, architecture: "amd64" }, disabled);
    expect(await db().select().from(scopeMachineImages)).toEqual([]);
    expect(await scenarioSourceCard(ORG_SCOPE, pipelineOn)).toMatchObject({ enabled: true, pipelineImages: true });
    expect(await scenarioSourceCard(ORG_SCOPE, enabled)).toMatchObject({ enabled: true, pipelineImages: false });
    // The platform's card tells a platform administrator what may be switched; no other card does.
    const promotionOn = new StaticFeatureToggleService({ scenario_git_sources: true, scenario_automatic_promotion: true });
// Without a reader who changes settings, the card offers none.
    expect((await scenarioSourceCard(ORG_SCOPE, promotionOn)).settings).toBeUndefined();
    expect((await scenarioSourceCard(PUBLIC_SCOPE, promotionOn, "platform")).settings)
      .toEqual({ platform: true, automaticPromotion: true });
    expect((await scenarioSourceCard(ORG_SCOPE, promotionOn, "scope")).settings)
      .toEqual({ platform: false, automaticPromotion: true });
    expect((await scenarioSourceCard(ORG_SCOPE, enabled, "scope")).settings).toMatchObject({ automaticPromotion: false });
  });

  it("sets a pipeline only for a connected push source, and the builder for any", async () => {
    await insertBinding();
    await expect(as({ action: "image_producer", producer: "pipeline" })).rejects.toMatchObject({
      status: 409, code: "scenario_source_mode_pull",
    });
    await db().update(scenarioSources).set({ mode: "push", disconnectedAt: 1 });
    await expect(as({ action: "image_producer", producer: "pipeline" })).rejects.toMatchObject({
      status: 409, code: "scenario_source_not_connected",
    });
    await expect(as({ action: "runner_policy", allow_self_hosted: true })).rejects.toMatchObject({
      status: 409, code: "scenario_source_not_connected",
    });
    await db().update(scenarioSources).set({ imageProducer: "pipeline", pausedAt: 1, pauseReason: "admin" });
    expect(await as({ action: "image_producer", producer: "builder" })).toMatchObject({ imageProducer: "builder" });
  });

  it("applies from the next commit: the view shows what the head commit was ingested with", async () => {
    await insertBinding({ mode: "push" });
    await pipelineHead("builder");
    const view = await as({ action: "image_producer", producer: "pipeline" });
    expect(view).toMatchObject({ imageProducer: "pipeline", commit: { imageProducer: "builder", state: "building" } });
    // Nothing of the head changed.
    expect((await db().select().from(scenarioRevisions))[0]).toMatchObject({ state: "building" });
  });

  it("does not switch to pull while a pipeline builds, and ends what waits for one when it does switch", async () => {
    await insertBinding({ mode: "push", imageProducer: "pipeline" });
    await pipelineHead();
    await expect(platform({ action: "mode", mode: "pull" })).rejects.toMatchObject({
      status: 409, code: "scenario_source_pipeline_images",
    });
    expect(await binding()).toMatchObject({ mode: "push" });
    expect((await db().select().from(scenarioRevisions))[0]).toMatchObject({ state: "building" });
    // A switch to the mode it already has ends nothing either.
    await change({ action: "mode", mode: "push" });
    expect((await db().select().from(scenarioSourceCommits))[0]).toMatchObject({ state: "building" });

    await as({ action: "image_producer", producer: "builder" });
    // A builder's building head of the same scope is left alone.
    await db().insert(bundles).values({ rev: "builders", scopeKey: ORG_SCOPE.key, organizationId: ORG, compilerVersion: "c", r2Key: "k2" });
    await db().insert(scenarios).values({
      id: `${ORG}/other`, namespace: ORG, slug: "other", organizationId: ORG, scopeKey: ORG_SCOPE.key, enabled: true, play: false,
    });
    await db().insert(scenarioRevisions).values({
      scenarioId: `${ORG}/other`, rev: "builders", guestContract: 3, state: "building", docJson: { machines: [] } as never,
    });
    await platform({ action: "mode", mode: "pull" });
    expect(await binding()).toMatchObject({ mode: "pull", imageProducer: "builder" });
    expect(await db().select({ rev: scenarioRevisions.rev, state: scenarioRevisions.state, reason: scenarioRevisions.failureReason })
      .from(scenarioRevisions).orderBy(scenarioRevisions.rev)).toEqual([
      { rev: "builders", state: "building", reason: null },
      { rev: REV, state: "failed", reason: expect.stringContaining("pull mode") },
    ]);
    expect((await db().select().from(scenarioSourceCommits))[0]).toMatchObject({
      state: "failed", detail: expect.stringContaining("pull mode"),
    });
  });

  it("leaves the commit of a pipeline head that has its images as it is, on a switch to pull and on a disconnect", async () => {
    await insertBinding({ mode: "push" });
    await pipelineHead();
    await db().update(scenarioRevisions).set({ state: "ready" });
    await platform({ action: "mode", mode: "pull" });
    expect(await binding()).toMatchObject({ mode: "pull" });
    expect((await db().select().from(scenarioSourceCommits))[0]).toMatchObject({ state: "building", detail: null });
    await change({ action: "disconnect" });
    expect((await db().select().from(scenarioSourceCommits))[0]).toMatchObject({ state: "building", detail: null });
    expect((await db().select().from(scenarioRevisions))[0]).toMatchObject({ state: "ready" });
  });

  it("starts a reconnected source on the builder, on GitHub's runners and with manual promotion", async () => {
    await insertBinding({
      mode: "push", imageProducer: "pipeline", allowSelfHostedRunners: true, promotion: "automatic",
      disconnectedAt: 1, disconnectReason: "admin",
    });
    github();
    await change({ action: "connect", repository: "acme/labs" });
    expect(await binding()).toMatchObject({
      githubRepositoryId: 42, mode: "push", imageProducer: "builder", allowSelfHostedRunners: false, promotion: "manual",
      disconnectedAt: null,
    });
  });

  it("switches promotion to automatic only with its flag and for a connected source, and back always", async () => {
    const promotionOn = new StaticFeatureToggleService({ scenario_git_sources: true, scenario_automatic_promotion: true });
    await insertBinding({ mode: "pull" });
    // The sources flag and the pipeline flag are not this one.
    await expect(as({ action: "promotion", promotion: "automatic" }, pipelineOn)).rejects.toMatchObject({ status: 404 });
    expect(await binding()).toMatchObject({ promotion: "manual", pokedAt: null });
    expect(await as({ action: "promotion", promotion: "automatic" }, promotionOn)).toMatchObject({ promotion: "automatic" });
    // The source's pass is asked for at once. It had no head commit to leave alone.
    expect(await binding()).toMatchObject({ promotionAfter: null });
    expect((await binding())!.pokedAt).not.toBeNull();
    // Back with every flag off.
    await db().update(scenarioSources).set({ pokedAt: null });
    expect(await as({ action: "promotion", promotion: "manual" }, disabled)).toMatchObject({ promotion: "manual" });
    expect((await binding())!.pokedAt).not.toBeNull();
    // The commit that is the head at the switch is remembered, with its attempt.
    const digest = await sourceCompileDigest();
    await db().update(scenarioSources).set({ headSha: "a".repeat(40) });
    await db().insert(scenarioSourceCommits).values({
      id: "head", scopeKey: ORG_SCOPE.key, purpose: "deploy", sha: "a".repeat(40), rev: `git-9-${"a".repeat(40)}-${digest}`,
      via: "push", state: "building", attempt: 3,
    });
    await as({ action: "promotion", promotion: "automatic" }, promotionOn);
    expect(await binding()).toMatchObject({ promotion: "automatic", promotionAfter: "head:3" });
    await as({ action: "promotion", promotion: "manual" }, disabled);
    expect(await binding()).toMatchObject({ promotion: "manual", promotionAfter: null });
    // A disconnected source gets no job, but can still be set back.
    await db().update(scenarioSources).set({ disconnectedAt: 1, disconnectReason: "admin", promotion: "automatic" });
    await expect(as({ action: "promotion", promotion: "automatic" }, promotionOn)).rejects.toMatchObject({
      status: 409, code: "scenario_source_not_connected",
    });
    await as({ action: "promotion", promotion: "manual" }, disabled);
    expect(await binding()).toMatchObject({ promotion: "manual" });
  });

  it("closes the sessions of self-hosted runners when they are no longer allowed", async () => {
    await insertBinding({ mode: "push", allowSelfHostedRunners: true });
    const session = (id: string, runnerEnvironment: string) => db().insert(pipelineUploadSessions).values({
      id, tokenHash: id, scopeKey: ORG_SCOPE.key, githubRepositoryId: 9, githubRepository: "acme/old", ref: "refs/heads/main",
      sha: "a".repeat(40), rev: REV, runId: "1", runAttempt: 1, runnerEnvironment, jobWorkflowSha: "w",
      expiresAt: Date.now() + 60_000,
    });
    await session("hosted", "github-hosted");
    await session("own", "self-hosted");
    // Allowing them again closes nothing.
    await as({ action: "runner_policy", allow_self_hosted: true });
    expect((await db().select().from(pipelineUploadSessions)).every((row) => row.closedAt === null)).toBe(true);

    await as({ action: "runner_policy", allow_self_hosted: false });
    expect(await db().select({ id: pipelineUploadSessions.id, closed: sql<number>`closed_at IS NOT NULL` })
      .from(pipelineUploadSessions).orderBy(pipelineUploadSessions.id)).toEqual([
      { id: "hosted", closed: 0 },
      { id: "own", closed: 1 },
    ]);
  });

  it("forgets one recorded image and says which revisions still name it", async () => {
    await insertBinding({ mode: "push", imageProducer: "pipeline" });
    await pipelineHead();
    const amd = `sha256:${"1".repeat(64)}`;
    const arm = `sha256:${"2".repeat(64)}`;
    await image("amd64", amd);
    await image("arm64", arm);
    await image("amd64", amd, "public");
    await db().update(scenarioRevisions).set({
      state: "ready", docJson: { machines: [{ name: "m", build_key: KEY, image_digest: amd }] } as never,
    });
    const revision = { scenarioId: `${ORG}/lab`, rev: REV, doc: { machines: [{ build_key: KEY }] } as never };
    for (const digest of [amd, arm]) {
      await env.DB.prepare(
        `INSERT INTO registry_manifests (digest, media_type, artifact_type, size) VALUES (?1, 'm', 'application/vnd.intar.machine.v1', 1)`,
      ).bind(digest).run();
    }
    expect(await arm64MachineImages(env.DB, revision)).toEqual(new Map([[KEY, arm]]));

    // The arm64 image is read where it is recorded: a local arm64 run of the
    // settled revision has none until the next push.
    const armGone = await as({ action: "forget_image", build_key: KEY, architecture: "arm64" });
    expect(armGone?.forgotten).toEqual({ imageDigest: arm, revisions: [] });
    expect(await arm64MachineImages(env.DB, revision)).toBeNull();

    // The amd64 one stays in the revision that settled on it.
    const amdGone = await as({ action: "forget_image", build_key: KEY, architecture: "amd64" });
    expect(amdGone?.forgotten).toEqual({ imageDigest: amd, revisions: [{ scenarioId: `${ORG}/lab`, rev: REV, state: "ready" }] });
    expect((await db().select().from(scenarioRevisions))[0]).toMatchObject({ state: "ready" });
    // Another scope's record of the same key is not this source's to forget.
    expect(await db().select({ scopeKey: scopeMachineImages.scopeKey }).from(scopeMachineImages)).toEqual([{ scopeKey: "public" }]);
    await expect(as({ action: "forget_image", build_key: KEY, architecture: "amd64" })).rejects.toMatchObject({
      status: 404, code: "image_not_recorded",
    });
    // The next upload is told the key is missing again.
    expect((await pipelinePlan(env, ORG_SCOPE.key, [KEY])).missing).toHaveLength(2);
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

  it("redacts the commit detail and its diagnostics", async () => {
    const rev = `git-42-${"a".repeat(40)}-digest`;
    await insertBinding();
    const db = drizzle(env.DB);
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
    });
  });
});
