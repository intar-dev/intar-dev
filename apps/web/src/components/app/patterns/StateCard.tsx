import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StateShellProps {
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  /** A keyboard hint rendered under the action, e.g. a <kbd> chip. */
  hint?: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
  /** The app bar owns every route's h1 — states start at h2. */
  headingLevel?: 2 | 3 | undefined;
}

function StateShell({
  icon,
  title,
  description,
  action,
  hint,
  className,
  contentClassName,
  headingLevel = 2,
}: StateShellProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <Card size="sm" className={className}>
      <CardContent
        className={cn(
          "flex flex-col items-center justify-center gap-3 py-5 text-center sm:py-6",
          contentClassName,
        )}
      >
        <div className="space-y-1.5">
          <Heading className="inline-flex items-center gap-2 text-base font-semibold">
            {icon ? (
              <span className="text-muted-foreground [&_svg:not([class*='size-'])]:size-5">
                {icon}
              </span>
            ) : null}
            {title}
          </Heading>
          {description ? (
            <p className="max-w-md text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
        {hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function EmptyState(props: StateShellProps) {
  return <StateShell {...props} />;
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Try again",
  className,
  headingLevel,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  headingLevel?: 2 | 3 | undefined;
}) {
  return (
    <StateShell
      className={className}
      icon={<TriangleAlert className="text-destructive" />}
      title={title}
      description={description}
      headingLevel={headingLevel}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    />
  );
}
