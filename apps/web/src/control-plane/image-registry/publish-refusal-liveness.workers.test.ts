/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import { agentHosts, hostDesiredState, user, vmScenarioVms } from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  acquireRegistrySweep,
  completeRegistryUploadSession,
  createRegistryUploadSession,
  finishRegistrySweep,
  readRegistryAdmissionState,
} from "@/lib/image-registry-admission";
import { resetD1Database } from "@/test/d1-migrations";
import {
  seedChunkedImage,
  type SeededChunkedImage,
} from "./registry-artifact-fixtures";

/**
 * A known refusal of a live publish settles its registry writer.
 *
 * The refusal of a live replacement is an expected 409: the outgoing-reference
 * policy found a run or a host transfer that still reads an image the publish
 * would replace, and the batch that would rewrite the pointers never ran. The
 * publish has already stored its objects by then, so its writer row is the only
 * thing between the collector and the objects that refusal left unreferenced.
 * An unresolved row would block every destructive sweep until an operator reap,
 * for a refusal that no retry can pass while that reference is live.
 */

const SCENARIO_ID = "broken-nginx";
const VM_NAME = "web";
const ARCH = "x86_64" as const;
const HOST_ID = "host-1";
const OWNER_USER_ID = "publisher-owner";
const PUBLISH_TOKEN = "test-publish-token";
const OWNER = { kind: "publish_token", id: "publish-token" } as const;

function manifestFor(image: SeededChunkedImage): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: SCENARIO_ID,
    name: SCENARIO_ID,
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
        name: VM_NAME,
        image_key: { scenario: SCENARIO_ID, vm: VM_NAME, arch: ARCH },
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

function publish(
  image: SeededChunkedImage,
  sessionId?: string,
): Promise<Response | null> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifestFor(image)));
  return handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/publish", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PUBLISH_TOKEN}`,
        ...(sessionId ? { "x-intar-registry-session": sessionId } : {}),
      },
      body: form,
    }),
    env,
  );
}

describe("live publish refusal settlement", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("settles the writer of a refused replacement, so the collector is reachable when the client abandons", async () => {
    const outgoing = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "refusal-live-outgoing",
    });
    const first = await publish(outgoing);
    expect(first?.status).toBe(201);
    await seedHostNeedingImage(outgoing);

    const session = await createRegistryUploadSession(env, { owner: OWNER });
    if (!session.ok) throw new Error("the upload session was refused");
    const incoming = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "refusal-live-incoming",
    });
    const blocked = await publish(incoming, session.sessionId);

    expect(blocked?.status).toBe(409);
    await expect(blocked?.json()).resolves.toMatchObject({
      error: "image publish is blocked by active image use",
      blocking_host_ids: [HOST_ID],
      outgoing_image_ids: [outgoing.imageId],
    });
    // The refusal changed nothing, and it left no hold: the pointer still names
    // the outgoing image, and the writer settled while the session stayed open.
    await expect(liveImageIds()).resolves.toEqual([outgoing.imageId]);
    const held = await readRegistryAdmissionState(env);
    expect(held.counts.pendingWriters).toBe(0);
    expect(held.counts.openSessions).toBe(1);
    // Only the open session keeps the collector out at this point.
    await expect(sweepAcquires()).resolves.toBe(false);

    await completeRegistryUploadSession(env, {
      owner: OWNER,
      sessionId: session.sessionId,
      outcome: "abandoned",
    });
    await expect(blockedWriterCount()).resolves.toBe(0);
    await expect(sweepAcquires()).resolves.toBe(true);
  });
});

/** A tracked host transfer for the outgoing image is what blocks the publish. */
async function seedHostNeedingImage(image: SeededChunkedImage): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({
    id: OWNER_USER_ID,
    name: "Publisher Owner",
    email: "publisher@example.test",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: HOST_ID,
    scope: "platform",
    userId: OWNER_USER_ID,
    name: "Host 1",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
  });
  const doc = createEmptyHostDesiredState({ ownerUserId: OWNER_USER_ID, scope: "platform", hostId: HOST_ID, nowUnixMs: now });
  doc.cached_images = [
    {
      image_key: { scenario: SCENARIO_ID, vm: VM_NAME, arch: ARCH },
      image_id: image.imageId,
    },
  ];
  await db.insert(hostDesiredState).values({
    hostId: HOST_ID,
    version: doc.version,
    docJson: doc,
    createdAt: now,
    updatedAt: now,
  });
}

async function liveImageIds(): Promise<string[]> {
  const rows = await drizzle(env.DB)
    .select({ imageSha256: vmScenarioVms.imageSha256 })
    .from(vmScenarioVms)
    .where(eq(vmScenarioVms.scenarioId, SCENARIO_ID));
  return rows.map((row) => row.imageSha256 ?? "").sort();
}

/** The writers the collector refuses to sweep next to. */
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
