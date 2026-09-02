import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageShellVariant = "page" | "workspace";
export type Density = "comfortable" | "compact";

interface PageShellProps {
  children: ReactNode;
  variant?: PageShellVariant;
  density?: Density;
}

// Pure layout container for page content. Page chrome (title, status,
// actions) lives in the app bar via usePageChrome; content pages may open
// with a ContentHeader.
export function PageShell({
  children,
  variant = "page",
  density = "comfortable",
}: PageShellProps) {
  return (
    <div
      data-density={density}
      data-page-variant={variant}
      className={cn(
        "flex w-full flex-1 flex-col",
        density === "comfortable"
          ? "gap-(--space-xl)"
          : "gap-(--space-md)",
        variant === "page" && "px-[var(--page-inset)] py-4 sm:py-6",
        variant === "workspace" && "px-[var(--workspace-inset)] py-3 sm:py-4",
      )}
    >
      {children}
    </div>
  );
}
