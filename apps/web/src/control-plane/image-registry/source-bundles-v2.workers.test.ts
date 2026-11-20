/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentBootstrap, sha256Hex as sha256Text } from "@/control-plane/auth";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import type { ScenarioSourceDO } from "@/control-plane/scenario-source-do";
import {
  agentBootstrapTokens,
  agentHosts,
  member,
  organization,
  scenarioSourceCommits,
  scenarioSources,
} from "@/db/schema";
import { AGENT_SOURCES_PATH, SOURCE_BUNDLES_PATH, SOURCE_COMPILER_PATH } from "@/generated/constants";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import revisionFixture from "@/generated/fixtures/scenario/broken-nginx-revision.json";
import refusalsFixture from "@/generated/fixtures/scenario/bundle-refusals.json";
import sourceRefusalSchema from "@/generated/schemas/source-refusal-v1.schema.json";
import { GITHUB_ACTIONS_ISSUER } from "@/lib/github-oidc";
import { REVISION_REPLACED, settleScenarioRevisions } from "@/lib/machine-builds";
import {
  PIPELINE_REVISION_DEADLINE_MS,
  REVISION_PIPELINE_DEADLINE,
  REVISION_SOURCE_DISCONNECTED,
} from "@/lib/pipeline-revisions";
import { ingestSourceBundle, sourceBundleObjectKey } from "@/lib/scenario-bundles";
import { baseKey } from "@/lib/scenario-contract/build-key";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { changeScenarioSource, scenarioSourceScope, stagedSourceObjectPrefix } from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const BUNDLE = JSON.stringify(bundleFixture);
const STORED = revisionFixture as {
  scenario_id: string;
  revision: { json: string; digest: string };
  specs: Record<string, Record<string, { json: string; digest: string }>>;
};
const REFUSALS = refusalsFixture as { name: string; bundle: unknown }[];

const ADMIN = "admin";
const OWNER = "owner";
const ORG = "org-a";
const SHA = "a".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
// Repository 42 is bound to the public scope, 43 to the organization `acme`.
const REPOS = {
  42: { scope: "public", name: "intar/scenarios" },
  43: { scope: `organization:${ORG}`, name: "acme/labs" },
} as const;

let testEnv: Cloudflare.Env;
let digest: string;
let oidcKey: CryptoKey;
let jwks: unknown;

const rev = (repo = 42, at = digest) => `git-${repo}-${SHA}-${at}`;
const gz = (text: string | unknown) =>
  new Uint8Array(gzipSync(typeof text === "string" ? text : JSON.stringify(text)));

beforeAll(async () => {
  const app = await generateKeyPair("RS256", { extractable: true });
  const oidc = await generateKeyPair("RS256", { extractable: true });
  oidcKey = oidc.privateKey;
  jwks = { keys: [{ ...(await exportJWK(oidc.publicKey)), kid: "k1", alg: "RS256" }] };
  testEnv = {
    ...env,
    GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(app.privateKey),
    SCENARIO_PUBLISH_WORKFLOW_SHAS: WORKFLOW_SHA,
  } as unknown as Cloudflare.Env;
  digest = await sourceCompileDigest();
});

beforeEach(async () => {
  await resetD1Database();
  const db = drizzle(env.DB);
  await createFixtureMember({ d1: env.DB, userId: ADMIN, role: "admin", githubAccountId: "1000" });
  await createFixtureMember({ d1: env.DB, userId: OWNER, githubAccountId: "1001" });
  await db.insert(organization).values({ id: ORG, name: "Acme", slug: "acme", createdAt: new Date() });
  await db.insert(member).values({
    id: "owner-member", organizationId: ORG, userId: OWNER, role: "owner", createdAt: new Date(),
  });
  for (const [id, repo] of Object.entries(REPOS)) {
    const isPublic = repo.scope === "public";
    await db.insert(scenarioSources).values({
      scopeKey: repo.scope,
      organizationId: isPublic ? null : ORG,
      githubInstallationId: Number(id),
      githubRepositoryId: Number(id),
      githubRepository: repo.name,
      defaultBranch: "main",
      mode: "push",
      boundByUserId: isPublic ? ADMIN : OWNER,
    });
  }
  for (const prefix of ["builds/", "oci/"]) {
    const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix });
    if (listed.objects.length) {
      await env.VM_IMAGE_REGISTRY_BUCKET.delete(listed.objects.map((object) => object.key));
    }
  }
  github();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** GitHub: OIDC keys, one installation per repository (same id), heads at `SHA`, check runs. */
function github() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/jwks") return Response.json(jwks);
    const installation = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)?.[1];
    if (installation) return Response.json({ token: `ghs_${installation}` }, { status: 201 });
    if (path === "/installation/repositories") {
      const id = Number((request.headers.get("authorization") ?? "").split("ghs_")[1]) as keyof typeof REPOS;
      return Response.json({
        repositories: [{ id: Number(id), full_name: REPOS[id].name, default_branch: "main" }],
      });
    }
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: SHA } });
    if (path.endsWith("/check-runs")) return Response.json({ id: 901 }, { status: 201 });
    if (path.includes("/check-runs/")) return Response.json({ id: 901 });
    return new Response(null, { status: 404 });
  });
}

