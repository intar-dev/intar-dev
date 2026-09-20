/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentBootstrapTokens,
  agentHosts,
  imageBuildBundles,
  imageBuilds,
  runtimeExecutions,
  scenarioRuns,
  user,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  acquireRegistrySweep,
  completeRegistryUploadSession,
  createRegistryUploadSession,
  finishRegistrySweep,
  readRegistryAdmissionState,
} from "@/lib/image-registry-admission";
import { candidateScenarioId } from "@/lib/scenario-catalog-candidates";
import { resetD1Database } from "@/test/d1-migrations";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import {
  seedChunkedImage,
  type SeededChunkedImage,
} from "./registry-artifact-fixtures";

/**
 * The refusal of a candidate source rewrite at the route boundary.
 *
 * The refusal is an expected 409: one conditional statement proved that the
 * staged row did not change. A route that turned it into a 500 would leave a
 * registry writer hold, and that hold blocks every destructive sweep until an
 * operator reap even though the refusal is settled. These tests drive the real
 * router, the real writer lease, and the real D1 schema.
 */

const PUBLISH_TOKEN = "test-publish-token";
const SCENARIO_ID = "broken-nginx";
const REVISION = "candidate-revision-locked";
const BUILD_ID = "candidate-build-locked";
const CONTENT_HASH = "a".repeat(64);
const ARCH = "x86_64" as const;
const COURSE_ID = "linux-operations";
const LECTURE_ID = "01-locked";
/** The staged row predates both refusals, so its stamp must never move. */
const STAGED_AT = 1_000;
const RUN_USER_ID = "locked-run-user";
const AGENT_HOST_ID = "locked-agent-host";
const BUILDER_HOST_ID = "locked-builder-host";
const BUILDER_OWNER_ID = "locked-builder-owner";
const BOOTSTRAP_TOKEN = "locked-builder-bootstrap-token";
const REFUSAL_MESSAGE =
  "an active run still reads this candidate scenario; the staged manifest was not changed";

let image: SeededChunkedImage;
let builderToken: string;

