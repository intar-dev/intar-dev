/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentBootstrapTokens,
  agentHosts,
  hostDesiredState,
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import {
  AGENT_SOURCES_PATH,
  SOURCE_BUNDLE_FIELD,
  SOURCE_META_FIELD,
} from "@/generated/constants";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import sourceRefusalSchema from "@/generated/schemas/source-refusal-v1.schema.json";
import { mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { syncBuilderDesiredState } from "@/lib/machine-builds";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { stagedSourceObjectPrefix } from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const SCOPE = `organization:${ORG}`;
const OWNER = "owner";
const SHA = "a".repeat(40);
const COMPILE = "compile-1";
const SNAPSHOT = "repository snapshot";

let testEnv: Cloudflare.Env;
let rev: string;
let staged: string;
let tokens: Record<string, string>;
let woken: string[];

beforeAll(async () => {
  const hostRuntime = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async () => {
        woken.push(name);
        return new Response(null, { status: 204 });
      },
    }),
  };
  testEnv = {
    ...env,
    HOST_RUNTIME: hostRuntime,
  } as unknown as Cloudflare.Env;
  rev = `git-42-${SHA}-${await sourceCompileDigest()}`;
  staged = stagedSourceObjectPrefix(SCOPE, rev, "deploy");
});

beforeEach(async () => {
  await resetD1Database();
  woken = [];
  const db = drizzle(env.DB);
  await createFixtureMember({ d1: env.DB, userId: OWNER });
  await db.insert(organization).values({ id: ORG, name: ORG, slug: "acme", createdAt: new Date() });
  await db.insert(member).values({
    id: "owner-member", organizationId: ORG, userId: OWNER, role: "owner", createdAt: new Date(),
  });
  await db.insert(scenarioSources).values({
    scopeKey: SCOPE,
    organizationId: ORG,
    githubInstallationId: 7,
    githubRepositoryId: 42,
    githubRepository: "acme/labs",
    defaultBranch: "main",
    mode: "pull",
    boundByUserId: OWNER,
    headSha: SHA,
    headObservedAt: Date.now(),
  });
  tokens = {};
  for (const hostId of ["builder-1", "builder-2"]) {
    await db.insert(agentHosts).values({
      id: hostId, userId: OWNER, name: hostId, role: "builder", scope: "platform", credentialGeneration: 1,
    });
    await db.insert(agentBootstrapTokens).values({
      id: `${hostId}-bootstrap`, hostId, tokenHash: await sha256Text(`${hostId}-token`),
      credentialGeneration: 1, expiresAt: Date.now() + 60_000,
    });
    const bootstrap = await handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "intar-bridge-protocol": "9" },
      body: JSON.stringify({ hostId, bootstrapToken: `${hostId}-token` }),
    }), env);
    tokens[hostId] = ((await bootstrap.json()) as { accessToken: string }).accessToken;
  }
  await db.insert(scenarioSourceCommits).values({
    id: COMPILE, scopeKey: SCOPE, purpose: "deploy", sha: SHA, rev, via: "pull", attempt: 2,
    state: "compiling", compileHostId: "builder-1", compileAssignedAt: Date.now(),
  });
  for (const hostId of ["builder-1", "builder-2"]) await mutateHostDesiredStateV3(db, hostId, Date.now(), () => {});
  await syncBuilderDesiredState(env, "builder-1", Date.now());
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: "builds/" });
  if (listed.objects.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(listed.objects.map((object) => object.key));
  }
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`${staged}source.tar.gz`, SNAPSHOT);
});

/** A gzipped compiled bundle. */
function compiledBundle(bundle: unknown = bundleFixture): Uint8Array {
  return new Uint8Array(gzipSync(JSON.stringify(bundle)));
}

/**
 * The result request exactly as intar-builder 0.14.0 sends it: reqwest's
 * multipart with a text meta part and a `Part::bytes` bundle, so it carries
 * a Content-Length, posted to the S01 path with the attempt in the query.
 */
