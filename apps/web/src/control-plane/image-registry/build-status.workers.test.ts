/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  runtimeOperationGates,
  user,
} from "@/db/schema";
import type {
  DesiredGuestToolsV1,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";
import { sha256HexOf } from "./registry-artifact-fixtures";

const IMAGE_ID = "a".repeat(64);
const CONTENT_HASH = "b".repeat(64);
const MANIFEST_SHA = "c".repeat(64);
const TOOLS: DesiredGuestToolsV1 = {
  tools_disk_sha256: "1".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "2".repeat(64),
  bootstrap_abi: 2,
};
const CHANNEL_PIN = {
  schema_version: 1,
  bootstrap_abi: 2,
  tools_disk_sha256: TOOLS.tools_disk_sha256,
  tools_disk_size_bytes: TOOLS.tools_disk_size_bytes,
  compressed_disk_sha256: "3".repeat(64),
  compressed_disk_size_bytes: 64,
  kino_sha256: TOOLS.kino_sha256,
  kino_size_bytes: 32,
};

/**
 * Publish the channel pin the endpoint reports on. The builders own this
 * channel: the web deploy pin is a different, release-scoped value.
 */
async function publishChannel(channel: "stable" | "candidate"): Promise<void> {
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "guest-tools/scenario/" + channel + ".json",
    JSON.stringify(CHANNEL_PIN),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "guest-tools/scenario/disks/" +
      CHANNEL_PIN.tools_disk_sha256 +
      ".ext4.zst",
    new Uint8Array(CHANNEL_PIN.compressed_disk_size_bytes),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "guest-tools/scenario/kino/" + CHANNEL_PIN.kino_sha256 + "/kino",
    new Uint8Array(CHANNEL_PIN.kino_size_bytes),
  );
}

