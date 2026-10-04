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
  const layer = (name: AsyncState) =>
    cn(
      "inline-flex items-center justify-center gap-1.5 transition-opacity",
      state === name
        ? "duration-(--duration-moderate) ease-enter"
        : "invisible opacity-0 duration-(--duration-fast) ease-exit",
    );
  return (
    <span className="grid *:col-start-1 *:row-start-1">
      <span className={layer("idle")}>{idle}</span>
      <span className={layer("pending")}>
        <LoaderCircle
          className="size-3.5 motion-safe:animate-spin"
          aria-hidden="true"
        />
        {pending}
      </span>
      {done ? (
        <span className={layer("done")}>
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
