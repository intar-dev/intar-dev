import type { ComponentProps, ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * A form or tool beside the page: a full-height sheet from the right with its
 * own header and close, a scrolling body and an optional footer. Dialogs are
 * kept for confirmations; anything that holds a form or a tool opens here.
 *
 * `wide` is for tools that need room (an SSH setup): the full width on a
 * phone, up to 42rem from bp-sm. The default is the DS sheet, 75% wide and at
 * most 24rem.
 */
export function SideSheet({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  wide = false,
  initialFocus,
  className,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  initialFocus?: ComponentProps<typeof SheetContent>["initialFocus"];
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <Sheet open={open} onOpenChange={(next) => onOpenChange(next)}>
      <SheetContent
        side="right"
        initialFocus={initialFocus}
        className={cn(
          "gap-0 overflow-hidden data-[side=right]:rounded-l-2xl",
          wide &&
            "max-sm:data-[side=right]:w-full max-sm:data-[side=right]:rounded-none data-[side=right]:sm:max-w-2xl",
          className,
        )}
        {...rest}
      >
        <SheetHeader className="border-b pr-14">
          <SheetTitle className="text-balance [overflow-wrap:anywhere]">
            {title}
          </SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
        {footer ? (
          <div
            data-slot="side-sheet-footer"
            className="flex shrink-0 flex-col-reverse gap-2 border-t bg-canvas/60 px-4 py-3 sm:flex-row sm:justify-end"
          >
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
