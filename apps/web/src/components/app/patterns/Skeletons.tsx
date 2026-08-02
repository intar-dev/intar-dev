import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

// Layout-matched loading placeholders. Show on `query.isPending` only; render
// empty states on settled queries, and never re-skeleton on background
// refetches.

function LoadingStatus({ children }: { children: React.ReactNode }) {
  return (
    <div role="status">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}

export function ListSkeleton({
  rows = 4,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <LoadingStatus>
      <div className={cn("divide-y border-y", className)}>
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-4 py-4"
          >
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-4 w-56 max-w-full" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-9 w-24 shrink-0" />
          </div>
        ))}
      </div>
    </LoadingStatus>
  );
}

export function TableSkeleton({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <LoadingStatus>
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
  className,
}: {
  cards?: number;
  cardClassName?: string;
  className?: string;
}) {
  return (
    <LoadingStatus>
      <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
        {Array.from({ length: cards }, (_, index) => (
          <Skeleton key={index} className={cn("rounded-xl", cardClassName)} />
        ))}
      </div>
    </LoadingStatus>
  );
}
