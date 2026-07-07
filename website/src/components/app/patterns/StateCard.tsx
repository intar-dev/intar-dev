import type { ReactNode } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Re-export the existing empty-state primitive so both names resolve to one
// implementation during the migration.
export { EmptyStateCard } from "../PagePatterns";

interface StateShellProps {
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
}

function StateShell({
  icon,
  title,
  description,
  action,
  className,
  contentClassName,
}: StateShellProps) {
  return (
    <Card className={className}>
      <CardContent
        className={cn(
          "flex min-h-[16rem] flex-col items-center justify-center gap-3 text-center",
          contentClassName,
        )}
      >
        {icon ? <div className="text-muted-foreground">{icon}</div> : null}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}

export function EmptyState(props: StateShellProps) {
  return <StateShell {...props} />;
}

export function LoadingState({
  title = "Loading…",
  description,
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <StateShell
      className={className}
      icon={<LoaderCircle className="size-6 motion-safe:animate-spin" />}
      title={title}
      description={description}
    />
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <StateShell
      className={className}
      icon={<TriangleAlert className="size-6 text-destructive" />}
      title={title}
      description={description}
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
