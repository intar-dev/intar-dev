import * as React from "react"
import { isValidElement } from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // One interaction language for every control: tone shifts on hover, a
  // half-pixel press, a 2px focus ring with 2px offset, and arrows that lean
  // toward their destination.
  // The press goes down over duration-instant and releases over duration-fast
  // (the destination state's duration applies). Busy and menu-trigger buttons
  // take no pointer input, so they don't press. Distances read the move-* and
  // scale-* tokens, which reduced motion sets to zero. Tailwind v4 writes
  // translate and scale as their own properties, so those are what transition.
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,scale,opacity] duration-(--duration-fast) ease-standard select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:not-aria-[haspopup]:not-aria-busy:translate-y-(--move-press) active:not-aria-[haspopup]:not-aria-busy:scale-(--scale-press) active:not-aria-[haspopup]:not-aria-busy:duration-(--duration-instant) pointer-coarse:min-h-11 disabled:pointer-events-none data-disabled:pointer-events-none aria-busy:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive-border dark:aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_.lucide-arrow-left]:transition-transform [&_.lucide-arrow-left]:duration-(--duration-moderate) [&_.lucide-arrow-left]:ease-enter [&_.lucide-arrow-right]:transition-transform [&_.lucide-arrow-right]:duration-(--duration-moderate) [&_.lucide-arrow-right]:ease-enter hover:[&_.lucide-arrow-left]:-translate-x-(--move-nudge) hover:[&_.lucide-arrow-right]:translate-x-(--move-nudge) focus-visible:[&_.lucide-arrow-left]:-translate-x-(--move-nudge) focus-visible:[&_.lucide-arrow-right]:translate-x-(--move-nudge)",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_1px_2px_rgb(31_26_20/0.2)] hover:bg-primary-hover dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_1px_2px_rgb(0_0_0/0.35)]",
        outline:
          "border-input bg-card text-foreground shadow-[var(--highlight),var(--shadow-control)] hover:border-border-strong hover:bg-muted aria-expanded:border-border-strong aria-expanded:bg-muted dark:hover:bg-accent dark:aria-expanded:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_6%)] aria-expanded:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_6%)]",
        ghost:
          "text-foreground hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "border-destructive-border bg-transparent text-destructive hover:border-destructive/60 hover:bg-destructive-subtle aria-expanded:bg-destructive-subtle",
        danger:
          "bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.22)] hover:bg-[color-mix(in_oklab,var(--destructive),var(--foreground)_10%)] dark:hover:bg-[color-mix(in_oklab,var(--destructive),white_14%)]",
        success:
          "bg-success text-success-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.25)] hover:bg-[color-mix(in_oklab,var(--success),white_12%)] focus-visible:outline-success",
        link: "text-brand-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-(--control-standard) gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-(--control-utility) gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--control-compact) gap-1.5 px-3 text-[0.8125rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--control-prominent) gap-2 rounded-[0.625rem] px-4 text-[0.9375rem] has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
        icon: "size-(--control-standard) pointer-coarse:min-w-11",
        "icon-xs":
          "size-(--control-utility) rounded-md in-data-[slot=button-group]:rounded-lg pointer-coarse:min-w-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-(--control-compact) in-data-[slot=button-group]:rounded-lg pointer-coarse:min-w-11",
        "icon-lg": "size-(--control-prominent) rounded-[0.625rem] pointer-coarse:min-w-11",
      },
    },
    compoundVariants: [{ variant: "link", class: "px-1" }],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function ButtonLink({
  render,
  className,
  variant,
  size,
  ...props
}: useRender.ComponentProps<"a"> & VariantProps<typeof buttonVariants>) {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        className: cn(buttonVariants({ variant, size, className })),
        "data-slot": "button",
        "data-size": size ?? "default",
      } as React.ComponentProps<"a">,
      props,
    ),
  })
}

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

  // A link keeps link semantics: Base UI's button hook would add role="button"
  // and Space handling to the <a>, so only the look is borrowed.
  if (rendersNonButton && nativeButton === undefined) {
    const {
      disabled: _disabled,
      focusableWhenDisabled: _focusable,
      ...linkProps
    } = props
    return (
      <ButtonLink
        render={render as React.ReactElement}
        variant={variant}
        size={size}
        className={typeof className === "string" ? className : undefined}
        {...(linkProps as React.ComponentProps<"a">)}
      />
    )
  }

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
