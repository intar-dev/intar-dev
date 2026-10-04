import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ScenarioDifficulty = "easy" | "medium" | "hard";

export const SCENARIO_DIFFICULTIES: readonly ScenarioDifficulty[] = [
  "easy",
  "medium",
  "hard",
];

interface MetaLineProps {
  items: Array<ReactNode | null | undefined | false>;
  className?: string;
  /** A span inside links and other phrasing content; a paragraph otherwise. */
  as?: "p" | "span";
  /** The smaller size for dense lists. */
  dense?: boolean;
}

// The one metadata treatment: a single quiet line of interpunct-separated
// facts (`3 lectures · ~45 min · 1 VM`) in tabular sans. Mono is reserved for
// commands, IDs, logs, and timers. Chips remain only where they are
// interactive (filters).
export function MetaLine({
  items,
  className,
  as: Tag = "p",
  dense = false,
}: MetaLineProps) {
  const visible = items.filter(
    (item): item is ReactNode =>
      item !== null &&
      item !== undefined &&
      item !== false &&
      !(typeof item === "string" && !item.trim()),
  );
  const ref = useRef<HTMLParagraphElement>(null);
  const count = visible.length;
  // Each separator leads the item after it, so it never ends a line. The item
  // that lands first on a wrapped line then hides its dot, and its whole line
  // steps back over the dot's space (a translate, not a layout change, so
  // hiding the dot never lets an item climb back onto the line above): no
  // line starts or ends with a dot.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const mark = () => {
      let previous = Number.NEGATIVE_INFINITY;
      let shift = 0;
      (Array.from(root.children) as HTMLElement[]).forEach((item, index) => {
        // Items on one line share a centre; the next line sits a line lower.
        // Rects, not offsets: a translated item becomes its children's
        // offset parent.
        const box = item.getBoundingClientRect();
        const centre = box.top + box.height / 2;
        const lineStart = index > 0 && centre - previous > 4;
        if (index === 0) shift = 0;
        else if (lineStart) {
          const text = item.lastElementChild as HTMLElement;
          shift = text.getBoundingClientRect().left - box.left;
        }
        item.toggleAttribute("data-line-start", lineStart);
        item.toggleAttribute("data-shifted", shift > 0);
        item.style.setProperty("--shift", `${shift}px`);
        previous = centre;
      });
    };
    mark();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(mark);
    observer.observe(root);
    Array.from(root.children).forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [count]);
  if (count === 0) return null;
  return (
    <Tag
      ref={ref}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-faint-foreground tabular-nums",
        dense ? "text-xs leading-4" : "text-metadata leading-5",
        className,
      )}
    >
      {visible.map((item, index) => (
        <span
          key={index}
          className="group/sep inline-flex min-w-0 items-start gap-2 data-[shifted]:translate-x-[calc(var(--shift)*-1)]"
        >
          {index > 0 ? (
            <span
              aria-hidden="true"
              className="text-faint-foreground/55 group-data-[line-start]/sep:invisible"
            >
              ·
            </span>
          ) : null}
          <span className="min-w-0 [overflow-wrap:anywhere]">{item}</span>
        </span>
      ))}
    </Tag>
  );
}

const DIFFICULTY_DOTS: Record<ScenarioDifficulty, string> = {
  // The challenge scale keeps the brand gradient: gold → orange → red.
  easy: "bg-success",
  medium: "bg-warning",
  hard: "bg-destructive",
};

export const DIFFICULTY_LABELS: Record<ScenarioDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function MetaDifficulty({
  difficulty,
  className,
}: {
  difficulty: ScenarioDifficulty;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", DIFFICULTY_DOTS[difficulty])}
      />
      {DIFFICULTY_LABELS[difficulty]}
    </span>
  );
}
