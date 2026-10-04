import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The modest in-flow header for content pages (scenario briefing, organization
// detail). Not a heading by default — the same string is already the route's
// h1 in the app bar; this renders it in full where the content starts. ~70px,
// scrolls away; the sticky crumb keeps identity on scroll. Reading pages
// (lecture, course) are the exception: their title here is the h1.
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
  /** A 12px label line above the title, e.g. "Course · Lecture 2 of 5". */
  eyebrow?: ReactNode;
  titleClassName?: string;
  /** An id for the title, so a landmark can name itself with it. */
  titleId?: string;
  /**
   * Lecture and course pages: the title and summary use the reading roles and
   * the title is the page's h1 (pass `reading: true` to usePageChrome too, so
   * the bar drops its own).
   */
  reading?: boolean;
}

export function ContentHeader({
  title,
  badge,
  summary,
  meta,
  actions,
  eyebrow,
  titleClassName,
  titleId,
  reading = false,
}: ContentHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className={cn("min-w-0", reading ? "space-y-2" : "space-y-1")}>
        {eyebrow ? <p className="text-label">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {/* A reading page's content owns the one h1; the bar shows context. */}
          {reading ? (
            <h1
              id={titleId}
              className={cn(
                "text-content-title text-balance [overflow-wrap:anywhere]",
                titleClassName,
              )}
            >
              {title}
            </h1>
          ) : (
            <p
              id={titleId}
              className={cn(
                "text-page-title text-pretty [overflow-wrap:anywhere]",
                titleClassName,
              )}
            >
              {title}
            </p>
          )}
          {badge}
        </div>
        {summary ? (
          <p
            className={
              reading ? "text-lede" : "text-support text-muted-foreground"
            }
          >
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
