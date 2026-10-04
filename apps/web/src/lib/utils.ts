import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type-role utilities in global.css set font size, so they must merge as
// font sizes. Plain twMerge reads them as text colors and drops them when a
// color class such as `text-success` follows.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "feature-title",
            "content-title",
            "lede",
            "prose",
            "prose-heading",
            "prose-subheading",
            "page-title",
            "section-title",
            "card-title",
            "body",
            "metadata",
            "support",
            "caption",
            "label",
            "code",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A refused value nudges its field once (see `[data-reject]` in global.css)
 * and keeps focus there. Call it from the submit handler when the value is
 * still wrong, after setting `aria-invalid` and the field's message.
 */
export function reject(field: HTMLElement | null | undefined) {
  if (!field) return;
  field.removeAttribute("data-reject");
  void field.offsetWidth; // restart the animation if it is already playing
  field.setAttribute("data-reject", "");
  field.focus();
}
