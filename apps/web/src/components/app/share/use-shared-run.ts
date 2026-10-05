import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareViewerMessage } from "@/lib/run-share/protocol";
import {
  applyShareMessages,
  createSharedRunState,
  type ShareStatus,
  type SharedRunState,
} from "@/lib/run-share/shared-run-model";
import {
  connectShareStream,
  type ShareStream,
} from "@/lib/run-share/shared-run-stream";

/** Messages that arrive close together are applied in one render. */
const FLUSH_MS = 30;

/**
 * One public share: the model of what it has said, and how the link is doing.
 * The model survives a reconnect (the share is asked only for what was missed)
 * and starts over only when the page loads or the share id changes.
 */
export function useSharedRun(shareId: string): {
  model: SharedRunState;
  status: ShareStatus;
  retry: () => void;
} {
  const [model, setModel] = useState(createSharedRunState);
  const [status, setStatus] = useState<ShareStatus>("connecting");
  const stream = useRef<ShareStream | null>(null);

  useEffect(() => {
    let state = createSharedRunState();
    let queue: ShareViewerMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    setModel(state);
    setStatus("connecting");

    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      state = applyShareMessages(state, batch);
      setModel(state);
    };

    const connection = connectShareStream({
      shareId,
      origin: window.location.origin,
      // What has been received counts, applied or still queued.
      after: () => {
        flush();
        return state.seq;
      },
      onMessages: (messages) => {
        for (const message of messages) queue.push(message);
        // Live once caught up with what the share had stored.
        if (messages.some((message) => message.type === "synced")) {
          setStatus("live");
        }
        timer ??= setTimeout(flush, FLUSH_MS);
      },
      // An open socket is still catching up; "synced" is what makes it live.
      onConnection: (next) => {
        if (next !== "open") setStatus(next);
      },
    });
    stream.current = connection;

    return () => {
      stream.current = null;
      connection.close();
      if (timer !== null) clearTimeout(timer);
    };
  }, [shareId]);

  const retry = useCallback(() => {
    setStatus("connecting");
    stream.current?.retry();
  }, []);

  return { model, status, retry };
}
