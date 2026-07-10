import type { ReactNode } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StateShellProps {
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
  headingLevel?: 1 | 2 | 3 | undefined;
}

function StateShell({
  icon,
  title,
  description,
  action,
  className,
  contentClassName,
  headingLevel = 2,
}: StateShellProps) {
  const Heading =
    headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2";

  return (
    <Card className={className}>
      <CardContent
        className={cn(
          "flex min-h-[16rem] flex-col items-center justify-center gap-4 text-center",
          contentClassName,
        )}
      >
        {icon ? (
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-6">
            {icon}
          </div>
        ) : null}
        <div className="space-y-2">
          <Heading className="text-section-title">{title}</Heading>
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
  headingLevel,
}: {
  title?: string;
  description?: string;
  className?: string;
  headingLevel?: 1 | 2 | 3 | undefined;
}) {
  return (
    <StateShell
      className={className}
      icon={<LoaderCircle className="motion-safe:animate-spin" />}
      title={title}
      description={description}
      headingLevel={headingLevel}
    />
  );
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
  headingLevel?: 1 | 2 | 3 | undefined;
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
