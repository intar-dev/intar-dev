import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageShellWidth = "narrow" | "content" | "default" | "workspace";
export type Density = "comfortable" | "compact";

interface PageShellProps {
  children: ReactNode;
  width?: PageShellWidth;
  density?: Density;
}

// Pure layout container for page content. Page chrome (title, status,
// actions) lives in the app bar via usePageChrome; content pages may open
// with a ContentHeader.
export function PageShell({
  children,
  width = "default",
  density = "comfortable",
}: PageShellProps) {
  return (
    <div
      data-density={density}
      data-page-width={width}
      className={cn(
        "mx-auto flex w-full flex-1 flex-col",
        density === "comfortable" ? "gap-6 sm:gap-8" : "gap-4 sm:gap-6",
        width === "narrow" && "max-w-2xl px-[var(--page-inset)] py-4 sm:py-6",
        width === "content" && "max-w-5xl px-[var(--page-inset)] py-4 sm:py-6",
        width === "default" && "max-w-7xl px-[var(--page-inset)] py-4 sm:py-6",
        width === "workspace" &&
          "px-[var(--workspace-inset)] py-3 sm:py-4",
      )}
    >
      {children}
    </div>
  );
}