describe("candidate source refusal at the registry routes", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedFixture();
  });

  it("answers the exact 409, keeps the staged row, and leaves no hold when the client abandons the upload", async () => {
    const db = drizzle(env.DB);
    await db.update(imageBuilds).set({ artifactsRetiredAt: STAGED_AT });
    const [buildBefore] = await db.select().from(imageBuilds);
    // The uploader owns one registry session for the whole upload, and the
    // publish holds a writer under it.
    const owner = { kind: "builder", id: BUILDER_HOST_ID } as const;
    const session = await createRegistryUploadSession(env, {
      owner,
      intent: "image_publish",
    });
    if (!session.ok) throw new Error("the upload session was refused");

    const response = await publishRequest({
      token: builderToken,
      manifest: publishedManifest(),
      sessionId: session.sessionId,
    });

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: REFUSAL_MESSAGE,
      code: "candidate_source_locked",
    });
    await expect(stagedRow()).resolves.toEqual({
      buildId: BUILD_ID,
      manifestJson: JSON.stringify(stagedManifest()),
      updatedAt: STAGED_AT,
    });
    expect((await db.select().from(imageBuilds))[0]).toEqual(buildBefore);
    // The refusal already settled the writer while the client still held its
    // session: the open session is what keeps the collector out at this point,
    // not an unresolved write.
    const held = await readRegistryAdmissionState(env);
    expect(held.counts.pendingWriters).toBe(0);
    expect(held.counts.openSessions).toBe(1);

    // The client abandons the upload. Nothing is left to protect, so the
    // collector takes its exclusive lease right away; an unresolved writer row
    // would refuse it instead.
    await completeRegistryUploadSession(env, {
      owner,
      sessionId: session.sessionId,
      outcome: "abandoned",
    });
    await expect(blockedWriterCount()).resolves.toBe(0);
    await expect(sweepAcquires()).resolves.toBe(true);
  });

  it("publishes a receipt for an identical candidate replay while a run reads it", async () => {
    const db = drizzle(env.DB);
    await db.update(imageBuilds).set({
      publishedManifestJson: null, artifactsRetiredAt: STAGED_AT,
    }).where(eq(imageBuilds.id, BUILD_ID));
    const before = await stagedRow();
    const response = await publishRequest({ token: builderToken, manifest: stagedManifest() });
    expect(response?.status, await response?.clone().text()).toBe(201);
    expect(await stagedRow()).toEqual(before);
    expect((await db.select().from(imageBuilds))[0]).toMatchObject({
      publishedManifestJson: stagedManifest(), artifactsRetiredAt: null,
    });
    expect(await blockedWriterCount()).toBe(0);
  });

  it("still holds the writer when the publish fails with an unexpected error", async () => {
    // Any failure that may have landed half-way keeps its hold. The dropped
    // table makes the candidate stage fail with a database error that is not
    // the refusal, which is the uncertain case the hold exists for.
    await env.DB.prepare("DROP TABLE scenario_catalog_candidates").run();

    await expect(
      publishRequest({ token: builderToken, manifest: publishedManifest() }),
    ).rejects.toThrow();

    await expect(blockedWriterCount()).resolves.toBe(1);
    await expect(sweepAcquires()).resolves.toBe(false);
  });

  it("does not orphan the writer when a bundle upload is refused", async () => {
    // The bundle route stages the reused candidate inside its own writer. A
    // refusal there must answer its 409 instead of the generic 500, because the
    // router holds a 5xx as an unsettled write.
    // The reused path needs a finished build that already holds this content
    // hash: the bundle then restages its manifest instead of queueing a
    // rebuild, which is the statement the active run's row refuses.
    await env.DB.prepare(
      "UPDATE image_builds SET status = 'succeeded', phase = 'succeeded' WHERE id = ?1",
    )
      .bind(BUILD_ID)
      .run();

    const response = await bundleRequest();

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: REFUSAL_MESSAGE,
      code: "candidate_source_locked",
    });
    await expect(stagedRow()).resolves.toEqual({
      buildId: BUILD_ID,
      manifestJson: JSON.stringify(stagedManifest()),
      updatedAt: STAGED_AT,
    });
    await expect(blockedWriterCount()).resolves.toBe(0);
    await expect(sweepAcquires()).resolves.toBe(true);
  });
});

