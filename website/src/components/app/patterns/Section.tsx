import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

// THE card/section idiom: solid card fill, hairline border, soft shadow.
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: SectionProps) {
  return (
    <section
      className={cn("rounded-2xl border bg-card p-6 shadow-xs", className)}
    >
      {title || actions || description ? (
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            {title ? <h2 className="text-section-title">{title}</h2> : null}
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
