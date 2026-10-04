import { useLayoutEffect, useRef, useState } from "react";

/**
 * Ids whose state reached `target` while this component was mounted. An id
 * already there on mount stays still (the Moment Rule); one that leaves
 * `target` drops out, so reaching it again plays again. The set lives in
 * state, so an unrelated re-render can't cut a moment short.
 */
export function useJustReached<S extends string>(
  entries: readonly (readonly [id: string, state: S])[],
  target: S,
): ReadonlySet<string> {
  const previous = useRef<ReadonlyMap<string, S> | null>(null);
  const [reached, setReached] = useState<ReadonlySet<string>>(new Set());
  const signature = entries.map(([id, state]) => `${id}:${state}`).join("|");
  useLayoutEffect(() => {
    const before = previous.current;
    const now = new Map(entries);
    previous.current = now;
    if (!before) return;
    setReached((current) => {
      const next = new Set(
        [...current].filter((id) => now.get(id) === target),
      );
      for (const [id, state] of entries) {
        if (state === target && before.has(id) && before.get(id) !== target) {
          next.add(id);
        }
      }
      const same =
        next.size === current.size && [...next].every((id) => current.has(id));
      return same ? current : next;
    });
    // `signature` captures every state change; `entries` is new each render.
  }, [signature]);
  return reached;
}
