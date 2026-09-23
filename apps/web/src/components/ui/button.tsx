import { isValidElement } from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // One interaction language for every control: tone shifts on hover, a
  // half-pixel press, a 2px focus ring with 2px offset, and arrows that lean
  // toward their destination.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 ease-standard select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px active:not-aria-[haspopup]:scale-[0.985] motion-reduce:transition-none motion-reduce:active:transform-none disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_.lucide-arrow-left]:transition-transform [&_.lucide-arrow-left]:duration-200 [&_.lucide-arrow-left]:ease-enter [&_.lucide-arrow-right]:transition-transform [&_.lucide-arrow-right]:duration-200 [&_.lucide-arrow-right]:ease-enter hover:[&_.lucide-arrow-left]:-translate-x-0.5 hover:[&_.lucide-arrow-right]:translate-x-0.5 motion-reduce:[&_svg]:transition-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(25_28_34/0.2)] hover:bg-primary-hover dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_1px_2px_rgb(0_0_0/0.35)]",
        outline:
          "border-input bg-card text-foreground shadow-[var(--highlight),var(--shadow-control)] hover:border-border-strong hover:bg-muted aria-expanded:border-border-strong aria-expanded:bg-muted dark:hover:bg-accent dark:aria-expanded:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)] aria-expanded:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)]",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        destructive:
          "border-destructive-border bg-transparent text-destructive hover:border-destructive/60 hover:bg-destructive-subtle aria-expanded:bg-destructive-subtle",
        danger:
          "bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.22)] hover:bg-[color-mix(in_oklch,var(--destructive),var(--foreground)_10%)] dark:hover:bg-[color-mix(in_oklch,var(--destructive),white_14%)]",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-standard) gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-(--control-utility) gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-compact) gap-1.5 px-3 text-[0.8125rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--control-prominent) gap-2 rounded-[0.625rem] px-4 text-[0.9375rem] has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
        icon: "size-(--control-standard)",
        "icon-xs":
          "size-(--control-utility) rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-(--control-compact) in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-(--control-prominent) rounded-[0.625rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant = "default",
  size = "default",
  nativeButton,
  render,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  // When rendered as a non-<button> element (e.g. a router Link or <a> for a
  // link-styled button), Base UI needs nativeButton=false to keep correct
  // button semantics/accessibility. Default it automatically so call sites
  // don't have to remember; an explicit prop still wins.
  const rendersNonButton = isValidElement(render) && render.type !== "button"
  const resolvedNativeButton = nativeButton ?? !rendersNonButton

  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      nativeButton={resolvedNativeButton}
      render={render}
      {...props}
    />
  )
}

export { Button, buttonVariants }
