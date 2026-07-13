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
  open,
  defaultOpen,
  onOpenChange,
  contentClassName,
  children,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-3 py-2 text-left">
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
          "pt-1 pb-3",
          // Align panel content under the title when a leading icon is set
          // (size-4 icon + gap-3).
          leading ? "pl-7" : undefined,
          contentClassName,
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
