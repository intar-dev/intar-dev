import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

/**
 * A sheet you can drag. Where Sheet is a fixed panel, Drawer follows the
 * finger and settles on snap points (peek, full), or swipes away to the
 * side. Pass `snapPoints` (fractions of the viewport height) and a
 * controlled `snapPoint` to the root for detents; `DrawerContent` reads the
 * snap offset Base UI sets, so the popup rests where the detent says.
 *
 * It moves `move-sheet` and fades on open and close, and settles between
 * detents over `duration-slow`. Under reduced motion the distances are zero,
 * so only the fade remains.
 */
function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 transition-opacity duration-(--duration-moderate) ease-standard data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/55",
        className,
      )}
      {...props}
    />
  )
}

const SIDE_CLASS = {
  bottom:
    "items-end justify-center",
  right: "items-stretch justify-end",
} as const

const POPUP_SIDE_CLASS = {
  bottom:
    "w-full rounded-t-2xl border border-b-0 [transform:translateY(calc(var(--drawer-snap-point-offset,0px)_+_var(--drawer-swipe-movement-y,0px)))] data-starting-style:[transform:translateY(calc(var(--drawer-snap-point-offset,0px)_+_var(--move-sheet)))] data-ending-style:[transform:translateY(calc(var(--drawer-snap-point-offset,0px)_+_var(--move-sheet)))]",
  right:
    "h-full w-[46%] rounded-l-2xl border border-r-0 [transform:translateX(var(--drawer-swipe-movement-x,0px))] data-starting-style:[transform:translateX(var(--move-sheet))] data-ending-style:[transform:translateX(var(--move-sheet))]",
} as const

function DrawerContent({
  className,
  children,
  side = "bottom",
  showOverlay = true,
  overlayClassName,
  ...props
}: DrawerPrimitive.Popup.Props & {
  side?: "bottom" | "right"
  showOverlay?: boolean
  overlayClassName?: string | undefined
}) {
  return (
    <DrawerPrimitive.Portal>
      {showOverlay ? <DrawerOverlay className={overlayClassName} /> : null}
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className={cn("fixed inset-0 z-50 flex", SIDE_CLASS[side])}
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          data-side={side}
          className={cn(
            "relative flex min-h-0 flex-col bg-popover bg-clip-padding text-sm text-popover-foreground shadow-(--shadow-overlay) outline-none transition-[transform,opacity] duration-(--duration-slow) ease-enter data-swiping:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0",
            POPUP_SIDE_CLASS[side],
            className,
          )}
          {...props}
        >
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  )
}

/** Tap it to toggle the detent; drag it (or anywhere outside the body) to move the sheet. */
function DrawerHandle({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="drawer-handle"
      className={cn(
        "grid h-7 w-full shrink-0 cursor-grab touch-none place-items-center before:h-[0.3125rem] before:w-9 before:rounded-full before:bg-border-strong before:content-['']",
        className,
      )}
      {...props}
    />
  )
}

/** The scrolling body. Swipes that start inside it scroll instead of dragging the sheet. */
function DrawerBody({ className, ...props }: DrawerPrimitive.Content.Props) {
  return (
    <DrawerPrimitive.Content
      data-slot="drawer-body"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-1 p-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHandle,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
}
