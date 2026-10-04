import { useRef, type ReactNode, type Ref } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  searchLabel = "Search",
  filtersActive = false,
  stackSearchOnMobile = false,
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
          className="h-9 pl-9 text-sm [&::-webkit-search-cancel-button]:appearance-none"
          aria-label={searchLabel}
        />
      </div>
      {children}
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
