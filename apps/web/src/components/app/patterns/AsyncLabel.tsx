import type { ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AsyncState = "idle" | "pending" | "done";

/**
 * A button label that swaps in place while work runs: the idle words, then a
 * spinner with the present tense ("Saving…"), then a drawn check with the
 * past tense ("Saved"). Every layer shares one grid cell, so the button keeps
 * the width of its widest label (the Steady Box Rule), and hidden layers are
 * `invisible`, so assistive technology reads only the current one.
 *
 * Pair it with `aria-busy` and `focusableWhenDisabled` on the button, so focus
 * stays put while the work runs and after it fails.
 */
export function AsyncLabel({
  state,
  idle,
  pending,
  done,
}: {
  state: AsyncState;
  idle: ReactNode;
  pending: ReactNode;
  done?: ReactNode;
}) {
  // The shared [data-swap] rules (global.css) fade the leaving layer out and
  // rise the arriving one in; hidden layers are visibility: hidden.
  const on = (name: AsyncState) => (state === name ? "" : undefined);
  return (
    <span data-swap>
      <span data-on={on("idle")}>{idle}</span>
      <span data-on={on("pending")}>
        <LoaderCircle
          className="size-3.5 motion-safe:animate-spin"
          aria-hidden="true"
        />
        {pending}
      </span>
      {done ? (
        <span data-on={on("done")}>
          <Check
            className={cn("size-3.5", state === "done" && "draw-check")}
            aria-hidden="true"
          />
          {done}
        </span>
      ) : null}
    </span>
  );
}
