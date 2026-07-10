import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ScenarioDifficulty = "easy" | "medium" | "hard";

export const SCENARIO_DIFFICULTIES: readonly ScenarioDifficulty[] = [
  "easy",
  "medium",
  "hard",
];

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
        "inline-flex min-h-6 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        variant === "default" && "border bg-muted text-muted-foreground",
        variant === "outline" && "border text-muted-foreground",
        variant === "accent" && "border-brand-border bg-brand-subtle text-brand-text",
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
  // A challenge scale following the brand gradient: gold → orange → red.
  easy: "border border-success-border bg-success-subtle text-success",
  medium: "border border-warning-border bg-warning-subtle text-warning",
  hard: "border border-destructive-border bg-destructive-subtle text-destructive",
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
        "inline-flex h-6 items-center rounded-md px-2 text-xs font-semibold",
        DIFFICULTY_STYLES[difficulty],
        className,
      )}
    >
      {DIFFICULTY_LABELS[difficulty]}
    </span>
  );
}
