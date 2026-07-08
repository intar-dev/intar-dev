import { startTransition, useEffect, useState } from "react";

export interface StreamedTextState {
  content: string;
  loading: boolean;
  error: string | null;
  receivedBytes: number;
}

const IDLE_STATE: StreamedTextState = {
  content: "",
  loading: false,
  error: null,
  receivedBytes: 0,
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
): StreamedTextState {
  const [state, setState] = useState<StreamedTextState>(IDLE_STATE);

  useEffect(() => {
    if (!url || !enabled) {
      setState(IDLE_STATE);
      return;
    }

    const controller = new AbortController();
    setState({ content: "", loading: true, error: null, receivedBytes: 0 });

    void (async () => {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          signal: controller.signal,
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
          setState({
            content: text,
            loading: false,
            error: null,
            receivedBytes: new TextEncoder().encode(text).byteLength,
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          accumulated += decoder.decode(value, { stream: true });
          const snapshotBytes = receivedBytes;
          const snapshot = accumulated;
          startTransition(() => {
            setState({
              content: snapshot,
              loading: true,
              error: null,
              receivedBytes: snapshotBytes,
            });
          });
        }

        accumulated += decoder.decode();
        setState({
          content: accumulated,
          loading: false,
          error: null,
          receivedBytes,
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
        }));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [url, enabled]);

  return state;
}
