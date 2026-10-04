import { useState, type ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AsyncLabel } from "./AsyncLabel";

interface StateShellProps {
  icon?: ReactNode;
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  className?: string | undefined;
  /** An error that replaces content is announced. */
  role?: "alert";
  /** The app bar owns every route's h1 — states start at h2. */
  headingLevel?: 2 | 3 | undefined;
}

function StateShell({
  icon,
  title,
  description,
  action,
  className,
  role,
  headingLevel = 2,
}: StateShellProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <Card size="sm" className={className} role={role}>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-5 text-center sm:py-6">
        <div className="space-y-1">
          <Heading className="inline-flex items-center gap-2 text-base font-semibold">
            {icon ? (
              <span className="text-muted-foreground [&_svg:not([class*='size-'])]:size-5">
                {icon}
              </span>
            ) : null}
            {title}
          </Heading>
          {description ? (
            <p className="mx-auto max-w-[42ch] text-support text-muted-foreground">
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

/**
 * Replaces content that never loaded. Try again swaps to a spinner and
 * "Trying again…" while the request runs, keeps focus and ignores presses;
 * return the refetch promise from `onRetry` so the card knows when it ends.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  className,
  headingLevel,
}: {
  title?: string;
  description?: string;
  onRetry?: () => unknown;
  className?: string;
  headingLevel?: 2 | 3 | undefined;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    if (retrying || !onRetry) return;
    setRetrying(true);
    const started = Date.now();
    // Hold the busy state for a moment so a fast refetch does not flicker.
    const settle = () =>
      window.setTimeout(
        () => setRetrying(false),
        Math.max(0, 400 - (Date.now() - started)),
      );
    Promise.resolve(onRetry()).then(settle, settle);
  };

  return (
    <StateShell
      className={className}
      role="alert"
      icon={<TriangleAlert className="text-destructive" />}
      title={title}
      description={description}
      headingLevel={headingLevel}
      action={
        onRetry ? (
          <Button
            variant="outline"
            size="sm"
            aria-busy={retrying || undefined}
            focusableWhenDisabled
            className="aria-busy:pointer-events-none"
            onClick={retry}
          >
            <AsyncLabel
              state={retrying ? "pending" : "idle"}
              idle="Try again"
              pending="Trying again…"
            />
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * A quiet notice for a refresh that failed while data is already on screen:
 * the data stays, and this says it may be out of date. Gate ErrorState on
 * `isLoadingError` and render this on `isRefetchError`.
 */
export function StaleNotice({ what }: { what: string }) {
  return (
    <Alert role="status">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{what} may be out of date</AlertTitle>
      <AlertDescription>
        The last loaded data is shown. Refresh to try again.
      </AlertDescription>
    </Alert>
  );
}
