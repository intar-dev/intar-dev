/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentHosts,
  hostDesiredState,
  scenarioCatalogSnapshots,
  user,
  vmScenarioVms,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { createImageRegistryCleanupCore } from "@/lib/image-registry-cleanup";
import { resetD1Database } from "@/test/d1-migrations";
import {
  enableRegistryDeletion,
  seedChunkedImage,
  type SeededChunkedImage,
} from "./registry-artifact-fixtures";

/**
 * The direct-token live publish path.
 *
 * A live publish replaces the catalog pointers, so it must leave exactly one
 * recoverable previous state behind, and that state must be the release it just
 * replaced. Without the record the retention planner keeps the live images plus
 * whatever older snapshot exists, and the immediate previous release becomes
 * unreferenced and is deleted.
 */

const SCENARIO_ID = "broken-nginx";
const VM_NAME = "web";
const ARCH = "x86_64" as const;
const HOST_ID = "host-1";
const OWNER_USER_ID = "publisher-owner";

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

async function publish(image: SeededChunkedImage): Promise<Response> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifestFor(image)));
  const response = await handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/publish", {
      method: "POST",
      headers: { authorization: "Bearer test-publish-token" },
      body: form,
    }),
    env,
  );
  if (!response) throw new Error("the publish route did not answer");
  return response;
}

async function publishRelease(label: string): Promise<SeededChunkedImage> {
  const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label });
  const response = await publish(image);
  expect(response.status).toBe(201);
  return image;
}

async function liveImageIds(): Promise<string[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ imageSha256: vmScenarioVms.imageSha256 })
    .from(vmScenarioVms)
    .where(eq(vmScenarioVms.scenarioId, SCENARIO_ID));
  return rows.map((row) => row.imageSha256 ?? "").sort();
}

interface SnapshotRecord {
  id: string;
  createdAt: number;
  imageIds: string[];
}

/** The rollback records of the family, oldest first. */
async function snapshotRecords(): Promise<SnapshotRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioCatalogSnapshots.id,
      createdAt: scenarioCatalogSnapshots.createdAt,
      snapshot: scenarioCatalogSnapshots.snapshotJson,
    })
    .from(scenarioCatalogSnapshots)
    .orderBy(scenarioCatalogSnapshots.createdAt, scenarioCatalogSnapshots.id);
  return rows.map((row) => {
    const vms =
      (row.snapshot as { vms?: Array<{ imageSha256?: string }> }).vms ?? [];
    return {
      id: row.id,
      createdAt: row.createdAt,
      imageIds: vms
        .map((vm) => vm.imageSha256 ?? "")
        .filter((imageId) => imageId !== "")
        .sort(),
    };
  });
}

/** The rollback the planner will actually use: the newest record. */
async function rollbackOfRecord(): Promise<SnapshotRecord | null> {
  const records = await snapshotRecords();
  if (records.length === 0) return null;
  return (
    [...records].sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.id.localeCompare(left.id),
    )[0] ?? null
  );
}

/**
 * Publishes and forces a given wall clock, so a cycle can be replayed entirely
 * inside one millisecond. Serialized writers must still order their records.
 */
async function publishAt(image: SeededChunkedImage, at: number): Promise<Response> {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    return await publish(image);
  } finally {
    Date.now = realNow;
  }
}

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

function cleanupEnv(): { DB: D1Database; VM_IMAGE_REGISTRY_BUCKET: R2Bucket } {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
}

/** Converges the objects with the real collector core. */
async function convergeObjects(): Promise<void> {
  await enableRegistryDeletion(env.DB);
  const core = createImageRegistryCleanupCore({});
  const plan = await core.plan(cleanupEnv(), { mode: "delete", nowMs: Date.now() });
  expect(plan.details.faults).toEqual([]);
  for (let pass = 0; pass < 3; pass += 1) {
    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();
    if (!result.resumeRequired) return;
  }
  throw new Error("the registry sweep did not converge");
}

async function head(key: string): Promise<unknown> {
  return env.VM_IMAGE_REGISTRY_BUCKET.head(key);
}