async function oidcToken(repo: number, runner = "github-hosted"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository_id: String(repo),
    ref: "refs/heads/main",
    sha: SHA,
    event_name: "push",
    runner_environment: runner,
    run_id: "17700000001",
    run_attempt: "1",
    job_workflow_ref:
      "intar-dev/intar-dev/.github/workflows/scenario-publish.yml@refs/tags/scenario-publish-v1",
    job_workflow_sha: WORKFLOW_SHA,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(GITHUB_ACTIONS_ISSUER)
    .setAudience(env.BETTER_AUTH_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(oidcKey);
}

/** A multipart form shaped like the CLI's and the builder's. */
async function form(meta: unknown, bundle: Uint8Array<ArrayBuffer> | null, headers: Record<string, string>, url: string) {
  const body = new FormData();
  body.set("meta", JSON.stringify(meta));
  if (bundle) body.set("bundle", new File([bundle], "bundle.json.gz", { type: "application/gzip" }));
  const encoded = new Response(body);
  const bytes = await encoded.arrayBuffer();
  return new Request(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": encoded.headers.get("content-type") ?? "",
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
}

/** The CLI's `bundle` upload. */
async function push(input: { repo?: 42 | 43; rev?: string; bundle?: Uint8Array<ArrayBuffer>; runner?: string } = {}) {
  const repo = input.repo ?? 42;
  const request = await form(
    { rev: input.rev ?? rev(repo) },
    input.bundle ?? gz(BUNDLE),
    { authorization: `Bearer ${await oidcToken(repo, input.runner)}` },
    `https://intar.test${SOURCE_BUNDLES_PATH}`,
  );
  const response = await handleImageRegistryRequest(request, testEnv);
  if (!response) throw new Error("the source route is not registered");
  return response;
}

/** One alarm of the source DO of `scope`. */
async function tick(scope: string) {
  const values: Record<string | symbol, unknown> = {
    GITHUB_APP_CLIENT_ID: testEnv.GITHUB_APP_CLIENT_ID,
    GITHUB_APP_PRIVATE_KEY: testEnv.GITHUB_APP_PRIVATE_KEY,
  };
  const doEnv = new Proxy(env, {
    get: (target, key) => (Object.hasOwn(values, key) ? values[key] : Reflect.get(target, key)),
  });
  const stub = env.SCENARIO_SOURCE.get(env.SCENARIO_SOURCE.idFromName(scope));
  await runInDurableObject(stub, async (instance: ScenarioSourceDO, state) => {
    Object.defineProperty(instance, "env", { configurable: true, value: doEnv });
    await state.storage.put("scope", scope);
    await instance.alarm();
    await state.storage.deleteAlarm();
  });
}

const all = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;

/** Every row and object an ingest may write. */
async function written() {
  const keys = async (prefix: string) =>
    (await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix })).objects.map((object) => object.key).sort();
  return {
    commits: await all("SELECT scope_key, rev, state, updated_at FROM scenario_source_commits ORDER BY rev"),
    bundles: await all("SELECT * FROM bundles ORDER BY rev"),
    scenarios: await all("SELECT * FROM scenarios ORDER BY id"),
    revisions: await all("SELECT * FROM scenario_revisions ORDER BY scenario_id"),
    builds: await all("SELECT * FROM machine_builds ORDER BY build_key"),
    catalogs: await all("SELECT * FROM course_catalogs ORDER BY scope_key"),
    objects: [...(await keys("builds/")), ...(await keys("oci/"))],
  };
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.code).toBe(code);
  if (sourceRefusalSchema.$defs.SourceRefusalCode.enum.includes(code)) {
    expect(Object.keys(body).sort()).toEqual([...sourceRefusalSchema.required].sort());
  }
}