/** Seeds the staged candidate, the active run that reads it, and the builder. */
async function seedFixture(): Promise<void> {
  image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
    label: "candidate-source-refusal",
  });
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values([
    {
      id: RUN_USER_ID,
      name: "Locked Run User",
      email: "locked-run@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    {
      id: BUILDER_OWNER_ID,
      name: "Locked Builder",
      email: "locked-builder@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  ]);
  await db.insert(agentHosts).values([
    {
      id: AGENT_HOST_ID,
      scope: "platform",
      credentialGeneration: 1,
      userId: RUN_USER_ID,
      name: AGENT_HOST_ID,
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
    },
    {
      id: BUILDER_HOST_ID,
      scope: "platform",
      credentialGeneration: 1,
      userId: BUILDER_OWNER_ID,
      name: BUILDER_HOST_ID,
      role: "builder",
      disabled: false,
    },
  ]);
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: BUILDER_OWNER_ID,
    githubAccountId: `${BUILDER_OWNER_ID}-github`,
    githubUsername: BUILDER_OWNER_ID,
    now,
  });
  await db.insert(agentBootstrapTokens).values({
    id: "locked-builder-bootstrap",
    hostId: BUILDER_HOST_ID,
    tokenHash: await sha256Hex(BOOTSTRAP_TOKEN),
    credentialGeneration: 1,
    expiresAt: now + 60_000,
  });
  builderToken = await bootstrapBuilderToken();

  await db.insert(imageBuildBundles).values({
    rev: REVISION,
    r2Key: `builds/bundles/${REVISION}.tar.gz`,
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "candidate",
      scenarios: [
        { scenarioId: SCENARIO_ID, arch: ARCH, contentHash: CONTENT_HASH },
      ],
    },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(imageBuilds).values({
    id: BUILD_ID,
    scenarioId: SCENARIO_ID,
    arch: ARCH,
    rev: REVISION,
    contentHash: CONTENT_HASH,
    catalogChannel: "candidate",
    hostId: BUILDER_HOST_ID,
    status: "assigned",
    phase: "building",
    attempt: 1,
    timingsJson: {},
    publishedManifestJson: publishedManifest(),
    createdAt: now,
    updatedAt: now,
  });
  // The staged row is what the active run reads, and it differs from what both
  // routes would write, so both refusals are reachable.
  await env.DB.prepare(
    "INSERT INTO scenario_catalog_candidates (id, revision, organization_id, scenario_id, build_id, manifest_json, created_at, updated_at)" +
      " VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?6)",
  )
    .bind(
      candidateScenarioId(null, REVISION, SCENARIO_ID),
      REVISION,
      SCENARIO_ID,
      BUILD_ID,
      JSON.stringify(stagedManifest()),
      STAGED_AT,
    )
    .run();

  const executionId = "locked-runtime-execution";
  await db.insert(runtimeExecutions).values({
    id: executionId,
    userId: RUN_USER_ID,
    organizationId: null,
    hostId: AGENT_HOST_ID,
    providerKind: "agent_kvm",
    providerConnectionId: null,
    domainKind: "scenario",
    domainId: "locked-run",
    generation: 1,
    sourceExecutionId: null,
    checkpointId: null,
    state: "provisioning",
    leaseExpiresAt: null,
    archiveRequestedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scenarioRuns).values({
    runId: "locked-run",
    userId: RUN_USER_ID,
    organizationId: null,
    runtimeExecutionId: executionId,
    hostId: AGENT_HOST_ID,
    scenarioId: SCENARIO_ID,
    scenarioName: SCENARIO_ID,
    title: "Locked run",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    revealedHintsJson: [],
    solutionAssisted: false,
    vmCount: 1,
    state: "provisioning",
    stateRank: 1,
    requestIdempotencyKey: "locked-run-key",
    requestScopeJson: {
      scenarioId: SCENARIO_ID,
      organizationId: null,
      hostId: AGENT_HOST_ID,
      candidateRevision: REVISION,
      candidateBuildId: BUILD_ID,
      allowDrainedAdminProof: true,
      allowSequenceBypass: false,
    },
    stateJson: "{}",
    createdAt: now,
    updatedAt: now,
  });
}

/** The builder identity the publish route fences on, from the real bootstrap. */
async function bootstrapBuilderToken(): Promise<string> {
  const response = await handleAgentBootstrap(
    new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: BUILDER_HOST_ID,
        bootstrapToken: BOOTSTRAP_TOKEN,
      }),
    }),
    env,
  );
  if (response.status !== 200) {
    throw new Error(`the builder bootstrap answered ${response.status}`);
  }
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

/** The manifest this release publishes. */
function publishedManifest(): ScenarioManifestV5 {
  return manifestFor("Published after the lock");
}

/** The manifest the staged row already holds and the active run reads. */
function stagedManifest(): ScenarioManifestV5 {
  return manifestFor("Staged before the lock");
}

function manifestFor(title: string): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: SCENARIO_ID,
    name: SCENARIO_ID,
    title,
    category: "linux",
    description: "Repair nginx",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: [],
    briefing_markdown: "briefing",
    solution_markdown: "solution",
    hints: [],
    vms: [
      {
        name: "web",
        image_key: { scenario: SCENARIO_ID, vm: "web", arch: ARCH },
        image_id: image.imageId,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: image.virtualSizeBytes,
        chunk_manifest_sha256: image.chunkManifestSha256,
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: image.kernelSha256,
          initrd_sha256: image.initrdSha256,
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  } as ScenarioManifestV5;
}

