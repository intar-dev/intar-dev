import { useState, type ReactNode } from "react";
import { Activity, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function RunStatusDock({
  label,
  description,
  status,
  children,
}: {
  label: string;
  description?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 lg:hidden">
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-14 w-full justify-start gap-3 border-terminal-border bg-terminal-surface px-4 py-2.5 text-terminal-foreground shadow-lg"
            />
          }
        >
          <Activity className="size-4 text-terminal-brand" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-semibold">{label}</span>
            {status ? (
              <span className="block truncate text-xs text-terminal-muted">
                {status}
              </span>
            ) : null}
          </span>
          <ChevronUp className="size-4" />
        </SheetTrigger>
      </div>
      <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto p-0">
        <SheetHeader className="border-b px-4 py-4 text-left">
          <SheetTitle>{label}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
