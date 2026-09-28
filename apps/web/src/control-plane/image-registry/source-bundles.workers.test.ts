/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
} from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { sha256Hex } from "@/control-plane/image-registry/shared";
import {
  agentHosts,
  courseCatalogs,
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
  vmScenarios,
} from "@/db/schema";
import sourceRefusalSchema from "@/generated/schemas/source-refusal-v1.schema.json";
import {
  SOURCE_BUNDLES_PATH,
  SOURCE_COMPILER_PATH,
  SOURCE_COMPILER_VERSION,
} from "@/generated/constants";
import { GITHUB_ACTIONS_ISSUER } from "@/lib/github-oidc";
import {
  IMAGE_BUILD_FORMAT_VERSION,
  platformCompileDigest,
} from "@/lib/image-build-format";
import {
  acceptScenarioSourceUpload,
  MAX_SOURCE_UPLOAD_BYTES,
  scenarioSourceScope,
} from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const SCOPE = scenarioSourceScope(ORG);
const OWNER = "owner";
const SHA = "a".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const BASE_IMAGES = 'base "debian" {}\n';
const SCENARIO = "acme-web";

let testEnv: Cloudflare.Env;
let rev: string;
let oidcKey: CryptoKey;
let jwks: unknown;

beforeAll(async () => {
  const app = await generateKeyPair("RS256", { extractable: true });
  const oidc = await generateKeyPair("RS256", { extractable: true });
  oidcKey = oidc.privateKey;
  jwks = { keys: [{ ...(await exportJWK(oidc.publicKey)), kid: "k1", alg: "RS256" }] };
  testEnv = {
    ...env,
    PLATFORM_BASE_IMAGES_SHA256: await sha256Hex(new TextEncoder().encode(BASE_IMAGES).buffer),
    GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey),
    SCENARIO_PUBLISH_WORKFLOW_SHAS: WORKFLOW_SHA,
  } as unknown as Cloudflare.Env;
  rev = `git-42-${SHA}-${await platformCompileDigest(testEnv.PLATFORM_BASE_IMAGES_SHA256)}`;
});