describe("v2 bundle ingest", () => {
  it("accepts the fixture bundle and ingests it as Rust stores it", async () => {
    const response = await push();
    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, rev: rev(), queued: 0, assigned: [] });
    const staged = `${stagedSourceObjectPrefix("public", rev(), "deploy")}bundle.json.gz`;
    expect((await written()).objects).toEqual([staged]);

    await tick("public");
    const after = await written();
    expect(after.commits).toEqual([expect.objectContaining({ rev: rev(), state: "building" })]);
    expect(after.bundles).toEqual([
      expect.objectContaining({
        rev: rev(), scope_key: "public", organization_id: null,
        compiler_version: "intar-source-compiler-v2", r2_key: sourceBundleObjectKey(rev()),
      }),
    ]);
    expect(after.scenarios).toEqual([
      expect.objectContaining({
        id: "intar/broken-nginx", namespace: "intar", slug: "broken-nginx", organization_id: null,
        scope_key: "public", enabled: 1, live_rev: null, candidate_rev: null,
      }),
    ]);
    expect(after.revisions).toEqual([
      expect.objectContaining({
        scenario_id: STORED.scenario_id, rev: rev(), guest_contract: 3, state: "building",
        doc_json: STORED.revision.json, content_digest: null,
      }),
    ]);
    // The broken-nginx machine has setup on the base, so it is a machine build.
    expect(after.builds).toHaveLength(1);
    expect(after.builds[0]).toMatchObject({
      image_format: "intar-image-4", bundle_rev: rev(), state: "queued", attempt: 0, host_id: null,
      target_json: JSON.stringify({ kind: "machine", scenario: "broken-nginx", machine: "webserver" }),
    });
    const revision = JSON.parse(STORED.revision.json) as { machines: { build_key: string }[] };
    expect(after.builds[0]!.build_key).toBe(revision.machines[0]!.build_key);
    // Promotion applies the course catalog, not ingest.
    expect(after.catalogs).toEqual([]);

    const specs = Object.values(STORED.specs).flatMap((modes) => Object.values(modes));
    expect(after.objects).toEqual(
      [sourceBundleObjectKey(rev()), ...specs.map((spec) => `oci/sha256/${spec.digest.slice(7)}`)].sort(),
    );
    for (const spec of specs) {
      const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(`oci/sha256/${spec.digest.slice(7)}`);
      expect(await object?.text()).toBe(spec.json);
    }
    const stored = await env.VM_IMAGE_REGISTRY_BUCKET.get(sourceBundleObjectKey(rev()));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(gz(BUNDLE));
  });

  it("answers the same rev again as the first time and changes nothing", async () => {
    expect((await push()).status).toBe(202);
    await tick("public");
    const before = await written();
    const again = await push();
    expect(again.status).toBe(202);
    await expect(again.json()).resolves.toEqual({ ok: true, rev: rev(), queued: 0, assigned: [] });
    await tick("public");
    expect(await written()).toEqual(before);
  });

  it("leaves the scope's course catalog as it was", async () => {
    await env.DB.prepare(
      `INSERT INTO course_catalogs (scope_key, organization_id, catalog_json, source_revision)
        VALUES ('public', NULL, '{"version":2,"courses":[]}', 'earlier')`,
    ).run();
    const before = (await written()).catalogs;
    expect((await push()).status).toBe(202);
    await tick("public");
    expect((await written()).catalogs).toEqual(before);
  });

  it("keeps the first bytes of a rev and the rows that describe them", async () => {
    expect((await push()).status).toBe(202);
    await tick("public");
    const first = await written();
    const other = JSON.parse(BUNDLE) as { scenarios: { title: string; tasks: { title: string }[] }[] };
    other.scenarios[0]!.title = "Another title";
    // A re-upload that staged other valid bytes for the same rev.
    const staged = `${stagedSourceObjectPrefix("public", rev(), "deploy")}bundle.json.gz`;
    await env.VM_IMAGE_REGISTRY_BUCKET.put(staged, gz(other));
    await env.DB.prepare("UPDATE scenario_source_commits SET state = 'ingesting'").run();
    await tick("public");
    // And a racing try that never saw the bundle row.
    await expect(
      ingestSourceBundle(env, { organizationId: null, rev: rev(), gzip: gz(other), stored: false }),
    ).resolves.toBeNull();
    const after = await written();
    expect({ ...after, commits: [] }).toEqual({ ...first, commits: [] });
    const stored = await env.VM_IMAGE_REGISTRY_BUCKET.get(sourceBundleObjectKey(rev()));
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(gz(BUNDLE));
  });

  it("writes revisions whose documents together exceed one D1 value", async () => {
    const bundle = JSON.parse(BUNDLE) as { scenarios: Record<string, unknown>[] };
    const [scenario] = bundle.scenarios;
    for (let n = 0; n < 20; n += 1) {
      bundle.scenarios.push({
        ...scenario,
        slug: `broken-nginx-${String(n).padStart(2, "0")}`,
        briefing: `${String.fromCharCode(97 + n)}`.repeat(60_000),
        solution: "s".repeat(60_000),
      });
    }
    await expect(
      ingestSourceBundle(env, { organizationId: null, rev: rev(), gzip: gz(bundle), stored: false }),
    ).resolves.toBeNull();
    const docs = await all("SELECT length(doc_json) AS size FROM scenario_revisions");
    expect(docs).toHaveLength(21);
    expect(docs.reduce((sum, row) => sum + Number(row.size), 0)).toBeGreaterThan(2_000_000);
  });

  it("completes a partial earlier attempt from the stored bundle", async () => {
    expect((await push()).status).toBe(202);
    await tick("public");
    const complete = await written();
    // A try that stored the object and the bundle row, then stopped.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM scenario_revisions"),
      env.DB.prepare("DELETE FROM machine_builds"),
      env.DB.prepare("UPDATE scenario_source_commits SET state = 'ingesting'"),
    ]);
    await tick("public");
    const done = await written();
    expect(done.revisions).toEqual([
      expect.objectContaining({ doc_json: STORED.revision.json, state: "building" }),
    ]);
    expect(done.builds.map((row) => row.build_key)).toEqual(complete.builds.map((row) => row.build_key));
    expect(done.bundles).toEqual(complete.bundles);
    expect(done.scenarios).toEqual(complete.scenarios);
    expect(done.commits).toEqual([expect.objectContaining({ state: "building" })]);
  });

  it("refuses an outdated compile digest as compiler_outdated and writes nothing", async () => {
    const before = await written();
    await expectRefusal(await push({ rev: rev(42, "p00000000") }), 409, "compiler_outdated");
    expect(await written()).toEqual(before);
  });

  it("refuses a bundle of another compiler as compiler_outdated", async () => {
    const outdated = { ...JSON.parse(BUNDLE), compiler: "intar-source-compiler-v1" };
    await expectRefusal(await push({ bundle: gz(outdated) }), 409, "compiler_outdated");
  });

  it.each(REFUSALS.slice(0, 34).filter((_, index) => index % 6 === 0).map((entry) => [entry.name, entry] as const))(
    "refuses the invalid bundle %s with nothing written",
    async (_name, entry) => {
      const before = await written();
      const response = await push({ bundle: gz(entry.bundle) });
      expect([400, 409]).toContain(response.status);
      expect(await written()).toEqual(before);
    },
  );

  it("refuses an oversized gzip and a gzip bomb", async () => {
    const before = await written();
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    expect((await push({ bundle: oversized })).status).toBe(413);
    const bomb = gz(`${" ".repeat(33 * 1024 * 1024)}{}`);
    expect((await push({ bundle: bomb })).status).toBe(413);
    expect(await written()).toEqual(before);
  });

  it("takes a runner that is not GitHub-hosted only for a source that allows it", async () => {
    // As before the source could say so: the token itself is refused.
    await expectRefusal(await push({ runner: "self-hosted" }), 401, "unauthorized");
    await drizzle(env.DB).update(scenarioSources).set({ allowSelfHostedRunners: true });
    expect((await push({ runner: "self-hosted" })).status).toBe(202);
  });

  it("refuses a rev of another commit", async () => {
    await expectRefusal(await push({ rev: `git-42-${"b".repeat(40)}-${digest}` }), 400, "source_rev_invalid");
  });
});

