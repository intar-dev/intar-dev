import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-muted skeleton-shimmer motion-safe:animate-shimmer", className)}
      {...props}
    />
  )
}

export { Skeleton }
