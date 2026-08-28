import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// The one disclosure idiom for console rails and expandable list rows: a
// full-width trigger line (leading · title · meta · chevron) over a panel
// that unmounts when closed, so lazy children stay lazy.
export function DisclosureRow({
  leading,
  title,
  meta,
  density = "comfortable",
  open,
  defaultOpen,
  onOpenChange,
  contentClassName,
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  density?: "comfortable" | "compact";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center text-left",
          density === "compact"
            ? "min-h-9 gap-2 py-1"
            : "min-h-10 gap-3 py-2",
        )}
      >
        {leading}
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={typeof title === "string" ? title : undefined}
        >
          {title}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        ) : null}
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          density === "compact" ? "pt-1 pb-2" : "pt-1 pb-3",
          // Align panel content under the title when a leading icon is set
          // (size-4 icon + the density-specific trigger gap).
          leading
            ? density === "compact"
              ? "pl-6"
              : "pl-7"
            : undefined,
          contentClassName,
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
