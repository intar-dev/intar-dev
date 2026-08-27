import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReadOnlyTextSurface,
  RunArtifactViewer,
  replayPlayerErrorCopy,
} from "./RunArtifactViewer";

describe("replay player error copy", () => {
  it("keeps raw player failures out of the learner replay", () => {
    const raw = "asciinema import failed at internal worker path";

    expect(replayPlayerErrorCopy(raw, true)).toBe(
      "Replay could not be loaded. Try again soon.",
    );
    expect(replayPlayerErrorCopy(raw, true)).not.toContain(raw);
    expect(replayPlayerErrorCopy(raw, false)).toBe(raw);
  });
});

describe("read-only artifact text", () => {
  it("keeps the existing empty and error viewer states", () => {
    const empty = renderToStaticMarkup(
      createElement(RunArtifactViewer, { viewer: null }),
    );
    const error = renderToStaticMarkup(
      createElement(RunArtifactViewer, {
        viewer: {
          artifact: {
            id: "artifact-1",
            ordinal: 1,
            kind: "console_log",
            filename: "console.log",
            contentType: "text/plain",
            sizeBytes: 0,
            sha256: "abc",
            uploadStatus: "failed",
            uploadedAt: null,
          },
          loading: false,
          error: "Artifact download failed.",
          content: "",
          receivedBytes: 0,
        },
      }),
    );

    expect(empty).toContain("Select an artifact");
    expect(error).toContain("Artifact download failed.");
  });

  it("uses a native, focusable code pane with the selected wrapping mode", () => {
    const wrapped = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "first line\nsecond line",
        loading: false,
        wrapText: true,
      }),
    );
    const unwrapped = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "one very long line",
        loading: true,
        wrapText: false,
        compact: true,
      }),
    );

    expect(wrapped).toContain("<pre");
    expect(wrapped).toContain("<code>first line\nsecond line</code>");
    expect(wrapped).toContain('tabindex="0"');
    expect(wrapped).toContain('aria-label="Artifact text content"');
    expect(wrapped).toContain("whitespace-pre-wrap");
    expect(wrapped).not.toContain("cm-");
    expect(unwrapped).toContain('aria-busy="true"');
    expect(unwrapped).toContain("whitespace-pre");
    expect(unwrapped).not.toContain("whitespace-pre-wrap");
  });

  it("keeps an explicit empty state while a stream has not produced text", () => {
    const streaming = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "",
        loading: true,
        wrapText: true,
      }),
    );
    const empty = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "",
        loading: false,
        wrapText: true,
      }),
    );

    expect(streaming).toContain("Waiting for text…");
    expect(empty).toContain("This artifact is empty.");
  });

  it("renders streamed appends without an editor runtime", () => {
    const initial = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "first line",
        loading: true,
        wrapText: true,
      }),
    );
    const appended = renderToStaticMarkup(
      createElement(ReadOnlyTextSurface, {
        content: "first line\nsecond line",
        loading: true,
        wrapText: true,
      }),
    );

    expect(initial).toContain("first line");
    expect(appended).toContain("first line\nsecond line");
    expect(appended).not.toContain("cm-");
  });

  it("labels bounded previews and offers the complete download", () => {
    const markup = renderToStaticMarkup(
      createElement(RunArtifactViewer, {
        viewer: {
          artifact: {
            id: "artifact-large",
            ordinal: 1,
            kind: "console_log",
            filename: "large.log",
            contentType: "text/plain",
            sizeBytes: 2 * 1024 * 1024,
            sha256: "abc",
            uploadStatus: "complete",
            uploadedAt: 1,
          },
          loading: false,
          error: null,
          content: "bounded preview",
          receivedBytes: 256 * 1024,
          previewTruncated: true,
          downloadUrl: "/api/runs/run-1/artifacts/artifact-large/content",
        },
      }),
    );

    expect(markup).toContain("Copy preview");
    expect(markup).toContain("Download full file");
    expect(markup).toContain("inline preview is capped for speed");
    expect(markup).toContain('download="large.log"');
  });
});
