import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 400,
  timeout = 300,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      timeout={timeout}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={8}
        className="isolate z-50"
      >
        {/* Visual only: the trigger's aria-label is the name. */}
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          aria-hidden="true"
          className={cn(
            "z-50 inline-flex w-fit max-w-64 origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs leading-[1.4] font-medium text-background shadow-(--shadow-overlay) duration-(--duration-fast) ease-enter data-[side=bottom]:slide-in-from-top-[length:var(--move-swap)] data-[side=inline-end]:slide-in-from-left-[length:var(--move-swap)] data-[side=inline-start]:slide-in-from-right-[length:var(--move-swap)] data-[side=left]:slide-in-from-right-[length:var(--move-swap)] data-[side=right]:slide-in-from-left-[length:var(--move-swap)] data-[side=top]:slide-in-from-bottom-[length:var(--move-swap)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[var(--scale-popover)] data-[instant=delay]:animate-none data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--duration-instant) data-closed:ease-exit [&_kbd]:rounded-xs [&_kbd]:bg-background/20 [&_kbd]:px-1 [&_kbd]:font-sans [&_kbd]:text-[0.6875rem] [&_kbd]:leading-[1.4] [&_kbd]:font-medium",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
