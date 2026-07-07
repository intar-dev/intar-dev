import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PageHeader } from "./PageHeader";

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
  /** `wide` drops the max-width cap for workspace pages (run, authoring). */
  width?: "default" | "wide";
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
}: PageShellProps) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-1 flex-col gap-8",
        width === "default" && "max-w-7xl",
      )}
    >
      {showHeader ? (
        <PageHeader
          eyebrow={admin ? "Admin" : eyebrow}
          badge={admin ? "Admin" : undefined}
          title={title}
          description={description || undefined}
          compact={compactHeader}
          actions={actions}
          backLink={backLink}
          meta={meta}
        />
      ) : null}
      <main className="flex flex-1 flex-col gap-8">{children}</main>
    </div>
  );
}
