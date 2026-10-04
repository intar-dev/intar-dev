import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { digitCells, rollDirection, type DigitCell } from "./rolling-number";

interface Roll {
  cells: DigitCell[];
  direction: 1 | -1;
  /** Changes on every roll so a quick second change restarts the animation. */
  id: number;
}

/**
 * A count whose changed digits roll into place: up as it grows, down as it
 * shrinks. Nothing moves on first render (the Moment Rule). The digit rolling
 * out is generated content (`data-prev`), so text and assistive technology
 * only ever read the new number.
 */
export function RollingNumber({
  value,
  format = String,
  className,
}: {
  value: number;
  /** Renders the number, e.g. with thousands separators. */
  format?: (value: number) => string;
  className?: string;
}) {
  const text = format(value);
  const previous = useRef({ text, value });
  const [roll, setRoll] = useState<Roll | null>(null);

  useLayoutEffect(() => {
    if (previous.current.text === text) return;
    const from = previous.current;
    previous.current = { text, value };
    setRoll((current) => ({
      cells: digitCells(from.text, text),
      direction: rollDirection(from.value, value),
      id: (current?.id ?? 0) + 1,
    }));
  }, [text, value]);

  // Settle back to plain text once the roll has played (300ms plus the
  // stagger). A timer, not animationend, so a skipped animation never leaves
  // the old digit stacked on the new one.
  useEffect(() => {
    if (!roll) return;
    const timer = window.setTimeout(() => setRoll(null), 700);
    return () => window.clearTimeout(timer);
  }, [roll]);

  if (!roll) {
    return <span className={cn("tabular-nums", className)}>{text}</span>;
  }

  return (
    <span
      key={roll.id}
      className={cn("inline-flex tabular-nums", className)}
      style={{ "--digit-dir": roll.direction } as CSSProperties}
    >
      {roll.cells.map((cell, index) =>
        cell.previous === null ? (
          <span key={index}>{cell.char}</span>
        ) : (
          <span
            key={index}
            className="rolling-digit"
            data-prev={cell.previous}
            style={{ "--k": cell.order } as CSSProperties}
          >
            <span data-in>{cell.char}</span>
          </span>
        ),
      )}
    </span>
  );
}
