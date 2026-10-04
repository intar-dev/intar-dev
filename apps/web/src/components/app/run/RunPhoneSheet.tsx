import type { ReactNode } from "react";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHandle,
} from "@/components/ui/drawer";
import type { RunSheetDetent } from "./run-viewport";

// sheet-peek and sheet-full (viewports.md), as fractions of the viewport.
const PEEK = 0.42;
const FULL = 0.88;

/**
 * The run panel on a phone: a bottom sheet with two detents, peek (the
 * checks) and full, that you drag between or tap the handle to toggle. On a
 * phone in landscape it is a side sheet from the right instead (46% wide, no
 * handle, no detents). Reading and typing take turns, so the caller lowers
 * the keyboard when this opens.
 */
export function RunPhoneSheet({
  open,
  onOpenChange,
  detent,
  onDetentChange,
  side,
  header,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detent: RunSheetDetent;
  onDetentChange: (detent: RunSheetDetent) => void;
  side: "bottom" | "right";
  /** Screen-reader title and description. */
  header: ReactNode;
  children: ReactNode;
}) {
  const bottom = side === "bottom";
  return (
    <Drawer
      key={side}
      open={open}
      onOpenChange={onOpenChange}
      swipeDirection={bottom ? "down" : "right"}
      {...(bottom
        ? {
            snapPoints: [PEEK, FULL],
            snapPoint: detent === "full" ? FULL : PEEK,
            onSnapPointChange: (point: number | string | null) =>
              onDetentChange(point === FULL ? "full" : "peek"),
          }
        : {})}
    >
      <DrawerContent
        side={side}
        finalFocus={false}
        data-run-learning-mobile-sheet
        data-detent={bottom ? detent : undefined}
        // The scrim shows only at full; at peek the terminal stays readable.
        overlayClassName={bottom && detent === "peek" ? "opacity-0!" : undefined}
        className={
          bottom
            ? "h-(--sheet-full) max-h-(--sheet-full) gap-0 overflow-hidden bg-card pb-[max(1rem,env(safe-area-inset-bottom))]"
            : "gap-0 overflow-hidden bg-card pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        }
      >
        {bottom ? (
          <DrawerHandle
            aria-label={detent === "full" ? "Shrink panel" : "Expand panel"}
            onClick={() => onDetentChange(detent === "full" ? "peek" : "full")}
          />
        ) : null}
        {header}
        <DrawerBody
          data-run-learning-mobile-scroll
          // At peek the popup is as tall as full and rests lower, so its foot
          // is off screen; the gap between the detents as bottom padding lets
          // the last lines scroll into view instead of waiting behind the edge.
          className={`scroll-py-4 bg-card px-4 pt-2 focus-visible:-outline-offset-2 ${bottom && detent === "peek" ? "pb-[calc(var(--sheet-full)-var(--sheet-peek))]" : ""}`}
          role="region"
          aria-label="Checks, lecture and hints content"
          tabIndex={0}
        >
          {children}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