describe("image revision completion status", () => {
  beforeEach(async () => {
    await resetD1Database();
    await publishChannel("stable");
    await publishChannel("candidate");
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agentHosts).values({
      id: "agent-1",
      userId: "owner",
      name: "agent-1",
      scope: "platform",
      credentialGeneration: 1,
      role: "agent",
      connected: true,
      activeSessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.insert(imageBuildBundles).values({
      rev: "revision-1",
      r2Key: "builds/bundles/revision-1.tar.gz",
      metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        scenarios: [
          {
            scenarioId: "broken-nginx",
            arch: "x86_64",
            contentHash: CONTENT_HASH,
          },
        ],
      },
    });
    await db.insert(imageBuilds).values({
      id: "build-1",
      scenarioId: "broken-nginx",
      arch: "x86_64",
      rev: "revision-1",
      contentHash: CONTENT_HASH,
      hostId: null,
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: manifest(),
    });
    await db.insert(hostDesiredState).values({
      hostId: "agent-1",
      version: 7,
      docJson: desiredState(),
    });
    await db.insert(hostActualState).values({
      hostId: "agent-1",
      appliedDesiredVersion: 7,
      observedAt: Date.now(),
      reportJson: hostReport(),
    });
  });

  it("requires both the exact image and guest-tools cache report", async () => {
    const ready = await status();
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      state: "ready",
      revision: "revision-1",
      hosts: [{ host_id: "agent-1", ready: true }],
    });

    const report = hostReport();
    report.cached_guest_tools = [];
    await drizzle(env.DB)
      .update(hostActualState)
      .set({ reportJson: report })
      .where(eq(hostActualState.hostId, "agent-1"));
    const warming = await status();
    await expect(warming.json()).resolves.toMatchObject({
      ok: false,
      state: "warming",
      hosts: [{ host_id: "agent-1", actual_guest_tools_ready: false }],
    });
  });

  it("ignores a connected personal server that has not cached the publication", async () => {
    const db = drizzle(env.DB);
    await db.insert(agentHosts).values({
      id: "personal", userId: "owner", name: "Personal", scope: "personal",
      credentialGeneration: 1, role: "agent", connected: true,
    });
    await db.insert(hostDesiredState).values({
      hostId: "personal", version: 7, docJson: { ...desiredState(), host_id: "personal" },
    });
    const report = hostReport();
    report.cached_images = [];
    report.cached_guest_tools = [];
    await db.insert(hostActualState).values({
      hostId: "personal", appliedDesiredVersion: 7, observedAt: Date.now(), reportJson: report,
    });
    await expect((await status()).json()).resolves.toMatchObject({
      ok: true, state: "ready", hosts: [{ host_id: "agent-1", ready: true }],
    });
  });

  it.each([
    { action: "warm", platformRunning: false },
    { action: "promote", platformRunning: false },
    { action: "promote", platformRunning: true },
  ])("$action counts only platform VMs (platformRunning=$platformRunning)", async ({ action, platformRunning }) => {
    const db = drizzle(env.DB);
    await db.insert(agentHosts).values([
      { id: "personal", scope: "personal" as const, role: "agent" as const },
      { id: "legacy", scope: null, role: "agent" as const },
      { id: "builder", scope: "platform" as const, role: "builder" as const },
      { id: "disabled", scope: "platform" as const, role: "agent" as const, disabled: true },
    ].map((host) => ({
      userId: "owner", name: host.id, credentialGeneration: 1, connected: true, ...host,
    })));
    const excluded = ["personal", "legacy", "builder", "disabled"];
    for (const hostId of excluded) {
      await db.insert(hostDesiredState).values({
        hostId, version: 7, docJson: { ...desiredState(), host_id: hostId },
      });
    }
    // Personal workloads keep running while the platform publication fleet drains.
    await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json(?)) WHERE host_id = ?")
      .bind(JSON.stringify([{ desired_phase: "running" }]), "personal").run();
    if (platformRunning) {
      await env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.vms', json(?)) WHERE host_id = ?")
        .bind(JSON.stringify([{ desired_phase: "running" }]), "agent-1").run();
    }
    const before = await db.select().from(hostDesiredState);
    const compressed = new Uint8Array([1, 2, 3]);
    const kino = new Uint8Array([4, 5, 6]);
    const pin = {
      ...CHANNEL_PIN, tools_disk_sha256: "9".repeat(64),
      compressed_disk_sha256: await sha256HexOf(compressed),
      compressed_disk_size_bytes: compressed.byteLength,
      kino_sha256: await sha256HexOf(kino), kino_size_bytes: kino.byteLength,
    };
    const candidate = new TextEncoder().encode(JSON.stringify(pin));
    await env.VM_IMAGE_REGISTRY_BUCKET.put("guest-tools/scenario/candidate.json", candidate);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(`guest-tools/scenario/disks/${pin.tools_disk_sha256}.ext4.zst`, compressed);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(`guest-tools/scenario/kino/${pin.kino_sha256}/kino`, kino);
    await db.insert(runtimeOperationGates).values({ key: IMAGE_CUTOVER_GATE, state: "drained" });
    const cutover = await handleImageRegistryRequest(new Request("https://intar.test/registry/v1/cutover/gate", {
      headers: { authorization: "Bearer test-publish-token" },
    }), env);
    expect(cutover?.status).toBe(200);
    expect(await cutover!.json()).toMatchObject({ active_desired_vms: platformRunning ? 1 : 0 });
    const woken: string[] = [];
    const response = await handleImageRegistryRequest(new Request(`https://intar.test/registry/v1/guest-tools/${action}`, {
      method: "POST", headers: {
        authorization: "Bearer test-publish-token",
        "x-intar-candidate-sha256": await sha256HexOf(candidate),
      },
    }), {
      ...env,
      HOST_RUNTIME: {
        idFromName: (hostId: string) => hostId,
        get: (hostId: string) => ({ fetch: async () => { woken.push(hostId); return new Response(); } }),
      } as unknown as Cloudflare.Env["HOST_RUNTIME"],
    });
    if (platformRunning) {
      expect(response?.status).toBe(409);
      expect(woken).toEqual([]);
      expect(await db.select().from(hostDesiredState)).toEqual(before);
      expect(await (await env.VM_IMAGE_REGISTRY_BUCKET.get("guest-tools/scenario/stable.json"))!.json()).toEqual(CHANNEL_PIN);
      return;
    }
    expect(response?.status).toBe(200);
    const warmed = await response!.json() as { warmed_host_ids: string[]; updated_host_ids: string[] };
    expect(warmed.warmed_host_ids).toEqual(["agent-1"]);
    expect(warmed.updated_host_ids).toEqual(["agent-1"]);
    expect(woken).toEqual(["agent-1"]);
    const after = await db.select().from(hostDesiredState);
    expect(after.filter((row) => excluded.includes(row.hostId))).toEqual(before.filter((row) => excluded.includes(row.hostId)));
    const desired = after.find((row) => row.hostId === "agent-1")!;
    const tools = desired.docJson.cached_guest_tools?.[0]!;
    expect(tools.tools_disk_sha256).toBe(pin.tools_disk_sha256);
    const channel = action === "warm" ? "candidate" : "stable";
    await expect((await status(channel)).json()).resolves.toMatchObject({ state: "warming" });
    const report = hostReport();
    report.applied_desired_version = desired.version;
    report.cached_guest_tools = [{ guest_tools: tools, phase: "ready", bytes_on_disk: tools.tools_disk_size_bytes, updated_at_unix_ms: Date.now() }];
    await db.update(hostActualState).set({ appliedDesiredVersion: desired.version, reportJson: report }).where(eq(hostActualState.hostId, "agent-1"));
    const ready = await (await status(channel)).json() as { state: string; hosts: Array<{ host_id: string }> };
    expect(ready.state).toBe("ready");
    expect(ready.hosts.map((host) => host.host_id)).toEqual(warmed.warmed_host_ids);
  });

  it("marks a content-only bundle ready without an affected host", async () => {
    const db = drizzle(env.DB);
    await db
      .update(imageBuildBundles)
      .set({
        metaJson: {
          buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
          scenarios: [],
        },
      })
      .where(eq(imageBuildBundles.rev, "revision-1"));
    await db
      .update(agentHosts)
      .set({ disabled: true })
      .where(eq(agentHosts.id, "agent-1"));

    const ready = await status();
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      state: "ready",
      builds: [],
      images: [],
      hosts: [],
    });
  });

  it("keeps a scenario bundle warming when no host is affected", async () => {
    await drizzle(env.DB)
      .update(agentHosts)
      .set({ disabled: true })
      .where(eq(agentHosts.id, "agent-1"));

    const warming = await status();
    await expect(warming.json()).resolves.toMatchObject({
      ok: false,
      state: "warming",
      hosts: [],
    });
  });

  it("fails closed when the published channel pin is absent", async () => {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(
      "guest-tools/scenario/stable.json",
    );

    const response = await status();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "scenario guest-tools stable pin is unavailable",
    });
  });

  it("fails closed when the published channel objects do not match the pin", async () => {
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "guest-tools/scenario/disks/" +
        CHANNEL_PIN.tools_disk_sha256 +
        ".ext4.zst",
      new Uint8Array(CHANNEL_PIN.compressed_disk_size_bytes + 1),
    );

    const response = await status();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "scenario guest-tools stable objects are unavailable",
    });
  });
});

