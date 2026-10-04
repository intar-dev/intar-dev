import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FeedbackTone = "pending" | "success" | "error";

export function InlineFeedback({
  tone,
  children,
  className,
  announce = true,
}: {
  tone: FeedbackTone;
  children: React.ReactNode;
  className?: string;
  /** False when a live region that is always mounted already announces it. */
  announce?: boolean;
}) {
  const Icon =
    tone === "pending"
      ? LoaderCircle
      : tone === "success"
        ? CheckCircle2
        : CircleAlert;

  return (
    <p
      role={announce ? (tone === "error" ? "alert" : "status") : undefined}
      aria-live={announce ? (tone === "error" ? "assertive" : "polite") : undefined}
      className={cn(
        "flex min-h-6 items-start gap-2 text-sm",
        tone === "pending" && "text-muted-foreground",
        tone === "success" && "text-success",
        tone === "error" && "text-destructive",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "pending" && "motion-safe:animate-spin",
        )}
        aria-hidden="true"
      />
      <span>{children}</span>
    </p>
  );
}