describe("a source whose pipeline builds its images", () => {
  const KEY = (JSON.parse(STORED.revision.json) as { machines: { build_key: string }[] }).machines[0]!.build_key;
  const IMAGE = `sha256:${"1".repeat(64)}`;
  const DAY = PIPELINE_REVISION_DEADLINE_MS;
  const byPipeline = (scope = "public") =>
    env.DB.prepare("UPDATE scenario_sources SET image_producer = 'pipeline' WHERE scope_key = ?1").bind(scope).run();
  /** An image as a pipeline's result records it, with its manifest row. */
  async function record(input: { scope?: string; architecture?: string; digest?: string; format?: string; manifest?: boolean } = {}) {
    const digest = input.digest ?? IMAGE;
    if (input.manifest !== false) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO registry_manifests (digest, media_type, artifact_type, size, created_at)
         VALUES (?1, 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.intar.machine.v1', 1, 0)`,
      ).bind(digest).run();
    }
    await env.DB.prepare(
      `INSERT INTO scope_machine_images (scope_key, build_key, architecture, image_digest, image_format, size_bytes,
         github_repository_id, github_repository, sha, run_id, run_attempt, runner_environment, job_workflow_sha)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, 42, 'intar/scenarios', ?6, '1', 1, 'github-hosted', ?7)`,
    ).bind(input.scope ?? "public", KEY, input.architecture ?? "amd64", digest, input.format ?? "intar-image-4", SHA, WORKFLOW_SHA).run();
  }
  const revisions = () => all("SELECT scenario_id, rev, state, failure_reason, created_at FROM scenario_revisions ORDER BY rev");
  const commits = () => all("SELECT rev, state, detail FROM scenario_source_commits ORDER BY rev");
  const age = (ms: number) => env.DB.prepare("UPDATE scenario_revisions SET created_at = created_at - ?1").bind(ms).run();
  const plan = async (response: Response) => ((await response.json()) as { pipeline?: unknown }).pipeline;
  const BOTH = [{ build_key: KEY, architecture: "amd64" }, { build_key: KEY, architecture: "arm64" }];

  it("ingests without a build, and says in its receipt which images are missing", async () => {
    await byPipeline();
    const first = await push();
    expect(first.status).toBe(202);
    // Before ingest the keys are the uploaded bundle's; a second upload reads the same.
    expect(await plan(first)).toEqual({ architectures: ["amd64", "arm64"], missing: BOTH });
    expect(await plan(await push())).toEqual({ architectures: ["amd64", "arm64"], missing: BOTH });

    await tick("public");
    const after = await written();
    expect(after.builds).toEqual([]);
    expect(after.bundles).toEqual([expect.objectContaining({ rev: rev(), image_producer: "pipeline" })]);
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);

    // After ingest they are the revisions'. Another scope's image, a stale
    // format and a row without its manifest all leave the image missing.
    await record({ scope: `organization:${ORG}` });
    await record({ architecture: "arm64", digest: `sha256:${"2".repeat(64)}`, manifest: false });
    expect(await plan(await push())).toEqual({ architectures: ["amd64", "arm64"], missing: BOTH });
    await record();
    const before = await written();
    expect(await plan(await push())).toEqual({ architectures: ["amd64", "arm64"], missing: [BOTH[1]] });
    // Answering for a rev that is already held stages and claims nothing.
    expect(await written()).toEqual(before);
  });

  it("gives a builder source the receipt it always got, whatever is recorded", async () => {
    await record();
    const response = await push();
    await expect(response.json()).resolves.toEqual({ ok: true, rev: rev(), queued: 0, assigned: [] });
    await tick("public");
    expect((await written()).bundles).toEqual([expect.objectContaining({ image_producer: "builder" })]);
    // The scope's image does not complete a builder's revision.
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);
    expect((await written()).builds).toHaveLength(1);
  });

  it("settles at ingest when every image is recorded, and only from its own scope's amd64 images", async () => {
    await byPipeline();
    // None of these is its image: a builder's build of the key, another
    // scope's image, an arm64 one, one of a stale format, one without its manifest.
    await env.DB.prepare(
      `INSERT INTO machine_builds (build_key, image_format, bundle_rev, state, image_digest, updated_at)
       VALUES (?1, 'intar-image-4', 'other', 'succeeded', ?2, 0)`,
    ).bind(KEY, IMAGE).run();
    await record({ scope: `organization:${ORG}` });
    await record({ architecture: "arm64" });
    await push();
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);

    await record({ format: "intar-image-3" });
    await settleScenarioRevisions(env, { buildKey: KEY });
    await env.DB.prepare("UPDATE scope_machine_images SET image_format = 'intar-image-4', image_digest = ?1 WHERE architecture = 'amd64' AND scope_key = 'public'")
      .bind(`sha256:${"3".repeat(64)}`).run();
    await settleScenarioRevisions(env, { buildKey: KEY });
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);

    // Its own image, and a settle another scope asked for does not reach it.
    await env.DB.prepare("UPDATE scope_machine_images SET image_digest = ?1 WHERE architecture = 'amd64' AND scope_key = 'public'").bind(IMAGE).run();
    await settleScenarioRevisions(env, { buildKey: KEY, scopeKey: `organization:${ORG}` });
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);
    await settleScenarioRevisions(env, { buildKey: KEY, scopeKey: "public" });
    expect(await revisions()).toEqual([expect.objectContaining({ state: "ready" })]);
    const [{ doc_json: doc }] = await all("SELECT doc_json FROM scenario_revisions") as [{ doc_json: string }];
    expect((JSON.parse(doc) as { machines: { image_digest: string }[] }).machines[0]!.image_digest).toBe(IMAGE);
    expect((await all("SELECT candidate_rev FROM scenarios"))[0]).toEqual({ candidate_rev: rev() });
  });

  it("is ready straight from ingest when its image was recorded before", async () => {
    await byPipeline();
    await record();
    await push();
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "ready" })]);
  });

  it("keeps the producer a rev was first ingested with", async () => {
    await byPipeline();
    await push();
    await tick("public");
    await env.DB.prepare("UPDATE scenario_sources SET image_producer = 'builder'").run();
    await env.DB.prepare("UPDATE scenario_source_commits SET state = 'failed'").run();
    expect(await plan(await push())).toEqual({ architectures: ["amd64", "arm64"], missing: BOTH });
    await tick("public");
    expect((await written()).builds).toEqual([]);

    // And the other way: a builder's rev stays a builder's.
    await byPipeline(`organization:${ORG}`);
    await env.DB.prepare("UPDATE scenario_sources SET image_producer = 'builder' WHERE scope_key != 'public'").run();
    await push({ repo: 43 });
    await tick(`organization:${ORG}`);
    await byPipeline(`organization:${ORG}`);
    await env.DB.prepare("UPDATE scenario_source_commits SET state = 'failed' WHERE scope_key != 'public'").run();
    expect(await plan(await push({ repo: 43 }))).toBeUndefined();
  });

  it("settles on its next pass what a result left unsettled", async () => {
    await byPipeline();
    await push();
    await tick("public");
    await record();
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "ready" })]);
    expect(await commits()).toEqual([expect.objectContaining({ state: "building" })]);
  });

  it("fails a revision that waited a day, also while paused, and a new publish of the commit takes it up again", async () => {
    await byPipeline();
    await push();
    await tick("public");
    await age(DAY - 60_000);
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);

    await env.DB.prepare("UPDATE scenario_sources SET paused_at = 1, pause_reason = 'admin'").run();
    await age(60_001);
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "failed", failure_reason: REVISION_PIPELINE_DEADLINE })]);
    expect(await commits()).toEqual([{
      rev: rev(), state: "failed",
      detail: `${REVISION_PIPELINE_DEADLINE} Missing: intar/broken-nginx/webserver (amd64).`,
    }]);

    await env.DB.prepare("UPDATE scenario_sources SET paused_at = NULL, pause_reason = NULL").run();
    const before = Date.now();
    expect(await plan(await push())).toEqual({ architectures: ["amd64", "arm64"], missing: BOTH });
    await tick("public");
    const [revived] = await revisions();
    expect(revived).toMatchObject({ state: "building", failure_reason: null });
    expect(revived!.created_at as number).toBeGreaterThanOrEqual(before);
    expect(await commits()).toEqual([expect.objectContaining({ state: "building", detail: null })]);
  });

  it("leaves the commit building while one of its revisions still waits", async () => {
    await byPipeline();
    await push();
    await tick("public");
    await env.DB.prepare("INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play) VALUES ('intar/other', 'intar', 'other', 'public', 1, 0)").run();
    await env.DB.prepare(
      `INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
       SELECT 'intar/other', rev, guest_contract, doc_json, 'building', ?1 FROM scenario_revisions`,
    ).bind(Date.now()).run();
    await env.DB.prepare("UPDATE scenario_revisions SET created_at = created_at - ?1 WHERE scenario_id != 'intar/other'").bind(DAY + 1).run();
    await tick("public");
    expect((await revisions()).map((row) => row.state).sort()).toEqual(["building", "failed"]);
    expect(await commits()).toEqual([expect.objectContaining({ state: "building" })]);

    // Once the other is ready the commit fails for the one that never was,
    // and a new publish takes up that one alone.
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'ready', created_at = 5 WHERE scenario_id = 'intar/other'").run();
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'building' WHERE scenario_id != 'intar/other'").run();
    await tick("public");
    expect(await commits()).toEqual([expect.objectContaining({ state: "failed" })]);
    expect((await push()).status).toBe(202);
    await tick("public");
    expect(await all("SELECT scenario_id, state, created_at = 5 AS untouched FROM scenario_revisions ORDER BY scenario_id")).toEqual([
      { scenario_id: "intar/broken-nginx", state: "building", untouched: 0 },
      { scenario_id: "intar/other", state: "ready", untouched: 1 },
    ]);
  });

  it("fails a revision a newer publish of its scenario replaced", async () => {
    await byPipeline();
    await push();
    await tick("public");
    await env.DB.prepare(
      `INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
       SELECT scenario_id, 'newer', guest_contract, doc_json, 'building', created_at + 1 FROM scenario_revisions`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO bundles (rev, scope_key, compiler_version, r2_key, image_producer) VALUES ('newer', 'public', 'c', 'k', 'pipeline')`,
    ).run();
    await tick("public");
    expect(await revisions()).toEqual([
      expect.objectContaining({ rev: rev(), state: "failed", failure_reason: REVISION_REPLACED }),
      expect.objectContaining({ rev: "newer", state: "building" }),
    ]);
  });

  it("fails its building revisions with a disconnect, and a reconnect and publish takes them up again", async () => {
    await byPipeline();
    await push();
    await tick("public");
    // A disconnect that does not apply changes nothing.
    await createFixtureMember({ d1: env.DB, userId: "stranger", githubAccountId: "1002" });
    await changeScenarioSource({
      scope: scenarioSourceScope(null), actorUserId: "stranger", body: { action: "disconnect" }, startedAt: Date.now(),
    }).catch(() => undefined);
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);

    await changeScenarioSource({
      scope: scenarioSourceScope(null), actorUserId: ADMIN, body: { action: "disconnect" }, startedAt: Date.now(),
    });
    expect(await revisions()).toEqual([expect.objectContaining({ state: "failed", failure_reason: REVISION_SOURCE_DISCONNECTED })]);

    // Its commit failed with it, so the next publish is not answered as done.
    expect(await commits()).toEqual([{ rev: rev(), state: "failed", detail: REVISION_SOURCE_DISCONNECTED }]);

    await env.DB.prepare("UPDATE scenario_sources SET disconnected_at = NULL, disconnect_reason = NULL").run();
    expect((await push()).status).toBe(202);
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building", failure_reason: null })]);
  });

  it("fails them too when GitHub says the installation is gone", async () => {
    await byPipeline();
    await push();
    await tick("public");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
    await tick("public");
    expect((await all("SELECT disconnect_reason FROM scenario_sources WHERE scope_key = 'public'"))[0])
      .toEqual({ disconnect_reason: "github_gone" });
    expect(await revisions()).toEqual([expect.objectContaining({ state: "failed", failure_reason: REVISION_SOURCE_DISCONNECTED })]);
    expect(await commits()).toEqual([expect.objectContaining({ state: "failed" })]);
  });

  it("does not take up a pipeline's commit again once its source pulls", async () => {
    await byPipeline();
    await push();
    await tick("public");
    // Switched to the builder and to pull mode; the head's revision failed with the switch.
    await env.DB.prepare("UPDATE scenario_sources SET image_producer = 'builder', mode = 'pull'").run();
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'failed', failure_reason = 'switched'").run();
    // A re-run of the check asks for the commit again.
    await env.DB.prepare("UPDATE scenario_source_commits SET state = 'ingesting', attempt = attempt + 1").run();
    const before = (await written()).objects;
    await tick("public");
    expect(await commits()).toEqual([{
      rev: rev(), state: "invalid", detail: expect.stringContaining("publish a new commit"),
    }]);
    expect(await revisions()).toEqual([expect.objectContaining({ state: "failed", failure_reason: "switched" })]);
    expect((await written()).objects).toEqual(before);
    expect((await written()).builds).toEqual([]);

    // Back in push mode the same commit is taken up.
    await env.DB.prepare("UPDATE scenario_sources SET mode = 'push'").run();
    await env.DB.prepare("UPDATE scenario_source_commits SET state = 'ingesting', attempt = attempt + 1").run();
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building", failure_reason: null })]);
  });

  it("still ingests when the pass over the pipeline's revisions fails", async () => {
    await push();
    // The pass reads this table first.
    await env.DB.prepare("ALTER TABLE bundles RENAME COLUMN image_producer TO producer_gone").run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tick("public").catch(() => undefined);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("pipeline_revisions_maintenance_failed"));
    await env.DB.prepare("ALTER TABLE bundles RENAME COLUMN producer_gone TO image_producer").run();
    await tick("public");
    expect(await revisions()).toEqual([expect.objectContaining({ state: "building" })]);
  });
});

describe("namespaces", () => {
  it("files an organization's bundle under its own slug only", async () => {
    expect((await push()).status).toBe(202);
    await tick("public");
    const publicRows = await written();

    expect((await push({ repo: 43 })).status).toBe(202);
    await tick(REPOS[43].scope);
    const after = await written();
    expect(after.scenarios.map((row) => [row.id, row.scope_key])).toEqual([
      ["acme/broken-nginx", REPOS[43].scope],
      ["intar/broken-nginx", "public"],
    ]);
    expect(after.revisions.map((row) => [row.scenario_id, row.rev])).toEqual([
      ["acme/broken-nginx", rev(43)],
      ["intar/broken-nginx", rev(42)],
    ]);
    // The public scope's rows are as they were.
    expect(after.scenarios.find((row) => row.id === "intar/broken-nginx")).toEqual(publicRows.scenarios[0]);
    expect(after.catalogs).toEqual(publicRows.catalogs);
  });

  it("never writes into a scenario or a rev of another scope", async () => {
    const ingest = (organizationId: string | null, at: string) =>
      ingestSourceBundle(env, { organizationId, rev: at, gzip: gz(BUNDLE), stored: false });
    // A scenario in this namespace held by another scope.
    await env.DB.prepare(
      `INSERT INTO scenarios (id, namespace, slug, organization_id, scope_key, enabled, play)
        VALUES ('acme/broken-nginx', 'acme', 'broken-nginx', NULL, 'public', 1, 0)`,
    ).run();
    await expect(ingest(ORG, rev(43))).resolves.toBe("scenario `acme/broken-nginx` belongs to another scope");
    // A rev another scope already ingested.
    await expect(ingest(null, rev(42))).resolves.toBeNull();
    await expect(ingest(ORG, rev(42))).resolves.toBe("this commit is owned by another scope");
    // The public namespace is not an organization's.
    await env.DB.prepare("UPDATE organization SET slug = 'intar' WHERE id = ?1").bind(ORG).run();
    await expect(ingest(ORG, rev(43))).resolves.toContain("is not a scenario namespace");
    expect(await all("SELECT scenario_id, rev FROM scenario_revisions")).toEqual([
      { scenario_id: "intar/broken-nginx", rev: rev(42) },
    ]);
  });
});

describe("builder routes", () => {
  let tokens: Record<string, string>;

  beforeEach(async () => {
    tokens = {};
    for (const hostId of ["builder-1", "builder-2"]) {
      await drizzle(env.DB).insert(agentHosts).values({
        id: hostId, userId: ADMIN, name: hostId, role: "builder", scope: "platform", credentialGeneration: 1,
      });
      await drizzle(env.DB).insert(agentBootstrapTokens).values({
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
  });

  const download = async (hostId: string, at: string) =>
    (await handleImageRegistryRequest(
      new Request(`https://intar.test/agent/registry/bundles/${at}`, {
        headers: { authorization: `Bearer ${tokens[hostId]}` },
      }),
      testEnv,
    ))!;

  it("serves the bundle only to the builder its build is assigned to", async () => {
    expect((await push()).status).toBe(202);
    await tick("public");
    const queued = await download("builder-1", rev());
    expect(queued.status).toBe(404);
    await queued.body?.cancel();
    await env.DB.prepare("UPDATE machine_builds SET state = 'assigned', host_id = 'builder-1'").run();

    const served = await download("builder-1", rev());
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(gz(BUNDLE));
    const other = await download("builder-2", rev());
    expect(other.status).toBe(404);
    await other.body?.cancel();
    const unknown = await download("builder-1", rev(42, "p00000000"));
    expect(unknown.status).toBe(404);
    await unknown.body?.cancel();
  });

  describe("compile results", () => {
    const COMPILE = "compile-1";

    async function result(purpose: "deploy" | "validate", bundle: Uint8Array<ArrayBuffer> | null) {
      await drizzle(env.DB).update(scenarioSources).set({ mode: "pull", headSha: SHA, headObservedAt: 1 });
      await drizzle(env.DB).insert(scenarioSourceCommits).values({
        id: COMPILE, scopeKey: "public", purpose, sha: SHA, rev: rev(), via: "pull", attempt: 1,
        state: "compiling", compileHostId: "builder-1", compileAssignedAt: Date.now(),
      });
      const request = await form(
        { rev: rev() },
        bundle,
        { authorization: `Bearer ${tokens["builder-1"]}` },
        `https://intar.test${AGENT_SOURCES_PATH}/${COMPILE}/result?attempt=1`,
      );
      return (await handleImageRegistryRequest(request, testEnv))!;
    }

    it("stages a compiled bundle for ingest", async () => {
      const response = await result("deploy", gz(BUNDLE));
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await all("SELECT state FROM scenario_source_commits")).toEqual([{ state: "ingesting" }]);
      expect((await written()).objects).toEqual([
        `${stagedSourceObjectPrefix("public", rev(), "deploy")}bundle.json.gz`,
      ]);
    });

    it("settles a validate-only result without a bundle", async () => {
      const response = await result("validate", null);
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await all("SELECT state FROM scenario_source_commits")).toEqual([{ state: "validated" }]);
      expect((await written()).objects).toEqual([]);
    });

    it("refuses an invalid compiled bundle and settles the row invalid", async () => {
      const invalid = { ...JSON.parse(BUNDLE), scenarios: [] , course_catalog: { version: 3, courses: [] } };
      const response = await result("deploy", gz(invalid));
      expect(response.status).toBe(400);
      expect(await all("SELECT state FROM scenario_source_commits")).toEqual([{ state: "invalid" }]);
      expect((await written()).objects).toEqual([]);
    });
  });
});

