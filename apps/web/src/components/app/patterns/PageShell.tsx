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
        "flex w-full flex-1 flex-col pr-[max(var(--page-inset),env(safe-area-inset-right))] pl-[max(var(--page-inset),env(safe-area-inset-left))]",
        variant === "page" &&
          "pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:pt-8 md:pb-8",
        variant === "workspace" &&
          "pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
      )}
    >
      {/* Content grows with the panel up to app-max, then centres. */}
      <div
        className={cn(
          "mx-auto flex w-full max-w-(--app-max) flex-1 flex-col",
          density === "comfortable"
            ? "gap-(--space-2xl)"
            : "gap-(--space-md)",
        )}
      >
        {children}
      </div>
    </div>
  );
}