async function publishRequest(input: {
  token: string;
  manifest: ScenarioManifestV5;
  sessionId?: string;
}): Promise<Response | null> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(input.manifest));
  form.set("build_id", BUILD_ID);
  form.set("rev", REVISION);
  form.set("content_hash", CONTENT_HASH);
  form.set("architecture", ARCH);
  return handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/publish", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.sessionId
          ? { "x-intar-registry-session": input.sessionId }
          : {}),
      },
      body: form,
    }),
    env,
  );
}

/**
 * A bundle upload of the revision that already has a reusable build. Its
 * reused-candidate staging restages the build manifest for this revision, which
 * the active run's row refuses.
 */
async function bundleRequest(): Promise<Response | null> {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify({
      rev: REVISION,
      build_format_version: IMAGE_BUILD_FORMAT_VERSION,
      catalog_channel: "candidate",
      scenarios: [
        { scenarioId: SCENARIO_ID, arch: ARCH, contentHash: CONTENT_HASH },
      ],
      course_catalog: {
        version: 2,
        courses: [
          {
            course_id: COURSE_ID,
            title: "Linux operations",
            summary: "Diagnose common Linux failures.",
            body_markdown: "# Linux operations\n",
            sequential: true,
            lectures: [
              {
                lecture_id: LECTURE_ID,
                title: "Locked repair",
                summary: "Repair a service.",
                body_markdown: "# Locked repair\n",
                category: "linux",
                tags: ["linux"],
                difficulty: "easy",
                estimated_minutes: 15,
                scenario_id: SCENARIO_ID,
              },
            ],
          },
        ],
      },
    }),
  );
  form.set(
    "bundle",
    new File([gzipSync(bundleArchive())], "bundle.tar.gz"),
  );
  return handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/bundles", {
      method: "POST",
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      body: form,
    }),
    env,
  );
}

/** The tar members a candidate bundle for this revision must carry. */
function bundleArchive(): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const path of [
    "base-images.hcl",
    `scenarios/${SCENARIO_ID}/scenario.hcl`,
    "curriculum/catalog.json",
    `curriculum/${COURSE_ID}/course.md`,
    `curriculum/${COURSE_ID}/${LECTURE_ID}/lecture.md`,
  ]) {
    parts.push(...tarEntry(path, `# ${path}\n`));
  }
  parts.push(new Uint8Array(1_024));
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function tarEntry(path: string, content: string): Uint8Array[] {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar");
  writeTarText(header, 263, 2, "00");
  writeTarOctal(
    header,
    148,
    8,
    header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte),
      0,
    ),
  );
  const padding = new Uint8Array((512 - (data.byteLength % 512)) % 512);
  return [header, data, padding];
}

function writeTarText(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  for (let index = 0; index < value.length && index < length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const text = value.toString(8).padStart(length - 1, "0");
  writeTarText(target, offset, length, text);
  target[offset + length - 1] = 0;
}

/** The staged row exactly as it is stored. */
async function stagedRow(): Promise<{
  buildId: string;
  manifestJson: string;
  updatedAt: number;
}> {
  const row = await env.DB.prepare(
    "SELECT build_id AS buildId, manifest_json AS manifestJson, updated_at AS updatedAt" +
      " FROM scenario_catalog_candidates WHERE id = ?1",
  )
    .bind(candidateScenarioId(null, REVISION, SCENARIO_ID))
    .first<{ buildId: string; manifestJson: string; updatedAt: number }>();
  if (!row) throw new Error("the staged candidate row is missing");
  return row;
}

/**
 * The writers the collector refuses to sweep next to: unresolved rows and rows
 * that ended inconclusively. A settled refusal must leave none.
 */
async function blockedWriterCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM image_registry_operation_writers" +
      " WHERE released_at IS NULL OR outcome = 'unknown'",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

/** True when the collector can take its exclusive lease. */
async function sweepAcquires(): Promise<boolean> {
  const sweep = await acquireRegistrySweep(env, { owner: "refusal-test" });
  if (!sweep.ok) return false;
  await finishRegistrySweep(env, {
    sweepToken: sweep.lease.sweepToken,
    outcome: "completed",
  });
  return true;
}
