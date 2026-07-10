import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

export type PageShellWidth = "narrow" | "content" | "default" | "workspace";
export type Density = "comfortable" | "compact";

interface PageShellProps {
  title: string;
  description?: string;
  children: ReactNode;
  eyebrow?: string;
  /** Stamp the "Admin" eyebrow + badge. */
  admin?: boolean;
  compactHeader?: boolean;
  showHeader?: boolean;
  actions?: ReactNode;
  backLink?: { to: string; label: string; params?: Record<string, string> };
  meta?: ReactNode;
  width?: PageShellWidth;
  density?: Density;
}

// Presentational page shell: standard header + centered content region,
// rendered inside the AppShell content region.
export function PageShell({
  title,
  description = "",
  children,
  eyebrow,
  admin = false,
  compactHeader = false,
  showHeader = true,
  actions,
  backLink,
  meta,
  width = "default",
  density = "comfortable",
}: PageShellProps) {
  return (
    <div
      data-density={density}
      data-page-width={width}
      className={cn(
        "mx-auto flex w-full flex-1 flex-col",
        density === "comfortable" ? "gap-8 sm:gap-12" : "gap-6 sm:gap-8",
        width === "narrow" && "max-w-2xl px-[var(--page-inset)] py-6 sm:py-8",
        width === "content" && "max-w-5xl px-[var(--page-inset)] py-6 sm:py-8",
        width === "default" && "max-w-7xl px-[var(--page-inset)] py-6 sm:py-8",
        width === "workspace" && "px-[var(--workspace-inset)] py-3 sm:py-4 lg:py-6",
      )}
    >
      {showHeader ? (
        <PageHeader
          eyebrow={admin ? "Admin" : eyebrow}
          title={title}
          description={description || undefined}
          compact={compactHeader}
          actions={actions}
          backLink={backLink}
          meta={meta}
        />
      ) : null}
      <div
        className={cn(
          "flex flex-1 flex-col",
          density === "comfortable" ? "gap-8 sm:gap-12" : "gap-6 sm:gap-8",
        )}
      >
        {children}
      </div>
    </div>
  );
}
