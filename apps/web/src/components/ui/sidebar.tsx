import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelLeftIcon } from "lucide-react"

const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365
const SIDEBAR_WIDTH = "16rem"
const SIDEBAR_WIDTH_ICON = "3rem"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

/** The collapsed state is remembered across visits; the app renders client-only. */
function readSavedOpen(): boolean | undefined {
  try {
    const saved = document.cookie.match(
      new RegExp(`(?:^|; )${SIDEBAR_COOKIE_NAME}=(true|false)`),
    )?.[1]
    return saved === undefined ? undefined : saved === "true"
  } catch {
    return undefined
  }
}

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  keyboardShortcutEnabled = true,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  keyboardShortcutEnabled?: boolean
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(() => readSavedOpen() ?? defaultOpen)

  // Crossing into the desktop layout closes the drawer, so rotating back
  // doesn't show a drawer nobody asked for.
  React.useEffect(() => {
    if (!isMobile) setOpenMobile(false)
  }, [isMobile])
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // This sets the cookie to keep the sidebar state.
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`
    },
    [setOpenProp, open]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    if (!keyboardShortcutEnabled) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [keyboardShortcutEnabled, toggleSidebar])

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-dvh w-full has-data-[variant=inset]:bg-sidebar",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          dir={dir}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          // The sheet's left side already gives w-72 (18rem) and the
          // safe-area padding.
          className="bg-sidebar text-sidebar-foreground"
          side={side}
          // Any destination closes the drawer, including the page you are on
          // and external links. The path effect in AppSidebar still covers
          // back and forward.
          onClickCapture={(event) => {
            if ((event.target as Element).closest?.("a[href]")) {
              setOpenMobile(false)
            }
          }}
          finalFocus={() =>
            document.querySelector<HTMLElement>('[data-slot="sidebar-trigger"]') ??
            undefined
          }
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground lg:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-(--duration-slow) ease-enter",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
        )}
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "fixed inset-y-0 z-10 hidden h-dvh w-(--sidebar-width) transition-[left,right,width] duration-(--duration-slow) ease-enter data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] lg:flex",
          // Rows sit 0.5rem in from the edge (groups carry that padding); the
          // rail is exactly rail-width with 0.375rem at each side. The panel
          // starts right after it.
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          variant === "floating" || variant === "inset"
            ? "py-2 group-data-[collapsible=icon]:px-1.5"
            : "group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-sm group-data-[variant=floating]:ring-1 group-data-[variant=floating]:ring-sidebar-border"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, isMobile, open, openMobile } = useSidebar()
  // The name says what a click does on this device, and the tooltip repeats it.
  const name = isMobile
    ? "Open navigation"
    : open
      ? "Collapse sidebar"
      : "Expand sidebar"
  const mac =
    typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-sidebar="trigger"
            data-slot="sidebar-trigger"
            variant="ghost"
            size="icon"
            className={className}
            aria-label={name}
            aria-expanded={isMobile ? openMobile : open}
            aria-haspopup={isMobile ? "dialog" : undefined}
            aria-keyshortcuts={mac ? "Meta+B" : "Control+B"}
            onClick={(event) => {
              onClick?.(event)
              toggleSidebar()
            }}
            {...props}
          />
        }
      >
        <PanelLeftIcon />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {name}
        <kbd data-slot="kbd" className="font-sans text-background/70">
          {mac ? "⌘B" : "Ctrl B"}
        </kbd>
      </TooltipContent>
    </Tooltip>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn(
        "relative flex w-full flex-1 flex-col bg-background lg:peer-data-[variant=inset]:mr-2 lg:peer-data-[variant=inset]:mb-2 lg:peer-data-[variant=inset]:rounded-b-xl lg:peer-data-[variant=inset]:border-x lg:peer-data-[variant=inset]:border-b lg:peer-data-[variant=inset]:border-border lg:peer-data-[variant=inset]:shadow-(--shadow-raised)",
        className
      )}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn(
        "flex flex-col gap-2 px-2 py-2 group-data-[collapsible=icon]:px-0 lg:pt-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn(
        "flex flex-col gap-2 px-2 py-2 group-data-[collapsible=icon]:px-0 lg:pb-0",
        className
      )}
      {...props}
    />
  )
}

/** A div by default; the app passes `render={<nav />}` for the landmark. */
function SidebarContent({
  className,
  render,
  ref,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    ref,
    props: mergeProps<"div">(
      {
        className: cn(
          "no-scrollbar flex min-h-0 flex-1 flex-col gap-0 overflow-auto group-data-[collapsible=icon]:overflow-hidden",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-content",
      sidebar: "content",
    },
  })
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(
        "relative flex w-full min-w-0 flex-col px-2 py-0 group-data-[collapsible=icon]:px-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          // Only the opacity moves: the label fades in place, nothing in flow
          // animates its margin or height.
          "flex shrink-0 items-center rounded-md px-2.5 pt-3 pb-1 text-label text-faint-foreground transition-opacity duration-(--duration-fast) ease-standard group-data-[collapsible=icon]:opacity-0 [&>svg]:size-4 [&>svg]:shrink-0",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "sidebar-group-label",
      sidebar: "group-label",
    },
  })
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  // Rows keep their height in the rail: only the lane narrows, so nothing in
  // flow moves. Focus is the global 2px outline, drawn inside the row because
  // the list scrolls and clips. Labels fade over duration-fast as it narrows.
  "peer/menu-button group/menu-button flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-left text-sm font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-(--duration-fast) ease-standard group-data-[collapsible=icon]:px-2.5 hover:bg-sidebar-accent hover:text-foreground focus-visible:-outline-offset-2 active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-popup-open:bg-sidebar-accent data-popup-open:text-foreground data-active:bg-card data-active:text-foreground data-active:shadow-[inset_0_0_0_1px_var(--sidebar-border),var(--shadow-control)] data-active:hover:bg-card data-active:[&_svg]:text-primary [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:transition-colors [&_svg]:duration-(--duration-fast) [&_svg]:ease-standard [&>span:not([data-slot=avatar])]:transition-opacity [&>span:not([data-slot=avatar])]:duration-(--duration-fast) [&>span:not([data-slot=avatar])]:ease-standard group-data-[collapsible=icon]:[&>span:not([data-slot=avatar])]:opacity-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        default: "h-[2.125rem] text-sm",
        sm: "h-8 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:px-0.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function SidebarMenuButton({
  render,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean
    tooltip?: string | React.ComponentProps<typeof TooltipContent>
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar()
  const comp = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props
    ),
    render: !tooltip ? render : <TooltipTrigger render={render} />,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      size,
      active: isActive,
    },
  })

  if (!tooltip) {
    return comp
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    // Disabled at the root, so an expanded row never opens an unseen tooltip
    // that would warm the delay group.
    <Tooltip disabled={state !== "collapsed" || isMobile}>
      {comp}
      <TooltipContent side="right" align="center" {...tooltip} />
    </Tooltip>
  )
}

function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute top-1/2 right-1.5 flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
}
