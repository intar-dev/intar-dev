import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode | undefined;
  eyebrow?: ReactNode | undefined;
  badge?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  /** Small ghost back-link rendered above the title. */
  backLink?:
    | { to: string; label: string; params?: Record<string, string> }
    | undefined;
  /** Chip row (MetaChips etc.) rendered under the title. */
  meta?: ReactNode | undefined;
  compact?: boolean | undefined;
  className?: string | undefined;
}

// The standard page heading. Whitespace, not rules, separates it from the
// content below — the type ladder carries the hierarchy.
export function PageHeader({
  title,
  description,
  eyebrow,
  badge,
  actions,
  backLink,
  meta,
  compact = false,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 pb-2 lg:flex-row lg:items-end lg:justify-between",
        className,
      )}
    >
      <div className="space-y-2.5">
        {backLink ? (
          <Link
            to={backLink.to}
            params={backLink.params ?? {}}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {backLink.label}
          </Link>
        ) : null}
        {eyebrow || badge ? (
          <div className="flex items-center gap-2">
            {eyebrow ? <p className="text-eyebrow">{eyebrow}</p> : null}
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
            compact ? "text-page-title" : "text-page-title sm:text-3xl",
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
        {meta ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
