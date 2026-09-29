/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
} from "@/db/schema";
import {
  listAdministeredBuilds,
  readAdministeredBuildLog,
  TENANT_BUILD_LOG_BYTES,
} from "@/lib/organization-builds";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ERROR = "copy '/var/lib/intar-builder/work/disk.qcow2' failed";

beforeEach(async () => {
  await resetD1Database();
  const db = drizzle(env.DB);
  for (const userId of ["owner-a", "admin-b", "member-a", "stranger"]) {
    await createFixtureMember({ d1: env.DB, userId });
  }
  for (const id of ["org-a", "org-b"]) {
    await db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
  }
  await db.insert(member).values([
    { id: "m1", organizationId: "org-a", userId: "owner-a", role: "owner", createdAt: new Date() },
    { id: "m2", organizationId: "org-b", userId: "admin-b", role: "admin", createdAt: new Date() },
    { id: "m3", organizationId: "org-a", userId: "member-a", role: "member", createdAt: new Date() },
  ]);
  await db.insert(agentHosts).values({
    id: "builder-1",
    userId: "stranger",
    name: "Builder 1",
    scope: "platform",
    credentialGeneration: 1,
    role: "builder",
    scenarioEnabled: false,
    disabled: false,
    connected: true,
    createdAt: 1,
    updatedAt: 1,
  });
  for (const [scope, organizationId] of [
    ["a", "org-a"],
    ["b", "org-b"],
    ["public", null],
  ] as const) {
    await db.insert(imageBuildBundles).values({
      rev: `rev-${scope}`,
      organizationId,
      r2Key: `bundles/rev-${scope}.tar.gz`,
      metaJson: sql`'{}'`,
    });
    await db.insert(imageBuilds).values({
      id: `build-${scope}`,
      organizationId,
      scenarioId: `${scope}-demo`,
      arch: "x86_64",
      rev: `rev-${scope}`,
      contentHash: `hash-${scope}`,
      hostId: "builder-1",
      status: "failed",
      error: ERROR,
      logR2Key: `builds/logs/build-${scope}.log`,
    });
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      `builds/logs/build-${scope}.log`,
      `== ${scope}-demo:vm build log ==\nfailed to read build log '/var/lib/intar-builder/work/build.log': gone\n`,
    );
  }
});

describe("organization builds", () => {
  it("lists only the administered organization's builds, without builder details", async () => {
    expect(await listAdministeredBuilds("owner-a")).toEqual([
      expect.objectContaining({
        id: "build-a",
        scenarioId: "a-demo",
        hostId: null,
        hostName: null,
        bundleR2Key: null,
        error: "copy '<path>' failed",
        canRetry: true,
        hasLog: true,
      }),
    ]);
    expect((await listAdministeredBuilds("admin-b"))?.map((build) => build.id)).toEqual([
      "build-b",
    ]);
  });

  it("refuses members and people outside every organization", async () => {
    expect(await listAdministeredBuilds("member-a")).toBeNull();
    expect(await listAdministeredBuilds("stranger")).toBeNull();
  });

  it("serves a log only for an administered build, with host paths removed", async () => {
    expect(await readAdministeredBuildLog("owner-a", "build-a")).toBe(
      "== a-demo:vm build log ==\nfailed to read build log '<path>': gone\n",
    );
    expect(await readAdministeredBuildLog("owner-a", "build-b")).toBeNull();
    expect(await readAdministeredBuildLog("owner-a", "build-public")).toBeNull();
    expect(await readAdministeredBuildLog("member-a", "build-a")).toBeNull();
  });

  it("serves only the tail of an oversized log and drops the line it cuts", async () => {
    // The tail starts inside the path, past its leading slash.
    const log = `stage output\ncopy /var/lib/intar-builder/work/${"x".repeat(
      TENANT_BUILD_LOG_BYTES,
    )} failed\nlast line /var/lib/intar-builder/work/build.log\n`;
    await env.VM_IMAGE_REGISTRY_BUCKET.put("builds/logs/build-a.log", log);
    expect(await readAdministeredBuildLog("owner-a", "build-a")).toBe(
      `[earlier output truncated: the log is ${log.length} bytes]\nlast line <path>\n`,
    );
  });
});
