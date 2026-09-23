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