describe("direct live publish rollback record", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("keeps the immediate previous release and drops the older one", async () => {
    const a = await publishRelease("release-a");
    // A first publication has no previous live state to return to.
    expect(await snapshotRecords()).toEqual([]);
    expect(await liveImageIds()).toEqual([a.imageId]);

    const b = await publishRelease("release-b");
    let rollback = await rollbackOfRecord();
    expect(rollback?.imageIds).toEqual([a.imageId]);

    // Repeating the same release is the same image state, so it must not
    // rotate the rollback that is already recorded.
    expect((await publish(b)).status).toBe(201);
    rollback = await rollbackOfRecord();
    expect(rollback?.imageIds).toEqual([a.imageId]);
    expect(await liveImageIds()).toEqual([b.imageId]);

    const c = await publishRelease("release-c");
    expect(await liveImageIds()).toEqual([c.imageId]);
    expect(await snapshotRecords()).toHaveLength(2);

    await convergeObjects();

    // The live release and its recorded rollback survive.
    for (const image of [c, b]) {
      expect(await head(image.objectKey)).not.toBeNull();
      expect(
        await head("image-chunks/v1/zstd6/" + image.chunkRawSha256),
      ).not.toBeNull();
      expect(await head("artifacts/" + image.kernelSha256)).not.toBeNull();
      expect(await head("artifacts/" + image.initrdSha256)).not.toBeNull();
    }
    // The release that no reference reaches is gone.
    expect(await head(a.objectKey)).toBeNull();
    expect(await head("image-chunks/v1/zstd6/" + a.chunkRawSha256)).toBeNull();
    expect(await head("artifacts/" + a.kernelSha256)).toBeNull();
    expect(await head("artifacts/" + a.initrdSha256)).toBeNull();

    // Exactly one rollback record remains: the state before the live release.
    const remaining = await snapshotRecords();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.imageIds).toEqual([b.imageId]);
  });

  it("returns to B without losing the rollback of the state it replaces", async () => {
    // A -> B -> C -> B before any sweep. The second arrival at B is a new
    // transition with a different previous state, so it must not reuse the
    // record the first arrival at B wrote.
    const a = await publishRelease("release-a");
    const b = await publishRelease("release-b");
    const c = await publishRelease("release-c");
    expect(await rollbackOfRecord()).toMatchObject({ imageIds: [b.imageId] });

    const response = await publish(b);
    expect(response.status).toBe(201);
    expect(await liveImageIds()).toEqual([b.imageId]);
    // The immediate previous state is C, not A.
    expect(await rollbackOfRecord()).toMatchObject({ imageIds: [c.imageId] });

    // Repeating the return keeps the same rollback: B is the live state again
    // and the transition that produced it has already been recorded.
    const repeat = await publish(b);
    expect(repeat.status).toBe(201);
    expect(await liveImageIds()).toEqual([b.imageId]);
    expect(await rollbackOfRecord()).toMatchObject({ imageIds: [c.imageId] });
    // Three records for four replacements: A wrote none (nothing to return
    // to), B captured A, C captured B, the return to B captured C, and the
    // repeat of B rotated nothing because B was already live.
    const recorded = await snapshotRecords();
    expect(recorded).toHaveLength(3);
    expect(recorded.map((record) => record.imageIds)).toEqual([
      [a.imageId],
      [b.imageId],
      [c.imageId],
    ]);

    await convergeObjects();

    // B is live and C is its rollback, so both survive; A is unreachable.
    expect(await head(b.objectKey)).not.toBeNull();
    expect(await head(c.objectKey)).not.toBeNull();
    expect(await head(a.objectKey)).toBeNull();
    expect(await snapshotRecords()).toHaveLength(1);
  });

  it("orders same-clock transitions without relying on an id tiebreak", async () => {
    // A whole cycle inside one millisecond: created_at must still advance, so
    // the newest record is the newest transition.
    const frozen = Date.now() + 60_000;
    const a = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "clock-a",
    });
    const b = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "clock-b",
    });
    const c = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "clock-c",
    });
    expect((await publishAt(a, frozen)).status).toBe(201);
    expect((await publishAt(b, frozen)).status).toBe(201);
    expect((await publishAt(c, frozen)).status).toBe(201);

    const records = await snapshotRecords();
    expect(records).toHaveLength(2);
    // Strictly increasing, so the newest snapshot is the newest transition.
    expect(records[1]!.createdAt).toBeGreaterThan(records[0]!.createdAt);
    expect(await rollbackOfRecord()).toMatchObject({ imageIds: [b.imageId] });

    // A step backwards must not reorder the records either.
    const back = await publishAt(b, frozen - 120_000);
    expect(back.status).toBe(201);
    const afterBackwards = await snapshotRecords();
    expect(
      afterBackwards[afterBackwards.length - 1]!.createdAt,
    ).toBeGreaterThan(records[1]!.createdAt);
    expect(await rollbackOfRecord()).toMatchObject({ imageIds: [c.imageId] });
    expect(await liveImageIds()).toEqual([b.imageId]);
  });

  it("serializes concurrent live replacements so one captures the other", async () => {
    const a = await publishRelease("release-a");
    const b = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "release-b",
    });
    const c = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "release-c",
    });

    // Both replacements read the same live state, but the per-family lock
    // serializes them, so the second one captures the first one's result.
    const [first, second] = await Promise.all([publish(b), publish(c)]);
    expect([first.status, second.status].sort()).toEqual([201, 201]);

    const live = await liveImageIds();
    expect(live).toHaveLength(1);
    const records = await snapshotRecords();
    expect(records).toHaveLength(2);
    // The winner is whichever committed last, and the rollback of record is the
    // state it replaced: A for the first commit, then the loser for the second.
    const winner = live[0];
    const rollback = await rollbackOfRecord();
    expect(rollback?.imageIds).toHaveLength(1);
    expect(rollback?.imageIds[0]).not.toEqual(winner);
    expect(new Set([a.imageId, b.imageId, c.imageId])).toContain(
      rollback?.imageIds[0],
    );

    await convergeObjects();
    // The live release and its recorded rollback survive.
    const survivors = [winner, rollback?.imageIds[0]];
    for (const imageId of survivors) {
      const image = [a, b, c].find((candidate) => candidate.imageId === imageId);
      expect(image).toBeDefined();
      expect(await head(image!.objectKey)).not.toBeNull();
    }
    expect(await snapshotRecords()).toHaveLength(1);
  });

  it("refuses to replace images an active host transfer still needs", async () => {
    const a = await publishRelease("release-a");
    await seedHostNeedingImage(a);

    const b = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "release-b",
    });
    const blocked = await publish(b);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "image publish is blocked by active image use",
      blocking_host_ids: [HOST_ID],
      outgoing_image_ids: [a.imageId],
    });
    // The refusal is complete: no catalog change and no rollback record.
    expect(await liveImageIds()).toEqual([a.imageId]);
    expect(await snapshotRecords()).toEqual([]);

    await drizzle(env.DB)
      .delete(hostDesiredState)
      .where(eq(hostDesiredState.hostId, HOST_ID));
    expect((await publish(b)).status).toBe(201);
    expect(await liveImageIds()).toEqual([b.imageId]);
    expect((await rollbackOfRecord())?.imageIds).toEqual([a.imageId]);
  });
});