function builderResult(
  input: { host?: string; attempt?: number; id?: string; rev?: string; bundle?: unknown } = {},
): Request {
  const boundary = "8f2c1a9e4b7d3c60-1e5a7c9b2d4f6a80-3b5d7f9a1c2e4b60-7d9f1b3a5c7e9d20";
  const text = new TextEncoder();
  const head = text.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${SOURCE_META_FIELD}"\r\n\r\n` +
      `${JSON.stringify({ rev: input.rev ?? rev })}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="${SOURCE_BUNDLE_FIELD}"; filename="${rev}.tar.gz"\r\n` +
      "Content-Type: application/gzip\r\n\r\n",
  );
  const bundle = compiledBundle(input.bundle);
  const tail = text.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + bundle.byteLength + tail.byteLength);
  body.set(head);
  body.set(bundle, head.byteLength);
  body.set(tail, head.byteLength + bundle.byteLength);
  return new Request(
    `https://intar.test${AGENT_SOURCES_PATH}/${input.id ?? COMPILE}/result?attempt=${input.attempt ?? 2}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens[input.host ?? "builder-1"]}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.byteLength),
      },
      body,
    },
  );
}

function builderFailure(errors: unknown[], input: { compileId?: string; attempt?: number } = {}): Request {
  return new Request(`https://intar.test${AGENT_SOURCES_PATH}/${COMPILE}/result?attempt=2`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens["builder-1"]}`, "content-type": "application/json" },
    body: JSON.stringify({ compile_id: input.compileId ?? COMPILE, attempt: input.attempt ?? 2, errors }),
  });
}

async function send(request: Request): Promise<Response> {
  const response = await handleImageRegistryRequest(request, testEnv);
  if (!response) throw new Error("the compile route is not registered");
  return response;
}

async function row() {
  const [commit] = await drizzle(env.DB)
    .select()
    .from(scenarioSourceCommits)
    .where(eq(scenarioSourceCommits.id, COMPILE));
  return commit;
}

async function stagedKeys(): Promise<string[]> {
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: staged });
  return listed.objects.map((object) => object.key).sort();
}

async function desiredCompiles(hostId: string) {
  const [desired] = await drizzle(env.DB)
    .select({ doc: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId));
  return desired?.doc.source_compiles;
}

async function expectRefusal(response: Response, code: string) {
  expect(response.status).toBe(409);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([...sourceRefusalSchema.required].sort());
  expect(sourceRefusalSchema.$defs.SourceRefusalCode.enum).toContain(body.code);
  expect(body.code).toBe(code);
}

