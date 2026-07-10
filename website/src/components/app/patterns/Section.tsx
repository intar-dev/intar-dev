import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, type CardVariant } from "@/components/ui/card";

interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  variant?: CardVariant;
  density?: "comfortable" | "compact";
}

// THE card/section idiom: solid card fill, hairline border, soft shadow.
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  variant = "default",
  density = "comfortable",
}: SectionProps) {
  return (
    <Card
      as="section"
      variant={variant}
      size={density === "compact" ? "sm" : "default"}
      className={cn("block", className)}
    >
      {title || actions || description ? (
        <div className={cn("flex flex-col gap-2 px-(--card-spacing) sm:flex-row sm:items-start sm:justify-between", density === "comfortable" ? "mb-6" : "mb-4")}>
          <div className="space-y-1">
            {title ? <h2 className="text-section-title">{title}</h2> : null}
            {description ? (
              <p className="text-metadata prose-measure">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div className={cn("px-(--card-spacing)", bodyClassName)}>{children}</div>
    </Card>
  );
}
