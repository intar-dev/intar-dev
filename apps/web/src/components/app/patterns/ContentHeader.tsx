import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The modest in-flow header for content pages (scenario briefing, organization
// detail). Deliberately NOT a heading — the same string is already the
// route's h1 in the app bar; this renders it in full where the content
// starts. ~70px, scrolls away; the sticky crumb keeps identity on scroll.
interface ContentHeaderProps {
  title: ReactNode;
  /** Inline Badge beside the title. */
  badge?: ReactNode;
  /** One short muted line. Longer prose belongs in the content. */
  summary?: ReactNode;
  /** One MetaLine of machine facts. */
  meta?: ReactNode;
  /** Transitional slot — page actions belong in the app bar. */
  actions?: ReactNode;
  titleClassName?: string;
}

export function ContentHeader({
  title,
  badge,
  summary,
  meta,
  actions,
  titleClassName,
}: ContentHeaderProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={cn(
              "text-page-title text-pretty [overflow-wrap:anywhere]",
              titleClassName,
            )}
          >
            {title}
          </p>
          {badge}
        </div>
        {summary ? (
          <p className="text-support text-muted-foreground">
            {summary}
          </p>
        ) : null}
        {meta}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
