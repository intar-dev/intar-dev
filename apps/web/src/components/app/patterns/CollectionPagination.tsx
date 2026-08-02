import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const COLLECTION_PAGE_SIZE = {
  cards: 9,
  list: 8,
  dense: 12,
} as const;

interface PaginationSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface WeightedCollectionUnit<T> {
  item: T;
  weight: number;
}

interface WeightedPaginationSlice<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  start: number;
  end: number;
}

export function paginateCollection<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
): PaginationSlice<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(
    Math.max(1, Math.floor(requestedPage) || 1),
    totalPages,
  );
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems,
    totalPages,
  };
}

/**
 * Packs weighted units without splitting them across pages. A unit that is
 * heavier than the target page size gets a page to itself.
 */
export function paginateWeightedCollection<T>(
  units: readonly WeightedCollectionUnit<T>[],
  requestedPage: number,
  pageSize: number,
): WeightedPaginationSlice<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer");
  }
  for (const unit of units) {
    if (!Number.isInteger(unit.weight) || unit.weight < 1) {
      throw new RangeError("unit weights must be positive integers");
    }
  }

  const pages: Array<Array<WeightedCollectionUnit<T>>> = [];
  let pending: Array<WeightedCollectionUnit<T>> = [];
  let pendingWeight = 0;

  const finishPage = () => {
    if (!pending.length) return;
    pages.push(pending);
    pending = [];
    pendingWeight = 0;
  };

  for (const unit of units) {
    if (pending.length && pendingWeight + unit.weight > pageSize) {
      finishPage();
    }
    pending.push(unit);
    pendingWeight += unit.weight;
    if (pendingWeight >= pageSize) finishPage();
  }
  finishPage();

  const totalItems = units.reduce((total, unit) => total + unit.weight, 0);
  const totalPages = Math.max(1, pages.length);
  const page = Math.min(
    Math.max(1, Math.floor(requestedPage) || 1),
    totalPages,
  );
  const visibleUnits = pages[page - 1] ?? [];
  const precedingItems = pages
    .slice(0, page - 1)
    .flat()
    .reduce((total, unit) => total + unit.weight, 0);
  const visibleItems = visibleUnits.reduce(
    (total, unit) => total + unit.weight,
    0,
  );

  return {
    items: visibleUnits.map((unit) => unit.item),
    page,
    pageSize,
    totalItems,
    totalPages,
    start: visibleItems ? precedingItems + 1 : 0,
    end: precedingItems + visibleItems,
  };
}

export function buildVisiblePageNumbers(
  currentPage: number,
  totalPages: number,
  maximum = 5,
): number[] {
  if (totalPages < 1 || maximum < 1) return [];
  const count = Math.min(totalPages, maximum);
  const half = Math.floor(count / 2);
  const start = Math.max(
    1,
    Math.min(currentPage - half, totalPages - count + 1),
  );
  return Array.from({ length: count }, (_, index) => start + index);
}

export function PaginatedCollection<T>({
  items,
  pageSize,
  itemLabel,
  resetKey,
  paginationClassName,
  children,
}: {
  items: readonly T[];
  pageSize: number;
  itemLabel: string;
  resetKey?: string | number | boolean | null;
  paginationClassName?: string | undefined;
  children: (visibleItems: T[]) => ReactNode;
}) {
  const [pageState, setPageState] = useState(() => ({
    page: 1,
    resetKey,
  }));
  const resetPending = !Object.is(pageState.resetKey, resetKey);
  const requestedPage = resetPending ? 1 : pageState.page;
  const pagination = useMemo(
    () => paginateCollection(items, requestedPage, pageSize),
    [items, pageSize, requestedPage],
  );

  useEffect(() => {
    if (resetPending || pageState.page !== pagination.page) {
      setPageState({ page: pagination.page, resetKey });
    }
  }, [pageState.page, pagination.page, resetKey, resetPending]);

  return (
    <>
      {children(pagination.items)}
      <CollectionPagination
        page={pagination.page}
        pageSize={pagination.pageSize}
        totalItems={pagination.totalItems}
        itemLabel={itemLabel}
        onPageChange={(page) => setPageState({ page, resetKey })}
        className={paginationClassName}
      />
    </>
  );
}

export function PaginatedWeightedCollection<T>({
  units,
  pageSize,
  itemLabel,
  resetKey,
  paginationClassName,
  children,
}: {
  units: readonly WeightedCollectionUnit<T>[];
  pageSize: number;
  itemLabel: string;
  resetKey?: string | number | boolean | null;
  paginationClassName?: string | undefined;
  children: (visibleItems: T[]) => ReactNode;
}) {
  const [pageState, setPageState] = useState(() => ({
    page: 1,
    resetKey,
  }));
  const resetPending = !Object.is(pageState.resetKey, resetKey);
  const requestedPage = resetPending ? 1 : pageState.page;
  const pagination = useMemo(
    () => paginateWeightedCollection(units, requestedPage, pageSize),
    [pageSize, requestedPage, units],
  );

  useEffect(() => {
    if (resetPending || pageState.page !== pagination.page) {
      setPageState({ page: pagination.page, resetKey });
    }
  }, [pageState.page, pagination.page, resetKey, resetPending]);

  return (
    <>
      {children(pagination.items)}
      <CollectionPagination
        page={pagination.page}
        pageSize={pagination.pageSize}
        totalItems={pagination.totalItems}
        totalPages={pagination.totalPages}
        visibleStart={pagination.start}
        visibleEnd={pagination.end}
        itemLabel={itemLabel}
        onPageChange={(page) => setPageState({ page, resetKey })}
        className={paginationClassName}
      />
    </>
  );
}

export function CollectionPagination({
  page,
  pageSize,
  totalItems,
  totalPages: suppliedTotalPages,
  visibleStart,
  visibleEnd,
  itemLabel,
  onPageChange,
  className,
}: {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages?: number | undefined;
  visibleStart?: number | undefined;
  visibleEnd?: number | undefined;
  itemLabel: string;
  onPageChange: (page: number) => void;
  className?: string | undefined;
}) {
  const totalPages =
    suppliedTotalPages ?? Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) return null;

  const start = visibleStart ?? (page - 1) * pageSize + 1;
  const end = visibleEnd ?? Math.min(page * pageSize, totalItems);
  const visiblePages = buildVisiblePageNumbers(page, totalPages);

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      className={cn(
        "mt-6 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p className="text-metadata tabular-nums" aria-live="polite">
        {start}–{end} of {totalItems} {itemLabel}
      </p>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 px-3"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
          <span className="hidden sm:inline">Previous</span>
          <span className="sr-only sm:hidden">Previous page</span>
        </Button>

        <span className="min-w-20 text-center text-sm font-medium tabular-nums sm:hidden">
          Page {page} of {totalPages}
        </span>
        <div className="hidden items-center gap-1 sm:flex">
          {visiblePages.map((pageNumber) => (
            <Button
              key={pageNumber}
              type="button"
              size="icon-sm"
              variant={pageNumber === page ? "secondary" : "ghost"}
              className="min-h-11 min-w-11"
              aria-label={`Page ${pageNumber}`}
              aria-current={pageNumber === page ? "page" : undefined}
              onClick={() => onPageChange(pageNumber)}
            >
              {pageNumber}
            </Button>
          ))}
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 px-3"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <span className="hidden sm:inline">Next</span>
          <span className="sr-only sm:hidden">Next page</span>
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </nav>
  );
}
