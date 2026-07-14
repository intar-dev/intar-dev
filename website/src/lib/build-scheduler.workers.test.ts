/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  user,
} from "@/db/schema";
import type { BuildReportV1, DesiredBuildV1 } from "@/generated/bridge";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  queueImageBuildsFromBundle,
  recordImageBuildReport,
} from "@/lib/build-scheduler";
import { resetD1Database } from "@/test/d1-migrations";

describe("build scheduler bundle supersession", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("retires only superseded active hashes, cleans desired state, and rejects late reports", async () => {
    const now = 1_762_041_660_000;
    const db = drizzle(env.DB);
    await seedBuilder(db, now);
    await db.insert(imageBuildBundles).values({
      rev: "bundle-old",
      r2Key: "builds/bundles/bundle-old.tar.gz",
      kinoVersion: "0.4.0",
      metaJson: {
        buildFormatVersion: "intar-image-build-v7",
        scenarios: [],
      },
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });

    const oldRows = [
      oldBuild("queued-old", "1", "queued", null, now),
      oldBuild("assigned-old", "2", "assigned", "builder-1", now),
      oldBuild("building-old", "3", "building", "builder-1", now),
      oldBuild("succeeded-old", "4", "succeeded", "builder-1", now),
      oldBuild("failed-old", "5", "failed", "builder-1", now),
    ];
    await db.insert(imageBuilds).values(oldRows);

    const desired = {
      ...createEmptyHostDesiredState({ hostId: "builder-1", nowUnixMs: now }),
      version: 1,
      builds: [
        desiredBuild("assigned-old", "2"),
        desiredBuild("building-old", "3"),
        desiredBuild("keep", "9"),
      ],
    };
    await db.insert(hostDesiredState).values({
      hostId: "builder-1",
      version: desired.version,
      docJson: desired,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      queueImageBuildsFromBundle(db, {
        rev: "bundle-new",
        r2Key: "builds/bundles/bundle-new.tar.gz",
        kinoVersion: "0.4.0",
        meta: {
          buildFormatVersion: "intar-image-build-v7",
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: "a".repeat(64),
            },
          ],
        },
        nowUnixMs: now,
      }),
    ).resolves.toEqual({ queued: 1 });

    const rows = await db
      .select({
        id: imageBuilds.id,
        rev: imageBuilds.rev,
        status: imageBuilds.status,
        error: imageBuilds.error,
        updatedAt: imageBuilds.updatedAt,
      })
      .from(imageBuilds)
      .where(eq(imageBuilds.scenarioId, "broken-nginx"));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ["queued-old", "assigned-old", "building-old"]) {
      expect(byId.get(id)).toMatchObject({
        status: "stale",
        error: "superseded by bundle bundle-new",
        updatedAt: now,
      });
    }
    expect(byId.get("succeeded-old")).toMatchObject({
      status: "succeeded",
      error: null,
      updatedAt: now - 1_000,
    });
    expect(byId.get("failed-old")).toMatchObject({
      status: "failed",
      error: null,
      updatedAt: now - 1_000,
    });
    const newRow = rows.find((row) => row.rev === "bundle-new");
    expect(newRow).toMatchObject({ status: "queued", error: null });

    const [storedDesired] = await db
      .select({ docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "builder-1"));
    expect(
      storedDesired?.docJson.builds.map((build) => build.build_id),
    ).toEqual(["keep"]);

    await expect(
      recordImageBuildReport(
        db,
        "builder-1",
        buildReport("assigned-old", "2"),
        now + 1,
      ),
    ).resolves.toEqual({ updated: false, terminal: false });

    await expect(
      queueImageBuildsFromBundle(db, {
        rev: "bundle-same-hash",
        r2Key: "builds/bundles/bundle-same-hash.tar.gz",
        kinoVersion: "0.4.0",
        meta: {
          buildFormatVersion: "intar-image-build-v7",
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: "a".repeat(64),
            },
          ],
        },
        nowUnixMs: now + 2,
      }),
    ).resolves.toEqual({ queued: 0 });
    const [sameHashRow] = await db
      .select({ rev: imageBuilds.rev, status: imageBuilds.status })
      .from(imageBuilds)
      .where(eq(imageBuilds.contentHash, "a".repeat(64)));
    expect(sameHashRow).toEqual({ rev: "bundle-new", status: "queued" });
  });
});

function oldBuild(
  id: string,
  hashChar: string,
  status: "queued" | "assigned" | "building" | "succeeded" | "failed",
  hostId: string | null,
  now: number,
) {
  const phase: BuildReportV1["phase"] =
    status === "queued" || status === "assigned" ? "queued" : status;
  return {
    id,
    scenarioId: "broken-nginx",
    arch: "x86_64" as const,
    rev: "bundle-old",
    contentHash: hashChar.repeat(64),
    kinoVersion: "0.4.0",
    hostId,
    status,
    phase,
    attempt: status === "queued" ? 0 : 1,
    error: null,
    logR2Key: null,
    timingsJson: {},
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
  };
}

function desiredBuild(id: string, hashChar: string): DesiredBuildV1 {
  return {
    build_id: id,
    scenario_id: "broken-nginx",
    arch: "x86_64",
    rev: "bundle-old",
    content_hash: hashChar.repeat(64),
    bundle_ref: "builds/bundles/bundle-old.tar.gz",
    kino_version: "0.4.0",
  };
}

function buildReport(buildId: string, hashChar: string): BuildReportV1 {
  return {
    schema_version: 1,
    host_id: "builder-1",
    build_id: buildId,
    scenario_id: "broken-nginx",
    content_hash: hashChar.repeat(64),
    observed_at_unix_ms: 1_762_041_660_001,
    phase: "succeeded",
    current_vm: null,
    started_at_unix_ms: 1_762_041_659_000,
    finished_at_unix_ms: 1_762_041_660_001,
    attempt: 1,
    error: null,
  };
}

async function seedBuilder(
  db: ReturnType<typeof drizzle>,
  now: number,
): Promise<void> {
  await db.insert(user).values({
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: "builder-1",
    userId: "user-1",
    name: "Builder 1",
    role: "builder",
    scenarioEnabled: false,
    disabled: false,
    connected: false,
    createdAt: now,
    updatedAt: now,
  });
}
