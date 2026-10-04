import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"

import { cn } from "@/lib/utils"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
  )
}

// The panel folds on grid rows (0fr to 1fr) over duration-slow. The caller's
// className lands on the inner clipped div, so its padding folds away with the
// content instead of standing when closed.
function CollapsibleContent({
  className,
  children,
  ...props
}: Omit<CollapsiblePrimitive.Panel.Props, "className"> & {
  className?: string
}) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-(--duration-slow) ease-enter data-ending-style:grid-rows-[0fr] data-starting-style:grid-rows-[0fr]"
      {...props}
    >
      <div className={cn("min-h-0 overflow-hidden", className)}>{children}</div>
    </CollapsiblePrimitive.Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
