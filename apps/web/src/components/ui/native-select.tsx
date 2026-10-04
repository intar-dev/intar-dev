import * as React from "react"

import { cn } from "@/lib/utils"

function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-(--control-standard) min-w-0 appearance-none rounded-lg border border-input bg-card bg-(image:--select-chevron) bg-size-[1rem] bg-position-[right_0.625rem_center] bg-no-repeat py-1 pr-9 pl-3 font-sans text-sm font-normal text-foreground shadow-(--shadow-control) transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard outline-none cursor-pointer hover:border-border-strong focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 disabled:hover:border-input aria-disabled:cursor-not-allowed aria-disabled:bg-muted aria-disabled:opacity-60 aria-disabled:hover:border-input aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive/30",
        className,
      )}
      {...props}
    />
  )
}

export { NativeSelect }
