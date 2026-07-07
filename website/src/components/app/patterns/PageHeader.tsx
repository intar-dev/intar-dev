import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

// The standard page heading, replacing the header role the old SignedInShell /
// AuthenticatedShell wrappers used to play. Rendered by pages directly into the
// shell's content region.
export function PageHeader({
  title,
  description,
  eyebrow,
  badge,
  actions,
  compact = false,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 border-b pb-6 lg:flex-row lg:items-end lg:justify-between",
        className,
      )}
    >
      <div className="space-y-2">
        {eyebrow || badge ? (
          <div className="flex items-center gap-2">
            {eyebrow ? (
              <p className="text-sm font-medium text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            {badge ? (
              typeof badge === "string" ? (
                <Badge variant="secondary">{badge}</Badge>
              ) : (
                badge
              )
            ) : null}
          </div>
        ) : null}
        <h1
          className={cn(
            "font-semibold tracking-tight",
            compact ? "text-2xl" : "text-3xl sm:text-4xl",
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
