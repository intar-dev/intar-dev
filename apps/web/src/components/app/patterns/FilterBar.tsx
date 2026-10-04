import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsPhone, useShortViewport } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { RollingNumber } from "./RollingNumber";

export function FilterChip({
  active,
  onClick,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "min-h-9 cursor-pointer rounded-lg border px-3 text-xs font-semibold capitalize transition-[color,background-color,border-color,transform] duration-(--duration-fast) ease-standard active:translate-y-(--move-press) active:scale-(--scale-press) active:duration-(--duration-instant)",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A chip cluster named for what it filters, so "Enabled" has context. */
export function FilterChipGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  );
}

// Search + chip groups on one row, with a clear affordance once anything is
// active. Chip groups are passed as children (`FilterChip` clusters). Give it
// `shown`, `total` and `noun` and it also owns the polite count line under the
// bar ("Showing 4 of 20 runs."), always mounted so the first change is read.
// `collapseOnPhone` (with `activeCount`) keeps only the search and a "Filters"
// button on a phone; the chip groups open in a sheet (a bottom sheet, or a
// side one on a landscape phone) and sit inline from bp-md up.
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  searchLabel = "Search",
  filtersActive = false,
  stackSearchOnMobile = false,
  collapseOnPhone = false,
  activeCount = 0,
  onClear,
  searchRef,
  shown,
  total,
  noun,
  note,
  children,
  end,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  searchLabel?: string;
  filtersActive?: boolean;
  stackSearchOnMobile?: boolean;
  /** On a phone, the children move behind a "Filters" button and sheet. */
  collapseOnPhone?: boolean;
  /** How many filters are set, shown on the "Filters" button. */
  activeCount?: number;
  onClear?: (() => void) | undefined;
  /** The search field, so a page can return focus to it after clearing. */
  searchRef?: Ref<HTMLInputElement>;
  shown?: number;
  total?: number;
  noun?: string;
  /** Appended to the count line, e.g. "Load older runs to search more." */
  note?: ReactNode;
  children?: ReactNode;
  end?: ReactNode;
}) {
  const ownRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const phone = useIsPhone();
  const short = useShortViewport();
  const [sheetOpen, setSheetOpen] = useState(false);
  const collapsed = collapseOnPhone && phone;
  // A sheet left open must not reopen when a phone-width window returns.
  useEffect(() => {
    if (!collapsed) setSheetOpen(false);
  }, [collapsed]);
  const setRef = (node: HTMLInputElement | null) => {
    ownRef.current = node;
    if (typeof searchRef === "function") searchRef(node);
    else if (searchRef) searchRef.current = node;
  };
  const bar = (
    <div className="flex flex-wrap items-center gap-3">
      <div
        className={cn(
          "relative min-w-56 flex-1 sm:max-w-xs",
          stackSearchOnMobile && "max-sm:w-full max-sm:flex-none",
        )}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={setRef}
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-9 max-w-none pl-9 text-sm [&::-webkit-search-cancel-button]:appearance-none"
          aria-label={searchLabel}
        />
      </div>
      {collapsed ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={
                  activeCount ? `Filters, ${activeCount} active` : "Filters"
                }
              />
            }
          >
            <ListFilter aria-hidden="true" />
            Filters{activeCount ? ` · ${activeCount}` : ""}
          </SheetTrigger>
          <SheetContent
            side={short ? "right" : "bottom"}
            handleLabel="Close filters"
            className="data-[side=bottom]:overflow-y-auto data-[side=right]:gap-0"
            data-filter-sheet
          >
            <SheetHeader className="pr-14">
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription aria-live="polite" aria-atomic="true">
                {shown !== undefined && total !== undefined
                  ? `Showing ${shown} of ${total} ${noun ?? "items"}.`
                  : "Narrow what the page shows."}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col items-start gap-4 overflow-y-auto px-4 pb-4 in-data-[side=bottom]:pt-4">
              {children}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 pb-2">
              {activeCount && onClear ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onClear();
                    // A page may send focus to its search field, which sits
                    // behind the open sheet; the button unmounts too. Focus
                    // stays inside the sheet, on Done.
                    doneRef.current?.focus();
                  }}
                >
                  <X className="size-3.5" />
                  Clear filters
                </Button>
              ) : null}
              <SheetClose
                render={<Button ref={doneRef} type="button" size="sm" />}
              >
                Done
              </SheetClose>
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        children
      )}
      {end ? <div className="ml-auto flex items-center gap-2">{end}</div> : null}
      {filtersActive && onClear ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onClear();
            // The button unmounts once nothing is active, so focus goes back
            // to the search field instead of falling to the page.
            ownRef.current?.focus();
          }}
        >
          <X className="size-3.5" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
  if (shown === undefined || total === undefined) return bar;
  return (
    <div className="space-y-2">
      {bar}
      <p className="text-metadata" aria-live="polite" aria-atomic="true">
        Showing <RollingNumber value={shown} /> of {total} {noun ?? "items"}.
        {note ? <> {note}</> : null}
      </p>
    </div>
  );
}
