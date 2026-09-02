import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webSshTerminalModule = vi.hoisted(() => ({ loadCount: 0 }));
const fleetState = vi.hoisted(() => ({
  hasMoreLive: false,
  hostRecords: [] as unknown[],
  liveLoadedCount: 0,
  liveTotalCount: 0,
}));
const archiveState = vi.hoisted(() => ({
  runs: [] as unknown[],
  totalCount: 0 as number | null,
  hasMore: false,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
}));

vi.mock("@/components/remote-access/WebSshTerminal", () => {
  webSshTerminalModule.loadCount += 1;
  return { WebSshTerminal: () => null };
});

vi.mock("@/components/app/admin/hosts/useAdminScenarios", () => ({
  useAdminScenarios: () => ({
    data: { scenarios: [] },
    error: null,
  }),
}));

vi.mock("@/components/app/admin/hosts/useHostFleet", () => ({
  useHostFleet: () => ({
    hosts: {
      data: [],
      error: null,
      isPending: false,
      refetch: vi.fn(),
    },
    hostRecords: fleetState.hostRecords,
    liveLoadedCount: fleetState.liveLoadedCount,
    liveTotalCount: fleetState.liveTotalCount,
    hasMoreLive: fleetState.hasMoreLive,
    refreshHost: vi.fn(),
  }),
}));

vi.mock("@/components/app/admin/hosts/useAdminRunArchive", () => ({
  useAdminRunArchive: () => ({
    runs: archiveState.runs,
    totalCount: archiveState.totalCount,
    hasMore: archiveState.hasMore,
    isPending: false,
    error: null,
    refetch: vi.fn(),
    isLoadingMore: false,
    loadMoreError: null,
    loadMore: vi.fn(),
    loadRunDetail: vi.fn(),
    forgetRun: vi.fn(),
  }),
}));

import type {
  AgentVmRunSummary,
  ArchivedScenarioRunRecord,
} from "@/components/app/admin/hosts/types";
import {
  artifactPreviewRequest,
  Dashboard,
  filterArchivedScenarioRuns,
  isMissingArchivedRunStatus,
} from "./Dashboard";

describe("dashboard optional surfaces", () => {
  beforeEach(() => {
    archiveState.runs = [];
    archiveState.totalCount = 0;
    archiveState.hasMore = false;
    fleetState.hasMoreLive = false;
    fleetState.hostRecords = [];
    fleetState.liveLoadedCount = 0;
    fleetState.liveTotalCount = 0;
  });

  it("does not load or mount Web SSH before the user opens it", () => {
    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(webSshTerminalModule.loadCount).toBe(0);
    expect(markup).not.toContain("Web SSH");
  });

  it("keeps the retained total when the global archive page is bounded", () => {
    archiveState.totalCount = 142;

    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(markup).toContain("142 retained");
  });

  it("offers older archive pages instead of silently truncating the archive", () => {
    archiveState.totalCount = 142;
    archiveState.hasMore = true;

    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(markup).toContain("Load older runs");
  });

  it("labels a partial global archive without running an exact count", () => {
    archiveState.runs = [archivedRun({ id: "run-loaded" })];
    archiveState.totalCount = null;
    archiveState.hasMore = true;

    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(markup).toContain("1+ loaded");
  });

  it("filters loaded archive rows by owner search and outcome", () => {
    const runs = [
      archivedRun({
        id: "run-succeeded",
        ownerName: "Ada Admin",
        ownerUsername: "ada",
        outcome: "succeeded",
      }),
      archivedRun({
        id: "run-failed",
        ownerName: "Grace Operator",
        ownerUsername: "grace",
        outcome: "failed",
      }),
    ];

    expect(
      filterArchivedScenarioRuns(runs, "ADA", null).map(({ run }) => run.id),
    ).toEqual(["run-succeeded"]);
    expect(
      filterArchivedScenarioRuns(runs, "", "failed").map(({ run }) => run.id),
    ).toEqual(["run-failed"]);
  });

  it("treats already-removed archive rows as idempotent deletes", () => {
    expect(isMissingArchivedRunStatus(404)).toBe(true);
    expect(isMissingArchivedRunStatus(410)).toBe(true);
    expect(isMissingArchivedRunStatus(409)).toBe(false);
    expect(isMissingArchivedRunStatus(500)).toBe(false);
  });

  it("bounds large text previews but keeps replay casts complete", () => {
    expect(
      artifactPreviewRequest({
        contentType: "text/plain",
        filename: "large.log",
        kind: "console_log",
        sizeBytes: 2 * 1024 * 1024,
      }),
    ).toEqual({
      previewTruncated: true,
      requestInit: { headers: { range: "bytes=0-262143" } },
    });
    expect(
      artifactPreviewRequest({
        contentType: "application/x-asciicast",
        filename: "session.cast",
        kind: "ssh_recording_segment",
        sizeBytes: 3 * 1024 * 1024,
      }),
    ).toEqual({
      previewTruncated: true,
      requestInit: { headers: { range: "bytes=0-2097151" } },
    });
    expect(
      artifactPreviewRequest({
        contentType: "application/x-asciicast",
        filename: "session.cast",
        kind: "ssh_recording_segment",
        sizeBytes: 512 * 1024,
      }),
    ).toEqual({ previewTruncated: false, requestInit: {} });
  });
});

function archivedRun(
  overrides: Partial<AgentVmRunSummary>,
): ArchivedScenarioRunRecord {
  return {
    host: {
      id: "host-1",
      name: "Agent host",
    },
    run: {
      id: "run-1",
      hostId: "host-1",
      userId: "user-1",
      ownerName: "Run owner",
      ownerUsername: "run-owner",
      vmName: "vm-1",
      state: "completed",
      outcome: "succeeded",
      solvedAt: null,
      solveDurationMs: null,
      uploadStatus: "complete",
      vmCreatedAt: 0,
      deleteRequestedAt: 0,
      deletedAt: 0,
      uploadStartedAt: 0,
      uploadCompletedAt: 0,
      uploadError: null,
      deleteBlockedReason: null,
      createdAt: 0,
      updatedAt: 0,
      artifactCount: 0,
      eventCount: 0,
      scenarioMeta: null,
      ...overrides,
    },
  };
}
