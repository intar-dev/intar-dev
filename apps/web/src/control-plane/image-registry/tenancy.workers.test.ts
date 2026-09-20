/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import type { VerifiedAgentHost } from "@/control-plane/auth";
import { agentScenarioImageAccess } from "./image-access";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, requireVerifiedAgentRequest, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  organization,
  member,
  courseCatalogs,
  runtimeExecutions,
  runtimeVms,
  scenarioRuns,
  scenarioCatalogCandidates,
  user,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import { handleAgentImageIndex, handleAgentArtifactDownload, handleAgentImageDownload } from "./agent";
import { handleImageRegistryRequest } from "./router";
import { sha256Hex as hashBytes } from "./shared";
import { imageObjectKey, registryImageKey } from "./shared";

const PUBLIC_SHA = "a".repeat(64);
const ORG_A_SHA = "b".repeat(64);
const ORG_B_SHA = "c".repeat(64);

describe("personal image access", () => {
  let token: string;
  let platformToken: string;
  let scenarios: SeededScenario[];
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of ["runner-owner", "other-owner"]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
      await grantActiveBetaAccess(id);
    }
    await db.insert(organization).values({ id: "org-a", name: "A", slug: "a", createdAt: new Date() });
    await db.insert(member).values({ id: "membership", organizationId: "org-a", userId: "runner-owner", role: "member", createdAt: new Date() });
    scenarios = [
      await seedScenario(null, "public-scenario", PUBLIC_SHA),
      await seedScenario("org-a", "private-assigned", ORG_A_SHA),
      await seedScenario("org-a", "private-unassigned", ORG_B_SHA),
    ];
    await db.insert(courseCatalogs).values({
      scopeKey: "organization:org-a", organizationId: "org-a", sourceRevision: "test",
      catalogJson: { version: 2, courses: [{ courseId: "course", title: "Course", summary: "", bodyMarkdown: "", sequential: false,
        lectures: scenarios.slice(1).map(scenario => ({ lectureId: scenario.scenarioId, scenarioId: scenario.scenarioId,
          title: "Lecture", summary: "", bodyMarkdown: "", category: "test", tags: [], estimatedMinutes: 10 })) }] },
    });
    token = await seedAgentAndBootstrap({ hostId: "personal", scope: "personal", bootstrapToken: "personal-secret" });
    platformToken = await seedAgentAndBootstrap({ hostId: "platform", scope: "platform", bootstrapToken: "platform-secret" });
    await seedWorkload(scenarios[1]!);
  });

  it("requires an exact owner workload even when the owner can access both private courses", async () => {
    expect((await download(token, scenarios[0]!)).status).toBe(404);
    expect((await download(token, scenarios[1]!)).status).toBe(200);
    expect((await download(token, scenarios[2]!)).status).toBe(404);
    expect((await download(platformToken, scenarios[2]!)).status).toBe(200);
    const otherToken = await seedAgentAndBootstrap({ hostId: "other-personal", scope: "personal", userId: "other-owner", bootstrapToken: "other-secret" });
    expect((await download(otherToken, scenarios[1]!)).status).toBe(404);
  });

  it.each([
    ["scenario disabled", "UPDATE vm_scenarios SET enabled = 0 WHERE scenario_id = 'private-assigned'"],
    ["scenario not published", "UPDATE vm_scenarios SET enabled_at = NULL WHERE scenario_id = 'private-assigned'"],
    ["published scenario removed", "DELETE FROM vm_scenarios WHERE scenario_id = 'private-assigned'"],
    ["membership removed", "DELETE FROM member"],
    ["course removed", "DELETE FROM course_catalogs"],
    ["lecture unlinked", "UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures[0].scenarioId', 'different')"],
    ["foreign workload owner", "UPDATE runtime_executions SET user_id = 'other-owner'"],
    ["image replaced", "UPDATE runtime_vms SET image_sha256 = '" + "f".repeat(64) + "'"],
    ["VM key replaced", "UPDATE runtime_vms SET image_key_json = json_set(image_key_json, '$.vm', 'different')"],
    ["workload expired", "UPDATE runtime_executions SET lease_expires_at = 1"],
    ["desired workload removed", "UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json('[]'))"],
  ])("denies private image, index, and boot artifact after %s", async (_reason, change) => {
    const scenario = scenarios[1]!;
    const artifact = () => handleAgentArtifactDownload(new Request("https://intar.test/artifact", { headers: { authorization: `Bearer ${token}` } }), env, scenario.kernelSha);
    const indexKeys = async () => {
      const response = await handleAgentImageIndex(new Request("https://intar.test/index", { headers: { authorization: `Bearer ${token}` } }), env);
      const body = await response.json() as { images: Array<{ image_key: string }> };
      return body.images.map(image => image.image_key);
    };
    expect((await download(token, scenario)).status).toBe(200);
    expect((await artifact()).status).toBe(200);
    expect(await indexKeys()).toContain(scenario.imageKey);
    await env.DB.prepare(change).run();
    expect((await download(token, scenario)).status).toBe(404);
    expect((await artifact()).status).toBe(404);
    expect(await indexKeys()).not.toContain(scenario.imageKey);
  });

  it.each([
    {
      reason: "an unmet prerequisite",
      setup: ["UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures', json_array(json_extract(catalog_json, '$.courses[0].lectures[1]'), json_extract(catalog_json, '$.courses[0].lectures[0]')))"],
      revoke: "UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].sequential', json('true'))",
    },
    ...["allowSequenceBypass", "allowDrainedAdminProof"].map(flag => ({
      reason: `administrator removal from ${flag}`,
      setup: ["UPDATE user SET role = 'admin' WHERE id = 'runner-owner'",
        `UPDATE scenario_runs SET request_scope_json = '{"${flag}":true}'`],
      revoke: "UPDATE user SET role = 'user' WHERE id = 'runner-owner'",
    })),
    {
      reason: "a public course hidden by an organization course",
      setup: [
        "UPDATE vm_scenarios SET organization_id = NULL WHERE scenario_id = 'private-assigned'",
        "INSERT INTO course_catalogs (scope_key, organization_id, source_revision, catalog_json) SELECT 'public', NULL, source_revision, catalog_json FROM course_catalogs",
        "UPDATE scenario_runs SET course_scope_key = 'public'",
        "DELETE FROM course_catalogs WHERE organization_id = 'org-a'",
      ],
      revoke: "INSERT INTO course_catalogs (scope_key, organization_id, source_revision, catalog_json) SELECT 'organization:org-a', 'org-a', source_revision, catalog_json FROM course_catalogs",
    },
  ])("rechecks all workload image routes after $reason", async ({ setup, revoke }) => {
    for (const statement of setup) await env.DB.prepare(statement).run();
    const assigned = scenarios[1]!;
    const paths = [
      `/agent/registry/images/${assigned.imageKey}/${assigned.sha256}`,
      `/agent/registry/artifacts/${assigned.kernelSha}`,
      manifestPath(assigned), chunkPath(assigned),
    ];
    for (const path of paths) expect((await registryGet(token, path))?.status).toBe(200);
    await env.DB.prepare(revoke).run();
    for (const path of paths) expect((await registryGet(token, path))?.status).toBe(404);
    const index = await handleAgentImageIndex(new Request("https://intar.test/index", {
      headers: { authorization: `Bearer ${token}` },
    }), env);
    expect(await index.json()).toEqual({ images: [] });
  });

  it("permits a sequential workload after its prerequisite is completed", async () => {
    await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].sequential', json('true'), '$.courses[0].lectures', json_array(json_extract(catalog_json, '$.courses[0].lectures[1]'), json_extract(catalog_json, '$.courses[0].lectures[0]')))").run();
    expect((await download(token, scenarios[1]!)).status).toBe(404);
    await env.DB.prepare("INSERT INTO course_unit_completions (user_id, scope_key, course_id, lecture_id, completed_at) VALUES ('runner-owner', 'organization:org-a', 'course', 'private-unassigned', ?)")
      .bind(Date.now()).run();
    expect((await download(token, scenarios[1]!)).status).toBe(200);
    expect((await registryGet(token, chunkPath(scenarios[1]!)))?.status).toBe(200);
  });

  it.each([
    ["membership removed", "DELETE FROM member"],
    ["credentials replaced", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'personal'"],
    ["owner replaced", "UPDATE agent_hosts SET user_id = 'other-owner' WHERE id = 'personal'"],
    ["scope replaced", "UPDATE agent_hosts SET scope = 'platform' WHERE id = 'personal'"],
    ["workload removed", "UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json('[]'))"],
    ["boot metadata replaced", "UPDATE vm_scenario_vms SET boot_cmdline = 'replacement-private-command' WHERE scenario_id = 'private-assigned'"],
    ["manifest replaced", "UPDATE vm_scenario_vms SET chunk_manifest_sha256 = '" + "f".repeat(64) + "' WHERE scenario_id = 'private-assigned'"],
  ])("filters captured index entries when %s during R2 reads", async (_reason, change) => {
    const request = () => new Request("https://intar.test/index", { headers: { authorization: `Bearer ${token}` } });
    const before = await handleAgentImageIndex(request(), env);
    expect(await before.json()).toMatchObject({ images: [{ image_key: scenarios[1]!.imageKey }] });
    let changed = false;
    const racedEnv = { ...env, VM_IMAGE_REGISTRY_BUCKET: {
      head: async (key: string) => {
        const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(key);
        if (!changed) {
          changed = true;
          await env.DB.prepare(change).run();
        }
        return object;
      },
    } as R2Bucket };
    const response = await handleAgentImageIndex(request(), racedEnv);
    expect(changed).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ images: [] });
  });

  it("uses one authorized manifest as chunk context and has no context-free download route", async () => {
    const assigned = scenarios[1]!;
    expect((await registryGet(token, manifestPath(assigned)))?.status).toBe(200);
    const chunk = await registryGet(token, chunkPath(assigned));
    expect(chunk?.status).toBe(200);
    expect(chunk?.headers.get("cache-control")).toBe("private, no-store");
    expect((await registryGet(token, chunkPath(assigned, scenarios[2]!.rawSha)))?.status).toBe(404);
    expect((await registryGet(token, chunkPath(scenarios[2]!)))?.status).toBe(404);
    expect(await registryGet(token, `/agent/registry/image-chunks/${assigned.rawSha}`)).toBeNull();
    expect(await registryGet(platformToken, `/agent/registry/image-chunks/${assigned.rawSha}`)).toBeNull();
    expect((await registryGet(platformToken, chunkPath(assigned)))?.status).toBe(200);
    const other = await seedAgentAndBootstrap({ hostId: "other-personal", scope: "personal", userId: "other-owner", bootstrapToken: "other-secret" });
    expect((await registryGet(other, manifestPath(assigned)))?.status).toBe(404);
    expect((await registryGet(other, chunkPath(assigned)))?.status).toBe(404);
  });

  it.each([
    ["membership", "DELETE FROM member", 404],
    ["credentials", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'personal'", 401],
  ])("denies both routes after %s replacement", async (_kind, change, status) => {
    const assigned = scenarios[1]!;
    expect((await registryGet(token, manifestPath(assigned)))?.status).toBe(200);
    expect((await registryGet(token, chunkPath(assigned)))?.status).toBe(200);
    await env.DB.prepare(change as string).run();
    expect((await registryGet(token, manifestPath(assigned)))?.status).toBe(status);
    expect((await registryGet(token, chunkPath(assigned)))?.status).toBe(status);
  });

  for (const route of ["image", "artifact", "manifest", "chunk"] as const) {
    it.each([
      ["membership", "DELETE FROM member"],
      ["credentials", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'personal'"],
      ["owner", "UPDATE agent_hosts SET user_id = 'other-owner' WHERE id = 'personal'"],
      ["scope", "UPDATE agent_hosts SET scope = 'platform' WHERE id = 'personal'"],
    ])(`rechecks ${route} access after a %s change during R2 read`, async (_kind, change) => {
      const assigned = scenarios[1]!;
      const { path, objectKey } = {
        image: { path: `/agent/registry/images/${assigned.imageKey}/${assigned.sha256}`, objectKey: imageObjectKey(assigned.imageKey, assigned.sha256) },
        artifact: { path: `/agent/registry/artifacts/${assigned.kernelSha}`, objectKey: `artifacts/${assigned.kernelSha}` },
        manifest: { path: manifestPath(assigned), objectKey: `image-manifests/v1/${assigned.manifestSha}.json` },
        chunk: { path: chunkPath(assigned), objectKey: `image-chunks/v1/zstd6/${assigned.rawSha}` },
      }[route];
      expect((await registryGet(token, path))?.status).toBe(200);
      let changed = false;
      const racedEnv = { ...env, VM_IMAGE_REGISTRY_BUCKET: {
        get: async (key: string) => {
          const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key);
          if (key === objectKey && !changed) {
            changed = true;
            await env.DB.prepare(change).run();
          }
          return object;
        },
      } as R2Bucket };
      expect((await registryGet(token, path, racedEnv))?.status).toBe(404);
      expect(changed).toBe(true);
    });
  }

  for (const route of ["artifact", "index"] as const) {
    it.each([
      ["credentials", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'platform'"],
      ["scope", "UPDATE agent_hosts SET scope = 'personal' WHERE id = 'platform'"],
      ["owner", "UPDATE agent_hosts SET user_id = 'other-owner' WHERE id = 'platform'"],
    ])(`rechecks platform candidate ${route} access after %s replacement during R2 read`, async (_kind, change) => {
      const candidate = scenarios[2]!;
      const imageKey = { scenario: candidate.scenarioId, vm: "vm", arch: "x86_64" as const };
      const db = drizzle(env.DB);
      // Remove the published source so only the exact desired candidate can grant access.
      await db.delete(vmScenarioVms).where(eq(vmScenarioVms.scenarioId, candidate.scenarioId));
      await db.insert(scenarioCatalogCandidates).values({
        id: "candidate", revision: "candidate-revision", scenarioId: candidate.scenarioId, buildId: "candidate-build",
        organizationId: "org-a", manifestJson: {
          schema_version: 5, scenario_id: candidate.scenarioId, name: candidate.scenarioId, title: "Candidate", category: "test",
          description: "Candidate", difficulty: "easy", estimated_minutes: 10, tags: [], briefing_markdown: "", solution_markdown: "", hints: [],
          vms: [{ name: "vm", image_key: imageKey, image_id: candidate.sha256, image_format: "raw_chunks_v1",
            image_virtual_size_bytes: 1024, chunk_manifest_sha256: candidate.manifestSha, guest_bootstrap_abi: 2,
            boot: { kernel_sha256: candidate.kernelSha, initrd_sha256: `${candidate.sha256.slice(0, 63)}e`, cmdline: "root=/dev/vda" },
            cpu_millis: 1000, memory_mib: 512, disk_mib: 1024, probes: [] }],
        },
      });
      await loadOrCreateHostDesiredState(db, "platform", Date.now());
      await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.cached_images', json(?)) WHERE host_id = 'platform'")
        .bind(JSON.stringify([{ image_key: imageKey, image_id: candidate.sha256 }])).run();
      const path = route === "artifact" ? `/agent/registry/artifacts/${candidate.kernelSha}` : "/agent/registry/images";
      expect((await registryGet(platformToken, path))?.status).toBe(200);
      let changed = false;
      const revoke = async (key: string) => {
        if (key === `artifacts/${candidate.kernelSha}` && !changed) {
          changed = true;
          await env.DB.prepare(change).run();
        }
      };
      const racedEnv = { ...env, VM_IMAGE_REGISTRY_BUCKET: {
        get: async (key: string) => {
          const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(key);
          await revoke(key);
          return object;
        },
        head: async (key: string) => {
          const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(key);
          await revoke(key);
          return object;
        },
      } as R2Bucket };
      const response = await registryGet(platformToken, path, racedEnv);
      expect(response?.status).toBe(route === "artifact" ? 404 : 200);
      if (route === "index") expect(await response!.json()).toEqual({ images: [] });
      expect(changed).toBe(true);
    });
  }

  it.each(["personal", "platform"] as const)("rejects a stale %s credential snapshot before image authorization", async scope => {
    const bearer = scope === "personal" ? token : platformToken;
    const verified = await requireVerifiedAgentRequest(new Request("https://intar.test", { headers: { authorization: `Bearer ${bearer}` } }), env);
    if (!verified.ok) throw new Error("fixture authentication failed");
    await env.DB.prepare("UPDATE agent_hosts SET credential_generation = 2 WHERE id = ?").bind(scope).run();
    const rows = await drizzle(env.DB).select({ id: vmScenarioVms.id }).from(vmScenarioVms)
      .innerJoin(vmScenarios, eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId))
      .where(agentScenarioImageAccess(verified.agent));
    expect(rows).toEqual([]);
  });

  it.each([undefined, null, "organization"])("denies even public images for unsupported scope %s", async scope => {
    const agent = { hostId: "personal", userId: "runner-owner", credentialGeneration: 1, scope } as unknown as VerifiedAgentHost;
    const rows = await drizzle(env.DB).select({ id: vmScenarioVms.id }).from(vmScenarioVms)
      .innerJoin(vmScenarios, eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId))
      .where(agentScenarioImageAccess(agent));
    expect(rows).toEqual([]);
  });

  it("does not treat a cached private image as a preparation grant", async () => {
    await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json('[]'))").run();
    expect((await download(token, scenarios[1]!)).status).toBe(404);
  });
});

