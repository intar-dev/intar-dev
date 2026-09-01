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
  user,
} from "@/db/schema";
import type {
  DesiredGuestToolsV1,
  HostDesiredStateV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { resetD1Database } from "@/test/d1-migrations";

const IMAGE_ID = "a".repeat(64);
const CONTENT_HASH = "b".repeat(64);
const MANIFEST_SHA = "c".repeat(64);
const TOOLS: DesiredGuestToolsV1 = {
  tools_disk_sha256: "1".repeat(64),
  tools_disk_size_bytes: 64 * 1024 * 1024,
  kino_sha256: "2".repeat(64),
  bootstrap_abi: 1,
};

describe("image revision completion status", () => {
  beforeEach(async () => {
    await resetD1Database();
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
        buildFormatVersion: "intar-image-build-v11",
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

  it("marks a content-only bundle ready without an affected host", async () => {
    const db = drizzle(env.DB);
    await db
      .update(imageBuildBundles)
      .set({
        metaJson: {
          buildFormatVersion: "intar-image-build-v11",
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
});

async function status(): Promise<Response> {
  const response = await handleImageRegistryRequest(
    new Request(
      "https://intar.test/registry/v1/builds/revisions/revision-1?tools=stable",
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
  return {
    schema_version: 4,
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
  return {
    schema_version: 5,
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
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
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

function manifest(): ScenarioManifestV4 {
  return {
    schema_version: 4,
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
        guest_bootstrap_abi: 1,
        boot: {
          kernel_sha256: "e".repeat(64),
          initrd_sha256: "f".repeat(64),
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}
