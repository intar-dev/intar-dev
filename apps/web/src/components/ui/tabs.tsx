import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className,
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list relative inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:min-h-10 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        // The line strip is its own scroller: it fades at the edge where more
        // tabs wait (scroll-fade) and has no padding but the underline's 2px.
        line: "scroll-fade max-w-full gap-1 overflow-x-auto bg-transparent p-0 pb-0.5 group-data-vertical/tabs:overflow-visible",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

/** Sets --fade-start/--fade-end on a scrolling strip, and brings the open tab
 *  into view once on mount (a later tab can start past the edge). */
function useScrollFade(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  React.useEffect(() => {
    const list = ref.current
    if (!enabled || !list) return
    const update = () => {
      const max = list.scrollWidth - list.clientWidth
      list.style.setProperty("--fade-start", list.scrollLeft > 2 ? "2rem" : "0px")
      list.style.setProperty("--fade-end", list.scrollLeft < max - 2 ? "2rem" : "0px")
    }
    const active = list.querySelector<HTMLElement>("[data-active]")
    if (active && active.offsetLeft + active.offsetWidth > list.clientWidth) {
      list.scrollLeft = Math.max(0, active.offsetLeft - 32)
    }
    update()
    list.addEventListener("scroll", update, { passive: true })
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    observer?.observe(list)
    return () => {
      list.removeEventListener("scroll", update)
      observer?.disconnect()
    }
  }, [ref, enabled])
}

function TabsList({
  className,
  variant = "default",
  children,
  activateOnFocus = true,
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  useScrollFade(listRef, variant === "line")
  return (
    <TabsPrimitive.List
      ref={listRef}
      data-slot="tabs-list"
      data-variant={variant}
      activateOnFocus={activateOnFocus}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {children}
      {/* One indicator glides between tabs instead of each tab repainting.
          Pinned at 0 and moved by transform, so only transform and size
          change during the glide. */}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className={cn(
          "pointer-events-none absolute z-0 transition-[translate,width,height] duration-(--duration-slow) ease-enter motion-reduce:transition-none",
          variant === "line"
            ? "bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-primary group-data-vertical/tabs:top-0 group-data-vertical/tabs:right-0 group-data-vertical/tabs:left-auto group-data-vertical/tabs:h-(--active-tab-height) group-data-vertical/tabs:w-0.5 group-data-vertical/tabs:translate-x-0 group-data-vertical/tabs:translate-y-(--active-tab-top)"
            : "top-[3px] bottom-[3px] left-0 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md bg-background shadow-(--shadow-control) dark:bg-accent",
        )}
      />
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative z-10 inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color] duration-(--duration-fast) ease-standard group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-foreground motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        // The ring is the global :focus-visible one, so the open panel (a tab
        // stop) shows where focus is. The new panel enters from the side the
        // reader moved toward; the old one leaves in the same frame. The first
        // mount has direction "none", so it never animates.
        "flex-1 rounded-lg data-ending-style:hidden data-[activation-direction=left]:animate-[intar-tab-panel_var(--duration-moderate)_var(--ease-enter)] data-[activation-direction=left]:[--tab-dir:-1] data-[activation-direction=right]:animate-[intar-tab-panel_var(--duration-moderate)_var(--ease-enter)] data-[activation-direction=right]:[--tab-dir:1]",
        className,
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
