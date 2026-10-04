import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

// `mono` is for machine values (slugs, URLs, IDs, owner/repo): Plex Mono, and
// no autocapitalize, autocorrect or spellcheck. Explicit props still win.
function Input({
  className,
  type,
  mono,
  ...props
}: React.ComponentProps<"input"> & { mono?: boolean }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      {...(mono
        ? { spellCheck: false, autoCapitalize: "none", autoCorrect: "off" }
        : null)}
      className={cn(
        "h-(--control-standard) w-full min-w-0 rounded-lg border border-input bg-card px-3 py-1 font-sans text-sm font-normal text-foreground shadow-(--shadow-control) transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard outline-none hover:border-border-strong file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive/30",
        mono && "font-mono",
        className,
      )}
      {...props}
    />
  )
}

export { Input }
