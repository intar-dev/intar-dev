import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function EmptyStateCard(props: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={props.className}>
      <CardContent
        className={cn(
          "flex min-h-[20rem] flex-col items-center justify-center gap-3 text-center",
          props.contentClassName,
        )}
      >
        {props.icon ? (
          <div className="text-muted-foreground">{props.icon}</div>
        ) : null}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{props.title}</h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            {props.description}
          </p>
        </div>
        {props.action}
      </CardContent>
    </Card>
  );
}
