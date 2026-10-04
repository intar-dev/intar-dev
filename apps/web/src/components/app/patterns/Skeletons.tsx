import { useState } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// Layout-matched loading placeholders. Show on `query.isPending` only; render
// empty states on settled queries, and never re-skeleton on background
// refetches.

/**
 * True only when this mount started on its skeleton, so data that arrives
 * after one rises into place and data that was cached on mount stays still
 * (the Moment Rule). Put `data-arrive={arrived || undefined}` on the list
 * container holding the rows; keep the skeleton's status region outside it.
 */
export function useArrived(pending: boolean): boolean {
  const [arrived] = useState(pending);
  return arrived;
}

function LoadingStatus({
  label = "Loading…",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** The row's frame: the same card, padding, breakpoint and action size as RunListItem. */
export function ListSkeleton({
  rows = 4,
  avatar = false,
  action = true,
  label,
  className,
}: {
  rows?: number;
  /** A 32px round slot before the text, for lists of people. */
  avatar?: boolean;
  /** False for rows without a trailing action. */
  action?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <LoadingStatus {...(label ? { label } : null)}>
      <div
        className={cn(
          "divide-y overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)]",
          className,
        )}
      >
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {avatar ? (
                <Skeleton className="size-8 shrink-0 rounded-full" />
              ) : null}
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-56 max-w-full" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            {action ? (
              <Skeleton className="h-(--control-compact) w-24 shrink-0 max-sm:w-full pointer-coarse:h-11" />
            ) : null}
          </div>
        ))}
      </div>
    </LoadingStatus>
  );
}

export function TableSkeleton({
  rows = 5,
  label,
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <LoadingStatus {...(label ? { label } : null)}>
      <div className={cn("space-y-2", className)}>
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </LoadingStatus>
  );
}

export function CardGridSkeleton({
  cards = 4,
  cardClassName = "h-40",
  label,
  className,
}: {
  cards?: number;
  cardClassName?: string;
  label?: string;
  className?: string;
}) {
  return (
    <LoadingStatus {...(label ? { label } : null)}>
      <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
        {Array.from({ length: cards }, (_, index) => (
          <Skeleton key={index} className={cn("rounded-xl", cardClassName)} />
        ))}
      </div>
    </LoadingStatus>
  );
}