beforeEach(async () => {
  await resetD1Database();
  const db = drizzle(env.DB);
  await createFixtureMember({ d1: env.DB, userId: OWNER, githubAccountId: "1001" });
  await db.insert(organization).values({ id: ORG, name: ORG, slug: "acme", createdAt: new Date() });
  await db.insert(member).values({
    id: "owner-member", organizationId: ORG, userId: OWNER, role: "owner", createdAt: new Date(),
  });
  await db.insert(scenarioSources).values({
    scopeKey: SCOPE.key,
    organizationId: ORG,
    githubInstallationId: 7,
    githubRepositoryId: 42,
    githubRepository: "acme/labs",
    defaultBranch: "main",
    mode: "push",
    boundByUserId: OWNER,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** GitHub for `acme/labs` (id 42), whose default-branch head is `head`. */
function github(head = SHA) {
  const routes: Record<string, () => Response> = {
    "GET /.well-known/jwks": () => Response.json(jwks),
    "POST /app/installations/7/access_tokens": () =>
      Response.json({ token: "ghs_test" }, { status: 201 }),
    "GET /installation/repositories": () =>
      Response.json({
        repositories: [{ id: 42, full_name: "acme/labs", default_branch: "main" }],
      }),
    "GET /repos/acme/labs/git/ref/heads/main": () => Response.json({ object: { sha: head } }),
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    return route ? route() : new Response(null, { status: 404 });
  });
}

async function oidcToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository_id: "42",
    ref: "refs/heads/main",
    sha: SHA,
    event_name: "push",
    runner_environment: "github-hosted",
    job_workflow_ref:
      "intar-dev/intar-dev/.github/workflows/scenario-publish.yml@refs/tags/scenario-publish-v1",
    job_workflow_sha: WORKFLOW_SHA,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(GITHUB_ACTIONS_ISSUER)
    .setAudience(env.BETTER_AUTH_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(oidcKey);
}

type Lecture = { lecture_id: string; scenario_id?: string };

function sourceMeta(overrides: Record<string, unknown> = {}, lectures: Lecture[] = [
  { lecture_id: "01-web", scenario_id: SCENARIO },
]) {
  return {
    rev,
    build_format_version: IMAGE_BUILD_FORMAT_VERSION,
    catalog_channel: "candidate",
    scenarios: lectures.flatMap((lecture) =>
      lecture.scenario_id
        ? [{ scenario_id: lecture.scenario_id, arch: "x86_64", content_hash: "b".repeat(64) }]
        : [],
    ),
    course_catalog: {
      version: 2,
      courses: lectures.length
        ? [{
            course_id: "linux",
            title: "Linux",
            summary: "Linux basics",
            body_markdown: "# Linux",
            sequential: false,
            lectures: lectures.map((lecture) => ({
              lecture_id: lecture.lecture_id,
              title: lecture.lecture_id,
              summary: "A lecture",
              body_markdown: "# Lecture",
              category: "web",
              tags: ["web"],
              estimated_minutes: 10,
              ...(lecture.scenario_id
                ? { difficulty: "easy", scenario_id: lecture.scenario_id }
                : {}),
            })),
          }]
        : [],
    },
    source: { scope: "acme", courses_root: "courses", compiler_version: SOURCE_COMPILER_VERSION },
    ...overrides,
  };
}

/** A gzipped tar of the named files, each holding its own path. */
function archive(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = new TextEncoder().encode(content);
    const header = new Uint8Array(512);
    const write = (offset: number, text: string) =>
      header.set(new TextEncoder().encode(text), offset);
    write(0, path);
    write(100, "0000644\0");
    write(124, `${data.byteLength.toString(8).padStart(11, "0")}\0`);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    write(257, "ustar\u000000");
    write(148, `${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `);
    parts.push(header, data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

function sourceArchive(baseImages: string | null = BASE_IMAGES): Uint8Array<ArrayBuffer> {
  return archive({
    ...(baseImages === null ? {} : { "base-images.hcl": baseImages }),
    "curriculum/catalog.json": "{}",
    [`scenarios/${SCENARIO}/scenario.hcl`]: "scenario {}",
  });
}

/** A multipart POST shaped like the CLI's: Content-Length, meta and bundle. */
async function cliRequest(input: {
  path?: string;
  token?: string;
  meta?: unknown;
  bundle?: Uint8Array<ArrayBuffer>;
  contentLength?: string | null;
}): Promise<Request> {
  const form = new FormData();
  form.set("meta", JSON.stringify(input.meta ?? sourceMeta()));
  form.set(
    "bundle",
    new File([input.bundle ?? sourceArchive()], `${rev}.tar.gz`, { type: "application/gzip" }),
  );
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const headers = new Headers({
    "content-type": encoded.headers.get("content-type") ?? "",
  });
  if (input.token) headers.set("authorization", `Bearer ${input.token}`);
  const length = input.contentLength === undefined ? String(body.byteLength) : input.contentLength;
  if (length !== null) headers.set("content-length", length);
  return new Request(`https://intar.test${input.path ?? SOURCE_BUNDLES_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

async function push(input: Parameters<typeof cliRequest>[0] = {}): Promise<Response> {
  const request = await cliRequest({ token: await oidcToken(), ...input });
  const response = await handleImageRegistryRequest(request, testEnv);
  if (!response) throw new Error("the source route is not registered");
  return response;
}

async function commits() {
  return drizzle(env.DB).select().from(scenarioSourceCommits);
}

async function binding() {
  const [row] = await drizzle(env.DB)
    .select()
    .from(scenarioSources)
    .where(eq(scenarioSources.scopeKey, SCOPE.key));
  return row;
}

async function stagedKeys(): Promise<string[]> {
  const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix: "builds/sources/" });
  return listed.objects.map((object) => object.key).sort();
}

/** The body must be a `SourceRefusalV1` with this code. */
async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([...sourceRefusalSchema.required].sort());
  expect(typeof body.error).toBe("string");
  expect(sourceRefusalSchema.$defs.SourceRefusalCode.enum).toContain(body.code);
  expect(body.code).toBe(code);
}

describe("push uploads", () => {
  it("accepts the first push after a bind, before any observe", async () => {
    github();
    const response = await push();

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, rev, queued: 0, assigned: [] });
    expect(await commits()).toEqual([
      expect.objectContaining({ scopeKey: SCOPE.key, purpose: "deploy", sha: SHA, rev, via: "push", attempt: 0, state: "ingesting" }),
    ]);
    expect(await binding()).toMatchObject({
      headSha: SHA,
      headObservedAt: expect.any(Number),
      pokedAt: expect.any(Number),
    });
    const staged = `builds/sources/${SCOPE.key}/${rev}/deploy/`;
    expect(await stagedKeys()).toEqual([`${staged}bundle.tar.gz`, `${staged}meta.json`]);
    const meta = await env.VM_IMAGE_REGISTRY_BUCKET.get(`${staged}meta.json`);
    expect(await meta?.text()).toBe(JSON.stringify(sourceMeta()));
  });

  it.each([
    ["missing", null],
    ["over the cap", String(MAX_SOURCE_UPLOAD_BYTES + 1)],
  ])("refuses a %s Content-Length before reading the body", async (_name, contentLength) => {
    github();
    const request = await cliRequest({ token: await oidcToken(), contentLength });
    const response = await handleImageRegistryRequest(request, testEnv);
    expect(response?.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(await commits()).toEqual([]);
  });

  it("answers a re-upload of an accepted rev without decompressing it", async () => {
    github();
    await drizzle(env.DB).insert(scenarioSourceCommits).values({
      id: "row", scopeKey: SCOPE.key, purpose: "deploy", sha: SHA, rev, via: "push", state: "building", updatedAt: 5,
    });
    const response = await push({ bundle: new TextEncoder().encode("not gzip") });
    expect(response.status).toBe(202);
    expect(await commits()).toEqual([expect.objectContaining({ state: "building", updatedAt: 5 })]);
    expect(await stagedKeys()).toEqual([]);
  });

  it.each(["failed", "invalid", "superseded"] as const)(
    "takes over a %s row when CI runs the push again",
    async (state) => {
      github();
      await drizzle(env.DB).insert(scenarioSourceCommits).values({
        id: "row", scopeKey: SCOPE.key, purpose: "deploy", sha: SHA, rev, via: "push", attempt: 1, state, detail: "earlier",
      });
      expect((await push()).status).toBe(202);
      expect(await commits()).toEqual([
        expect.objectContaining({ id: "row", state: "ingesting", attempt: 2, detail: null }),
      ]);
    },
  );

  it("refuses a base catalog the platform does not use", async () => {
    github();
    await expectRefusal(await push({ bundle: sourceArchive('base "other" {}\n') }), 409, "compiler_outdated");
    expect(await commits()).toEqual([]);
    expect(await stagedKeys()).toEqual([]);
  });

  it.each([
    ["a theory-only commit", [{ lecture_id: "01-intro" }]],
    ["an empty commit", []],
  ])("skips the base-catalog check for %s", async (_name, lectures) => {
    github();
    const response = await push({ meta: sourceMeta({}, lectures), bundle: sourceArchive(null) });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(await commits()).toEqual([expect.objectContaining({ state: "ingesting" })]);
  });

  it.each([
    ["an older compiler", { source: { scope: "acme", courses_root: "courses", compiler_version: "intar-source-compiler-v0" } }],
    ["another compile digest", { rev: `git-42-${SHA}-p00000000` }],
    ["another build format", { build_format_version: "intar-image-build-v1" }],
  ])("refuses %s as compiler_outdated and writes no row", async (_name, overrides) => {
    github();
    await expectRefusal(await push({ meta: sourceMeta(overrides) }), 409, "compiler_outdated");
    expect(await commits()).toEqual([]);
    expect(await stagedKeys()).toEqual([]);
  });

  it("refuses a meta without its source", async () => {
    github();
    const response = await push({ meta: sourceMeta({ source: undefined }) });
    expect(response.status).toBe(400);
    expect(await commits()).toEqual([]);
  });

  it("refuses a commit that is no longer the head", async () => {
    github("d".repeat(40));
    await expectRefusal(await push(), 409, "superseded");
    expect(await commits()).toEqual([]);
  });

  it("keeps a head observed later than this request's read", async () => {
    github();
    const later = Date.now() + 60_000;
    await drizzle(env.DB).update(scenarioSources).set({ headSha: "d".repeat(40), headObservedAt: later });
    await expectRefusal(await push(), 409, "superseded");
    expect(await binding()).toMatchObject({ headSha: "d".repeat(40), headObservedAt: later });
    expect(await commits()).toEqual([]);
  });

  it.each([
    ["a pull-mode binding", { mode: "pull" as const }],
    ["a paused binding", { pausedAt: 1, pauseReason: "admin" as const }],
    ["a disconnected binding", { disconnectedAt: 1 }],
  ])("refuses %s as binding_inactive", async (_name, change) => {
    github();
    await drizzle(env.DB).update(scenarioSources).set(change);
    await expectRefusal(await push(), 409, "binding_inactive");
    expect(await commits()).toEqual([]);
  });

  it("refuses a GHEC unique issuer as issuer_unsupported", async () => {
    const fetchSpy = github();
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`${GITHUB_ACTIONS_ISSUER}/acme`)
      .setAudience(env.BETTER_AUTH_URL)
      .setExpirationTime(now + 300)
      .sign(oidcKey);
    await expectRefusal(await push({ token }), 401, "issuer_unsupported");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps deploy and validate objects apart", async () => {
    github();
    expect((await push()).status).toBe(202);
    const response = await acceptScenarioSourceUpload(await cliRequest({}), testEnv, {
      scope: SCOPE,
      repositoryId: 42,
      sha: SHA,
      purpose: "validate",
      claim: { via: "push", headSha: SHA, observedAt: Date.now() },
    });
    expect(response.status).toBe(202);
    const prefix = `builds/sources/${SCOPE.key}/${rev}`;
    expect(await stagedKeys()).toEqual([
      `${prefix}/deploy/bundle.tar.gz`,
      `${prefix}/deploy/meta.json`,
      `${prefix}/validate/bundle.tar.gz`,
      `${prefix}/validate/meta.json`,
    ]);
  });
});

describe("pull compile results", () => {
  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.insert(agentHosts).values({ id: "builder", userId: OWNER, name: "builder", scope: "platform", role: "builder" });
    await db.update(scenarioSources).set({ mode: "pull", headSha: SHA, headObservedAt: 1 });
    await db.insert(scenarioSourceCommits).values({
      id: "row", scopeKey: SCOPE.key, purpose: "deploy", sha: SHA, rev, via: "pull", attempt: 2, state: "compiling", compileHostId: "builder",
    });
  });

  function result(attempt: number) {
    return async () =>
      acceptScenarioSourceUpload(await cliRequest({}), testEnv, {
        scope: SCOPE,
        repositoryId: 42,
        sha: SHA,
        purpose: "deploy",
        claim: { via: "pull", commitId: "row", attempt, hostId: "builder" },
      });
  }

  it("moves its own compiling row to ingesting", async () => {
    expect((await result(2)()).status).toBe(202);
    expect(await commits()).toEqual([expect.objectContaining({ state: "ingesting", attempt: 2 })]);
  });

  it("fences out a stale attempt", async () => {
    await expect(result(1)()).rejects.toMatchObject({ status: 409, code: "fenced" });
    expect(await commits()).toEqual([expect.objectContaining({ state: "compiling" })]);
  });
});

describe("token route gates", () => {
  const PUBLIC_SCENARIO = "broken-nginx";

  beforeEach(async () => {
    const db = drizzle(env.DB);
    await db.insert(scenarioSources).values({
      scopeKey: "public",
      githubInstallationId: 8,
      githubRepositoryId: 43,
      githubRepository: "intar-dev/scenarios",
      defaultBranch: "main",
      pausedAt: 1,
      pauseReason: "admin",
    });
    for (const [scenarioId, organizationId] of [[PUBLIC_SCENARIO, null], [SCENARIO, ORG]] as const) {
      await db.insert(vmScenarios).values({
        scenarioId, organizationId, title: scenarioId, description: scenarioId, difficulty: "easy",
        estimatedMinutes: 10, tagsJson: [], briefingMarkdown: "b", solutionMarkdown: "s", hintsJson: [],
      });
    }
  });

  async function tokenUpload(tokenRev: string, lectures: Lecture[]) {
    const scenarioFiles = Object.fromEntries(
      lectures.flatMap((lecture) =>
        lecture.scenario_id ? [[`scenarios/${lecture.scenario_id}/scenario.hcl`, "scenario {}"]] : [],
      ),
    );
    const request = await cliRequest({
      path: "/registry/v1/bundles",
      token: env.REGISTRY_PUBLISH_TOKEN,
      meta: sourceMeta({ rev: tokenRev, source: undefined }, lectures),
      bundle: archive({
        "base-images.hcl": BASE_IMAGES,
        "curriculum/catalog.json": "{}",
        "curriculum/linux/course.md": "# Linux",
        ...Object.fromEntries(lectures.map((lecture) => [`curriculum/linux/${lecture.lecture_id}/lecture.md`, "# L"])),
        ...scenarioFiles,
      }),
    });
    const response = await handleImageRegistryRequest(request, testEnv);
    if (!response) throw new Error("the bundle route is not registered");
    return response;
  }

  async function publicCatalog() {
    return drizzle(env.DB).select().from(courseCatalogs).where(eq(courseCatalogs.scopeKey, "public"));
  }

  it("refuses ids a connected scope owns", async () => {
    const response = await tokenUpload("token-rev-1", [{ lecture_id: "01-nginx", scenario_id: PUBLIC_SCENARIO }]);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ scenario_ids: [PUBLIC_SCENARIO] });
  });

  it("lets a benchmark rev sample public-owned ids but not org-owned ones", async () => {
    const accepted = await tokenUpload("image-build-benchmark-1", [{ lecture_id: "01-nginx", scenario_id: PUBLIC_SCENARIO }]);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ queued: 1 });

    const refused = await tokenUpload("image-build-benchmark-2", [{ lecture_id: "01-web", scenario_id: SCENARIO }]);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ scenario_ids: [SCENARIO] });
    expect(await publicCatalog()).toEqual([]);
  });

  it("leaves the public catalog alone while public is connected", async () => {
    const theory = [{ lecture_id: "01-intro" }];
    expect((await tokenUpload("token-rev-1", theory)).status).toBe(202);
    expect(await publicCatalog()).toEqual([]);

    // Disconnecting `public` lifts the gate.
    await drizzle(env.DB)
      .update(scenarioSources)
      .set({ disconnectedAt: 1 })
      .where(and(eq(scenarioSources.scopeKey, "public")));
    expect((await tokenUpload("token-rev-2", theory)).status).toBe(202);
    expect(await publicCatalog()).toEqual([expect.objectContaining({ sourceRevision: "token-rev-2" })]);
  });
});

describe("compiler descriptor", () => {
  const request = () => new Request(`https://intar.test${SOURCE_COMPILER_PATH}`);

  it.each([
    ["no CLI release", {}],
    ["an unreadable checksum", { SCENARIO_COMPILER_CLI_VERSION: "0.9.0", SCENARIO_COMPILER_CLI_SHA256: "{" }],
  ])("answers 503 with %s", async (_name, vars) => {
    const response = await handleImageRegistryRequest(request(), { ...testEnv, ...vars } as Cloudflare.Env);
    expect(response?.status).toBe(503);
  });

  it("names the CLI release and the platform compile digest", async () => {
    const sha256 = { linux_amd64: "e".repeat(64) };
    const response = await handleImageRegistryRequest(request(), {
      ...testEnv,
      SCENARIO_COMPILER_CLI_VERSION: "0.9.0",
      SCENARIO_COMPILER_CLI_SHA256: JSON.stringify(sha256),
    } as unknown as Cloudflare.Env);
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      cli_version: "0.9.0",
      sha256,
      digest: rev.split("-").at(-1),
    });
  });
});
