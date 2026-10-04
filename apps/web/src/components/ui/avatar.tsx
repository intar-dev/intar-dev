import * as React from "react"
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"

import { cn } from "@/lib/utils"

function Avatar({
  className,
  size = "default",
  ...props
}: AvatarPrimitive.Root.Props & {
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative inline-flex size-8 shrink-0 rounded-full select-none after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className
      )}
      {...props}
    />
  )
}

// The photo mounts only once it has loaded, so the keyframe fade plays once, on
// top of the initials. A keyframe (not a transition) keeps the fade under
// reduced motion. It sits absolutely over the always-mounted fallback.
function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "absolute inset-0 aspect-square size-full animate-in rounded-full object-cover fade-in-0 duration-(--duration-moderate) ease-standard",
        className
      )}
      {...props}
    />
  )
}

// Decorative: the name always sits beside an avatar. It stays mounted under the
// photo (Base UI's own Fallback would unmount the moment the photo loads, so
// the photo could not fade in over it).
function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-fallback"
      aria-hidden="true"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm font-normal tracking-normal text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
}
