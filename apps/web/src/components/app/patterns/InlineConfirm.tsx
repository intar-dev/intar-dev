import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { BinIcon } from "@/components/ui/bin-icon";
import { cn } from "@/lib/utils";
import { AsyncLabel } from "./AsyncLabel";

export { BinIcon };

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
  /** The question closed without confirming (Keep, Escape, click or Tab away). */
  onCancel?: () => void;
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
  onCancel,
}: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const open = asking || pending || done;
  const busy = pending || done;
  const stage = done ? "done" : pending ? "pending" : "idle";

  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  // Clicking or tabbing anywhere in the same list row leaves the question
  // open; only the outside of the row backs out.
  const scope = () => root.current?.closest("li") ?? root.current;

  const close = (refocus: boolean) => {
    setAsking(false);
    cancel.current?.();
    if (refocus) requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (asking) keep.current?.focus();
  }, [asking]);

  useEffect(() => {
    if (!asking || busy) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!scope()?.contains(event.target as Node)) {
        setAsking(false);
        cancel.current?.();
      }
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
        if (asking && !busy && next && !scope()?.contains(next)) {
          setAsking(false);
          onCancel?.();
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
          "text-muted-foreground transition-[opacity,color,background-color] duration-(--duration-moderate) ease-enter hover:text-destructive",
          open && "pointer-events-none opacity-0 duration-(--duration-fast) ease-exit",
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
          "flex items-center gap-1.5 transition-opacity duration-(--duration-moderate) ease-enter",
          !open &&
            "pointer-events-none opacity-0 duration-(--duration-fast) ease-exit",
        )}
      >
        <Button
          ref={keep}
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          className={cn(
            "transition-[translate,opacity,background-color,color] duration-(--duration-moderate) ease-enter",
            !open &&
              "translate-x-(--move-overlay) duration-(--duration-fast) ease-exit",
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
          <AsyncLabel
            state={stage}
            idle={confirmLabel}
            pending={pendingLabel}
            done={doneLabel}
          />
        </Button>
      </div>
    </div>
  );
}
