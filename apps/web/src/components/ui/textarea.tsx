import * as React from "react"

import { cn } from "@/lib/utils"

// Grows with its content from 5rem to 16rem, then scrolls, and stops at the
// field-max width. `mono` is machine text (a public key): code size, no
// ligatures, no spellcheck or autofill. Explicit props still win.
function Textarea({
  className,
  mono,
  ...props
}: React.ComponentProps<"textarea"> & { mono?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      {...(mono ? { spellCheck: false, autoComplete: "off" } : null)}
      className={cn(
        "flex field-sizing-content max-h-64 min-h-20 w-full max-w-(--field-max) resize-y overflow-y-auto rounded-lg border border-input bg-card px-3 py-2 font-sans text-sm/[1.5] font-normal text-foreground shadow-(--shadow-control) transition-[color,background-color,border-color,box-shadow] duration-(--duration-fast) ease-standard outline-none hover:border-border-strong placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive/30",
        mono && "font-mono text-code [font-variant-ligatures:none]",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
