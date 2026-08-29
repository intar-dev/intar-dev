import { describe, expect, it } from "vitest";
import {
  isSafeAdminBuildId,
  serializeAdminBuildDetail,
  serializeAdminBuildSummary,
  type AdminBuildDetailResponseRow,
} from "@/lib/admin-build-response";

describe("admin build response serialization", () => {
  it("summarizes build rows without exposing raw log object keys", () => {
    const serialized = serializeAdminBuildSummary(buildRow);

    expect(serialized).toMatchObject({
      id: "build-1",
      scenarioId: "broken-nginx",
      arch: "x86_64",
      rev: "abc123",
      contentHash: "f".repeat(64),
      kinoVersion: "0.4.0",
      hostId: "builder-1",
      hostName: "Builder One",
      status: "building",
      phase: "publishing",
      attempt: 2,
      canRetry: false,
      hasLog: true,
      bundleR2Key: "builds/bundles/abc123.tar.gz",
    });
    expect(serialized).not.toHaveProperty("logR2Key");
  });

  it("adds host and bundle detail for build detail responses", () => {
    const serialized = serializeAdminBuildDetail(buildRow);

    expect(serialized.host).toEqual({
      id: "builder-1",
      name: "Builder One",
      role: "builder",
      connected: true,
      lastHeartbeatAt: 1_762_041_655_000,
    });
    expect(serialized.bundle).toEqual({
      rev: "abc123",
      r2Key: "builds/bundles/abc123.tar.gz",
      kinoVersion: "0.4.0",
      meta: {
        buildFormatVersion: "intar-image-build-v9",
        scenarios: [
          {
            scenarioId: "broken-nginx",
            arch: "x86_64",
            contentHash: "f".repeat(64),
          },
        ],
      },
    });
    expect(serialized).not.toHaveProperty("logR2Key");
  });

  it("marks only failed and stale builds as retryable", () => {
    expect(
      serializeAdminBuildSummary({ ...buildRow, status: "failed" }).canRetry,
    ).toBe(true);
    expect(
      serializeAdminBuildSummary({ ...buildRow, status: "stale" }).canRetry,
    ).toBe(true);
    expect(
      serializeAdminBuildSummary({ ...buildRow, status: "queued" }).canRetry,
    ).toBe(false);
    expect(
      serializeAdminBuildSummary({ ...buildRow, status: "building" }).canRetry,
    ).toBe(false);
    expect(
      serializeAdminBuildSummary({ ...buildRow, status: "succeeded" }).canRetry,
    ).toBe(false);
  });

  it("accepts only bounded path-safe build ids for log downloads", () => {
    expect(isSafeAdminBuildId("build-1_2.3")).toBe(true);
    expect(isSafeAdminBuildId("a".repeat(128))).toBe(true);

    expect(isSafeAdminBuildId("")).toBe(false);
    expect(isSafeAdminBuildId(".")).toBe(false);
    expect(isSafeAdminBuildId("..")).toBe(false);
    expect(isSafeAdminBuildId("build 1")).toBe(false);
    expect(isSafeAdminBuildId("../build-1")).toBe(false);
    expect(isSafeAdminBuildId("build/1")).toBe(false);
    expect(isSafeAdminBuildId("a".repeat(129))).toBe(false);
  });
});

const buildRow: AdminBuildDetailResponseRow = {
  id: "build-1",
  scenarioId: "broken-nginx",
  arch: "x86_64",
  rev: "abc123",
  contentHash: "f".repeat(64),
  kinoVersion: "0.4.0",
  hostId: "builder-1",
  hostName: "Builder One",
  hostRole: "builder",
  hostConnected: true,
  hostLastHeartbeatAt: 1_762_041_655_000,
  status: "building",
  phase: "publishing",
  attempt: 2,
  error: null,
  logR2Key: "builds/logs/build-1.log",
  timings: {
    queuedAt: 1_762_041_600_000,
    startedAt: 1_762_041_620_000,
    lastReportAt: 1_762_041_650_000,
  },
  bundleR2Key: "builds/bundles/abc123.tar.gz",
  bundleKinoVersion: "0.4.0",
  bundleMeta: {
    buildFormatVersion: "intar-image-build-v9",
    scenarios: [
      {
        scenarioId: "broken-nginx",
        arch: "x86_64",
        contentHash: "f".repeat(64),
      },
    ],
  },
  createdAt: 1_762_041_600_000,
  updatedAt: 1_762_041_660_000,
};
