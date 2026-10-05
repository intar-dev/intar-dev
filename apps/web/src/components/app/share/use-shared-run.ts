import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyShareMessages,
  createSharedRunState,
  type ShareStatus,
  type ShareUpdate,
  type SharedRunState,
} from "@/lib/run-share/shared-run-model";
import {
  startShareLive,
  type ShareLive,
} from "@/lib/run-share/shared-run-poller";

/** What arrives close together is applied in one render. */
const FLUSH_MS = 30;

/**
 * One public share: the model of what it holds, and how the viewer's reads of
 * its files are going. The model survives a failed read (the poller carries on
 * from the segment it was at) and starts over only when the page loads or the
 * share id changes.
 */
export function useSharedRun(shareId: string): {
  model: SharedRunState;
  status: ShareStatus;
  retry: () => void;
} {
  const [model, setModel] = useState(createSharedRunState);
  const [status, setStatus] = useState<ShareStatus>("connecting");
  const live = useRef<ShareLive | null>(null);

  useEffect(() => {
    let state = createSharedRunState();
    let queue: ShareUpdate[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let truncatedSeen = false;
    setModel(state);
    setStatus("connecting");

    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      const next = applyShareMessages(state, batch);
      if (next === state) return;
      state = next;
      setModel(state);
    };
    const enqueue = (updates: readonly ShareUpdate[]) => {
      for (const update of updates) queue.push(update);
      timer ??= setTimeout(flush, FLUSH_MS);
    };

    const poller = startShareLive({
      shareId,
      onMission: (mission) => enqueue([{ type: "mission", mission }]),
      // A rebuilt share starts its log over, truncation flag included.
      onGeneration: (generation) => {
        truncatedSeen = false;
        enqueue([{ type: "generation", generation }]);
      },
      // The head carries the truncation flag, whether or not a segment says so.
      onHead: (head) => {
        if (head.truncated && !truncatedSeen) {
          truncatedSeen = true;
          enqueue([{ type: "truncated" }]);
        }
      },
      onMessages: enqueue,
      // What was read is applied before the status says so, in the same render:
      // "live" over a model that is 30 ms behind would show an empty share.
      onStatus: (next) => {
        flush();
        setStatus(next);
      },
    });
    live.current = poller;

    return () => {
      live.current = null;
      poller.close();
      if (timer !== null) clearTimeout(timer);
    };
  }, [shareId]);

  const retry = useCallback(() => {
    setStatus("connecting");
    live.current?.retry();
  }, []);

  return { model, status, retry };
}
