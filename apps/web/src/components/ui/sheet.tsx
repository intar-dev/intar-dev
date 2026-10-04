import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 duration-(--duration-moderate) ease-standard dark:bg-black/55 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--duration-fast) data-closed:ease-exit",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The grab bar of a bottom sheet. A tap closes it. A drag follows the finger
 * (translateY on the standalone `translate` property); released past 30% of
 * the sheet's height it leaves, otherwise it settles back. Handle-only: the
 * content keeps its own scrolling.
 */
function SheetHandle({ label }: { label: string }) {
  const drag = React.useRef<{
    y: number
    popup: HTMLElement
    moved: boolean
  } | null>(null)
  const swallowClick = React.useRef(false)
  const reduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches

  return (
    <SheetPrimitive.Close
      data-slot="sheet-handle"
      aria-label={label}
      className="grid h-6 w-full shrink-0 cursor-grab touch-none place-items-center before:h-[0.3125rem] before:w-9 before:rounded-full before:bg-border-strong active:cursor-grabbing"
      onClick={(event) => {
        if (swallowClick.current) {
          swallowClick.current = false
          event.preventBaseUIHandler()
        }
      }}
      onPointerDown={(event) => {
        const popup = event.currentTarget.closest<HTMLElement>(
          '[data-slot="sheet-content"]',
        )
        if (!popup) return
        event.currentTarget.setPointerCapture(event.pointerId)
        popup.style.transition = "none"
        swallowClick.current = false
        drag.current = { y: event.clientY, popup, moved: false }
      }}
      onPointerMove={(event) => {
        const d = drag.current
        if (!d) return
        const dy = Math.max(0, event.clientY - d.y)
        if (dy > 4) d.moved = true
        d.popup.style.translate = `0 ${dy}px`
      }}
      onPointerUp={(event) => {
        const d = drag.current
        drag.current = null
        if (!d) return
        const dy = Math.max(0, event.clientY - d.y)
        const target = event.currentTarget
        if (!d.moved) {
          d.popup.style.transition = ""
          d.popup.style.translate = ""
          return
        }
        swallowClick.current = true
        if (dy > d.popup.offsetHeight * 0.3) {
          // Leave toward the edge, then let Base UI close it.
          d.popup.style.transition = reduced()
            ? "none"
            : "translate var(--duration-fast) var(--ease-exit)"
          d.popup.style.translate = "0 100%"
          window.setTimeout(
            () => {
              swallowClick.current = false
              target.click()
            },
            reduced() ? 0 : 150,
          )
        } else {
          d.popup.style.transition = reduced()
            ? "none"
            : "translate var(--duration-slow) var(--ease-enter)"
          d.popup.style.translate = "0 0"
        }
      }}
      onPointerCancel={() => {
        const d = drag.current
        drag.current = null
        if (!d) return
        d.popup.style.transition = ""
        d.popup.style.translate = ""
      }}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  showOverlay = true,
  handle = true,
  handleLabel = "Close sheet",
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "right" | "bottom" | "left"
  showCloseButton?: boolean
  showOverlay?: boolean
  /** Bottom sheets only: the drag handle, which also closes on a tap. */
  handle?: boolean
  handleLabel?: string
}) {
  return (
    <SheetPortal>
      {showOverlay ? <SheetOverlay /> : null}
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          // Keyframe-driven (as the dialog is) so reduced motion keeps the fade
          // and drops only the slide: --move-sheet is 0px there. The drag
          // offset lives on the standalone `translate` property, so it
          // composes with the animation's `transform`.
          "group/sheet fixed z-50 flex flex-col gap-3 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-(--shadow-overlay) duration-(--duration-slow) ease-enter data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--duration-fast) data-closed:ease-exit data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:max-h-[min(82dvh,48rem)] data-[side=bottom]:gap-0 data-[side=bottom]:overflow-hidden data-[side=bottom]:rounded-t-2xl data-[side=bottom]:border-x data-[side=bottom]:border-t data-[side=bottom]:pr-[env(safe-area-inset-right)] data-[side=bottom]:pb-[max(1rem,env(safe-area-inset-bottom))] data-[side=bottom]:pl-[env(safe-area-inset-left)] data-[side=bottom]:data-open:slide-in-from-bottom-[length:var(--move-sheet)] data-[side=bottom]:data-closed:slide-out-to-bottom-[length:var(--move-sheet)] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-72 data-[side=left]:max-w-full data-[side=left]:border-r data-[side=left]:pt-[env(safe-area-inset-top)] data-[side=left]:pb-[env(safe-area-inset-bottom)] data-[side=left]:pl-[env(safe-area-inset-left)] data-[side=left]:data-open:slide-in-from-left-[length:var(--move-sheet)] data-[side=left]:data-closed:slide-out-to-left-[length:var(--move-sheet)] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:pt-[env(safe-area-inset-top)] data-[side=right]:pr-[env(safe-area-inset-right)] data-[side=right]:pb-[env(safe-area-inset-bottom)] data-[side=right]:data-open:slide-in-from-right-[length:var(--move-sheet)] data-[side=right]:data-closed:slide-out-to-right-[length:var(--move-sheet)] data-[side=right]:sm:max-w-sm",
          className,
        )}
        {...props}
      >
        {side === "bottom" && handle ? (
          <SheetHandle label={handleLabel} />
        ) : null}
        {/* Before the content, so a keyboard open lands on Close rather than
            on the first link inside, and Close is the first tab stop. It is
            absolutely placed, so nothing moves. */}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3 group-data-[side=left]/sheet:top-[calc(0.75rem+env(safe-area-inset-top))] group-data-[side=right]/sheet:top-[calc(0.75rem+env(safe-area-inset-top))] group-data-[side=right]/sheet:right-[calc(0.75rem+env(safe-area-inset-right))]"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
        {children}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 p-4 in-data-[side=bottom]:border-b", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-support text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
}
