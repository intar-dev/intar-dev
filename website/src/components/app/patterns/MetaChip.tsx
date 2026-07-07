import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ScenarioDifficulty = "easy" | "medium" | "hard";

interface MetaChipProps {
  icon?: ReactNode;
  children: ReactNode;
  variant?: "default" | "outline" | "accent";
  className?: string;
}

// The one small-metadata pill: icon + label, used for duration, machine
// counts, lease countdowns, difficulty, and similar chip rows.
export function MetaChip({
  icon,
  children,
  variant = "default",
  className,
}: MetaChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        variant === "default" && "bg-muted text-muted-foreground",
        variant === "outline" && "border text-muted-foreground",
        variant === "accent" && "bg-primary/10 text-primary",
        "[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const DIFFICULTY_STYLES: Record<ScenarioDifficulty, string> = {
  // A challenge scale, not a threat scale: teal → amber → strong orange.
  easy: "bg-secondary text-secondary-foreground",
  medium: "bg-warning/20 text-warning-foreground dark:text-warning",
  hard: "bg-primary/15 text-primary",
};

const DIFFICULTY_LABELS: Record<ScenarioDifficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export function DifficultyChip({
  difficulty,
  className,
}: {
  difficulty: ScenarioDifficulty;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold",
        DIFFICULTY_STYLES[difficulty],
        className,
      )}
    >
      {DIFFICULTY_LABELS[difficulty]}
    </span>
  );
}
