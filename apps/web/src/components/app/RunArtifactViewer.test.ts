import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AsciicastReplaySurface,
  ReadOnlyTextSurface,
  RunArtifactViewer,
  replayPlayerErrorCopy,
} from "./RunArtifactViewer";

describe("replay player error copy", () => {
  it("keeps raw player failures out of the learner replay", () => {
    const raw = "asciinema import failed at internal worker path";

    expect(replayPlayerErrorCopy(raw, true)).toEqual({
      lead: "Replay could not be loaded. Try again soon.",
      detail: null,
    });
    expect(JSON.stringify(replayPlayerErrorCopy(raw, true))).not.toContain(raw);
  });

  it("leads with a plain sentence and keeps the raw detail for operators", () => {
    const raw = "asciinema import failed at internal worker path";

    expect(replayPlayerErrorCopy(raw, false)).toEqual({
      lead: "Replay could not be loaded.",
      detail: raw,
    });
  });
});

describe("replay frame states", () => {
  const surface = (content: string, loading: boolean, minimal = true) =>
    renderToStaticMarkup(
      createElement(AsciicastReplaySurface, {
        contentId: "cast-1",
        content,
        loading,
        minimal,
        label: "Terminal replay of Broken nginx",
      }),
    );

  it("names the replay and says so in words when the cast is empty", () => {
    const markup = surface("  \n", false);

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Terminal replay of Broken nginx"');
    expect(markup).toContain("This replay is empty.");
    expect(markup).not.toContain("replay-bar");
  });

  it("marks the frame busy with one plain loading line while the cast streams", () => {
    const markup = surface('{"version":2,"width":80,"height":24}', true);

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Preparing replay…");
    expect(markup).not.toContain("animate-pulse");
    expect(markup).not.toContain("`");
  });

  it("sizes the loading box from the cast header", () => {
    const wide = surface('{"version":2,"width":120,"height":24}', true);
    const tall = surface('{"version":2,"width":40,"height":40}', true);

    expect(wide).toMatch(/aspect-ratio:\s*[2-9]/);
    expect(tall).toMatch(/aspect-ratio:\s*0\./);
  });

  it("renders the learner controls: toggle, named slider, clock and speed", () => {
    const markup = surface('{"version":2,"width":80,"height":24}\n', false);

    expect(markup).toContain('aria-label="Play replay"');
    expect(markup).toContain('aria-label="Replay position"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('aria-valuetext="0:00 of 0:00"');
    expect(markup).toContain('aria-label="Playback speed: 1×"');
    expect(markup).toContain("0:00 / 0:00");
    // The player's own bar is off, so no second set of controls.
    expect(markup).not.toContain("Toggle fullscreen");
  });

  it("keeps the player's own bar on the operations viewer", () => {
    const markup = surface('{"version":2,"width":80,"height":24}\n', false, false);

    expect(markup).not.toContain("replay-bar");
  });

  it("explains the wait to operators with the machine value in code", () => {
    const markup = surface("", true, false);

    expect(markup).toContain('<code class="text-code">.cast</code>');
    expect(markup).not.toContain("`");
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