async function status(channel: "candidate" | "stable" = "stable"): Promise<Response> {
  const response = await handleImageRegistryRequest(
    new Request(
      `https://intar.test/registry/v1/builds/revisions/revision-1?tools=${channel}`,
      {
        headers: { authorization: "Bearer test-publish-token" },
      },
    ),
    env,
  );
  if (!response) throw new Error("status route did not match");
  return response;
}

function desiredState(): HostDesiredStateV2 {
  return { owner_user_id: "owner", scope: "platform",
    schema_version: 6,
    host_id: "agent-1",
    version: 7,
    generated_at_unix_ms: Date.now(),
    cached_images: [
      {
        image_key: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
        image_id: IMAGE_ID,
      },
    ],
    cached_guest_tools: [TOOLS],
    vms: [],
    builds: [],
  };
}

function hostReport(): HostStateReportV2 {
  return { relay_connected: true,
    schema_version: 7,
    host_id: "agent-1",
    observed_at_unix_ms: Date.now(),
    applied_desired_version: 7,
    capacity: {
      total_cpu_millis: 8_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: 7_000,
      committed_cpu_millis: 0,
      memory_total_mib: 16_384,
      memory_available_mib: 12_000,
      disk_probe_path: "/var/lib/intar",
      disk_total_mib: 256_000,
      disk_available_mib: 128_000,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256: "d".repeat(64),
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
      supports_jailer_v3: true,
    },
    cached_images: [
      {
        image_key: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
        image_id: IMAGE_ID,
        phase: "ready",
        bytes_on_disk: 1,
        updated_at_unix_ms: Date.now(),
      },
    ],
    cached_guest_tools: [
      {
        guest_tools: TOOLS,
        phase: "ready",
        bytes_on_disk: TOOLS.tools_disk_size_bytes,
        updated_at_unix_ms: Date.now(),
      },
    ],
    vms: [],
    builds: [],
  };
}

function manifest(): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: "broken-nginx",
    name: "broken-nginx",
    title: "Broken Nginx",
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
        image_key: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
        image_id: IMAGE_ID,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 1,
        chunk_manifest_sha256: MANIFEST_SHA,
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: "e".repeat(64),
          initrd_sha256: "f".repeat(64),
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}