async function seedWorkload(scenario: SeededScenario) {
  const db = drizzle(env.DB);
  const lease = Date.now() + 60_000;
  const imageKey = { scenario: scenario.scenarioId, vm: "vm", arch: "x86_64" };
  await db.insert(runtimeExecutions).values({ id: "execution", userId: "runner-owner", hostId: "personal", organizationId: "org-a",
    domainKind: "scenario", domainId: "run", generation: 1, state: "ready", leaseExpiresAt: lease });
  await db.insert(runtimeVms).values({ id: "vm", executionId: "execution", vmId: "vm", ordinal: 0, runtimeVmName: "guest",
    imageKeyJson: imageKey, imageSha256: scenario.sha256, cpuMillis: 1000, memoryMib: 512, diskMib: 1024 });
  await db.insert(scenarioRuns).values({ runId: "run", userId: "runner-owner", hostId: "personal", runtimeExecutionId: "execution",
    organizationId: "org-a", scenarioId: scenario.scenarioId, scenarioName: "Private", courseScopeKey: "organization:org-a",
    courseId: "course", lectureId: scenario.scenarioId, activeKey: "runner-owner", title: "Run", tagline: "", briefingMarkdown: "",
    objectivesJson: "[]", difficulty: "easy", estimatedMinutes: 10, tagsJson: [], hintsJson: [], solutionMarkdown: "",
    vmCount: 1, state: "running", stateRank: 2, stateJson: "{}" });
  await loadOrCreateHostDesiredState(db, "personal", Date.now());
  await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json(?1), '$.cached_images', json(?2)) WHERE host_id = 'personal'")
    .bind(JSON.stringify([{ vm_id: "guest", run_id: "run", owner_user_id: "runner-owner", runtime_execution_id: "execution", generation: 1, vm_name: "guest", desired_phase: "running", lease_expires_at_unix_ms: lease,
      image_key: imageKey, image_id: scenario.sha256 }]), JSON.stringify([{ image_key: imageKey, image_id: scenario.sha256 }])).run();
}

