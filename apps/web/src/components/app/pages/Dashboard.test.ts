import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webSshTerminalModule = vi.hoisted(() => ({ loadCount: 0 }));
const fleetState = vi.hoisted(() => ({
  archiveTotalCount: 0,
  hasMoreArchives: false,
  hasMoreLive: false,
  hostRecords: [] as unknown[],
  liveLoadedCount: 0,
  liveTotalCount: 0,
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
    archiveTotalCount: fleetState.archiveTotalCount,
    hasMoreArchives: fleetState.hasMoreArchives,
    hasMoreLive: fleetState.hasMoreLive,
    isLoadingMoreArchives: false,
    loadMoreArchivesError: null,
    loadMoreArchives: vi.fn(),
    refreshHost: vi.fn(),
    forgetArchivedRun: vi.fn(),
    loadArchivedRunDetail: vi.fn(),
  }),
}));

import { artifactPreviewRequest, Dashboard } from "./Dashboard";

describe("dashboard optional surfaces", () => {
  beforeEach(() => {
    fleetState.archiveTotalCount = 0;
    fleetState.hasMoreArchives = false;
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

  it("keeps the retained archive count when the fleet snapshot is bounded", () => {
    fleetState.archiveTotalCount = 142;

    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(markup).toContain("142 retained");
  });

  it("offers older archive pages instead of silently truncating the archive", () => {
    fleetState.archiveTotalCount = 142;
    fleetState.hasMoreArchives = true;

    const markup = renderToStaticMarkup(createElement(Dashboard));

    expect(markup).toContain("Load older runs");
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
