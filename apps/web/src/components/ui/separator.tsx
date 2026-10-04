import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        // A vertical rule is 1rem tall by default; pass h-full for a full-height
        // one. Fixed height (not self-stretch) keeps it centred in flex rows.
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:h-4 data-vertical:w-px",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
