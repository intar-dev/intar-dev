import { startTransition, useEffect, useState } from "react";

export interface StreamedTextState {
  content: string;
  loading: boolean;
  error: string | null;
  receivedBytes: number;
  truncated: boolean;
}

export const MAX_INLINE_REPLAY_BYTES = 2 * 1024 * 1024;
const STREAM_UPDATE_INTERVAL_MS = 50;

const IDLE_STATE: StreamedTextState = {
  content: "",
  loading: false,
  error: null,
  receivedBytes: 0,
  truncated: false,
};

/**
 * Streams a text response (cast files, transcripts) into state, appending
 * chunks inside `startTransition` so multi-megabyte bodies don't jank the
 * page. Nothing is fetched until `enabled` — session transcripts only load
 * when their tab is opened.
 */
export function useStreamedText(
  url: string | null,
  enabled: boolean,
  maxBytes = MAX_INLINE_REPLAY_BYTES,
): StreamedTextState {
  const [state, setState] = useState<StreamedTextState>(IDLE_STATE);

  useEffect(() => {
    if (!url || !enabled) {
      setState(IDLE_STATE);
      return;
    }

    const controller = new AbortController();
    setState({
      content: "",
      loading: true,
      error: null,
      receivedBytes: 0,
      truncated: false,
    });

    void (async () => {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          signal: controller.signal,
          headers: { range: `bytes=0-${maxBytes}` },
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ?? `Failed to load content (${response.status})`,
          );
        }

        if (!response.body) {
          const text = await response.text();
          const bytes = new TextEncoder().encode(text);
          const truncated = bytes.byteLength > maxBytes;
          setState({
            content: new TextDecoder().decode(bytes.subarray(0, maxBytes)),
            loading: false,
            error: null,
            receivedBytes: Math.min(bytes.byteLength, maxBytes),
            truncated,
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let receivedBytes = 0;
        let truncated = false;
        let lastPublishedAt = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const visibleBytes = Math.max(0, maxBytes - receivedBytes);
          const visibleChunk = value.subarray(0, visibleBytes);
          receivedBytes += visibleChunk.byteLength;
          accumulated += decoder.decode(visibleChunk, { stream: true });
          if (value.byteLength > visibleChunk.byteLength) {
            truncated = true;
            await reader.cancel();
          }
          const now = Date.now();
          if (!truncated && now - lastPublishedAt < STREAM_UPDATE_INTERVAL_MS) {
            continue;
          }
          lastPublishedAt = now;
          const snapshot = accumulated;
          const snapshotBytes = receivedBytes;
          const snapshotTruncated = truncated;
          startTransition(() => {
            setState({
              content: snapshot,
              loading: true,
              error: null,
              receivedBytes: snapshotBytes,
              truncated: snapshotTruncated,
            });
          });
          if (truncated) break;
        }

        accumulated += decoder.decode();
        setState({
          content: accumulated,
          loading: false,
          error: null,
          receivedBytes,
          truncated,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState((current) => ({
          content: current.content,
          loading: false,
          error:
            error instanceof Error ? error.message : "Failed to stream content",
          receivedBytes: current.receivedBytes,
          truncated: current.truncated,
        }));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [url, enabled, maxBytes]);

  return state;
}
