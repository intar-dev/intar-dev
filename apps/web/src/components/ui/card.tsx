import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

export type CardVariant = "default" | "flat" | "interactive"

// `render` makes the card itself the link (or any element), so hover, press and
// the focus ring belong to one rounded box and assistive tech meets one link.
function Card({
  className,
  size = "default",
  variant = "default",
  as = "div",
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  size?: "default" | "sm"
  variant?: CardVariant
  as?: "div" | "section" | "article"
}) {
  return useRender({
    defaultTagName: as,
    render,
    props: mergeProps<"div">(
      {
        "data-slot": "card",
        "data-size": size,
        "data-variant": variant,
        className: cn(
          "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:var(--space-lg)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:var(--space-md)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
          variant === "default" && "shadow-[var(--highlight),var(--shadow-raised)]",
          variant === "flat" && "bg-transparent shadow-none",
          // The edge strengthens, the fill shifts 3% toward foreground, and the
          // card drops move-press while pressed (down over duration-instant,
          // back over duration-fast). move-press is zero under reduced motion.
          variant === "interactive" &&
            "shadow-[var(--highlight),var(--shadow-raised)] transition-[border-color,background-color,box-shadow,translate] duration-(--duration-fast) ease-standard hover:border-border-strong hover:bg-[color-mix(in_oklab,var(--card),var(--foreground)_3%)] active:translate-y-(--move-press) active:duration-(--duration-instant)",
          className
        ),
      } as React.ComponentProps<"div">,
      props,
    ),
  })
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({
  className,
  as: Component = "div",
  ...props
}: React.ComponentProps<"div"> & {
  as?: "div" | "h2" | "h3" | "h4"
}) {
  return (
    <Component
      data-slot="card-title"
      className={cn("text-card-title", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-support text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/40 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
}
