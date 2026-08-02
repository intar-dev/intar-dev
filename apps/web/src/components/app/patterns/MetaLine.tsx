import { Fragment, type ReactNode } from "react";
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
}

// The one metadata treatment: a single muted mono line of interpunct-separated
// facts (`ubuntu-24.04 · ~45 min · 3 VMs`). Replaces chip rows; chips remain
// only where they are interactive (filters).
export function MetaLine({ items, className }: MetaLineProps) {
  const visible = items.filter(
    (item): item is ReactNode => item !== null && item !== undefined && item !== false,
  );
  if (visible.length === 0) return null;
  return (
    <p
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground",
        className,
      )}
    >
      {visible.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {item}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

const DIFFICULTY_DOTS: Record<ScenarioDifficulty, string> = {
  // The challenge scale keeps the brand gradient: gold → orange → red.
  easy: "bg-success",
  medium: "bg-warning",
  hard: "bg-destructive",
};

const DIFFICULTY_LABELS: Record<ScenarioDifficulty, string> = {
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
        className={cn("size-2 rounded-full", DIFFICULTY_DOTS[difficulty])}
      />
      {DIFFICULTY_LABELS[difficulty]}
    </span>
  );
}