describe("compiler descriptor", () => {
  it("names the v2 source compile digest", async () => {
    const sha256 = { linux_amd64: "e".repeat(64) };
    const response = await handleImageRegistryRequest(new Request(`https://intar.test${SOURCE_COMPILER_PATH}`), {
      ...testEnv,
      SCENARIO_COMPILER_CLI_VERSION: "0.9.0",
      SCENARIO_COMPILER_CLI_SHA256: JSON.stringify(sha256),
    } as unknown as Cloudflare.Env);
    await expect(response?.json()).resolves.toEqual({ cli_version: "0.9.0", sha256, digest });
  });

  it("names the release of the pinned Kino once the deploy says which it is, for both architectures", async () => {
    const sha256 = { linux_amd64: "e".repeat(64) };
    const amd64 = { version: "0.12.0", sha256: "a".repeat(64) };
    const arm64 = { version: "0.12.0", sha256: "b".repeat(64) };
    const read = async (releases: unknown) => {
      const response = await handleImageRegistryRequest(new Request(`https://intar.test${SOURCE_COMPILER_PATH}`), {
        ...testEnv,
        SCENARIO_COMPILER_CLI_VERSION: "0.9.0",
        SCENARIO_COMPILER_CLI_SHA256: JSON.stringify(sha256),
        KINO_RELEASES_JSON: typeof releases === "string" ? releases : JSON.stringify(releases),
      } as unknown as Cloudflare.Env);
      return ((await response?.json()) as { kino?: unknown }).kino;
    };
    expect(await read({ 3: { amd64, arm64 } })).toEqual({ amd64, arm64 });
    // Another contract's, one architecture alone, a malformed entry or text: none.
    for (const releases of [
      { 2: { amd64, arm64 } },
      { 3: { amd64 } },
      { 3: { amd64, arm64: { version: "latest", sha256: "b".repeat(64) } } },
      { 3: { amd64, arm64: { version: "0.12.0", sha256: "short" } } },
      "not json",
      "",
    ]) {
      expect(await read(releases)).toBeUndefined();
    }
  });
});

it("queues the base image build for a zero-setup machine on the platform base", async () => {
  const bundle = JSON.parse(BUNDLE) as { scenarios: { machines: { setup: unknown[]; defer: unknown[] }[] }[] };
  for (const machine of bundle.scenarios[0]!.machines) {
    machine.setup = [];
    machine.defer = [];
  }
  await expect(
    ingestSourceBundle(env, { organizationId: null, rev: rev(), gzip: gz(bundle), stored: false }),
  ).resolves.toBeNull();
  expect(await all("SELECT build_key, target_json FROM machine_builds")).toEqual([
    { build_key: await baseKey(), target_json: JSON.stringify({ kind: "image", name: "trixie" }) },
  ]);
});
