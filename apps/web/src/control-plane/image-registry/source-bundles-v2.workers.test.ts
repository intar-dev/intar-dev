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
import { ingestSourceBundle, sourceBundleObjectKey } from "@/lib/scenario-bundles";
import { baseKey } from "@/lib/scenario-contract/build-key";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { stagedSourceObjectPrefix } from "@/lib/scenario-sources";
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

async function oidcToken(repo: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository_id: String(repo),
    ref: "refs/heads/main",
    sha: SHA,
    event_name: "push",
    runner_environment: "github-hosted",
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
async function push(input: { repo?: 42 | 43; rev?: string; bundle?: Uint8Array<ArrayBuffer> } = {}) {
  const repo = input.repo ?? 42;
  const request = await form(
    { rev: input.rev ?? rev(repo) },
    input.bundle ?? gz(BUNDLE),
    { authorization: `Bearer ${await oidcToken(repo)}` },
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
      image_format: "intar-image-3", bundle_rev: rev(), state: "queued", attempt: 0, host_id: null,
      target_json: JSON.stringify({ kind: "machine", scenario: "broken-nginx", machine: "webserver" }),
    });
    const revision = JSON.parse(STORED.revision.json) as { machines: { build_key: string }[] };
    expect(after.builds[0]!.build_key).toBe(revision.machines[0]!.build_key);
    // Lecture links are namespaced from the binding.
    const linked = JSON.stringify(after.catalogs);
    expect(linked).toContain('\\"scenarioId\\":\\"intar/broken-nginx\\"');
    expect(after.catalogs).toEqual([expect.objectContaining({ scope_key: "public", source_revision: rev() })]);

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

  it("refuses a rev of another commit", async () => {
    await expectRefusal(await push({ rev: `git-42-${"b".repeat(40)}-${digest}` }), 400, "source_rev_invalid");
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
    expect(after.catalogs.find((row) => row.scope_key === "public")).toEqual(publicRows.catalogs[0]);
    expect(JSON.stringify(after.catalogs.find((row) => row.scope_key === REPOS[43].scope))).toContain(
      "acme/broken-nginx",
    );
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
