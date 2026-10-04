import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Info, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

const alertVariants = cva(
  "group/alert relative grid w-full gap-1 rounded-xl border px-4 py-3 text-left text-support has-[>svg]:grid-cols-[auto_minmax(0,1fr)] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground shadow-(--shadow-raised) *:[svg]:text-current",
        destructive:
          "border-destructive-border bg-destructive-subtle text-foreground *:data-[slot=alert-description]:text-muted-foreground *:[svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

/**
 * A notice. It is polite (`role="status"`) by default, because most notices
 * are already on the page when it loads. Pass `just` only for an alert that
 * answers a learner's action: it rises in once, and an error then speaks up
 * as `role="alert"`. `icon` leads the alert; omit it for the variant's icon,
 * or pass `null` for none. A hand-placed leading svg child still wins over
 * the default icon.
 */
function Alert({
  className,
  variant,
  just,
  icon,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    just?: boolean
    icon?: React.ReactNode
  }) {
  const lead =
    icon === undefined ? (
      variant === "destructive" ? (
        <TriangleAlert data-slot="alert-icon" className="[&:has(~svg)]:hidden" />
      ) : (
        <Info data-slot="alert-icon" className="[&:has(~svg)]:hidden" />
      )
    ) : (
      icon
    )
  return (
    <div
      data-slot="alert"
      data-just={just ? "" : undefined}
      role={just && variant === "destructive" ? "alert" : "status"}
      className={cn(alertVariants({ variant }), just && "animate-rise", className)}
      {...props}
    >
      {lead}
      {children}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "min-w-0 font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "min-w-0 text-pretty wrap-break-word text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