interface SeededScenario {
  scenarioId: string;
  imageKey: string;
  sha256: string;
  kernelSha: string;
  manifestSha: string;
  rawSha: string;
}

async function seedScenario(
  organizationId: string | null,
  scenarioId: string,
  sha256: string,
): Promise<SeededScenario> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const rawSha = sha256;
  const encoded = `encoded:${scenarioId}`;
  const domain = new TextEncoder().encode("intar-raw-chunks-v1\0");
  const identity = new Uint8Array(domain.length + 8 + 4 + 40);
  identity.set(domain);
  const view = new DataView(identity.buffer);
  view.setBigUint64(domain.length, 1024n, true);
  view.setUint32(domain.length + 8, 4 * 1024 * 1024, true);
  view.setUint32(domain.length + 12, 0, true);
  view.setUint32(domain.length + 16, 1024, true);
  identity.set(Uint8Array.from(rawSha.match(/../g)!.map(byte => Number.parseInt(byte, 16))), domain.length + 20);
  sha256 = await hashBytes(identity.buffer);
  const descriptor = { index: 0, raw_sha256: rawSha, raw_size_bytes: 1024,
    encoded_sha256: await sha256Hex(encoded), encoded_size_bytes: encoded.length };
  const manifestText = JSON.stringify({ schema_version: 1, image_id: sha256, virtual_size_bytes: 1024,
    chunk_size_bytes: 4 * 1024 * 1024, encoding: "zstd-v1-level-6", chunks: [descriptor] });
  const manifestSha = await sha256Hex(manifestText);
  const image = { scenario: scenarioId, vm: "vm", arch: "x86_64" as const };
  await db.batch([
    db.insert(vmScenarios).values({
      scenarioId,
      organizationId,
      title: scenarioId,
      category: "test",
      description: "registry tenancy test",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "briefing",
      solutionMarkdown: "solution",
      hintsJson: [],
      enabled: true,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${scenarioId}:vm`,
      scenarioId,
      ordinal: 0,
      vmName: "vm",
      image: `${scenarioId}-vm-x86_64.raw.zst`,
      imageKeyJson: image,
      imageSha256: sha256,
      imageFormat: "raw_chunks_v1",
      chunkManifestSha256: manifestSha,
      guestBootstrapAbi: 2,
      imageVirtualSizeBytes: 1_024,
      kernelSha256: `${sha256.slice(0, 63)}d`,
      initrdSha256: `${sha256.slice(0, 63)}e`,
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
  const key = registryImageKey(image);
  const kernelSha = `${sha256.slice(0, 63)}d`;
  await env.VM_IMAGE_REGISTRY_BUCKET.put(imageObjectKey(key, sha256), "image", { customMetadata: { image_key: key, image_sha256: sha256 } });
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`image-manifests/v1/${manifestSha}.json`, manifestText, { customMetadata: { manifest_sha256: manifestSha, image_id: sha256 } });
  await env.VM_IMAGE_REGISTRY_BUCKET.put(`image-chunks/v1/zstd6/${rawSha}`, encoded, { customMetadata: {
    raw_sha256: rawSha, raw_size_bytes: "1024", encoded_sha256: descriptor.encoded_sha256,
    encoded_size_bytes: String(encoded.length), encoding: "zstd-v1-level-6",
  } });
  for (const artifact of [kernelSha, `${sha256.slice(0, 63)}e`]) {
    await env.VM_IMAGE_REGISTRY_BUCKET.put(`artifacts/${artifact}`, "artifact", { customMetadata: { artifact_sha256: artifact } });
  }
  return { scenarioId, imageKey: key, sha256, kernelSha, manifestSha, rawSha };
}

async function seedAgentAndBootstrap(input: {
  hostId: string;
  scope: "personal" | "platform";
  userId?: string;
  bootstrapToken: string;
}): Promise<string> {
  const db = drizzle(env.DB);
  await db.insert(agentHosts).values({
    id: input.hostId,
    userId: input.userId ?? "runner-owner",
    scope: input.scope,
    credentialGeneration: 1,
    name: input.hostId,
    role: "agent",
  });
  await db.insert(agentBootstrapTokens).values({
    id: `${input.hostId}-bootstrap`,
    hostId: input.hostId,
    tokenHash: await sha256Hex(input.bootstrapToken),
    credentialGeneration: 1,
    expiresAt: null,
  });

  const response = await handleAgentBootstrap(
    new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostId: input.hostId,
        bootstrapToken: input.bootstrapToken,
      }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

async function grantActiveBetaAccess(userId: string): Promise<void> {
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId,
    githubUsername: userId,
  });
}

function download(token: string, scenario: SeededScenario): Promise<Response> {
  return handleAgentImageDownload(
    new Request(
      `https://intar.test/agent/registry/images/${scenario.imageKey}/${scenario.sha256}`,
      { headers: { authorization: `Bearer ${token}` } },
    ),
    env,
    scenario.imageKey,
    scenario.sha256,
  );
}

function manifestPath(scenario: SeededScenario): string {
  return `/agent/registry/image-manifests/${scenario.manifestSha}`;
}
function chunkPath(scenario: SeededScenario, rawSha = scenario.rawSha): string {
  return `${manifestPath(scenario)}/chunks/${rawSha}`;
}
function registryGet(token: string, path: string, bindings: Cloudflare.Env = env) {
  return handleImageRegistryRequest(new Request(`https://intar.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  }), bindings);
}