describe("pull compile routes", () => {
  it("accepts a result posted exactly as the builder sends it and wakes the next binding", async () => {
    // A second pull binding waits for a compiler with nothing in flight.
    await createFixtureMember({ d1: env.DB, userId: "owner-b" });
    const db = drizzle(env.DB);
    await db.insert(organization).values({ id: "org-b", name: "org-b", slug: "beta", createdAt: new Date() });
    await db.insert(member).values({
      id: "owner-b-member", organizationId: "org-b", userId: "owner-b", role: "owner", createdAt: new Date(),
    });
    await db.insert(scenarioSources).values({
      scopeKey: "organization:org-b", organizationId: "org-b", githubInstallationId: 7,
      githubRepositoryId: 43, githubRepository: "acme/other", defaultBranch: "main",
      mode: "pull", boundByUserId: "owner-b", headSha: "b".repeat(40), headObservedAt: 1,
    });
    expect(await desiredCompiles("builder-1")).toEqual([
      { compile_id: COMPILE, attempt: 2, rev, validate_only: false },
    ]);

    const response = await send(builderResult());

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, rev, queued: 0, assigned: [] });
    expect(await row()).toMatchObject({ state: "ingesting", attempt: 2 });
    expect(await stagedKeys()).toEqual([`${staged}bundle.json.gz`]);
    expect(await desiredCompiles("builder-1")).toEqual([]);
    expect(woken).toEqual(["builder-1"]);
    const poked = await db
      .select({ scopeKey: scenarioSources.scopeKey, pokedAt: scenarioSources.pokedAt })
      .from(scenarioSources)
      .orderBy(scenarioSources.scopeKey);
    expect(poked).toEqual([
      { scopeKey: SCOPE, pokedAt: expect.any(Number) },
      { scopeKey: "organization:org-b", pokedAt: expect.any(Number) },
    ]);
  });

  it("fences a stale attempt, another builder and a paused binding", async () => {
    await expectRefusal(await send(builderResult({ attempt: 1 })), "fenced");
    await expectRefusal(await send(builderResult({ host: "builder-2" })), "fenced");
    expect((await send(builderResult({ id: "unknown" }))).status).toBe(404);

    await drizzle(env.DB).update(scenarioSources).set({ pausedAt: 1, pauseReason: "admin" });
    await expectRefusal(await send(builderResult()), "binding_inactive");

    expect(await row()).toMatchObject({ state: "compiling", attempt: 2 });
    expect(await stagedKeys()).toEqual([`${staged}source.tar.gz`]);
    expect(woken).toEqual([]);
  });

  it("settles a refused result now and frees its builder instead of waiting for the lease", async () => {
    const response = await send(builderResult({ bundle: { ...bundleFixture, course_catalog: { version: 3, courses: [] } } }));

    expect(response.status).toBe(400);
    expect(await row()).toMatchObject({ state: "invalid", detail: expect.stringContaining("/course_catalog/version"), attempt: 2 });
    expect(await stagedKeys()).toEqual([]);
    expect(await desiredCompiles("builder-1")).toEqual([]);
    expect(woken).toEqual(["builder-1"]);
  });

  it("returns an outdated result to its archive like an expiry, and fails it at the attempt cap", async () => {
    const outdated = `git-42-${SHA}-p00000000`;
    await expectRefusal(await send(builderResult({ rev: outdated })), "compiler_outdated");
    expect(await row()).toMatchObject({ state: "fetching", attempt: 2 });
    expect(await stagedKeys()).toEqual([`${staged}source.tar.gz`]);
    expect(await desiredCompiles("builder-1")).toEqual([]);

    await drizzle(env.DB)
      .update(scenarioSourceCommits)
      .set({ state: "compiling", attempt: 3 });
    await expectRefusal(await send(builderResult({ attempt: 3, rev: outdated })), "compiler_outdated");
    expect(await row()).toMatchObject({ state: "failed", detail: expect.stringContaining("another compiler") });
    expect(await stagedKeys()).toEqual([]);
  });

  it("counts outdated results from the row's last claim", async () => {
    const outdated = `git-42-${SHA}-p00000000`;
    await drizzle(env.DB).update(scenarioSourceCommits).set({ attempt: 3, claimedAttempt: 1 });
    await expectRefusal(await send(builderResult({ attempt: 3, rev: outdated })), "compiler_outdated");
    expect(await row()).toMatchObject({ state: "fetching", attempt: 3 });

    await drizzle(env.DB)
      .update(scenarioSourceCommits)
      .set({ state: "compiling", attempt: 4 });
    await expectRefusal(await send(builderResult({ attempt: 4, rev: outdated })), "compiler_outdated");
    expect(await row()).toMatchObject({ state: "failed", detail: expect.stringContaining("another compiler") });
  });

  it("records a compile failure as invalid with diagnostics bounded to 64 KiB", async () => {
    const first = { path: "intar.yaml", line: 3, code: "manifest_invalid", message: "courses_root is required" };
    const filler = { code: "compile_failed", message: "x".repeat(40 * 1024) };
    expect((await send(builderFailure([first], { compileId: "other" }))).status).toBe(400);
    expect((await send(builderFailure([first], { attempt: 1 }))).status).toBe(400);

    const response = await send(builderFailure([first, filler, filler]));

    expect(response.status).toBe(202);
    const commit = await row();
    expect(commit).toMatchObject({ state: "invalid", detail: "The repository did not compile." });
    expect(JSON.parse(commit?.diagnosticsJson ?? "null")).toEqual([first, filler]);
    expect(await stagedKeys()).toEqual([]);
    expect(await desiredCompiles("builder-1")).toEqual([]);
    expect(woken).toEqual(["builder-1"]);
    await expectRefusal(await send(builderFailure([first])), "fenced");
  });

  it("serves the snapshot only to the assigned builder and attempt", async () => {
    const snapshot = (host: string, query: string) =>
      send(new Request(`https://intar.test${AGENT_SOURCES_PATH}/${COMPILE}${query}`, {
        headers: { authorization: `Bearer ${tokens[host]}` },
      }));

    const response = await snapshot("builder-1", "?attempt=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(SNAPSHOT);

    await expectRefusal(await snapshot("builder-1", "?attempt=1"), "fenced");
    await expectRefusal(await snapshot("builder-2", "?attempt=2"), "fenced");
    expect((await snapshot("builder-1", "")).status).toBe(400);
  });
});
