import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Lucide's trash-2 with its lid grouped, so the lid can lift on its hinge. */
export function BinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-3.5 overflow-visible", className)}
    >
      <g data-bin-lid>
        <path d="M3 6h18" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      </g>
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

interface InlineConfirmProps {
  /** Visible trigger label, such as "Remove". */
  label: string;
  /** The trigger's accessible name, naming the row: "Remove the Work laptop key". */
  name: string;
  /** The question the confirm group asks: "Remove the Work laptop key?". */
  question: string;
  /** The destructive button's words: "Remove key". */
  confirmLabel: string;
  /** Present tense while the request runs: "Removing…". */
  pendingLabel: string;
  /** Past tense once it worked: "Removed". */
  doneLabel: string;
  pending?: boolean;
  /** The request worked: a check draws itself before the row leaves. */
  done?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}

/**
 * A row action that asks again in place instead of opening a dialog. Use it
 * when the button's own words carry the consequence; a consequence that needs
 * a sentence belongs in a dialog. Keep and the destructive button take the
 * trigger's place in one grid cell, so nothing in the row moves; focus goes to
 * Keep, and Escape, Keep, a click elsewhere or Tab away backs out. The idle
 * layer is transparent and inert (not visibility: hidden), so focus can move
 * into the newly shown layer on the same frame.
 */
export function InlineConfirm({
  label,
  name,
  question,
  confirmLabel,
  pendingLabel,
  doneLabel,
  pending = false,
  done = false,
  disabled = false,
  onConfirm,
}: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const open = asking || pending || done;
  const busy = pending || done;
  const stage = done ? "done" : pending ? "pending" : "idle";

  const close = (refocus: boolean) => {
    setAsking(false);
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (!asking || busy) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setAsking(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [asking, busy]);

  return (
    <div
      ref={root}
      data-inline-confirm
      data-asking={open || undefined}
      className="grid shrink-0 items-center justify-items-end *:[grid-area:1/1]"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !asking || busy) return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (asking && !busy && next && !root.current?.contains(next)) {
          setAsking(false);
        }
      }}
    >
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="ghost"
        data-inline-confirm-trigger
        aria-label={name}
        aria-expanded={open}
        disabled={disabled}
        inert={open || undefined}
        className={cn(
          "text-muted-foreground transition-[opacity,color,background-color] hover:text-destructive",
          open && "pointer-events-none opacity-0",
        )}
        onClick={() => setAsking(true)}
      >
        <BinIcon />
        {label}
      </Button>
      <div
        role="group"
        aria-label={question}
        inert={!open || undefined}
        className={cn(
          "flex items-center gap-1.5 transition-opacity duration-200 ease-enter",
          !open && "pointer-events-none opacity-0",
        )}
      >
        <Button
          ref={keep}
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          className={cn(
            "transition-[translate,opacity,background-color,color] duration-200 ease-enter motion-reduce:transition-none",
            !open && "translate-x-2",
          )}
          onClick={() => close(true)}
        >
          Keep
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          aria-busy={pending || undefined}
          disabled={busy}
          // Keep focus here while the request runs, and after it fails.
          focusableWhenDisabled
          onClick={onConfirm}
        >
          {/* Every label shares one cell, so the button keeps the width of
              its widest one (the Steady Box Rule). */}
          <span className="grid *:col-start-1 *:row-start-1 *:inline-flex *:items-center *:justify-center *:gap-1.5">
            <span className={cn(stage !== "idle" && "invisible")}>
              {confirmLabel}
            </span>
            <span className={cn(stage !== "pending" && "invisible")}>
              <LoaderCircle
                className="size-3.5 motion-safe:animate-spin"
                aria-hidden="true"
              />
              {pendingLabel}
            </span>
            <span className={cn(stage !== "done" && "invisible")}>
              <Check
                className={cn("size-3.5", done && "draw-check")}
                aria-hidden="true"
              />
              {doneLabel}
            </span>
          </span>
        </Button>
      </div>
    </div>
  );
}
